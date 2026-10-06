const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { EventEmitter } = require('node:events');

class DapConnection extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.sequence = 0; this.pending = new Map(); this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => { try { this.consume(chunk); } catch (error) { socket.destroy(error); } });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => { this.fail(new Error('调试连接已关闭')); this.emit('closed'); });
  }
  fail(error) { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); } this.pending.clear(); }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 8 * 1024 * 1024) throw new Error('调试消息过大');
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n'); if (headerEnd < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString());
      if (!match) throw new Error('调试协议头无效');
      const length = Number(match[1]); if (length > 8 * 1024 * 1024) throw new Error('调试消息过大');
      if (this.buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      if (message.type === 'response') {
        const entry = this.pending.get(message.request_seq); if (!entry) continue;
        this.pending.delete(message.request_seq); clearTimeout(entry.timer);
        if (message.success) entry.resolve(message.body || {}); else entry.reject(new Error(message.message || message.body?.error?.format || '调试请求失败'));
      } else if (message.type === 'event') this.emit(message.event, message.body || {});
      else if (message.type === 'request') this.write({ seq: ++this.sequence, type: 'response', request_seq: message.seq, command: message.command, success: false, message: '不支持外部终端，请使用内置控制台' });
    }
  }
  write(message) { const data = Buffer.from(JSON.stringify(message)); this.socket.write(Buffer.concat([Buffer.from(`Content-Length: ${data.length}\r\n\r\n`), data])); }
  request(command, args = {}) {
    const seq = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`调试请求超时：${command}`)); }, 60_000); timer.unref();
      this.pending.set(seq, { resolve, reject, timer }); this.write({ seq, type: 'request', command, arguments: args });
    });
  }
}

