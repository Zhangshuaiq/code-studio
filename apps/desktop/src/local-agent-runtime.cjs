const { spawn } = require('node:child_process');
const { spawnGuarded } = require('./guarded-process.cjs');

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);

class LocalAgentRuntime {
  constructor({ store, credentialCodec, commands = {}, timeoutMs = 10 * 60_000, codeIntelligence }) {
    this.store = store;
    this.credentialCodec = credentialCodec;
    this.commands = { 'codex-cli': 'codex', 'claude-code': 'claude', aider: 'aider', ...commands };
    this.timeoutMs = timeoutMs;
    this.codeIntelligence = codeIntelligence;
    this.active = new Map();
  }

  start(task, project, config) {
    if (this.active.has(project.id)) { const error = new Error('该工作区已有 Agent 任务运行中'); error.code = 'LOCAL_AGENT_BUSY'; throw error; }
    const workspaceRoot = verifiedWorkspaceRoot(project);
    const boundedProject = { ...project, path: workspaceRoot };
    const controller = new AbortController();
    const run = { taskId: task.id, projectId: project.id, controller, child: null, timedOut: false, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } };
    this.active.set(project.id, run);
    run.promise = this.execute(run, task, boundedProject, config).finally(() => this.active.delete(project.id));
  }

  isProjectBusy(projectId) { return this.active.has(projectId); }

  cancel(taskId) {
    const run = [...this.active.values()].find((item) => item.taskId === taskId);
    if (!run) return false;
    this.store.updateAgentTask(taskId, 'cancelling');
    run.controller.abort(new Error('用户取消任务'));
    if (run.child) killProcessTree(run.child);
    return true;
  }

  async shutdown() {
    const runs = [...this.active.values()];
    for (const run of runs) {
      run.controller.abort(new Error('客户端退出'));
      if (run.child) killProcessTree(run.child);
    }
    await Promise.allSettled(runs.map((run) => run.promise));
    for (const run of runs) this.store.updateAgentTask(run.taskId, 'interrupted', { error: '客户端退出，任务已中断', finishedAt: new Date().toISOString() });
    this.active.clear();
  }

  async execute(run, task, project, config) {
    const startedAt = new Date().toISOString();
    this.store.updateAgentTask(task.id, 'running', { startedAt });
    this.event(task.id, { kind: 'system', text: `${config.name} 已开始处理 · ${task.permissionProfile === 'workspace-write' ? '可修改工作区文件' : '仅查看'}。` });
    const timer = setTimeout(() => {
      run.timedOut = true; run.controller.abort(new Error('任务超时'));
      if (run.child) killProcessTree(run.child);
    }, this.timeoutMs);
    try {
      if (config.engine === 'openai-compatible' || config.engine === 'ollama') await this.runOpenAiCompatible(run, task, project, config);
      else await this.runCli(run, task, project, config);
      if (run.controller.signal.aborted) throw run.controller.signal.reason;
      this.event(task.id, { kind: 'result', text: '任务已完成' });
      this.store.updateAgentTask(task.id, 'succeeded', { finishedAt: new Date().toISOString() });
    } catch (error) {
      const cancelled = run.controller.signal.aborted;
      const status = run.timedOut ? 'timed_out' : cancelled ? 'cancelled' : 'failed';
      const message = safeError(error, config.apiKey);
      this.event(task.id, { kind: 'result', text: run.timedOut ? '任务运行超时' : cancelled ? '任务已取消' : `任务失败：${message}` });
      this.store.updateAgentTask(task.id, status, { error: message, finishedAt: new Date().toISOString() });
    } finally { clearTimeout(timer); }
  }

  async runCli(run, task, project, config) {
    const command = this.commands[config.engine];
    if (!command) throw new Error(`暂不支持本地引擎 ${config.engine}`);
    const { args, env } = cliInvocation(config, task.prompt, task.permissionProfile);
    await new Promise((resolve, reject) => {
      const child = spawnGuarded(command, args, { cwd: project.path, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      run.child = child;
      let pending = '';
      const onData = (chunk) => {
        pending += chunk.toString('utf8');
        const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
        for (const line of lines) this.forwardLine(task.id, line, config.apiKey, run);
      };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.once('error', reject);
      child.once('close', (code) => {
        if (pending.trim()) this.forwardLine(task.id, pending, config.apiKey, run);
        run.child = null;
        if (run.controller.signal.aborted) reject(run.controller.signal.reason);
        else if (code === 0) resolve(); else reject(new Error(`${command} 退出码 ${code}`));
      });
    });
  }

  async runOpenAiCompatible(run, task, project, config) {
    if (!config.baseUrl || !config.model) throw new Error('请配置模型服务地址和模型标识');
    const messages = [{ role: 'system', content: 'You are a coding assistant working with a local project. Use the provided code-intelligence tools to inspect symbols and diagnostics before answering. Never invent file contents.' }, { role: 'user', content: task.prompt }];
    for (let turn = 0; turn < 8; turn += 1) {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: run.controller.signal,
        headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, messages, tools: CODE_INTELLIGENCE_TOOLS, tool_choice: 'auto' }),
      });
      const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error?.message || `模型服务 HTTP ${response.status}`);
      this.recordUsage(run, task.id, body.usage, true);
      const message = body.choices?.[0]?.message; if (!message) throw new Error('模型服务未返回消息');
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, 8) : [];
      if (!calls.length) { if (typeof message.content !== 'string') throw new Error('模型服务未返回文本'); this.event(task.id, { kind: 'text', text: message.content }); return; }
      messages.push(message);
      for (const call of calls) {
        const name = call.function?.name; let input = {}; try { input = JSON.parse(call.function?.arguments || '{}'); } catch {}
        this.event(task.id, { kind: 'tool_use', toolName: codeToolLabel(name), toolInput: input });
        let result; try { result = await this.codeIntelligence?.(project, name, input); } catch (error) { result = { error: safeError(error, config.apiKey) }; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 100_000) });
      }
    }
    throw new Error('模型连续调用工具次数过多，请缩小任务范围');
  }

  forwardLine(taskId, line, secret, run) {
    const cleaned = redact(line, secret).trimEnd();
    if (!cleaned) return;
    try {
      const value = JSON.parse(cleaned);
      this.recordUsage(run, taskId, value.usage || value.response?.usage || value.rate_limits?.usage);
      const item = value.item || value.message || value;
      const text = item.text || item.content?.find?.((part) => part.type === 'text')?.text || value.result;
      if (typeof text === 'string') this.event(taskId, { kind: value.type?.includes('reason') ? 'reasoning' : 'text', text });
      else if (item.command || item.changes || item.tool_name) this.event(taskId, { kind: 'tool_use', toolName: item.tool_name || item.type || '工具调用', toolInput: item.command || item.changes || item.input });
    } catch { this.event(taskId, { kind: 'text', text: `${cleaned}\n` }); }
  }

  event(taskId, event) { return this.store.addAgentEvent(taskId, event); }

  recordUsage(run, taskId, value, additive = false) {
    if (!run || !value || typeof value !== 'object') return;
    const input = tokenValue(value, ['input_tokens', 'inputTokens', 'prompt_tokens']);
    const cached = tokenValue(value, ['cached_input_tokens', 'cachedInputTokens', 'cached_tokens'], value.input_tokens_details || value.prompt_tokens_details);
    const output = tokenValue(value, ['output_tokens', 'outputTokens', 'completion_tokens']);
    if (!input && !cached && !output) return;
    // Codex emits a final cumulative usage event; OpenAI-compatible responses emit per-request usage.
    if (additive) {
      run.usage.inputTokens += input; run.usage.cachedInputTokens += cached; run.usage.outputTokens += output;
    } else run.usage = { inputTokens: input, cachedInputTokens: cached, outputTokens: output };
    this.store.updateAgentTask(taskId, 'running', run.usage);
  }
}

