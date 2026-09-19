import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentCredentialResolver } from '../credential-resolver';
import { AgentRuntimeStateService } from '../agent-runtime-state.service';
import type { ProjectRuntime } from '../../sandbox/language-runtime';
import { isAbsolute, relative, resolve } from 'path';
import {
  AgentEvent,
  GenerationInput,
  GenerationProvider,
  GenerationResult,
} from './generation-provider';
import { diagnosticMessage, redactDiagnosticText } from '../../common/redact-diagnostic';
import {
  assertWorkspaceWithinLimits,
  assertNoSymlinkPath,
  editableRelativePath,
  workspaceLimits,
} from '../../common/workspace-quota';
import { restrictedChildEnvironment } from '../../common/child-process-env';

@Injectable()
export class ClaudeAgentProvider implements GenerationProvider {
  private readonly logger = new Logger(ClaudeAgentProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly credentials: AgentCredentialResolver,
    private readonly state: AgentRuntimeStateService,
  ) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const { userId, prompt, cwd, runtime, resumeId, onEvent, signal } = input;
    signal?.throwIfAborted();
    const apiAgent = ['claude-code', 'deepseek-agent', 'glm-agent'].includes(input.credentials?.engine || '');
    const cred = apiAgent
      ? { env: {
          ...(input.credentials!.engine === 'glm-agent' || input.credentials!.engine === 'claude-code'
            ? { ANTHROPIC_API_KEY: input.credentials!.apiKey }
            : { ANTHROPIC_AUTH_TOKEN: input.credentials!.apiKey }),
          ANTHROPIC_BASE_URL: input.credentials!.baseUrl,
        }, source: 'user' as const }
      : await this.credentials.resolve(userId);

    const localHostLogin = this.config.get<string>('AGENT_USE_HOST_LOGIN') === 'true' &&
      this.config.get<string>('NODE_ENV') !== 'production';
    const stateTool = input.credentials?.engine === 'deepseek-agent' ? 'deepseek-api'
      : input.credentials?.engine === 'glm-agent' ? 'glm-api' : apiAgent ? 'claude-api' : 'claude';
    const configDir = localHostLogin && !apiAgent ? undefined : await this.state.home(userId, stateTool);
    const childEnv = restrictedChildEnvironment({ ...cred.env, CLAUDE_CONFIG_DIR: configDir });
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      if (!childEnv[k]) delete childEnv[k];
    }

    const events: AgentEvent[] = [];
    const secrets = Object.entries(childEnv)
      .filter(([key, value]) =>
        Boolean(value) && /(api[_-]?key|token|secret|password)/i.test(key),
      )
      .map(([, value]) => value);
    const push = (e: AgentEvent) => {
      const safe: AgentEvent = {
        ...e,
        text: redactDiagnosticText(e.text, secrets),
      };
      events.push(safe);
      onEvent?.(safe);
    };

    let contextId = resumeId;
    let isError = false;
    const limits = workspaceLimits((key, fallback) =>
      Number(this.config.get(key, fallback)),
    );
    await assertWorkspaceWithinLimits(cwd, limits);
    const abortController = new AbortController();
    const abort = () => abortController.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const stream = query({
        prompt,
        options: {
          cwd,
          model: apiAgent ? input.credentials!.model : this.config.get<string>('AGENT_MODEL', 'claude-opus-4-8'),
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: buildSystemAppend(runtime),
          },
          // 仅开放仓库读写工具；构建由后续受控执行器负责，Agent 不得直接运行 Shell/联网。
          tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
          permissionMode: 'default',
          canUseTool: async (toolName, toolInput) => {
            if (!['Read', 'Edit', 'Write', 'Glob', 'Grep'].includes(toolName)) {
              return { behavior: 'deny', message: '平台未授权该工具', interrupt: true };
            }
            const rawPath = toolInput.file_path ?? toolInput.path;
            if (rawPath == null && ['Glob', 'Grep'].includes(toolName)) {
              return { behavior: 'allow', updatedInput: toolInput };
            }
            if (typeof rawPath !== 'string') {
              return { behavior: 'deny', message: '工具缺少有效的工作区文件路径', interrupt: true };
            }
            try {
              const candidate = isAbsolute(rawPath)
                ? relative(resolve(cwd), resolve(rawPath))
                : rawPath;
              if (['Glob', 'Grep'].includes(toolName) && (!candidate || candidate === '.')) {
                return { behavior: 'allow', updatedInput: toolInput };
              }
              const normalized = editableRelativePath(cwd, candidate);
              await assertNoSymlinkPath(cwd, normalized);
              return { behavior: 'allow', updatedInput: toolInput };
            } catch {
              return { behavior: 'deny', message: '只允许访问项目工作区内的源码文件', interrupt: true };
            }
          },
          disallowedTools: ['Bash', 'WebFetch', 'WebSearch', 'NotebookEdit'],
          settingSources: [],
          strictMcpConfig: true,
          maxTurns: Number(this.config.get('AGENT_MAX_TURNS', 30)),
          includePartialMessages: true,
          resume: resumeId,
          env: childEnv,
          abortController,
        },
      });

      let pendingPartialText = '';
      for await (const message of stream as AsyncIterable<AnyMessage>) {
        // SDK 工具执行发生在消息迭代之间；每次恢复迭代时立即检查其落盘结果。
        await assertWorkspaceWithinLimits(cwd, limits);
        if (message.session_id) contextId = message.session_id;
        switch (message.type) {
          case 'stream_event': {
            const delta = (message as AnyMessage & { event?: { type?: string; delta?: { type?: string; text?: string } } }).event?.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              pendingPartialText += delta.text;
              push({ kind: 'text', text: delta.text });
            }
            break;
          }
          case 'assistant': {
            for (const block of message.message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                if (!pendingPartialText) push({ kind: 'text', text: block.text });
                else if (block.text.startsWith(pendingPartialText)) {
                  const remainder = block.text.slice(pendingPartialText.length);
                  if (remainder) push({ kind: 'text', text: remainder });
                }
              } else if (block.type === 'tool_use') {
                push({
                  kind: 'tool_use',
                  toolName: block.name,
                  toolInput: block.input,
                });
              }
            }
            pendingPartialText = '';
            break;
          }
          case 'result':
            isError = message.is_error === true;
            push({ kind: 'result', text: message.result });
            break;
          case 'system':
            push({ kind: 'system', text: message.subtype });
            break;
        }
      }
      await assertWorkspaceWithinLimits(cwd, limits);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      isError = true;
      const message = diagnosticMessage(err, secrets);
      push({ kind: 'result', text: `Agent 执行异常: ${message}` });
      this.logger.error(`Claude Agent 失败: ${message}`);
    } finally {
      signal?.removeEventListener('abort', abort);
    }

    return { events, isError, contextId };
  }
}

function buildSystemAppend(runtime: ProjectRuntime): string {
  return `你是代码项目助手。项目登记的运行类型是「${runtime.displayName}」，但实际仓库可能包含多个语言和子项目。先读取当前工作目录的文件结构及已有构建清单，再按用户需求修改。尊重现有子项目目录和工具链；不要因为根目录缺少某种清单就自行添加模板、迁移结构或改写无关文件。只有用户明确要求新建项目或确实需要某个文件来完成本次任务时，才新增该文件。`;
}

// Agent SDK 消息的最小结构
interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}
interface AnyMessage {
  type: 'assistant' | 'result' | 'system' | 'user' | string;
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: ContentBlock[] };
}
