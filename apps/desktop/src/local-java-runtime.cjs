const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { EventEmitter } = require('node:events');
const { validateBreakpoints } = require('./java-breakpoint-configuration.cjs');
const { discoverJdks, selectJdk, javaMajor } = require('./local-java-jdks.cjs');
const { buildMaven } = require('./local-java-build.cjs');

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
  constructor(lsp, options = {}) { this.lsp = lsp; this.discoverJdks = options.discoverJdks || discoverJdks; this.sessions = new Map(); this.builtProjects = new Set(); this.pendingTargets = new Map(); }
  async targets(project) {
    const root = fs.realpathSync(project.path), key = JSON.stringify([project.id, root]);
    let pending = this.pendingTargets.get(key);
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        const targets = await this.lsp.javaCommand(project, 'vscode.java.resolveMainClass', [pathToFileURL(root).href]);
        return (targets || []).map((item) => ({ mainClass: item.mainClass, projectName: item.projectName, filePath: item.filePath, label: `${item.mainClass}${item.projectName ? ` · ${item.projectName}` : ''}` }));
      }).finally(() => { if (this.pendingTargets.get(key) === pending) this.pendingTargets.delete(key); });
      this.pendingTargets.set(key, pending);
    }
    return pending;
  }
  async environment(project, input, target) {
    if (!target) target = (await this.targets(project)).find(item => item.mainClass === input.mainClass && item.projectName === input.projectName);
    if (!target) throw Error('请选择有效的 Java 启动入口');
    const root = fs.realpathSync(project.path);
    let uri = pathToFileURL(root).href;
    if (target.filePath) { const file = fs.realpathSync(target.filePath); if (!file.startsWith(root + path.sep)) throw Error('启动入口不在当前项目内'); uri = pathToFileURL(file).href; }
    else if (target.projectName) throw Error('语言服务未提供启动入口源码路径，无法确认所属模块的编译配置');
    const keys = ['org.eclipse.jdt.core.compiler.source', 'org.eclipse.jdt.core.compiler.codegen.targetPlatform', 'org.eclipse.jdt.core.compiler.release', 'org.eclipse.jdt.ls.core.vm.location', 'org.eclipse.m2e.core.selectedProfiles'];
    const settings = await this.lsp.javaCommand(project, 'java.project.getSettings', [uri, keys]);
    const source = settings?.[keys[0]], targetVersion = settings?.[keys[1]], required = Math.max(javaMajor(source) || 0, javaMajor(targetVersion) || 0);
    if (!required) throw Error('项目编译版本尚未解析完成，请等待代码智能加载后刷新');
    const jdks = this.discoverJdks({ candidates: [settings[keys[3]]] });
    const jdk = selectJdk(jdks, required, input.javaHome, settings[keys[3]]);
    return { source, target: targetVersion, release: settings[keys[2]] === 'enabled', required, jdks, selected: jdk, profiles: settings[keys[4]] || '', buildTool: fs.existsSync(path.join(root, 'pom.xml')) ? 'maven' : 'eclipse', origin: '项目导入配置', projectName: target.projectName || '' };
  }
  inspect(project) {
    const session = this.sessions.get(project.id);
    return session ? { sessionId: session.id, stopVersion: session.stopVersion, framesLoading: session.framesLoading, framesError: session.framesError, status: session.status, mode: session.mode, mainClass: session.mainClass, logs: session.logs, issues: session.issues || [], threadId: session.threadId, pausedThreadIds: [...(session.pausedThreads || [])], threads: session.threads || [], threadsTruncated: !!session.threadsTruncated, frames: session.frames, reason: session.reason, breakpoints: session.breakpoints } : { status: 'idle', logs: [], frames: [], issues: [], breakpoints: [] };
  }
  source(project, relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('断点文件路径无效');
    const root = fs.realpathSync(project.path); const file = fs.realpathSync(path.resolve(root, relative));
    if (!file.startsWith(root + path.sep) || !file.endsWith('.java') || !fs.statSync(file).isFile()) throw new Error('断点必须位于当前项目的 Java 文件中');
    return file;
  }
  async setBreakpoints(project, session, groups = {}) {
    const checked = Object.entries(validateBreakpoints(groups)).map(([relative, points]) => {
      const lines = points.map(point => typeof point === 'number' ? { line: point } : { ...point });
      if (lines.some(point => point.condition) && !session.capabilities?.supportsConditionalBreakpoints) throw Object.assign(new Error('当前 Java 调试器不支持条件断点'), { code: 'LOCAL_JAVA_CONDITIONAL_BREAKPOINT_UNSUPPORTED' });
      if (lines.some(point => point.hitCondition) && !session.capabilities?.supportsHitConditionalBreakpoints) throw Object.assign(new Error('当前 Java 调试器不支持命中次数断点'), { code: 'LOCAL_JAVA_HIT_BREAKPOINT_UNSUPPORTED' });
      if (lines.some(point => point.logMessage) && !session.capabilities?.supportsLogPoints) throw Object.assign(new Error('当前 Java 调试器不支持日志断点'), { code: 'LOCAL_JAVA_LOGPOINT_UNSUPPORTED' });
      return { relative, file: this.source(project, relative), lines };
    });
    const update = (session.breakpointQueue || Promise.resolve()).catch(() => {}).then(() => this.applyBreakpoints(session, checked));
    session.breakpointQueue = update;
    return update;
  }
  async applyBreakpoints(session, checked) {
    const result = [];
    // DAP replaces breakpoints per source, not globally. Explicitly clear sources
    // removed from the next snapshot, including the last breakpoint in a file.
    const sources = new Map(checked.map(item => [item.relative, item]));
    for (const previous of session.breakpointSources || []) {
      if (!sources.has(previous.relative)) checked.push({ ...previous, lines: [] });
    }
    for (const item of checked) {
      const response = await session.dap.request('setBreakpoints', { source: { path: item.file }, breakpoints: item.lines, sourceModified: false });
      result.push(...(response.breakpoints || []).map((point, index) => ({ path: item.relative, line: point.line, verified: point.verified, message: point.message, ...Object.fromEntries(['condition', 'hitCondition', 'logMessage'].filter(field => item.lines[index]?.[field]).map(field => [field, item.lines[index][field]])) })));
    }
    session.breakpointSources = [...sources.values()].filter(item => item.lines.length).map(({ relative, file }) => ({ relative, file }));
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
      const environment = await this.environment(project, input, target);
      if (session.cancelled) throw Error('项目启动已取消');
      session.logs.push(`项目编译级别：source ${environment.source} / target ${environment.target}${environment.release ? '（release）' : ''}\n`);
      const fullBuild = !this.builtProjects.has(project.id);
      if (environment.buildTool === 'maven') {
        await buildMaven(project, environment.selected, session, undefined, environment.profiles);
      } else {
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
      }
      if (session.cancelled) throw Error('项目启动已取消');
      this.builtProjects.add(project.id);
      session.logs.push('Java 编译成功。\n');
      const [modulePaths, classPaths] = await this.lsp.javaCommand(project, 'vscode.java.resolveClasspath', [target.mainClass, target.projectName]);
      if (session.cancelled) throw Error('项目启动已取消');
      const javaExec = environment.selected.javaExec;
      const port = await this.lsp.javaCommand(project, 'vscode.java.startDebugSession');
      if (session.cancelled) throw Error('项目启动已取消');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Java 调试端口无效');
      const socket = net.connect({ host: '127.0.0.1', port });
      const dap = new DapConnection(socket); session.dap = dap;
      dap.on('output', (event) => { session.logs.push(String(event.output || '')); if (session.logs.length > 2000) session.logs.splice(0, session.logs.length - 2000); });
      dap.on('userNotification', (event) => { if (typeof event.message === 'string') { session.logs.push(`[调试器] ${event.message.slice(0, 2000)}\n`); if (session.logs.length > 2000) session.logs.splice(0, session.logs.length - 2000); } });
      dap.on('terminated', () => { session.status = 'stopped'; session.frames = []; session.threads = []; session.pausedThreads?.clear(); session.release?.(); socket.end(); });
      dap.on('closed', () => { if (session.status !== 'failed') session.status = 'stopped'; session.frames = []; session.threads = []; session.pausedThreads?.clear(); session.release?.(); });
      dap.on('continued', event => { void this.resumedThreads(project, session, event.threadId, event.allThreadsContinued !== false); });
      dap.on('stopped', (event) => {
        session.status = 'paused'; session.threadId = event.threadId; session.reason = event.reason;
        session.pausedThreads ||= new Set();
        if (Number.isInteger(event.threadId)) session.pausedThreads.add(event.threadId);
        session.allThreadsStopped = event.allThreadsStopped === true;
        const version = ++session.stopVersion; session.frames = []; session.threads = []; session.framesLoading = true; session.framesError = '';
        void (async () => {
          const threads = await this.pausedThreads(project, session, version);
          if (!Number.isInteger(session.threadId)) session.threadId = threads[0]?.id;
          if (!Number.isInteger(session.threadId)) throw new Error('调试器未返回暂停线程');
          await this.pausedFrames(project, session, version);
        })().catch((error) => { if (version === session.stopVersion && session.status === 'paused') { session.framesError = error.message; session.logs.push(`${error.message}\n`); } }).finally(() => { if (version === session.stopVersion) session.framesLoading = false; });
      });
      session.capabilities = await dap.request('initialize', { adapterID: 'java', clientID: 'code-studio', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsRunInTerminalRequest: false, supportsVariableType: true });
      let initializeTimer;
      const initialized = new Promise((resolve, reject) => { dap.once('initialized', resolve); initializeTimer = setTimeout(() => reject(new Error('等待调试初始化超时')), 60_000); initializeTimer.unref(); });
      if (session.cancelled) { clearTimeout(initializeTimer); throw Error('项目启动已取消'); }
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
    } catch (error) { session.status = session.cancelled ? 'stopped' : 'failed'; if (error.issues) session.issues = error.issues; session.logs.push(error.message); session.release?.(); session.dap?.socket.destroy(); throw error; }
  }
  async action(project, action, input = {}) {
    const session = this.sessions.get(project.id);
    if (action === 'stop' && session?.status === 'starting') { session.cancelled = true; session.buildChild?.kill('SIGTERM'); session.dap?.socket.destroy(); await session.buildDone?.catch(() => {}); session.release?.(); session.status = 'stopped'; return this.inspect(project); }
    if (!session?.dap || !['paused', 'running'].includes(session.status)) throw new Error('当前没有活动调试会话');
    if (action === 'stop') { await session.dap.request('disconnect', { terminateDebuggee: true }); session.status = 'stopped'; session.frames = []; session.threads = []; session.pausedThreads?.clear(); session.release?.(); session.dap.socket.end(); return this.inspect(project); }
    if (session.mode !== 'debug') throw new Error('当前不是调试模式');
    if (action === 'breakpoints') return this.setBreakpoints(project, session, input.breakpoints);
    if (['continue', 'continueAll', 'next', 'stepIn', 'stepOut'].includes(action)) {
      if (session.status !== 'paused') throw new Error('请先暂停程序');
      const version = session.stopVersion;
      const threadId = session.threadId;
      const response = await session.dap.request(action, { threadId });
      // A new stopped event can arrive before the step response. Never erase it.
      if (session.stopVersion === version && session.status === 'paused') await this.resumedThreads(project, session, threadId, action === 'continueAll' || (action === 'continue' && response?.allThreadsContinued !== false));
      return this.inspect(project);
    }
    if (action === 'pause') {
      if (input.threadId !== undefined && (input.sessionId !== session.id || input.stopVersion !== session.stopVersion || !Number.isSafeInteger(input.threadId) || input.threadId < 1)) throw new Error('线程选择已过期或无效，请刷新');
      const version = session.stopVersion;
      const threads = await session.dap.request('threads'); const threadId = input.threadId ?? threads.threads?.[0]?.id;
      if (this.sessions.get(project.id) !== session || session.stopVersion !== version || !threads.threads?.some(thread => thread.id === threadId)) throw new Error('线程已变化，请刷新');
      if (!threadId) throw new Error('暂无可暂停的线程');
      await session.dap.request('pause', { threadId }); return this.inspect(project);
    }
    if (session.status !== 'paused') throw new Error('变量只在暂停时可查看');
    if (input.sessionId !== undefined && (input.sessionId !== session.id || input.stopVersion !== session.stopVersion)) throw new Error('暂停位置已变化，请刷新变量');
    const stopVersion = session.stopVersion;
    const assertCurrentPause = () => this.assertPause(project, session, stopVersion);
    if (action === 'threads') { await this.pausedThreads(project, session, stopVersion); return this.inspect(project); }
    if (action === 'selectThread') {
      if (input.sessionId !== session.id || input.stopVersion !== stopVersion || !Number.isSafeInteger(input.threadId) || input.threadId < 1) throw new Error('线程选择已过期或无效，请刷新');
      const threads = await this.pausedThreads(project, session, stopVersion);
      assertCurrentPause();
      if (!threads.some(thread => thread.id === input.threadId)) throw new Error('线程已不存在，请刷新');
      session.threadId = input.threadId;
      const version = ++session.stopVersion;
      session.frames = []; session.framesError = ''; session.framesLoading = true;
      try { await this.pausedFrames(project, session, version); }
      catch (error) { if (session.status === 'paused' && session.stopVersion === version) session.framesError = error.message; throw error; }
      finally { if (session.stopVersion === version) session.framesLoading = false; }
      return this.inspect(project);
    }
    if (action === 'evaluate') {
      // Evaluation can execute application code. Require an explicit, current
      // pause identity instead of guessing a frame or accepting stale clients.
      if (input.sessionId !== session.id || input.stopVersion !== stopVersion) throw new Error('暂停位置已变化，请刷新表达式');
      if (!Number.isInteger(input.frameId) || !session.frames.some((frame) => frame.id === input.frameId)) throw new Error('调用帧无效');
      if (typeof input.expression !== 'string' || !input.expression.trim() || input.expression.length > 4000 || input.expression.includes('\0')) throw new Error('表达式无效（最多 4000 字符）');
      const body = await session.dap.request('evaluate', { frameId: input.frameId, expression: input.expression, context: 'watch' });
      assertCurrentPause();
      return { result: String(body.result ?? ''), type: body.type, variablesReference: Number.isInteger(body.variablesReference) && body.variablesReference > 0 ? body.variablesReference : 0 };
    }
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
  assertPause(project, session, version) {
    if (this.sessions.get(project.id) !== session || session.status !== 'paused' || session.stopVersion !== version) throw new Error('暂停位置已变化，请刷新');
  }
  async pausedThreads(project, session, version) {
    this.assertPause(project, session, version);
    const body = await session.dap.request('threads');
    this.assertPause(project, session, version);
    const threads = (Array.isArray(body.threads) ? body.threads : []).filter(thread => Number.isSafeInteger(thread.id) && thread.id > 0).map(thread => ({ id: thread.id, name: String(thread.name || `线程 ${thread.id}`).slice(0, 500) }));
    if (session.allThreadsStopped) session.pausedThreads = new Set(threads.map(thread => thread.id));
    session.threads = threads.slice(0, 1000); session.threadsTruncated = threads.length > 1000;
    if (!session.threads.some(thread => thread.id === session.threadId)) {
      const selected = threads.find(thread => thread.id === session.threadId);
      if (selected) session.threads = [...session.threads.slice(0, 999), selected];
    }
    return threads;
  }
  async pausedFrames(project, session, version) {
    this.assertPause(project, session, version);
    const body = await session.dap.request('stackTrace', { threadId: session.threadId, startFrame: 0, levels: 50 });
    this.assertPause(project, session, version);
    session.frames = (body.stackFrames || []).map(frame => ({ id: frame.id, name: frame.name, line: frame.line, column: frame.column, path: debugSourcePath(project.path, frame.source?.path) }));
  }
  async resumedThreads(project, session, threadId, all) {
    if (this.sessions.get(project.id) !== session || !['paused', 'running'].includes(session.status)) return;
    session.pausedThreads ||= new Set(Number.isInteger(session.threadId) ? [session.threadId] : []);
    if (all) session.pausedThreads.clear(); else session.pausedThreads.delete(threadId);
    session.allThreadsStopped = false;
    session.frames = []; session.threads = [];
    if (!session.pausedThreads.size) { session.status = 'running'; return; }
    session.status = 'paused'; session.threadId = session.pausedThreads.values().next().value;
    const version = ++session.stopVersion; session.framesLoading = true; session.framesError = '';
    try { await this.pausedThreads(project, session, version); await this.pausedFrames(project, session, version); }
    catch (error) { if (session.status === 'paused' && session.stopVersion === version) session.framesError = error.message; }
    finally { if (session.stopVersion === version) session.framesLoading = false; }
  }
  async shutdown() {
    await Promise.all([...this.sessions.values()].map(async (session) => {
      session.cancelled = true; session.buildChild?.kill('SIGTERM');
      await session.buildDone?.catch(() => {});
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
