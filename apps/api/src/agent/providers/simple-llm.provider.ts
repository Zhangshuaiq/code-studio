import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import {
  AgentEvent,
  GenerationInput,
  GenerationProvider,
  GenerationResult,
} from './generation-provider';
import {
  diagnosticMessage,
  redactDiagnosticText,
  redactExplicitSecrets,
} from '../../common/redact-diagnostic';
import {
  assertWorkspaceChanges,
  editableRelativePath,
  workspaceLimits,
} from '../../common/workspace-quota';

interface GenFile {
  path: string;
  content: string;
}

// 模型有时会把 prompt 里的占位路径当真写出来，过滤掉
function isPlaceholderPath(p: string): boolean {
  return (
    /[<>]/.test(p) ||
    /^(relative\/path|next\/path|your\/|example\/)/i.test(p) ||
    /(^|\/)path\/to\//i.test(p)
  );
}

// 读现有项目文件时忽略的目录（体积大/无编辑意义）
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
// 喂给模型的现有代码上下文预算，避免弱模型上下文超限
const MAX_CONTEXT_FILES = 40;
const MAX_FILE_BYTES = 40 * 1024;
const MAX_CONTEXT_BYTES = 80 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * 免费平替：调任意 OpenAI 兼容 API（Groq / Gemini / OpenRouter 等），
 * 让模型一次性吐出项目文件（JSON），我们写盘。用于免付费走通「对话→生成→预览」流程。
 * 不具备 Claude Agent 的多步工具调用，只做一把梭生成。
 */
@Injectable()
export class SimpleLlmProvider implements GenerationProvider {
  private readonly logger = new Logger(SimpleLlmProvider.name);

  constructor(private readonly config: ConfigService) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const { prompt, cwd, runtime, credentials, onEvent, signal } = input;
    signal?.throwIfAborted();
    // 优先用每用户 BYOK 凭证；无则回退 .env（本地调试用）
    const baseURL = credentials?.baseUrl ?? this.config.get<string>('LLM_BASE_URL');
    const apiKey = credentials?.apiKey ?? this.config.get<string>('LLM_API_KEY');
    const model = credentials?.model ?? this.config.get<string>('LLM_MODEL');
    if (!baseURL || !apiKey || !model) {
      throw new BadRequestException(
        '未配置模型：请在「设置 · 模型」添加你自己的 API Key（BYOK）',
      );
    }

    const events: AgentEvent[] = [];
    const push = (e: AgentEvent) => {
      const safe: AgentEvent = {
        ...e,
        text: redactDiagnosticText(e.text, [apiKey]),
      };
      events.push(safe);
      onEvent?.(safe);
    };

    // 读现有项目文件：非空 => 迭代模式（在现状上改）；空 => 冷启动（整套生成）
    const existing = await readProjectFiles(cwd);
    const iterating = existing.length > 0;

    const system = [
      iterating
        ? `You are a coding assistant editing an existing, runnable "${runtime.displayName}" project. Apply the user's requested change to the CURRENT project shown below.`
        : `You are a coding assistant generating a complete, runnable "${runtime.displayName}" project based on the user's request.`,
      // 先分析后代码：便于在会话里流式展示"分析 + 进度"，不生硬
      `First write 1-3 short sentences in Chinese explaining what the user wants and your plan. This is shown to the user as live progress, so keep it natural and concise.`,
      // 用分隔符格式而非 JSON：文件内容原样输出、无需转义，弱模型也不会写坏
      `Then output each file with a marker line "@@FILE: <the real relative path>@@" followed by that file's raw content. For example:`,
      `@@FILE: src/App.jsx@@`,
      `import React from 'react'\n// ...real file content...`,
      `Rules: replace <the real relative path> with the ACTUAL path (e.g. src/App.jsx, index.html) — NEVER output literal placeholders like "relative/path", "next/path" or "path/to/...". Put each marker on its own line; write raw content right after it; NO markdown code fences; do NOT escape quotes or newlines; never write "@@FILE" except as a real marker line; end right after the last file's content.`,
      iterating
        ? `Output ONLY the files you add or modify (full content each). Do NOT include unchanged files. Never delete or blank out unrelated files. Keep the app runnable.`
        : `Include every file needed so that running "${runtime.installCommand ?? 'npm install'} && ${runtime.preview.startCommand ?? 'npm run dev'}" serves the app.`,
      `Use stable mainstream dependency versions.`,
      // runtime 自带的硬性脚手架约束，保证产物可被该 runtime 直接跑起来
      ...(runtime.scaffoldRules?.length
        ? ['', 'STRICT PROJECT RULES (must all be satisfied):', ...runtime.scaffoldRules.map((r) => `- ${r}`)]
        : []),
    ].join('\n');

