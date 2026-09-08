import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  assertNoSymlinkPath,
  editableRelativePath,
  WorkspaceQuotaError,
} from '../common/workspace-quota';
import { WorkspaceMcpFacade } from './workspace-mcp.facade';
import { assertMcpReadablePath, isMcpReadablePath } from './mcp-file-policy';

const ignoredDirectories = new Set([
  'node_modules', '.git', 'dist', '.vite', '.cache', '.next', 'build',
  'target', '__pycache__', '.venv', 'venv', '.mvn',
]);
const maxFiles = 500;
const maxReadBytes = 512 * 1024;
const maxReturnBytes = 256 * 1024;
const maxSearchBytes = 10 * 1024 * 1024;
const maxSearchResults = 200;

@Injectable()
export class WorkspaceFileMcpFacade {
  constructor(private readonly workspaces: WorkspaceMcpFacade) {}

  async tree(userId: string, sessionId: string) {
    const { path: root } = await this.workspaces.requireExisting(userId, sessionId);
    const files: string[] = [];
    let truncated = false;
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        if (entry.name.startsWith('.')) continue;
        const target = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) await walk(target);
        } else if (entry.isFile()) {
          const path = relative(root, target).split(sep).join('/');
          if (isMcpReadablePath(path)) files.push(path);
        }
      }
    };
    await walk(root);
    return { sessionId, files: files.sort(), truncated, limit: maxFiles };
  }

  async read(
    userId: string,
    sessionId: string,
    requestedPath: string,
    startLine?: number,
    endLine?: number,
  ) {
    const { path: root } = await this.workspaces.requireExisting(userId, sessionId);
    let path: string;
    try {
      path = editableRelativePath(root, requestedPath);
      assertMcpReadablePath(path);
      await assertNoSymlinkPath(root, path);
    } catch (error) {
      if (error instanceof WorkspaceQuotaError) {
        throw new BadRequestException({
          code: `WORKSPACE_${error.code.toUpperCase()}`,
          message: error.message,
        });
      }
      throw error;
    }
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new BadRequestException({ code: 'FILE_PATH_INVALID', message: '非法路径' });
    }
    let info;
    try {
      info = await stat(target);
    } catch {
      throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: '文件不存在' });
    }
    if (!info.isFile()) {
      throw new BadRequestException({ code: 'FILE_NOT_REGULAR', message: '不是普通文件' });
    }
    if (info.size > maxReadBytes) {
      throw new BadRequestException({
        code: 'FILE_VIEW_TOO_LARGE',
        message: `文件超过 ${maxReadBytes} 字节，只读 MCP 不予返回`,
      });
    }
    const source = await readFile(target);
    const text = source.toString('utf8');
    const lines = text.split('\n');
    const from = startLine ?? 1;
    const to = Math.min(endLine ?? lines.length, lines.length);
    const selected = lines.slice(from - 1, to).join('\n');
    const selectedBytes = Buffer.from(selected, 'utf8');
    const content = selectedBytes.length > maxReturnBytes
      ? selectedBytes.subarray(0, maxReturnBytes).toString('utf8')
      : selected;
    return {
      sessionId, path, sizeBytes: info.size,
      sha256: createHash('sha256').update(source).digest('hex'),
      startLine: from, endLine: to, totalLines: lines.length,
      truncated: from > 1 || to < lines.length || selectedBytes.length > maxReturnBytes,
      content,
    };
  }

  async search(userId: string, sessionId: string, query: string, caseSensitive: boolean) {
    const { files, truncated: treeTruncated } = await this.tree(userId, sessionId);
    const { path: root } = await this.workspaces.requireExisting(userId, sessionId);
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let scannedBytes = 0;
    let scanLimitReached = false;
    for (const path of files) {
      const target = resolve(root, path);
      const info = await stat(target).catch(() => null);
      if (!info?.isFile() || info.size > maxReadBytes) continue;
      if (scannedBytes + info.size > maxSearchBytes) { scanLimitReached = true; break; }
      const source = await readFile(target);
      scannedBytes += source.length;
      if (source.includes(0)) continue;
      const lines = source.toString('utf8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const candidate = caseSensitive ? lines[index] : lines[index].toLowerCase();
        if (!candidate.includes(needle)) continue;
        matches.push({ path, line: index + 1, text: lines[index].slice(0, 2000) });
        if (matches.length >= maxSearchResults) break;
      }
      if (matches.length >= maxSearchResults) break;
    }
    return {
      sessionId, query, matches, scannedBytes,
      truncated: treeTruncated || scanLimitReached || matches.length >= maxSearchResults,
      limits: { files: maxFiles, scannedBytes: maxSearchBytes, matches: maxSearchResults },
    };
  }
}
