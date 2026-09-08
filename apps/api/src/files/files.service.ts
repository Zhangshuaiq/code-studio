import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { readdir, readFile, writeFile, mkdir, stat } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { DistributedWorkspaceLockService } from '../workspace/distributed-workspace-lock.service';
import { ConfigService } from '@nestjs/config';
import {
  assertWorkspaceChanges,
  assertNoSymlinkPath,
  editableRelativePath,
  WorkspaceQuotaError,
  workspaceLimits,
} from '../common/workspace-quota';

// 不进树的目录（体积大/无编辑意义）
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.vite',
  '.cache',
  '.next',
  'build',
  'target', // Maven/Java 编译产物
  '__pycache__', // Python 编译缓存
  '.venv',
  'venv',
  '.mvn',
]);
const MAX_FILES = 500;
const MAX_READ_BYTES = 512 * 1024; // 单文件读取上限 512KB
const INDEX_FILE_BYTES = 256 * 1024;
const INDEX_TOTAL_BYTES = 4 * 1024 * 1024;
const SEARCH_TOTAL_BYTES = 10 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'json', 'css', 'scss', 'less', 'html', 'vue', 'java', 'py', 'go', 'rs', 'kt', 'kts', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb', 'sql', 'xml', 'yaml', 'yml']);

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly workspaces: WorkspaceService,
    private readonly workspaceLock: DistributedWorkspaceLockService,
    private readonly config: ConfigService,
  ) {}

  /** 校验会话归属并返回其项目卷的绝对根路径 */
  private async volumeRoot(userId: string, sessionId: string): Promise<string> {
    return (await this.projectVolume(userId, sessionId)).root;
  }

  /** 校验归属并返回项目卷根路径 + 项目名（下载用） */
  async projectVolume(
    userId: string,
    sessionId: string,
  ): Promise<{ root: string; name: string }> {
    const session = await this.access.requireSession(userId, sessionId, 'read');
    const workspace = await this.workspaces.ensureForSession(userId, sessionId);
    return { root: resolve(workspace.path), name: session.project.name };
  }

  /** 把用户传入的相对路径安全解析到卷内，防目录穿越 */
  private safeJoin(root: string, rel: string): string {
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new BadRequestException({ code: 'FILE_PATH_INVALID', message: '非法路径' });
    }
    return target;
  }

  /** 列出项目卷内所有文件（相对路径，排除 IGNORE_DIRS） */
  async list(userId: string, sessionId: string): Promise<string[]> {
    const root = await this.volumeRoot(userId, sessionId);
    const out: string[] = [];
    const walk = async (dir: string) => {
      if (out.length >= MAX_FILES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // 卷目录还不存在
      }
      for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
          await walk(join(dir, e.name));
        } else if (e.isFile()) {
          if (e.name.startsWith('.')) continue; // 隐藏 .aider*、.env 等点文件
          out.push(relative(root, join(dir, e.name)));
        }
      }
    };
    await walk(root);
    return out.sort();
  }

  /** 读取单个文件内容（文本） */
  async read(
    userId: string,
    sessionId: string,
    path: string,
  ): Promise<{ path: string; content: string }> {
    const root = await this.volumeRoot(userId, sessionId);
    let normalizedPath: string;
    try {
      normalizedPath = editableRelativePath(root, path);
      await assertNoSymlinkPath(root, normalizedPath);
    } catch (error) {
      if (error instanceof WorkspaceQuotaError) {
        throw new BadRequestException({ code: `WORKSPACE_${error.code.toUpperCase()}`, message: error.message });
      }
      throw error;
    }
    const target = this.safeJoin(root, normalizedPath);
    let info;
    try {
      info = await stat(target);
    } catch {
      throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: '文件不存在' });
    }
    if (!info.isFile()) throw new BadRequestException({ code: 'FILE_NOT_REGULAR', message: '不是文件' });
    if (info.size > MAX_READ_BYTES) {
      throw new BadRequestException({ code: 'FILE_VIEW_TOO_LARGE', message: '文件过大，暂不支持在线查看' });
    }
    const content = await readFile(target, 'utf8');
    return { path: normalizedPath, content };
  }

  async sourceIndex(userId: string, sessionId: string) {
    const root = await this.volumeRoot(userId, sessionId);
    const paths = await this.list(userId, sessionId);
    const files: Array<{ path: string; content: string }> = [];
    let bytes = 0;
    for (const path of paths) {
      if (!isSourcePath(path) || files.length >= 300 || bytes >= INDEX_TOTAL_BYTES) continue;
      const target = this.safeJoin(root, editableRelativePath(root, path));
      await assertNoSymlinkPath(root, path);
      const info = await stat(target).catch(() => null);
      if (!info?.isFile() || info.size > INDEX_FILE_BYTES || bytes + info.size > INDEX_TOTAL_BYTES) continue;
      const content = await readFile(target, 'utf8').catch(() => null);
      if (content === null || content.includes('\0')) continue;
      files.push({ path, content });
      bytes += Buffer.byteLength(content, 'utf8');
    }
    return { files, bytes, truncated: files.length >= 300 || bytes >= INDEX_TOTAL_BYTES || files.length < paths.filter(isSourcePath).length };
  }

  async search(userId: string, sessionId: string, rawQuery: string, caseSensitive = false) {
    const query = rawQuery.trim();
    if (!query) throw new BadRequestException({ code: 'FILE_SEARCH_QUERY_REQUIRED', message: '搜索内容不能为空' });
    const root = await this.volumeRoot(userId, sessionId);
    const paths = await this.list(userId, sessionId);
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const items: Array<{ path: string; line: number | null; column: number | null; preview: string; kind: 'path' | 'content' }> = [];
    let scannedBytes = 0;
    let scannedFiles = 0;
    for (const path of paths) {
      if (items.length >= 200 || scannedBytes >= SEARCH_TOTAL_BYTES) break;
      const comparablePath = caseSensitive ? path : path.toLocaleLowerCase();
      if (comparablePath.includes(needle)) items.push({ path, line: null, column: null, preview: path, kind: 'path' });
      if (!isSourcePath(path)) continue;
      const target = this.safeJoin(root, editableRelativePath(root, path));
      await assertNoSymlinkPath(root, path);
      const info = await stat(target).catch(() => null);
      if (!info?.isFile() || info.size > INDEX_FILE_BYTES || scannedBytes + info.size > SEARCH_TOTAL_BYTES) continue;
      const content = await readFile(target, 'utf8').catch(() => null);
      if (content === null || content.includes('\0')) continue;
      scannedFiles += 1;
      scannedBytes += Buffer.byteLength(content, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && items.length < 200; index += 1) {
        const haystack = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
        const column = haystack.indexOf(needle);
        if (column >= 0) items.push({ path, line: index + 1, column: column + 1, preview: lines[index].trim().slice(0, 500), kind: 'content' });
      }
    }
    return { items, scannedFiles, scannedBytes, truncated: items.length >= 200 || scannedBytes >= SEARCH_TOTAL_BYTES || paths.length >= MAX_FILES };
  }

  /** 写回文件内容（保存编辑）——bind mount 的卷会触发 Vite HMR */
  async write(
    userId: string,
    sessionId: string,
    path: string,
    content: string,
  ): Promise<{ path: string; bytes: number }> {
    const session = await this.access.requireSession(userId, sessionId, 'edit');
    const root = await this.volumeRoot(userId, sessionId);
    return this.workspaceLock.runExclusive(`workspace:${session.projectId}:${userId}`, () =>
      this.writeUnlocked(root, path, content),
    );
  }

  private async writeUnlocked(
    root: string,
    path: string,
    content: string,
  ): Promise<{ path: string; bytes: number }> {
    const bytes = Buffer.byteLength(content ?? '', 'utf8');
    let change: { path: string; bytes: number };
    try {
      [change] = await assertWorkspaceChanges(
        root,
        [{ path, bytes }],
        workspaceLimits((key, fallback) => Number(this.config.get(key, fallback))),
      );
    } catch (error) {
      if (error instanceof WorkspaceQuotaError) {
        throw new BadRequestException({ code: `WORKSPACE_${error.code.toUpperCase()}`, message: error.message });
      }
      throw error;
    }
    const target = this.safeJoin(root, editableRelativePath(root, change.path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content ?? '', 'utf8');
    return { path: change.path, bytes };
  }
}

function isSourcePath(path: string) { const extension = path.split('.').pop()?.toLowerCase(); return Boolean(extension && SOURCE_EXTENSIONS.has(extension)); }
