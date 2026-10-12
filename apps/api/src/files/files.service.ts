import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { readdir, readFile, writeFile, mkdir, stat, open } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import { ProjectAccessService } from '../project-access/project-access.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { ConfigService } from '@nestjs/config';
import { WorkspaceLanguageService } from '../lsp/workspace-language.service';
import {
  assertWorkspaceChanges,
  assertNoSymlinkPath,
  editableRelativePath,
  WorkspaceQuotaError,
  workspaceLimits,
} from '../common/workspace-quota';

// 不进树的目录（体积大/无编辑意义）
const IGNORE_DIRS = new Set(require('@codegen/code-intelligence/file-types.json').ignoredDirectories);
const MAX_READ_BYTES = 512 * 1024; // 单文件读取上限 512KB
const { describeFile, readSpreadsheet } = require('@codegen/code-intelligence/file-preview.cjs');
const { decodeText, encodeText, textEncoding } = require('@codegen/code-intelligence/file-text.cjs');
const ExcelJS = require('exceljs');
const INDEX_FILE_BYTES = 256 * 1024;
const INDEX_TOTAL_BYTES = 4 * 1024 * 1024;
const SEARCH_TOTAL_BYTES = 10 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'json', 'css', 'scss', 'less', 'html', 'vue', 'java', 'py', 'go', 'rs', 'kt', 'kts', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb', 'sql', 'xml', 'yaml', 'yml']);

@Injectable()
export class FilesService {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly workspaces: WorkspaceService,
    private readonly config: ConfigService,
    @Optional() private readonly language?: WorkspaceLanguageService,
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
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // 卷目录还不存在
      }
      for (const e of entries) {
        if (e.name.startsWith('.aider')) continue;
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name)) continue;
          await walk(join(dir, e.name));
        } else if (e.isFile()) {
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
  ) {
    const { normalizedPath, target, info } = await this.previewFile(userId, sessionId, path);
    const descriptor = describeFile(target);
    if (descriptor.kind !== 'text') {
      return { path: normalizedPath, content: '', ...descriptor, size: info.size, readOnly: true };
    }
    if (info.size > MAX_READ_BYTES) {
      throw new BadRequestException({ code: 'FILE_VIEW_TOO_LARGE', message: '文件过大，暂不支持在线查看' });
    }
    const bytes = await readFile(target);
    let decoded;
    try { decoded = decodeText(bytes); } catch (error) { throw new BadRequestException({ code: 'FILE_TEXT_ENCODING_INVALID', message: (error as Error).message }); }
    return { path: normalizedPath, ...descriptor, ...decoded, version: contentVersion(bytes), size: info.size };
  }

  private async previewFile(userId: string, sessionId: string, path: string) {
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
    return { normalizedPath, target, info };
  }

  async preview(userId: string, sessionId: string, path: string) {
    const { normalizedPath, target, info } = await this.previewFile(userId, sessionId, path);
    const descriptor = describeFile(target);
    if (!['image', 'pdf'].includes(descriptor.kind)) throw new BadRequestException({ code: 'FILE_PREVIEW_UNSUPPORTED', message: '该文件不支持原始预览' });
    if (info.size > 100 * 1024 * 1024) throw new BadRequestException({ code: 'FILE_VIEW_TOO_LARGE', message: '暂不支持预览超过 100 MiB 的文件' });
    const content = await readFile(target);
    if (content.length > 100 * 1024 * 1024) throw new BadRequestException({ code: 'FILE_VIEW_TOO_LARGE', message: '文件已超过预览大小上限' });
    await this.access.requireSession(userId, sessionId, 'read');
    return { path: normalizedPath, mime: descriptor.mime, content };
  }

  async spreadsheet(userId: string, sessionId: string, path: string) {
    const { target, info } = await this.previewFile(userId, sessionId, path);
    if (describeFile(target).kind !== 'spreadsheet') throw new BadRequestException({ code: 'FILE_PREVIEW_UNSUPPORTED', message: '当前仅支持 .xlsx 和 .csv 表格' });
    if (info.size > 20 * 1024 * 1024) throw new BadRequestException({ code: 'FILE_VIEW_TOO_LARGE', message: '暂不支持解析超过 20 MiB 的表格' });
    let result;
    try { result = await readSpreadsheet(target, new ExcelJS.Workbook()); }
    catch { throw new BadRequestException({ code: 'FILE_SPREADSHEET_INVALID', message: '无法解析此表格，请检查文件格式及内容' }); }
    await this.access.requireSession(userId, sessionId, 'read');
    return result;
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
      const content = await readFile(target).then(buffer => decodeText(buffer).content).catch(() => null);
      if (content === null || content.includes('\0')) continue;
      if (bytes + Buffer.byteLength(content, 'utf8') > INDEX_TOTAL_BYTES) continue;
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
      const content = await readFile(target).then(buffer => decodeText(buffer).content).catch(() => null);
      if (content === null || content.includes('\0')) continue;
      if (scannedBytes + Buffer.byteLength(content, 'utf8') > SEARCH_TOTAL_BYTES) continue;
      scannedFiles += 1;
      scannedBytes += Buffer.byteLength(content, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && items.length < 200; index += 1) {
        const haystack = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
        const column = haystack.indexOf(needle);
        if (column >= 0) items.push({ path, line: index + 1, column: column + 1, preview: lines[index].trim().slice(0, 500), kind: 'content' });
      }
    }
    return { items, scannedFiles, scannedBytes, truncated: items.length >= 200 || scannedBytes >= SEARCH_TOTAL_BYTES };
  }

  /** 写回文件内容（保存编辑）——bind mount 的卷会触发 Vite HMR */
  async write(
    userId: string,
    sessionId: string,
    path: string,
    content: string,
    expectedVersion?: string,
  ): Promise<{ path: string; bytes: number }> {
    await this.access.requireSession(userId, sessionId, 'edit');
    const root = await this.volumeRoot(userId, sessionId);
    const result = await this.writeUnlocked(root, path, content, expectedVersion);
    this.language?.workspaceChanged(root);
    return result;
  }

  private async writeUnlocked(
    root: string,
    path: string,
    content: string,
    expectedVersion?: string,
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
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile() && describeFile(target).kind !== 'text') throw new BadRequestException({ code: 'FILE_READ_ONLY', message: '此文件仅支持预览，不能作为文本保存' });
    if (expectedVersion !== undefined) {
      const previous = await readFile(target).catch(() => null);
      if (previous === null || contentVersion(previous) !== expectedVersion) throw new ConflictException({ code: 'FILE_VERSION_CONFLICT', message: '文件已被其他操作修改，草稿已保留，请重新加载后重试' });
    }
    let format = { encoding: 'utf-8', bom: false };
    if (existing?.isFile()) {
      const handle = await open(target, 'r');
      try { const prefix = Buffer.alloc(4); const { bytesRead } = await handle.read(prefix, 0, 4, 0); format = textEncoding(prefix.subarray(0, bytesRead)); }
      finally { await handle.close(); }
    }
    let encoded: Buffer;
    try { encoded = encodeText(content ?? '', format); } catch (error) { throw new BadRequestException({ code: 'FILE_TEXT_ENCODING_INVALID', message: (error as Error).message }); }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, encoded);
    return { path: change.path, bytes: encoded.length };
  }
}

function isSourcePath(path: string) { const extension = path.split('.').pop()?.toLowerCase(); return Boolean(extension && SOURCE_EXTENSIONS.has(extension)); }
function contentVersion(content: string | Buffer) { return createHash('sha256').update(content).digest('hex'); }
