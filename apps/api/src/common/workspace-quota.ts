import { lstat, readdir, stat } from 'fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'path';

export const WORKSPACE_IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  '.vite',
  '.cache',
  '.next',
  'build',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

export interface WorkspaceLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxSourceBytes: number;
}

export interface WorkspaceUsage {
  files: number;
  bytes: number;
  sizes: Map<string, number>;
}

export class WorkspaceQuotaError extends Error {
  constructor(
    readonly code: 'invalid_path' | 'file_too_large' | 'too_many_files' | 'workspace_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceQuotaError';
  }
}

export function workspaceLimits(get: (key: string, fallback: number) => number): WorkspaceLimits {
  return {
    maxFiles: get('WORKSPACE_MAX_SOURCE_FILES', 2_000),
    maxFileBytes: get('WORKSPACE_MAX_FILE_BYTES', 2 * 1024 * 1024),
    maxSourceBytes: get('WORKSPACE_MAX_SOURCE_BYTES', 100 * 1024 * 1024),
  };
}

/** 返回规范化相对路径，并拒绝工作区内部实现目录。 */
export function editableRelativePath(root: string, input: string): string {
  if (!input || input.includes('\0') || isAbsolute(input)) {
    throw new WorkspaceQuotaError('invalid_path', '文件路径无效');
  }
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, input);
  const rel = relative(absoluteRoot, target).split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../')) {
    throw new WorkspaceQuotaError('invalid_path', '文件路径超出项目工作区');
  }
  const segments = rel.split('/');
  if (segments.some((segment) => WORKSPACE_IGNORED_DIRECTORIES.has(segment))) {
    throw new WorkspaceQuotaError('invalid_path', '禁止修改工作区内部目录或构建产物目录');
  }
  return rel;
}

/** 防止工作区内已有符号链接把后续写入重定向到卷外。 */
export async function assertNoSymlinkPath(root: string, relativePath: string): Promise<void> {
  let current = resolve(root);
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new WorkspaceQuotaError('invalid_path', '禁止通过符号链接修改文件');
    }
  }
}

export async function scanWorkspaceUsage(root: string): Promise<WorkspaceUsage> {
  const absoluteRoot = resolve(root);
  const sizes = new Map<string, number>();
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!WORKSPACE_IGNORED_DIRECTORIES.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => null);
        if (!info?.isFile()) continue;
        const rel = relative(absoluteRoot, full).split(sep).join('/');
        sizes.set(rel, info.size);
        bytes += info.size;
      }
    }
  };
  await walk(absoluteRoot);
  return { files: sizes.size, bytes, sizes };
}

export async function assertWorkspaceWithinLimits(
  root: string,
  limits: WorkspaceLimits,
): Promise<WorkspaceUsage> {
  const usage = await scanWorkspaceUsage(root);
  if (usage.files > limits.maxFiles) {
    throw new WorkspaceQuotaError('too_many_files', `项目源码文件数超过 ${limits.maxFiles} 个限制`);
  }
  if (usage.bytes > limits.maxSourceBytes) {
    throw new WorkspaceQuotaError('workspace_too_large', '项目源码总容量超过平台限制');
  }
  for (const [path, bytes] of usage.sizes) {
    if (bytes > limits.maxFileBytes) {
      throw new WorkspaceQuotaError('file_too_large', `文件 ${path} 超过单文件大小限制`);
    }
  }
  return usage;
}

/** 在真正写盘前按最终状态计算配额，避免批量生成写到一半才失败。 */
export async function assertWorkspaceChanges(
  root: string,
  changes: Array<{ path: string; bytes: number }>,
  limits: WorkspaceLimits,
): Promise<Array<{ path: string; bytes: number }>> {
  const normalized = new Map<string, number>();
  for (const change of changes) {
    const path = editableRelativePath(root, change.path);
    await assertNoSymlinkPath(root, path);
    if (!Number.isSafeInteger(change.bytes) || change.bytes < 0) {
      throw new WorkspaceQuotaError('file_too_large', `文件 ${path} 大小无效`);
    }
    if (change.bytes > limits.maxFileBytes) {
      throw new WorkspaceQuotaError('file_too_large', `文件 ${path} 超过单文件大小限制`);
    }
    normalized.set(path, change.bytes);
  }
  const usage = await scanWorkspaceUsage(root);
  let files = usage.files;
  let bytes = usage.bytes;
  for (const [path, size] of normalized) {
    const previous = usage.sizes.get(path);
    if (previous == null) files += 1;
    bytes += size - (previous ?? 0);
  }
  if (files > limits.maxFiles) {
    throw new WorkspaceQuotaError('too_many_files', `项目源码文件数超过 ${limits.maxFiles} 个限制`);
  }
  if (bytes > limits.maxSourceBytes) {
    throw new WorkspaceQuotaError('workspace_too_large', '项目源码总容量超过平台限制');
  }
  return [...normalized].map(([path, size]) => ({ path, bytes: size }));
}