class LocalJavaRuntime {
  constructor(lsp) { this.lsp = lsp; this.sessions = new Map(); this.builtProjects = new Set(); }
  async targets(project) {
    const targets = await this.lsp.javaCommand(project, 'vscode.java.resolveMainClass', [pathToFileURL(fs.realpathSync(project.path)).href]);
    return (targets || []).map((item) => ({ mainClass: item.mainClass, projectName: item.projectName, label: `${item.mainClass}${item.projectName ? ` · ${item.projectName}` : ''}` }));
  }
  inspect(project) {
    const session = this.sessions.get(project.id);
    return session ? { sessionId: session.id, stopVersion: session.stopVersion, framesLoading: session.framesLoading, framesError: session.framesError, status: session.status, mode: session.mode, mainClass: session.mainClass, logs: session.logs, issues: session.issues || [], threadId: session.threadId, frames: session.frames, reason: session.reason, breakpoints: session.breakpoints } : { status: 'idle', logs: [], frames: [], issues: [], breakpoints: [] };
  }
  source(project, relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('断点文件路径无效');
    const root = fs.realpathSync(project.path); const file = fs.realpathSync(path.resolve(root, relative));
    if (!file.startsWith(root + path.sep) || !file.endsWith('.java') || !fs.statSync(file).isFile()) throw new Error('断点必须位于当前项目的 Java 文件中');
    return file;
  }
  async setBreakpoints(project, session, groups = {}) {
    if (!groups || typeof groups !== 'object' || Array.isArray(groups) || Object.keys(groups).length > 200) throw new Error('断点配置无效');
    const checked = Object.entries(groups).map(([relative, lines]) => {
      if (!Array.isArray(lines) || lines.length > 1000 || lines.some((line) => !Number.isInteger(line) || line < 1 || line > 1_000_000)) throw new Error('断点行号无效');
      return { relative, file: this.source(project, relative), lines };
    });
    const result = [];
    for (const item of checked) {
      const response = await session.dap.request('setBreakpoints', { source: { path: item.file }, breakpoints: item.lines.map((line) => ({ line })), sourceModified: false });
      result.push(...(response.breakpoints || []).map((point) => ({ path: item.relative, line: point.line, verified: point.verified, message: point.message })));
    }
    session.breakpoints = result; return result;
  }
  async start(project, input) {
    const current = this.sessions.get(project.id);
    if (current && ['starting', 'running', 'paused'].includes(current.status)) throw new Error('请先停止当前运行配置');
    if (!['run', 'debug'].includes(input.mode)) throw new Error('运行模式无效');
    for (const key of ['args', 'vmArgs']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 8000 || input[key].includes('\0'))) throw new Error('运行参数无效');
    const session = { id: randomUUID(), stopVersion: 0, framesLoading: false, framesError: '', status: 'starting', mode: input.mode, logs: [], frames: [], breakpoints: [] };
    this.sessions.set(project.id, session);
    try {
      session.release = await this.lsp.retainJava(project);
      const targets = await this.targets(project);
      const target = targets.find((item) => item.mainClass === input.mainClass && item.projectName === input.projectName);
      if (!target) throw new Error('未找到 Java main 入口，请选择有效的运行配置');
      session.mainClass = target.mainClass;
      const fullBuild = !this.builtProjects.has(project.id);
      session.logs.push(fullBuild ? '正在完整重建 Java 项目…\n' : '正在编译 Java 项目…\n');
      const build = await this.lsp.javaBuild(project, target, fullBuild);
      session.issues = build.issues;
      for (const issue of build.issues) session.logs.push(`${issue.path}:${issue.line}:${issue.column} ${issue.message}\n`);
      for (const message of build.messages) session.logs.push(`${message}\n`);
      if (build.status !== 1) {
        const reason = build.status === 2 ? 'Java 编译发现错误' : build.status === 3 ? 'Java 编译已取消' : 'Java 编译失败';
        const first = build.issues[0];
        throw Object.assign(new Error(first ? `${reason}：${first.path}:${first.line} ${first.message}` : `${reason}。请查看运行面板的编译输出。`), { code: 'LOCAL_JAVA_BUILD_FAILED', issues: build.issues });
      }
      this.builtProjects.add(project.id);
      session.logs.push('Java 编译成功。\n');
      const [modulePaths, classPaths] = await this.lsp.javaCommand(project, 'vscode.java.resolveClasspath', [target.mainClass, target.projectName]);
      const javaExec = await this.lsp.javaCommand(project, 'vscode.java.resolveJavaExecutable', [target.mainClass, target.projectName]);
      const port = await this.lsp.javaCommand(project, 'vscode.java.startDebugSession');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Java 调试端口无效');
      const socket = net.connect({ host: '127.0.0.1', port });
      const dap = new DapConnection(socket); session.dap = dap;
      dap.on('output', (event) => { session.logs.push(String(event.output || '')); if (session.logs.length > 2000) session.logs.splice(0, session.logs.length - 2000); });
      dap.on('terminated', () => { session.status = 'stopped'; session.frames = []; session.release?.(); socket.end(); });
      dap.on('closed', () => { if (session.status !== 'failed') session.status = 'stopped'; session.frames = []; session.release?.(); });
      dap.on('continued', () => { session.status = 'running'; session.frames = []; });
      dap.on('stopped', (event) => {
        session.status = 'paused'; session.threadId = event.threadId; session.reason = event.reason;
        const version = ++session.stopVersion; session.frames = []; session.framesLoading = true; session.framesError = '';
        void (async () => {
          if (!Number.isInteger(session.threadId)) { const body = await dap.request('threads'); if (version !== session.stopVersion || session.status !== 'paused') return; session.threadId = body.threads?.[0]?.id; }
          if (!Number.isInteger(session.threadId)) throw new Error('调试器未返回暂停线程');
          const body = await dap.request('stackTrace', { threadId: session.threadId, startFrame: 0, levels: 50 });
          if (session.status !== 'paused' || version !== session.stopVersion) return;
          session.frames = (body.stackFrames || []).map((frame) => ({ id: frame.id, name: frame.name, line: frame.line, column: frame.column, path: debugSourcePath(project.path, frame.source?.path) }));
        })().catch((error) => { if (version === session.stopVersion && session.status === 'paused') { session.framesError = error.message; session.logs.push(`${error.message}\n`); } }).finally(() => { if (version === session.stopVersion) session.framesLoading = false; });
      });
      await dap.request('initialize', { adapterID: 'java', clientID: 'code-studio', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsRunInTerminalRequest: false, supportsVariableType: true });
      let initializeTimer;
      const initialized = new Promise((resolve, reject) => { dap.once('initialized', resolve); initializeTimer = setTimeout(() => reject(new Error('等待调试初始化超时')), 60_000); initializeTimer.unref(); });
      const launch = dap.request('launch', { ...target, cwd: fs.realpathSync(project.path), javaExec, modulePaths, classPaths, noDebug: input.mode === 'run', console: 'internalConsole', stopOnEntry: false, shortenCommandLine: 'argfile', args: input.args || '', vmArgs: input.vmArgs || '' });
      // Attach rejection handling immediately: launch errors can arrive before initialized.
      if (input.mode === 'debug') {
        try { await Promise.race([initialized, launch.then(() => initialized)]); } finally { clearTimeout(initializeTimer); }
        await this.setBreakpoints(project, session, input.breakpoints || {});
        await dap.request('configurationDone');
      }
      else { clearTimeout(initializeTimer); }
      await launch;
      if (session.status === 'starting') session.status = 'running';
      return this.inspect(project);
    } catch (error) { session.status = 'failed'; session.logs.push(error.message); session.release?.(); session.dap?.socket.destroy(); throw error; }
  }
  async action(project, action, input = {}) {
    const session = this.sessions.get(project.id);
    if (!session?.dap || !['paused', 'running'].includes(session.status)) throw new Error('当前没有活动调试会话');
    if (action === 'stop') { await session.dap.request('disconnect', { terminateDebuggee: true }); session.status = 'stopped'; session.frames = []; session.release?.(); session.dap.socket.end(); return this.inspect(project); }
    if (session.mode !== 'debug') throw new Error('当前不是调试模式');
    if (action === 'breakpoints') return this.setBreakpoints(project, session, input.breakpoints);
    if (['continue', 'next', 'stepIn', 'stepOut'].includes(action)) {
      if (session.status !== 'paused') throw new Error('请先暂停程序');
      const version = session.stopVersion;
      await session.dap.request(action, { threadId: session.threadId });
      // A new stopped event can arrive before the step response. Never erase it.
      if (session.stopVersion === version && session.status === 'paused') { session.status = 'running'; session.frames = []; }
      return this.inspect(project);
    }
    if (action === 'pause') {
      const threads = await session.dap.request('threads'); const threadId = threads.threads?.[0]?.id;
      if (!threadId) throw new Error('暂无可暂停的线程');
      await session.dap.request('pause', { threadId }); return this.inspect(project);
    }
    if (session.status !== 'paused') throw new Error('变量只在暂停时可查看');
    if (input.sessionId !== undefined && (input.sessionId !== session.id || input.stopVersion !== session.stopVersion)) throw new Error('暂停位置已变化，请刷新变量');
    const stopVersion = session.stopVersion;
    const assertCurrentPause = () => { if (session.status !== 'paused' || session.stopVersion !== stopVersion) throw new Error('暂停位置已变化，请刷新变量'); };
    if (action === 'scopes') {
      if (!session.frames.some((frame) => frame.id === input.frameId)) throw new Error('调用帧无效');
      const body = await session.dap.request('scopes', { frameId: input.frameId }); assertCurrentPause(); return body;
    }
    if (action === 'variables' && Number.isInteger(input.variablesReference) && input.variablesReference > 0) {
      const body = await session.dap.request('variables', { variablesReference: input.variablesReference });
      assertCurrentPause();
      const variables = (body.variables || []).slice(0, 200);
      // Java's lazy object view returns a nameless intermediate variable with a
      // new reference. Resolve it before rendering, preserving the original name.
      for (let index = 0; index < variables.length; index++) {
        const variable = variables[index];
        if (!variable.presentationHint?.lazy || variable.variablesReference <= 0) continue;
        const resolved = await session.dap.request('variables', { variablesReference: variable.variablesReference });
        assertCurrentPause();
        const detail = resolved.variables?.[0];
        if (resolved.variables?.length === 1 && detail?.name === '') variables[index] = { ...variable, ...detail, name: variable.name, type: detail.type || variable.type, presentationHint: { ...variable.presentationHint, lazy: false } };
      }
      return { ...body, variables };
    }
    throw new Error('调试操作无效');
  }
  async shutdown() {
    await Promise.all([...this.sessions.values()].map(async (session) => {
      session.release?.();
      if (!session.dap || session.dap.socket.destroyed) return;
      try { await session.dap.request('disconnect', { terminateDebuggee: true }); } catch {}
      session.dap.socket.destroy();
    }));
  }
}
function debugSourcePath(rootPath, sourcePath) {
  try {
    if (typeof sourcePath !== 'string') return null;
    const root = fs.realpathSync(rootPath);
    const file = fs.realpathSync(sourcePath.startsWith('file:') ? fileURLToPath(sourcePath) : path.resolve(root, sourcePath));
    if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) return null;
    return path.relative(root, file).split(path.sep).join('/');
  } catch { return null; }
}
module.exports = { LocalJavaRuntime, DapConnection, debugSourcePath };
