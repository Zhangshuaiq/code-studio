import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { homedir } from 'os';
import {
  AgentEvent,
  GenerationInput,
  GenerationProvider,
  GenerationResult,
} from './generation-provider';
import { diagnosticMessage, redactDiagnosticText } from '../../common/redact-diagnostic';
import {
  assertWorkspaceWithinLimits,
  WorkspaceQuotaError,
  workspaceLimits,
} from '../../common/workspace-quota';
import { restrictedChildEnvironment } from '../../common/child-process-env';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.vite',
  '.cache',
  'build',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);
const MAX_CONTEXT_FILES = 40;
const RUN_TIMEOUT_MS = 240_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_EVENTS = 10_000;

/**
 * Aider 引擎：真·智能体式增量编辑（有仓库感知、按 diff 改文件）。
 * 以子进程方式在项目卷上运行 aider（无头 --message 模式），接用户 BYOK 的
 * OpenAI 兼容模型（GLM / Qwen / DeepSeek …）。相较 simple-llm 一把梭，
 * 迭代质量更高、能基于现有代码改而非重写。
 */
@Injectable()
export class AiderProvider implements GenerationProvider {
  private readonly logger = new Logger(AiderProvider.name);

  constructor(private readonly config: ConfigService) {}

  private resolveBin(): string {
    const fromEnv = this.config.get<string>('AIDER_BIN');
    if (fromEnv && existsSync(fromEnv)) return fromEnv;
    const candidates = [
      join(homedir(), '.pipx', 'bin', 'aider'),
      join(homedir(), '.local', 'bin', 'aider'),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return 'aider';
  }

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const { prompt, cwd, runtime, credentials, onEvent, signal } = input;
    signal?.throwIfAborted();
    if (!credentials?.baseUrl || !credentials.apiKey || !credentials.model) {
      throw new BadRequestException(
        '未配置模型：请在「设置 · 模型」添加你自己的 API Key（BYOK）',
      );
    }

    const events: AgentEvent[] = [];
    const limits = workspaceLimits((key, fallback) =>
      Number(this.config.get(key, fallback)),
    );
    await assertWorkspaceWithinLimits(cwd, limits);
    let outputBytes = 0;
    let outputTruncated = false;
    const push = (e: AgentEvent) => {
      const safe: AgentEvent = {
        ...e,
        text: redactDiagnosticText(e.text, [credentials.apiKey]),
      };
      if (safe.kind === 'text') {
        if (events.length >= MAX_OUTPUT_EVENTS || outputBytes >= MAX_OUTPUT_BYTES) {
          outputTruncated = true;
          return;
        }
        const encoded = Buffer.from(safe.text || '');
        const remaining = MAX_OUTPUT_BYTES - outputBytes;
        safe.text =
          encoded.length > remaining
            ? encoded.subarray(0, remaining).toString('utf8')
            : safe.text;
        outputBytes += Buffer.byteLength(safe.text || '');
        if (encoded.length > remaining) outputTruncated = true;
      }
      events.push(safe);
      onEvent?.(safe);
    };

    // 现有源码文件（作为 aider 的编辑上下文显式加入）
    const files = await listSourceFiles(cwd);

    // 把 runtime 脚手架规则拼进指令，保证冷启动产物可跑
    const message = [
      prompt,
      '',
      // 弱模型（如 glm-4-flash）常把文件名写成占位 path/to/xxx，这里明确纠正
      'IMPORTANT: Use exact relative file paths from the project root, e.g. `src/App.jsx` or `index.html`. Never use a placeholder prefix like `path/to/`.',
      ...(runtime.scaffoldRules?.length
        ? ['', 'Project rules:', ...runtime.scaffoldRules.map((r) => `- ${r}`)]
        : []),
    ].join('\n');

    const bin = this.resolveBin();
    const args = [
      '--model',
      `openai/${credentials.model}`,
      '--message',
      message,
      '--yes-always',
      '--no-git',
      '--no-check-update',
      '--no-stream',
      '--no-pretty',
      '--no-show-model-warnings',
      '--map-tokens',
      '0',
      '--encoding',
      'utf-8',
      ...files,
    ];

    const env = restrictedChildEnvironment({
      OPENAI_API_BASE: credentials.baseUrl,
      OPENAI_API_KEY: credentials.apiKey,
      // 避免交互/分析上报
      AIDER_ANALYTICS: 'false',
    });

    push({ kind: 'system', text: `aider (${credentials.model}) 启动…` });

    const exitCode = await new Promise<number>((resolveExit) => {
      let done = false;
      let pendingOutput = '';
      let quotaChecking = false;
      let quotaViolation = '';
      const child = spawn(bin, args, { cwd: resolve(cwd), env });
      const abort = () => {
        push({ kind: 'result', text: '任务已中断，正在终止 aider' });
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      };
      signal?.addEventListener('abort', abort, { once: true });

      const timer = setTimeout(() => {
        if (!done) {
          push({ kind: 'result', text: 'aider 超时，已终止' });
          child.kill('SIGKILL');
        }
      }, RUN_TIMEOUT_MS);
      const quotaTimer = setInterval(() => {
        if (done || quotaChecking || quotaViolation) return;
        quotaChecking = true;
        void assertWorkspaceWithinLimits(cwd, limits)
          .catch((error) => {
            if (!(error instanceof WorkspaceQuotaError) || done) return;
            quotaViolation = error.message;
            push({ kind: 'result', text: `aider 已因工作区配额中止: ${quotaViolation}` });
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
          })
          .finally(() => {
            quotaChecking = false;
          });
      }, 1_000);
      quotaTimer.unref();

      const onData = (buf: Buffer) => {
        pendingOutput += buf.toString();
        const lines = pendingOutput.split('\n');
        pendingOutput = lines.pop() || '';
        for (const line of lines) {
          const text = line.trimEnd();
          if (text) push({ kind: 'text', text: text + '\n' });
        }
        if (pendingOutput.length > 128 * 1024) {
          // 先对完整缓冲区脱敏再切块，并保留尾部，避免凭证恰好跨越 stdout chunk。
          const safePending = redactDiagnosticText(
            pendingOutput,
            [credentials.apiKey],
            pendingOutput.length,
          );
          const retainedLength = Math.min(
            Math.max(credentials.apiKey.length, 4 * 1024),
            64 * 1024,
          );
          const splitAt = Math.max(0, safePending.length - retainedLength);
          if (splitAt > 0) push({ kind: 'text', text: safePending.slice(0, splitAt) });
          pendingOutput = safePending.slice(splitAt);
        }
      };
      const flushOutput = () => {
        const text = pendingOutput.trimEnd();
        if (text) push({ kind: 'text', text: text + '\n' });
        pendingOutput = '';
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      child.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(quotaTimer);
        signal?.removeEventListener('abort', abort);
        flushOutput();
        push({ kind: 'result', text: `无法启动 aider: ${diagnosticMessage(err, [credentials.apiKey])}` });
        resolveExit(-1);
      });
      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(quotaTimer);
        signal?.removeEventListener('abort', abort);
        flushOutput();
        resolveExit(quotaViolation ? -1 : (code ?? -1));
      });
    });

    signal?.throwIfAborted();

    if (outputTruncated) push({ kind: 'result', text: 'aider 输出超过平台限制，已截断日志' });

    const isError = exitCode !== 0;
    push({
      kind: 'result',
      text: isError ? `aider 退出码 ${exitCode}` : 'aider 完成',
    });
    return { events, isError };
  }
}

/** 收集项目卷内现有源码文件（相对路径），作为 aider 的编辑对象加入 */
async function listSourceFiles(cwd: string): Promise<string[]> {
  const root = resolve(cwd);
  const out: string[] = [];
  const walk = async (dir: string) => {
    if (out.length >= MAX_CONTEXT_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_CONTEXT_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile()) {
        if (e.name.startsWith('.')) continue; // 跳过 .aider* 等隐藏文件
        const rel = relative(root, full);
        if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(rel))
          continue;
        try {
          const info = await stat(full);
          if (info.size > 40 * 1024) continue;
          await readFile(full, 'utf8'); // 确认可读文本
          out.push(rel);
        } catch {
          /* 跳过 */
        }
      }
    }
  };
  await walk(root);
  return out;
}
