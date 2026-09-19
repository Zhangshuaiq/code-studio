import { BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { restrictedChildEnvironment } from '../common/child-process-env';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRuntimeStateService } from './agent-runtime-state.service';

const DEVICE_URL = /https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[\w/?=&.%-]+/i;
const DEVICE_CODE = /(?:^|\s)([A-Z0-9]{4,8}-[A-Z0-9]{4,8})(?=\s|$)/m;
const HOST_BINDING_KEY = 'codex.host-login.binding';

/** CLI 输出可能带 ANSI 颜色码，设备码长度也会随 CLI 版本变化。 */
export function parseCodexDeviceInstructions(output: string) {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const verificationUrl = plain.match(DEVICE_URL)?.[0];
  const userCode = plain.match(DEVICE_CODE)?.[1];
  return verificationUrl && userCode ? { verificationUrl, userCode } : null;
}

function loginFailureMessage(output: string) {
  if (/error sending request|dns|network|connection|timed out/i.test(output)) {
    return 'Codex 无法连接 OpenAI 登录服务，请检查平台服务端到 auth.openai.com 的 HTTPS 网络';
  }
  if (/device.?auth.*(?:disabled|not enabled)|enable.*device/i.test(output)) {
    return 'Codex 设备码登录未启用，请检查个人安全设置或企业空间权限';
  }
  return 'Codex 登录未返回设备码，请检查平台服务日志及设备码登录权限';
}

