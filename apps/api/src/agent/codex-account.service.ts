import { BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { restrictedChildEnvironment } from '../common/child-process-env';
import { AgentRuntimeStateService } from './agent-runtime-state.service';

const DEVICE_URL = /https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[\w/?=&.%-]+/i;
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/i;

/** Codex 登录态按平台用户隔离，存放于 API 和 Agent Worker 共用的状态卷。 */
@Injectable()
export class CodexAccountService implements OnModuleDestroy {
  private readonly pending = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly state: AgentRuntimeStateService) {}

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
      const timeout = setTimeout(() => fail('Codex 未返回设备码，请检查 API 网络及设备码登录权限'), 20_000);
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
        const verificationUrl = output.match(DEVICE_URL)?.[0];
        const userCode = output.match(DEVICE_CODE)?.[0];
        if (!settled && verificationUrl && userCode) {
          settled = true;
          clearTimeout(timeout);
          resolve({ verificationUrl, userCode });
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', () => fail('Codex 登录程序无法启动'));
      child.on('exit', (code) => {
        clearTimeout(loginExpiry);
        this.pending.delete(userId);
        if (!settled) fail(code === 0 ? 'Codex 已退出，未返回设备码' : 'Codex 登录未能启动，请确认设备码登录已启用');
      });
    });
  }

  async disconnect(userId: string): Promise<{ connected: false }> {
    this.pending.get(userId)?.kill();
    this.pending.delete(userId);
    const home = await this.state.home(userId, 'codex');
    const result = await this.run(['logout'], home, 10_000);
    if (result.code !== 0) throw new BadRequestException('Codex 退出登录失败');
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
