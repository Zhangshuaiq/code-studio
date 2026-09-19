import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Codex as CodexClient, ThreadEvent } from '@openai/codex-sdk';
import { restrictedChildEnvironment } from '../../common/child-process-env';
import { diagnosticMessage, redactDiagnosticText } from '../../common/redact-diagnostic';
import { assertWorkspaceWithinLimits, workspaceLimits } from '../../common/workspace-quota';
import { AgentEvent, GenerationInput, GenerationProvider, GenerationResult } from './generation-provider';
import { AgentRuntimeStateService } from '../agent-runtime-state.service';
import { CodexAccountService } from '../codex-account.service';

// API 使用 CommonJS 构建；Codex SDK 只发布 ESM，因此保留原生动态 import。
const importCodex = new Function('return import("@openai/codex-sdk")') as
  () => Promise<{ Codex: typeof CodexClient }>;

@Injectable()
export class CodexProvider implements GenerationProvider {
  constructor(
    private readonly config: ConfigService,
    private readonly state: AgentRuntimeStateService,
    private readonly accounts: CodexAccountService,
  ) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const { prompt, cwd, resumeId, onEvent, signal } = input;
    signal?.throwIfAborted();
    const limits = workspaceLimits((key, fallback) => Number(this.config.get(key, fallback)));
    await assertWorkspaceWithinLimits(cwd, limits);
    const cliLogin = input.credentials?.engine === 'codex-cli';
    if (!cliLogin && !input.credentials?.apiKey) throw new Error('请先配置个人 OpenAI API Key');
    if (cliLogin) await this.accounts.assertConnected(input.userId);
    const secrets: string[] = input.credentials?.apiKey ? [input.credentials.apiKey] : [];
    const events: AgentEvent[] = [];
    const push = (event: AgentEvent) => {
      const safe = { ...event, text: redactDiagnosticText(event.text, secrets) };
      events.push(safe);
      onEvent?.(safe);
    };

    const { Codex } = await importCodex();
    const codexHome = await this.state.home(input.userId, cliLogin ? 'codex' : 'codex-api');
    const env = restrictedChildEnvironment({
      CODEX_HOME: codexHome,
    });
    const codex = new Codex({
      ...(cliLogin ? {} : { apiKey: input.credentials!.apiKey }),
      env: env as Record<string, string>,
      config: { cli_auth_credentials_store: cliLogin ? 'file' : 'ephemeral' },
    });
    const options = {
      workingDirectory: cwd,
      model: input.credentials?.model || undefined,
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      networkAccessEnabled: false,
    };
    const thread = resumeId ? codex.resumeThread(resumeId, options) : codex.startThread(options);
    let contextId = resumeId;
    let isError = false;
    let hasAnswer = false;
    const streamedMessages = new Map<string, string>();
    const forwardMessage = (item: { id: string; type: 'agent_message'; text: string }) => {
      const previous = streamedMessages.get(item.id) ?? '';
      // SDK 的 item.updated.text 是当前完整快照，向前端只发送新增部分。
      if (item.text.startsWith(previous)) {
        const delta = item.text.slice(previous.length);
        if (delta) push({ kind: 'text', text: delta });
      } else if (item.text !== previous) {
        push({ kind: 'text', text: item.text });
      }
      streamedMessages.set(item.id, item.text);
      hasAnswer = true;
    };
    try {
      const stream = await thread.runStreamed(prompt, { signal });
      for await (const event of stream.events) {
        signal?.throwIfAborted();
        if (event.type === 'thread.started') contextId = event.thread_id;
        else if (event.type === 'item.updated' && event.item.type === 'agent_message') {
          forwardMessage(event.item);
        } else if (event.type === 'item.completed') {
          await assertWorkspaceWithinLimits(cwd, limits);
          if (event.item.type === 'agent_message') forwardMessage(event.item);
          else this.forwardItem(event, push);
        } else if (event.type === 'turn.failed' || event.type === 'error') {
          isError = true;
          push({ kind: 'result', text: event.type === 'error' ? event.message : event.error.message });
        }
      }
      await assertWorkspaceWithinLimits(cwd, limits);
      if (!isError && !hasAnswer) push({ kind: 'result', text: 'Codex 已完成，但没有返回文本。' });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      isError = true;
      push({ kind: 'result', text: `Codex 执行失败: ${diagnosticMessage(error, secrets)}` });
    }
    return { events, isError, contextId };
  }

  private forwardItem(event: Extract<ThreadEvent, { type: 'item.completed' }>, push: (event: AgentEvent) => void) {
    const item = event.item;
    if (item.type === 'agent_message') push({ kind: 'text', text: item.text });
    else if (item.type === 'file_change') push({ kind: 'tool_use', toolName: '文件修改', toolInput: item.changes });
    else if (item.type === 'command_execution') push({ kind: 'tool_use', toolName: '命令执行', toolInput: item.command });
    else if (item.type === 'error') push({ kind: 'system', text: item.message });
  }
}