/** Codex 登录态按平台用户隔离，存放于 API 和 Agent Worker 共用的状态卷。 */
@Injectable()
export class CodexAccountService implements OnModuleDestroy {
  private readonly pending = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly state: AgentRuntimeStateService, private readonly prisma: PrismaService) {}

  /** 只检查 API 所在机器的文件型登录态；绝不把凭证返回给浏览器。 */
  async hostLoginStatus(): Promise<{ detected: boolean; bindable: boolean }> {
    const home = join(homedir(), '.codex');
    const authFile = join(home, 'auth.json');
    let safeFile = false;
    try {
      const info = await lstat(authFile);
      safeFile = info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.size <= 1024 * 1024;
    } catch { /* 没有可导入的文件 */ }
    if (!safeFile) return { detected: false, bindable: false };
    const result = await this.run(['login', 'status'], home, 10_000);
    const detected = result.code === 0 && /(?:^|\n)Logged in\b/i.test(result.output);
    return { detected, bindable: detected };
  }

  /** 只能由当前用户显式调用；一个部署环境的机器登录态只允许绑定给一个平台用户。 */
  async bindHostLogin(userId: string): Promise<{ connected: boolean }> {
    if ((await this.status(userId)).connected) return { connected: true };
    if (!(await this.hostLoginStatus()).bindable) {
      throw new BadRequestException('部署机器没有可绑定的 Codex 文件型登录态，请使用个人账号登录');
    }
    const owner = await this.prisma.systemSetting.findUnique({ where: { key: HOST_BINDING_KEY } });
    if (owner && owner.updatedById !== userId) {
      throw new BadRequestException('部署机器的 Codex 登录态已绑定其他平台用户，请使用自己的账号登录');
    }
    let claimed = false;
    if (!owner) {
      try {
        await this.prisma.systemSetting.create({ data: {
          key: HOST_BINDING_KEY, value: { source: 'server-codex-cli' }, updatedById: userId,
        } });
        claimed = true;
      } catch {
        throw new BadRequestException('部署机器的 Codex 登录态已由其他用户绑定，请使用自己的账号登录');
      }
    }
    const source = join(homedir(), '.codex', 'auth.json');
    const target = join(await this.state.home(userId, 'codex'), 'auth.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    let installed = false;
    try {
      const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let credentials: Buffer;
      try {
        const info = await input.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) {
          throw new BadRequestException('部署机器的 Codex 凭证文件不安全，无法绑定');
        }
        credentials = await input.readFile();
      } finally { await input.close(); }
      try {
        await lstat(target);
        throw new BadRequestException('当前用户已有 Codex 登录文件，请先退出登录再绑定服务器账号');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await output.writeFile(credentials); await output.sync(); } finally { await output.close(); }
      await rename(temporary, target);
      installed = true;
      if (!(await this.status(userId)).connected) throw new BadRequestException('Codex 登录态绑定后校验失败');
      return { connected: true };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (installed) await unlink(target).catch(() => undefined);
      if (claimed) await this.prisma.systemSetting.deleteMany({ where: { key: HOST_BINDING_KEY, updatedById: userId } });
      throw error;
    }
  }

  async status(userId: string): Promise<{ connected: boolean }> {
    const home = await this.state.home(userId, 'codex');
    // Codex CLI 的状态检查同时支持文件和系统凭证库；不读取或返回凭证内容。
    const result = await this.run(['login', 'status'], home, 10_000);
    return { connected: result.code === 0 && /(?:^|\n)Logged in\b/i.test(result.output) };
  }

  async assertConnected(userId: string): Promise<void> {
    if (!(await this.status(userId)).connected) {
      throw new BadRequestException('Codex 账号尚未连接，请先到「设置 · 模型」使用自己的账号登录');
    }
  }

  async beginLogin(userId: string): Promise<{ verificationUrl: string; userCode: string }> {
    if (this.pending.has(userId)) {
      throw new BadRequestException('Codex 登录已在进行中，请完成当前设备码验证');
    }
    const home = await this.state.home(userId, 'codex');
    const child = this.spawnCli(['login', '--device-auth'], home);
    this.pending.set(userId, child);
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const timeout = setTimeout(() => fail(loginFailureMessage(output)), 30_000);
      const loginExpiry = setTimeout(() => child.kill(), 10 * 60_000);
      loginExpiry.unref();
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(loginExpiry);
        child.kill();
        this.pending.delete(userId);
        reject(new BadRequestException(message));
      };
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-4096);
        const instructions = parseCodexDeviceInstructions(output);
        if (!settled && instructions) {
          settled = true;
          clearTimeout(timeout);
          resolve(instructions);
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', () => fail('Codex 登录程序无法启动'));
      child.on('exit', (code) => {
        clearTimeout(loginExpiry);
        this.pending.delete(userId);
        if (!settled) fail(code === 0 ? 'Codex 已退出，未返回设备码' : loginFailureMessage(output));
      });
    });
  }

  async disconnect(userId: string): Promise<{ connected: false }> {
    this.pending.get(userId)?.kill();
    this.pending.delete(userId);
    const home = await this.state.home(userId, 'codex');
    const result = await this.run(['logout'], home, 10_000);
    if (result.code !== 0) throw new BadRequestException('Codex 退出登录失败');
    await this.prisma.systemSetting.deleteMany({ where: { key: HOST_BINDING_KEY, updatedById: userId } });
    return { connected: false };
  }

  onModuleDestroy() {
    for (const child of this.pending.values()) child.kill();
    this.pending.clear();
  }

  private spawnCli(args: string[], home: string): ChildProcessWithoutNullStreams {
    const cli = require.resolve('@openai/codex/bin/codex.js');
    if (!existsSync(cli)) throw new BadRequestException('Codex 执行程序不可用');
    return spawn(process.execPath, [cli, '-c', 'cli_auth_credentials_store="file"', ...args], {
      env: restrictedChildEnvironment({ CODEX_HOME: home }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  private async run(args: string[], home: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = this.spawnCli(args, home);
      let output = '';
      const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-2048); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timeout = setTimeout(() => child.kill(), timeoutMs);
      child.on('error', () => { clearTimeout(timeout); resolve({ code: null, output: '' }); });
      child.on('exit', (code) => { clearTimeout(timeout); resolve({ code, output }); });
    });
  }
}
