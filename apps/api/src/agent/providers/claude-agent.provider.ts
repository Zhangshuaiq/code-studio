import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentCredentialResolver } from '../credential-resolver';
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
  ) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const { userId, prompt, cwd, runtime, resumeId, onEvent, signal } = input;
    signal?.throwIfAborted();
    const cred = await this.credentials.resolve(userId);

    const childEnv = restrictedChildEnvironment(cred.env);
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
          model: this.config.get<string>('AGENT_MODEL', 'claude-opus-4-8'),
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
          resume: resumeId,
          env: childEnv,
          abortController,
        },
      });

      for await (const message of stream as AsyncIterable<AnyMessage>) {
        // SDK 工具执行发生在消息迭代之间；每次恢复迭代时立即检查其落盘结果。
        await assertWorkspaceWithinLimits(cwd, limits);
        if (message.session_id) contextId = message.session_id;
        switch (message.type) {
          case 'assistant': {
            for (const block of message.message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                push({ kind: 'text', text: block.text });
              } else if (block.type === 'tool_use') {
                push({
                  kind: 'tool_use',
                  toolName: block.name,
                  toolInput: block.input,
                });
              }
            }
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
  const base = `你是一个代码项目生成助手。目标：在当前工作目录（已挂载为容器 /workspace）中生成或修改「${runtime.displayName}」项目。只做用户要求的改动，保持结构清晰、可运行。`;
  if (runtime.category === 'frontend') {
    return `${base}
- 这是一个前端项目，生成后会用 dev server 实时预览。
- 使用标准 Vite + React 结构（package.json、vite.config、src/、index.html）。
- 确保 "npm install && npm run dev" 能启动，页面能在浏览器打开。
- 依赖尽量精简、用主流稳定版本，避免冷启动装包过慢。`;
  }
  if (runtime.category === 'backend') {
    return `${base}
- 使用标准 Maven 目录结构（src/main/java、src/main/resources、pom.xml）。
- 生成的代码要能通过 "${runtime.buildCommand}" 编译。`;
  }
  return base;
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
