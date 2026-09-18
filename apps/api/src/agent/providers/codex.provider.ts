import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Codex as CodexClient, ThreadEvent } from '@openai/codex-sdk';
import { restrictedChildEnvironment } from '../../common/child-process-env';
import { diagnosticMessage, redactDiagnosticText } from '../../common/redact-diagnostic';
import { assertWorkspaceWithinLimits, workspaceLimits } from '../../common/workspace-quota';
import { AgentEvent, GenerationInput, GenerationProvider, GenerationResult } from './generation-provider';
import { AgentRuntimeStateService } from '../agent-runtime-state.service';

// API 使用 CommonJS 构建；Codex SDK 只发布 ESM，因此保留原生动态 import。
const importCodex = new Function('return import("@openai/codex-sdk")') as
  () => Promise<{ Codex: typeof CodexClient }>;

@Injectable()
export class CodexProvider implements GenerationProvider {
  constructor(private readonly config: ConfigService, private readonly state: AgentRuntimeStateService) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const { prompt, cwd, resumeId, onEvent, signal } = input;
    signal?.throwIfAborted();
    const limits = workspaceLimits((key, fallback) => Number(this.config.get(key, fallback)));
    await assertWorkspaceWithinLimits(cwd, limits);
    if (!input.credentials?.apiKey) throw new Error('请先配置个人 OpenAI API Key');
    const secrets: string[] = [input.credentials.apiKey];
    const events: AgentEvent[] = [];
    const push = (event: AgentEvent) => {
      const safe = { ...event, text: redactDiagnosticText(event.text, secrets) };
      events.push(safe);
      onEvent?.(safe);
    };

    const { Codex } = await importCodex();
    const codexHome = await this.state.home(input.userId, 'codex-api');
    const env = restrictedChildEnvironment({
      CODEX_HOME: codexHome,
    });
    const codex = new Codex({ apiKey: input.credentials.apiKey, env: env as Record<string, string>, config: { cli_auth_credentials_store: 'ephemeral' } });
    const options = {
      workingDirectory: cwd,
      model: input.credentials.model,
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      networkAccessEnabled: false,
    };
    const thread = resumeId ? codex.resumeThread(resumeId, options) : codex.startThread(options);
    let contextId = resumeId;
    let isError = false;
    let hasAnswer = false;
    try {
      const stream = await thread.runStreamed(prompt, { signal });
      for await (const event of stream.events) {
        signal?.throwIfAborted();
        if (event.type === 'thread.started') contextId = event.thread_id;
        else if (event.type === 'item.completed') {
          await assertWorkspaceWithinLimits(cwd, limits);
          this.forwardItem(event, push);
          if (event.item.type === 'agent_message') hasAnswer = true;
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