function tokenValue(value, keys, nested) {
  for (const key of keys) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) return value[key];
  if (nested && typeof nested === 'object') return tokenValue(nested, keys);
  return 0;
}

const CODE_INTELLIGENCE_TOOLS = [
  tool('workspace_symbols', 'Search declarations in the current project.', { query: { type: 'string' } }, ['query']),
  tool('definition', 'Find the definition at a one-based file position.', positionProperties(), ['path', 'line', 'column']),
  tool('find_references', 'Find references at a one-based file position.', positionProperties(), ['path', 'line', 'column']),
  tool('diagnostics', 'Read current diagnostics for a source file.', { path: { type: 'string' } }, ['path']),
];
function tool(name, description, properties, required) { return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }; }
function positionProperties() { return { path: { type: 'string' }, line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 } }; }
function codeToolLabel(name) { return ({ workspace_symbols: '搜索项目符号', definition: '查找定义', find_references: '查找引用', diagnostics: '检查代码问题' })[name] || '代码分析'; }

function cliInvocation(config, prompt, permissionProfile = 'read-only') {
  const writable = permissionProfile === 'workspace-write';
  if (config.engine === 'codex-cli') return { args: ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', writable ? 'workspace-write' : 'read-only', '--skip-git-repo-check', ...(config.model ? ['--model', config.model] : []), ...(config.reasoningEffort ? ['--config', `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`] : []), prompt], env: {} };
  if (config.engine === 'claude-code') {
    const tools = writable ? 'Read,Glob,Grep,Edit,Write,NotebookEdit' : 'Read,Glob,Grep';
    const boundary = writable
      ? 'You may read and edit files only inside the current working directory. Shell/Bash and network tools are unavailable. Do not access paths outside this workspace.'
      : 'This is a read-only task. Read files only inside the current working directory. Do not edit files or access paths outside this workspace.';
    return { args: ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--tools', tools, '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{}', '--append-system-prompt', boundary, '--permission-mode', writable ? 'acceptEdits' : 'plan', '--no-session-persistence', ...(config.model ? ['--model', config.model] : [])], env: {} };
  }
  if (config.engine === 'aider') {
    if (!writable) throw new Error('Aider 是文件编辑引擎，请明确授权“允许修改工作区”');
    if (!config.baseUrl || !config.model || !config.apiKey) throw new Error('Aider 需要 Base URL、模型标识和 API Key');
    return { args: ['--model', `openai/${config.model}`, '--message', prompt, '--yes-always', '--subtree-only', '--no-git', '--no-check-update', '--no-pretty'], env: { OPENAI_API_BASE: config.baseUrl, OPENAI_API_KEY: config.apiKey, AIDER_ANALYTICS: 'false' } };
  }
  throw new Error(`暂不支持本地引擎 ${config.engine}`);
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { try { child.kill('SIGTERM'); } catch {} }
}
function redact(value, secret) { return secret ? String(value).split(secret).join('[REDACTED]') : String(value); }
function safeError(error, secret) { return redact(error instanceof Error ? error.message : String(error), secret).slice(0, 2_000); }

function verifiedWorkspaceRoot(project) {
  const fs = require('node:fs');
  const path = require('node:path');
  if (!project || typeof project.path !== 'string') throw new Error('工作区目录无效');
  const resolved = path.resolve(project.path);
  let real;
  try { real = fs.realpathSync(resolved); } catch { throw new Error('工作区目录不存在或无法访问'); }
  if (!fs.statSync(real).isDirectory()) throw new Error('工作区路径不是目录');
  if (real !== resolved) throw new Error('工作区目录已发生变化，请重新打开项目');
  return real;
}

module.exports = { LocalAgentRuntime, TERMINAL_STATUSES, cliInvocation, verifiedWorkspaceRoot };
