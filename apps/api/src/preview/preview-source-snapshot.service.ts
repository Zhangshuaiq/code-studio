import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { assertWorkspaceWithinLimits, workspaceLimits } from '../common/workspace-quota';
import { WorkspaceService } from '../workspace/workspace.service';
import { DistributedWorkspaceLockService } from '../workspace/distributed-workspace-lock.service';

// archiver 的类型声明没有暴露 CommonJS 可调用签名。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const createArchive = require('archiver') as (format: string, options?: unknown) => any;

@Injectable()
export class PreviewSourceSnapshotService {
  private readonly root: string;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly workspaces: WorkspaceService,
    private readonly locks: DistributedWorkspaceLockService,
  ) {
    this.root = resolve(this.config.get('PREVIEW_SNAPSHOT_ROOT', '.data/preview-snapshots'));
  }

  async create(userId: string, sessionId: string, projectId: string) {
    const workspace = await this.workspaces.ensureForSession(userId, sessionId);
    return this.locks.runExclusive(`workspace:${projectId}:${userId}`, async () => {
      await assertWorkspaceWithinLimits(workspace.path, workspaceLimits((key, fallback) => Number(this.config.get(key, fallback))));
      const id = randomBytes(16).toString('hex');
      const token = randomBytes(32).toString('base64url');
      const archivePath = resolve(this.root, `${id}.tar.gz`);
      await mkdir(dirname(archivePath), { recursive: true });
      try {
        await archiveWorkspace(workspace.path, archivePath);
        const info = await stat(archivePath);
        const maxBytes = Number(this.config.get('PREVIEW_SNAPSHOT_MAX_BYTES', 128 * 1024 * 1024));
        if (info.size > maxBytes || info.size > 2_147_483_647) throw new BadRequestException({ code: 'PREVIEW_SNAPSHOT_TOO_LARGE', message: '工作区快照超过预览构建大小限制' });
        const sha256 = await fileSha256(archivePath);
        const ttlMinutes = Math.max(10, Number(this.config.get('PREVIEW_SNAPSHOT_TTL_MINUTES', 120)));
        const row = await this.prisma.previewSourceSnapshot.create({ data: { id, sessionId, tokenHash: tokenHash(token), archivePath, sha256, sizeBytes: info.size, expiresAt: new Date(Date.now() + ttlMinutes * 60_000) } });
        return { id: row.id, token, sha256, sizeBytes: row.sizeBytes, expiresAt: row.expiresAt };
      } catch (error) {
        await unlink(archivePath).catch(() => undefined);
        throw error;
      }
    });
  }

  async open(id: string, token: string) {
    const row = await this.prisma.previewSourceSnapshot.findFirst({ where: { id, tokenHash: tokenHash(token), status: 'ready', expiresAt: { gt: new Date() } } });
    if (!row) throw new NotFoundException({ code: 'PREVIEW_SNAPSHOT_NOT_FOUND', message: '构建快照不存在、已过期或凭证无效' });
    const info = await stat(row.archivePath).catch(() => null);
    if (!info?.isFile() || info.size !== row.sizeBytes) throw new NotFoundException({ code: 'PREVIEW_SNAPSHOT_FILE_MISSING', message: '构建快照文件不存在或不完整' });
    await this.prisma.previewSourceSnapshot.update({ where: { id: row.id }, data: { downloadedAt: new Date() } });
    return row;
  }

  async remove(id?: string) {
    if (!id) return;
    const row = await this.prisma.previewSourceSnapshot.findUnique({ where: { id } });
    if (!row) return;
    await unlink(row.archivePath).catch(() => undefined);
    await this.prisma.previewSourceSnapshot.update({ where: { id }, data: { status: 'deleted' } }).catch(() => undefined);
  }

  async reapExpired() {
    const rows = await this.prisma.previewSourceSnapshot.findMany({ where: { OR: [{ status: 'ready', expiresAt: { lte: new Date() } }, { status: 'deleted' }] }, take: 100 });
    for (const row of rows) {
      await unlink(row.archivePath).catch(() => undefined);
      await this.prisma.previewSourceSnapshot.delete({ where: { id: row.id } }).catch(() => undefined);
    }
    const orphanDeadline = Date.now() - Math.max(10, Number(this.config.get('PREVIEW_SNAPSHOT_TTL_MINUTES', 120))) * 60_000;
    const files = await readdir(this.root).catch(() => []);
    for (const file of files.filter((name) => /^[a-f0-9]{32}\.tar\.gz$/.test(name))) {
      const path = resolve(this.root, file);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && info.mtimeMs <= orphanDeadline) await unlink(path).catch(() => undefined);
    }
  }
}

function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
function archiveWorkspace(root: string, target: string) {
  return new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
    const archive = createArchive('tar', { gzip: true, gzipOptions: { level: 6 } });
    output.on('close', resolvePromise); output.on('error', reject); archive.on('error', reject);
    archive.pipe(output);
    archive.glob('**/*', { cwd: root, dot: false, follow: false, ignore: ['.git/**', 'node_modules/**', 'dist/**', 'build/**', 'target/**', '.next/**', '.vite/**', '.cache/**', '.venv/**', 'venv/**', '__pycache__/**', '**/*.class', '**/*.pyc', '.aider*'] });
    void archive.finalize();
  });
}
function fileSha256(path: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const hash = createHash('sha256'); const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}