    // 迭代模式下把现有文件作为上下文（受预算裁剪）先喂给模型
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: system },
    ];
    if (iterating) {
      messages.push({
        role: 'user',
        content:
          'CURRENT PROJECT FILES:\n\n' +
          existing
            .map((f) => `===== ${f.path} =====\n${f.content}`)
            .join('\n\n'),
      });
    }
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model,
      temperature: 0.2,
      messages,
      stream: true, // 流式：实时把分析/进度推给会话
    };
    // 智谱 GLM-4.5/4.6 默认开启"思考"(CoT)，代码生成慢近一倍；关闭以提速，质量仍好
    if (/bigmodel\.cn/.test(baseURL) && /glm-4\.(5|6)/i.test(model)) {
      body.thinking = { type: 'disabled' };
    }

    // 流式消费：分析阶段逐字展示；进入代码块后按出现的文件路径报进度
    let content = '';
    let contentBytes = 0;
    const emittedPaths = new Set<string>(); // 流式阶段已报过进度的文件路径
    try {
      const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok || !res.body) {
        const text = res.ok ? '' : await res.text();
        throw new Error(`LLM API ${res.status}: ${text.slice(0, 300)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';
      let phase: 'analysis' | 'code' = 'analysis';
      let shown = 0;
      const markerOf = (s: string) => s.indexOf('@@FILE:');

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = sseBuf.indexOf('\n')) >= 0) {
          const line = sseBuf.slice(0, nl).trim();
          sseBuf = sseBuf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let delta = '';
          try {
            delta = JSON.parse(payload)?.choices?.[0]?.delta?.content ?? '';
          } catch {
            continue;
          }
          if (!delta) continue;
          contentBytes += Buffer.byteLength(delta);
          if (contentBytes > MAX_RESPONSE_BYTES) {
            await reader.cancel('LLM response exceeded platform limit');
            throw new Error('LLM 返回内容超过平台 8 MiB 限制');
          }
          content += delta;

          if (phase === 'analysis') {
            const m = markerOf(content);
            if (m >= 0) {
              const tail = content.slice(shown, m);
              if (tail.trim()) push({ kind: 'text', text: tail });
              shown = content.length;
              phase = 'code';
              push({ kind: 'system', text: '开始生成代码…' });
            } else {
              // 保留末尾最多 7 个字符，避免把半个 "@@FILE:" 标记漏进分析文本
              const safe = Math.max(shown, content.length - 7);
              if (safe > shown) {
                push({ kind: 'text', text: content.slice(shown, safe) });
                shown = safe;
              }
            }
          } else {
            // 代码阶段：每出现一个新的 @@FILE: 标记就报一次进度
            for (const mm of content.matchAll(/@@FILE:[ \t]*(.+?)[ \t]*@@/g)) {
              const p = mm[1].trim();
              if (p && !isPlaceholderPath(p) && !emittedPaths.has(p)) {
                emittedPaths.add(p);
                push({ kind: 'tool_use', toolName: 'write', toolInput: p });
              }
            }
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      push({
        kind: 'result',
        text: `调用 LLM 失败: ${diagnosticMessage(err, [apiKey])}`,
      });
      return { events, isError: true };
    }

    let files: GenFile[];
    try {
      // 防止异常上游把 Authorization 凭证原样混入生成文件。
      files = parseFiles(redactExplicitSecrets(content, [apiKey]));
    } catch (err) {
      push({
        kind: 'result',
        text: `解析生成结果失败: ${diagnosticMessage(err, [apiKey])}`,
      });
      return { events, isError: true };
    }

    const root = resolve(cwd);
    try {
      // 同一路径重复出现时只采用最后一份内容，并在任何文件写入前校验整批最终状态。
      const contentByPath = new Map<string, string>();
      for (const file of files) {
        contentByPath.set(
          editableRelativePath(root, file.path),
          file.content ?? '',
        );
      }
      const changes = await assertWorkspaceChanges(
        root,
        [...contentByPath].map(([path, fileContent]) => ({
          path,
          bytes: Buffer.byteLength(fileContent, 'utf8'),
        })),
        workspaceLimits((key, fallback) => Number(this.config.get(key, fallback))),
      );
      files = changes.map(({ path }) => ({ path, content: contentByPath.get(path) ?? '' }));
    } catch (error) {
      push({
        kind: 'result',
        text: `生成结果未写入: ${diagnosticMessage(error)}`,
      });
      return { events, isError: true };
    }
    let written = 0;
    for (const f of files) {
      signal?.throwIfAborted();
      const target = resolve(cwd, f.path);
      // 防目录穿越：必须落在项目卷内
      if (target !== root && !target.startsWith(root + sep)) {
        this.logger.warn(`跳过越界路径: ${f.path}`);
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content ?? '', 'utf8');
      written++;
      // 进度已在流式阶段按路径报过；未报过的（如流式没匹配到）补一条
      if (!emittedPaths.has(f.path)) {
        push({ kind: 'tool_use', toolName: 'write', toolInput: f.path });
      }
    }

    push({
      kind: 'result',
      text: `${iterating ? '已修改' : '已生成'} ${written} 个文件`,
    });
    return { events, isError: written === 0 };
  }
}

/**
 * 读取项目卷内现有源码文件（作为迭代上下文喂给模型）。
 * 排除 node_modules 等目录与锁文件；受文件数/单文件/总量预算裁剪。
 */
async function readProjectFiles(cwd: string): Promise<GenFile[]> {
  const root = resolve(cwd);
  const out: GenFile[] = [];
  let totalBytes = 0;

  const walk = async (dir: string) => {
    if (out.length >= MAX_CONTEXT_FILES || totalBytes >= MAX_CONTEXT_BYTES)
      return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_CONTEXT_FILES || totalBytes >= MAX_CONTEXT_BYTES)
        return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile()) {
        if (e.name.startsWith('.')) continue; // 跳过 .gitignore/.aider* 等点文件（否则会误判为"已有项目"）
        const rel = relative(root, full);
        // 锁文件太大且无编辑意义，跳过
        if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(rel))
          continue;
        try {
          const info = await stat(full);
          if (info.size > MAX_FILE_BYTES) continue;
          const content = await readFile(full, 'utf8');
          out.push({ path: rel, content });
          totalBytes += info.size;
        } catch {
          /* 跳过读不了的文件 */
        }
      }
    }
  };
  await walk(root);
  return out;
}

/**
 * 从模型输出里提取文件（分隔符格式，非 JSON，弱模型也不会写坏）：
 *   @@FILE: relative/path@@
 *   <raw content>
 *   @@FILE: next/path@@
 *   ...
 * 逐行解析，防御性处理残缺/多余的 @@FILE 行（避免漏进文件内容）。
 */
function parseFiles(raw: string): GenFile[] {
  const lines = raw.split('\n');
  const files: GenFile[] = [];
  let cur: { path: string; body: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    let content = cur.body.join('\n');
    content = content.replace(/^\r?\n+/, ''); // 去掉标记行后的空行
    // 去掉模型误加的代码围栏
    content = content.replace(/^```[a-zA-Z0-9]*\r?\n/, '').replace(/\r?\n```\s*$/, '');
    content = content.replace(/\s+$/, '') + '\n';
    if (cur.path && !isPlaceholderPath(cur.path)) files.push({ path: cur.path, content });
    cur = null;
  };

  for (const line of lines) {
    // 完整标记 "@@FILE: path@@" 或宽松 "@@FILE: path"
    const full = line.match(/^\s*@@FILE:\s*(.+?)\s*@@\s*$/);
    const loose = !full && line.match(/^\s*@@FILE:\s*(\S.*?)\s*$/);
    if (full || loose) {
      flush();
      const p = (full ? full[1] : (loose as RegExpMatchArray)[1])
        .replace(/@@\s*$/, '')
        .trim();
      cur = { path: p, body: [] };
    } else if (/^\s*@@FILE\b/.test(line)) {
      // 残缺/多余的 @@FILE 行（如裸 "@@FILE"）：作为边界丢弃，绝不并入文件内容
      flush();
    } else if (cur) {
      cur.body.push(line);
    }
    // 首个 @@FILE 之前的分析文字（cur 为 null）自然被忽略
  }
  flush();

  if (files.length === 0)
    throw new Error('未从输出中解析到任何文件（缺少 @@FILE 标记）');
  return files;
}
