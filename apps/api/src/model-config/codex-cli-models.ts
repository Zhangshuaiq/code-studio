import { BadRequestException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { restrictedChildEnvironment } from '../common/child-process-env';

type RpcReply = { id?: number; result?: { data?: Array<{ model?: string; displayName?: string; isDefault?: boolean }>; nextCursor?: string | null; config?: { model?: string } }; error?: { message?: string } };

export interface CodexCliModelCatalog {
  models: Array<{ id: string; name: string; isDefault?: boolean }>;
  defaultModel: string | null;
}

/** The Codex app-server is the CLI's own model source, scoped to this user's CODEX_HOME. */
export async function listCodexCliModels(home: string): Promise<CodexCliModelCatalog> {
  const cli = require.resolve('@openai/codex/bin/codex.js');
  const child = spawn(process.execPath, [cli, '-c', 'cli_auth_credentials_store="file"', 'app-server'], {
    env: restrictedChildEnvironment({ CODEX_HOME: home }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const models = new Map<string, { id: string; name: string; isDefault?: boolean }>();
    let buffer = '';
    let requestId = 1;
    let pageCount = 0;
    let readingConfig = false;
    let configuredModel: string | undefined;
    let settled = false;
    const timeout = setTimeout(() => finish(new BadRequestException('Codex 模型列表读取超时，请稍后重试')), 12_000);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else {
        const ordered = [...models.values()].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
        resolve({ models: ordered, defaultModel: configuredModel || ordered.find((item) => item.isDefault)?.id || null });
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1_000_000) return finish(new BadRequestException('Codex 模型列表响应过大'));
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let reply: RpcReply;
        try { reply = JSON.parse(line); } catch { continue; }
        if (reply.id === 1) {
          if (reply.error) return finish(new BadRequestException('Codex 模型服务初始化失败'));
          send({ method: 'initialized' });
          send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false } });
        } else if (reply.id === requestId && readingConfig) {
          const model = reply.result?.config?.model;
          if (typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) configuredModel = model;
          finish();
        } else if (reply.id === requestId && requestId > 1) {
          if (reply.error) return finish(new BadRequestException('Codex 模型列表读取失败'));
          for (const item of reply.result?.data ?? []) {
            if (!item.model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(item.model)) continue;
            models.set(item.model, { id: item.model, name: item.displayName || item.model, isDefault: item.isDefault });
          }
          pageCount += 1;
          if (reply.result?.nextCursor && pageCount < 5) {
            send({ id: ++requestId, method: 'model/list', params: { cursor: reply.result.nextCursor, limit: 100, includeHidden: false } });
          } else {
            readingConfig = true;
            send({ id: ++requestId, method: 'config/read', params: { includeLayers: false } });
          }
        }
      }
    });
    child.on('error', () => finish(new BadRequestException('Codex 模型服务无法启动')));
    child.on('exit', () => finish(new BadRequestException('Codex 模型服务提前退出')));
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'code-generator', version: '1.0.0' } } });
  });
}
