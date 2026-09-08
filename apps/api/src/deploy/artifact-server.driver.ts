import { createHash, timingSafeEqual } from 'crypto';
import { basename, posix } from 'path';
import { Client, ClientChannel, SFTPWrapper, Stats } from 'ssh2';
import { diagnosticMessage, redactDiagnosticText } from '../common/redact-diagnostic';

export interface ArtifactServerConfig {
  host: string;
  port?: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  remotePath: string;
  restartCmd?: string;
  hostFingerprint?: string;
}

export interface ArtifactUploadResult {
  remoteFile: string;
  restartOutput: string;
}

/**
 * 通过 SSH/SFTP 把构建产物原子上传到普通服务器。
 * 文件会先传到同目录临时文件，传输完成后再 mv 覆盖正式文件，避免半包可见。
 */
export class ArtifactServerDriver {
  constructor(private readonly config: ArtifactServerConfig) {}

  async upload(
    localFile: string,
    onProgress?: (transferred: number, total: number) => void,
  ): Promise<ArtifactUploadResult> {
    const remoteDir = normalizeRemoteDirectory(this.config.remotePath);
    const remoteFile = posix.join(remoteDir, basename(localFile));
    const tempFile = posix.join(
      remoteDir,
      `.${basename(localFile)}.upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    );
    const client = await this.connect().catch((error) => { throw new Error(diagnosticMessage(error, [this.config.privateKey, this.config.passphrase], 'SSH 连接失败')); });

    try {
      try {
        const sftp = await openSftp(client);
        try {
          await ensureRemoteDirectory(sftp, remoteDir);
          await fastPut(sftp, localFile, tempFile, onProgress);
        } finally {
          sftp.end();
        }

        // SFTP rename 在部分服务端不能覆盖已有文件，统一由远端 mv 做原子替换。
        await execRemote(
          client,
          `mv -f -- ${shellQuote(tempFile)} ${shellQuote(remoteFile)}`,
        );

        let restartOutput = '';
        const restartCmd = this.config.restartCmd?.trim();
        if (restartCmd) {
          const command = restartCmd
            .replaceAll('{artifact}', shellQuote(remoteFile))
            .replaceAll('{directory}', shellQuote(remoteDir));
          restartOutput = redactDiagnosticText(await execRemote(client, command), [this.config.privateKey, this.config.passphrase]);
        }

        return { remoteFile, restartOutput };
      } catch (error) {
        await removeRemoteFile(client, tempFile);
        throw new Error(diagnosticMessage(error, [this.config.privateKey, this.config.passphrase], 'SSH/SFTP 操作失败'));
      }
    } finally {
      client.end();
    }
  }

  private connect(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        client.destroy();
        reject(new Error(`SSH 连接失败：${error.message}`));
      };

      client.once('ready', () => {
        settled = true;
        resolve(client);
      });
      client.once('error', fail);
      client.connect({
        host: this.config.host,
        port: Number(this.config.port) || 22,
        username: this.config.username,
        privateKey: this.config.privateKey,
        ...(this.config.passphrase
          ? { passphrase: this.config.passphrase }
          : {}),
        readyTimeout: 15_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        ...(this.config.hostFingerprint
          ? {
              hostVerifier: (key: Buffer) =>
                verifyFingerprint(key, this.config.hostFingerprint!),
            }
          : {}),
      });
    });
  }
}

function normalizeRemoteDirectory(path: string): string {
  const value = String(path || '').trim();
  if (!value.startsWith('/')) {
    throw new Error('目标目录必须是绝对路径，例如 /opt/apps/demo');
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('目标目录包含非法字符');
  }
  const normalized = posix.normalize(value);
  if (normalized === '/') {
    throw new Error('目标目录不能是服务器根目录 /');
  }
  return normalized;
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(new Error(`无法打开 SFTP：${error.message}`));
      else resolve(sftp);
    });
  });
}

async function ensureRemoteDirectory(
  sftp: SFTPWrapper,
  directory: string,
): Promise<void> {
  const segments = directory.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    const exists = await sftpStat(sftp, current);
    if (exists) {
      if (!exists.isDirectory())
        throw new Error(`远端路径不是目录：${current}`);
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(current, { mode: 0o755 }, (error) => {
        if (error)
          reject(new Error(`无法创建远端目录 ${current}：${error.message}`));
        else resolve();
      });
    });
  }
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, stats) => {
      if (!error) return resolve(stats);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === '2') return resolve(null);
      // ssh2 的 SFTP 错误在不同服务端可能只有数值 code。
      if ((error as unknown as { code?: number }).code === 2)
        return resolve(null);
      reject(new Error(`无法检查远端目录 ${path}：${error.message}`));
    });
  });
}

function fastPut(
  sftp: SFTPWrapper,
  localFile: string,
  remoteFile: string,
  onProgress?: (transferred: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(
      localFile,
      remoteFile,
      {
        concurrency: 32,
        chunkSize: 64 * 1024,
        mode: 0o644,
        step: (total, _chunk, fileSize) => onProgress?.(total, fileSize),
      },
      (error) => {
        if (error) reject(new Error(`上传产物失败：${error.message}`));
        else resolve();
      },
    );
  });
}

async function removeRemoteFile(client: Client, path: string): Promise<void> {
  const sftp = await openSftp(client).catch(() => null);
  if (!sftp) return;
  try {
    await new Promise<void>((resolve) => {
      sftp.unlink(path, () => resolve());
    });
  } finally {
    sftp.end();
  }
}

function execRemote(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(new Error(`执行远端命令失败：${error.message}`));
      collectCommandResult(stream).then(resolve, reject);
    });
  });
}

function collectCommandResult(stream: ClientChannel): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let exitCode: number | null = null;
    const append = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-8_000);
    };
    stream.on('data', append);
    stream.stderr.on('data', append);
    stream.on('exit', (code: number | null) => {
      exitCode = code;
    });
    stream.once('error', reject);
    stream.once('close', () => {
      if (exitCode === null || exitCode === 0) return resolve(output.trim());
      reject(
        new Error(
          `远端命令退出码 ${exitCode}${output.trim() ? `：${output.trim()}` : ''}`,
        ),
      );
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function verifyFingerprint(key: Buffer, expected: string): boolean {
  const actual = createHash('sha256').update(key).digest('base64');
  const normalized = expected
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
  const actualBuffer = Buffer.from(actual.replace(/=+$/, ''));
  const expectedBuffer = Buffer.from(normalized);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
