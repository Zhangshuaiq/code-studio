const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const { spawnGuarded } = require('./guarded-process.cjs');

const LANGUAGE_PROVIDERS = new Map([
  ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.js', 'typescript'], ['.jsx', 'typescript'], ['.mjs', 'typescript'], ['.cjs', 'typescript'], ['.py', 'python'], ['.java', 'java'],
  ['.c', 'clangd'], ['.h', 'clangd'], ['.cc', 'clangd'], ['.cpp', 'clangd'], ['.cxx', 'clangd'], ['.hh', 'clangd'], ['.hpp', 'clangd'], ['.hxx', 'clangd'],
  ['.go', 'gopls'], ['.rs', 'rust-analyzer'], ['.vue', 'vue'],
]);

class LocalLspManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.idleMs = options.idleMs || 10 * 60 * 1000;
    this.dataRoot = options.dataRoot || path.join(os.tmpdir(), 'code-studio-language-data');
    this.commands = options.commands || {};
    this.javaSources = new Map();
  }

  async request(project, operation, input = {}) {
    if (String(input.path).startsWith('@java-source/')) {
      const source = this.javaSources.get(`${project.id}:${input.path}`);
      if (!source) throw Object.assign(new Error('依赖源码引用已失效，请重新跳转'), { code: 'LOCAL_LSP_SOURCE_INVALID' });
      const session = await this.#session(project, 'java'); this.#touch(session);
      const method = { definition: 'definition', declaration: 'declaration', typeDefinition: 'typeDefinition', implementation: 'implementation', references: 'references', hover: 'hover', documentSymbols: 'documentSymbol' }[operation];
      if (!method) return [];
      const params = { textDocument: { uri: source.uri }, ...(input.line ? { position: lspPosition(input) } : {}), ...(operation === 'references' ? { context: { includeDeclaration: true } } : {}) };
      return this.#normalize(session.root, await languageRequest(session, `textDocument/${method}`, params), session);
    }
    const { file, provider } = this.#file(project, input.path);
    const session = await this.#session(project, provider);
    await this.#syncDocument(session, file, input.content);
    this.#touch(session);
    const position = input.line ? { line: Math.max(0, input.line - 1), character: Math.max(0, (input.column || 1) - 1) } : undefined;
    const params = { textDocument: { uri: pathToFileURL(file).href }, ...(position ? { position } : {}) };
    const methods = {
      definition: 'textDocument/definition', declaration: 'textDocument/declaration', typeDefinition: 'textDocument/typeDefinition', implementation: 'textDocument/implementation',
      references: 'textDocument/references', hover: 'textDocument/hover', completion: 'textDocument/completion', documentSymbols: 'textDocument/documentSymbol',
    };
    if (!methods[operation]) throw Object.assign(new Error('不支持该代码导航操作'), { code: 'LOCAL_LSP_REQUEST_INVALID' });
    if (operation === 'references') params.context = { includeDeclaration: true };
    if (operation === 'completion') params.context = { triggerKind: 1 };
    let result = await languageRequest(session, methods[operation], params);
    if (provider === 'java' && operation === 'definition' && (!Array.isArray(result) || !result.length)) {
      await unrefDelay(250);
      result = await languageRequest(session, methods[operation], params);
      if (!Array.isArray(result) || !result.length) {
        const identifier = identifierAt(typeof input.content === 'string' ? input.content : fs.readFileSync(file, 'utf8'), input.line, input.column);
        if (identifier) {
          const symbols = this.#normalize(session.root, await languageRequest(session, 'workspace/symbol', { query: identifier }));
          const exact = (Array.isArray(symbols) ? symbols : []).map(flattenSymbolLocation).find((item) => item?.path && item.name === identifier && item.range);
          if (exact) result = [{ path: exact.path, range: exact.range }];
        }
      }
    }
    if (process.env.CODE_STUDIO_LSP_DEBUG === '1') process.stderr.write(`[language:${operation}] ${JSON.stringify(result)}\n`);
    return Array.isArray(result) && result.some((item) => item?.path) ? result : this.#normalize(session.root, result, session);
  }

  async javaSource(project, sourcePath) {
    const source = this.javaSources.get(`${project.id}:${sourcePath}`);
    if (!source) throw Object.assign(new Error('依赖源码引用无效，请从代码定义跳转打开'), { code: 'LOCAL_LSP_SOURCE_INVALID' });
    const session = await this.#session(project, 'java'); this.#touch(session);
    let content;
    if (source.uri.startsWith('file:')) {
      const file = fileURLToPath(source.uri);
      if (path.extname(file).toLowerCase() !== '.java' || fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('依赖源码文件无效或过大');
      content = fs.readFileSync(file, 'utf8');
    } else {
      try { const result = await languageRequest(session, 'workspace/textDocumentContent', { uri: source.uri }); content = typeof result === 'string' ? result : result?.text; }
      catch (error) { if (error.code !== -32601) throw error; content = await languageRequest(session, 'java/classFileContents', { uri: source.uri }); }
    }
    if (typeof content !== 'string' || !content.trim()) throw new Error('语言服务未返回依赖源码');
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('依赖源码内容过大');
    return { kind: 'text', mime: 'text/x-java-source', content, readOnly: true, version: crypto.createHash('sha256').update(content).digest('hex') };
  }

  async diagnostics(project, input = {}) {
    if (String(input.path).startsWith('@java-source/')) return [];
    const { file, provider } = this.#file(project, input.path); const session = await this.#session(project, provider);
    const uri = pathToFileURL(file).href; const before = session.diagnosticVersions.get(uri) || 0;
    await this.#syncDocument(session, file, input.content); this.#touch(session);
    if ((session.diagnosticVersions.get(uri) || 0) === before) await Promise.race([new Promise((resolve) => session.diagnosticWaiters.set(uri, resolve)), new Promise((resolve) => setTimeout(resolve, 1_500))]);
    return this.#normalize(session.root, session.diagnostics.get(uri) || []);
  }

  async rename(project, input = {}) {
    const { file, provider } = this.#file(project, input.path); const session = await this.#session(project, provider);
    await this.#syncDocument(session, file, input.content); this.#touch(session);
    if (typeof input.newName !== 'string' || !input.newName.trim() || input.newName.length > 200 || /[\r\n\0]/.test(input.newName)) throw Object.assign(new Error('新名称无效'), { code: 'LOCAL_LSP_REQUEST_INVALID' });
    const edit = await session.connection.sendRequest('textDocument/rename', { textDocument: { uri: pathToFileURL(file).href }, position: lspPosition(input), newName: input.newName });
    return this.#workspaceEdit(session.root, edit);
  }

  async codeActions(project, input = {}) {
    const { file, provider } = this.#file(project, input.path); const session = await this.#session(project, provider);
    await this.#syncDocument(session, file, input.content); this.#touch(session);
    const start = lspPosition(input); const end = { line: Math.max(start.line, Number(input.endLine || input.line) - 1), character: Math.max(0, Number(input.endColumn || input.column) - 1) };
    const diagnostics = Array.isArray(input.diagnostics) ? input.diagnostics.slice(0, 100) : [];
    const actions = await session.connection.sendRequest('textDocument/codeAction', { textDocument: { uri: pathToFileURL(file).href }, range: { start, end }, context: { diagnostics, only: ['quickfix'], triggerKind: 1 } });
    return (actions || []).slice(0, 100).map((action) => ({ title: action.title, kind: action.kind, isPreferred: action.isPreferred, disabled: action.disabled, edit: this.#workspaceEdit(session.root, action.edit) })).filter((action) => action.edit?.edits?.length);
  }

  async callHierarchy(project, operation, input = {}) {
    const targetPath = input.path || input.item?.path; const { file, provider } = this.#file(project, targetPath); const session = await this.#session(project, provider); this.#touch(session);
    let params;
    if (operation === 'prepare') { await this.#syncDocument(session, file, input.content); params = { textDocument: { uri: pathToFileURL(file).href }, position: lspPosition(input) }; }
    else params = { item: restoreLspItem(session.root, input.item) };
    const method = operation === 'prepare' ? 'textDocument/prepareCallHierarchy' : operation === 'incoming' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls';
    return this.#normalize(session.root, await session.connection.sendRequest(method, params));
  }

  async workspaceSymbols(project, query) {
    const providers = detectProviders(project.path); const results = await Promise.all(providers.map(async (provider) => {
      const session = await this.#session(project, provider); this.#touch(session);
      return this.#normalize(session.root, await session.connection.sendRequest('workspace/symbol', { query }));
    }));
    return results.flat().map(flattenSymbolLocation).filter(Boolean).slice(0, 500);
  }

  async prepareProject(project) {
    const providers = detectProviders(project.path);
    const results = await Promise.all(providers.map(async (provider) => {
      try { await this.#session(project, provider); return { provider, ready: true }; }
      catch (error) { return { provider, ready: false, message: error instanceof Error ? error.message : String(error) }; }
    }));
    return { providers: results };
  }

  async javaCommand(project, command, args = []) {
    if (!['vscode.java.resolveMainClass', 'vscode.java.resolveClasspath', 'vscode.java.buildWorkspace', 'vscode.java.startDebugSession', 'vscode.java.resolveJavaExecutable'].includes(command)) throw new Error('不支持的 Java 命令');
    const session = await this.#session(project, 'java'); this.#touch(session);
    return session.connection.sendRequest('workspace/executeCommand', { command, arguments: args });
  }

  async javaBuild(project, target, fullBuild = false) {
    const session = await this.#session(project, 'java'); this.#touch(session);
    session.buildMessages = [];
    // Scope the command to the selected entry, rather than omitting its project.
    const status = await this.javaCommand(project, 'vscode.java.buildWorkspace', [JSON.stringify({ mainClass: target.mainClass, projectName: target.projectName, isFullBuild: fullBuild })]);
    // JDT publishes build diagnostics asynchronously after the command reply.
    if (status !== 1) await unrefDelay(1000);
    const issues = [];
    for (const [uri, diagnostics] of session.diagnostics) {
      const relative = workspaceRelativePath(session.root, uri); if (!relative) continue;
      for (const diagnostic of diagnostics) if (diagnostic.severity === 1) issues.push({ path: relative, line: (diagnostic.range?.start?.line || 0) + 1, column: (diagnostic.range?.start?.character || 0) + 1, message: diagnostic.message });
    }
    return { status, issues: issues.slice(0, 200), messages: session.buildMessages.slice(-20) };
  }

  async saved(project, relativePath) {
    const provider = LANGUAGE_PROVIDERS.get(path.extname(relativePath).toLowerCase());
    const existing = this.sessions.get(`${project.id}:${provider}`);
    if (!existing) return;
    try {
      const session = await existing.ready; const { file } = this.#file(project, relativePath);
      await this.#syncDocument(session, file);
      await session.connection.sendNotification('textDocument/didSave', { textDocument: { uri: pathToFileURL(file).href } });
      await session.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(file).href, type: 2 }] });
    } catch { /* Saving to disk must not fail if a language server has exited. */ }
  }

  async retainJava(project) {
    const session = await this.#session(project, 'java');
    session.leases = (session.leases || 0) + 1; clearTimeout(session.timer);
    let released = false;
    return () => { if (released) return; released = true; session.leases--; this.#touch(session); };
  }

  async shutdown() { await Promise.all([...this.sessions.values()].map((session) => this.#stop(session))); }

  #file(project, relativePath) {
    if (!relativePath || typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\0')) throw Object.assign(new Error('文件路径无效'), { code: 'WORKSPACE_PATH_INVALID' });
    const root = fs.realpathSync(project.path); const candidate = path.resolve(root, relativePath);
    const file = fs.realpathSync(candidate);
    const provider = LANGUAGE_PROVIDERS.get(path.extname(file).toLowerCase());
    if (!file.startsWith(`${root}${path.sep}`) || !fs.statSync(file).isFile() || !provider) throw Object.assign(new Error('该文件暂不支持代码导航'), { code: 'WORKSPACE_PATH_INVALID' });
    return { file, provider };
  }

  async #session(project, provider) {
    const key = `${project.id}:${provider}`; const existing = this.sessions.get(key);
    if (existing) return existing.ready;
    const session = { key, projectId: project.id, provider, root: fs.realpathSync(project.path), documents: new Map(), diagnostics: new Map(), diagnosticVersions: new Map(), diagnosticWaiters: new Map(), version: 0, stopping: false };
    session.ready = this.#start(session);
    this.sessions.set(key, session);
    try { return await session.ready; } catch (error) { this.sessions.delete(key); throw error; }
  }

  async #start(session) {
    const invocation = languageServerInvocation(session, this.dataRoot, this.commands);
    const child = spawnGuarded(invocation.command, invocation.args, { cwd: session.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    session.child = child;
    child.stderr.on('data', (chunk) => { if (process.env.CODE_STUDIO_LSP_DEBUG === '1') process.stderr.write(chunk); });
    session.connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    session.connection.onRequest('workspace/configuration', (params) => (params?.items || []).map((item) => session.provider === 'java' && item?.section === 'java' ? javaSettings().java : {}));
    session.connection.onRequest('client/registerCapability', () => null);
    session.buildMessages = [];
    const rememberBuildMessage = (event) => { if (event?.type <= 2 && typeof event.message === 'string') { session.buildMessages.push(event.message.slice(0, 8000)); if (session.buildMessages.length > 50) session.buildMessages.shift(); } };
    session.connection.onNotification('window/logMessage', rememberBuildMessage);
    session.connection.onNotification('window/showMessage', rememberBuildMessage);
    let markJavaReady;
    const javaReady = session.provider === 'java' ? new Promise((resolve) => { markJavaReady = resolve; }) : Promise.resolve();
    session.connection.onNotification('language/status', (status) => { if (/serviceready/i.test(String(status?.message || ''))) markJavaReady?.(); });
    session.connection.onNotification('textDocument/publishDiagnostics', (params) => {
      session.diagnostics.set(params.uri, params.diagnostics || []);
      session.diagnosticVersions.set(params.uri, (session.diagnosticVersions.get(params.uri) || 0) + 1);
      const waiter = session.diagnosticWaiters.get(params.uri); session.diagnosticWaiters.delete(params.uri); waiter?.();
    });
    session.connection.listen();
    child.once('close', () => { if (!session.stopping && this.sessions.get(session.key) === session) this.sessions.delete(session.key); });
    await waitForLanguageServer(session.connection.sendRequest('initialize', {
      processId: null, rootUri: pathToFileURL(session.root).href,
      workspaceFolders: [{ uri: pathToFileURL(session.root).href, name: path.basename(session.root) }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, applyEdit: true, symbol: {} },
        textDocument: { definition: {}, declaration: {}, typeDefinition: {}, implementation: {}, references: {}, hover: {}, completion: { completionItem: { snippetSupport: false } }, documentSymbol: {}, callHierarchy: {}, publishDiagnostics: { relatedInformation: true }, synchronization: { didOpen: true, didChange: true } },
      },
      initializationOptions: session.provider === 'java'
        ? { settings: javaSettings(), bundles: [resolveJavaTool('java-debug.jar')], extendedClientCapabilities: { classFileContentsSupport: true, progressReportProvider: true } }
        : session.provider === 'vue'
          ? { typescript: { tsdk: path.dirname(require.resolve('typescript/lib/typescript.js')), disableAutoImportCache: false }, vue: { hybridMode: false } }
          : undefined,
    }), child, session.provider);
    await session.connection.sendNotification('initialized', {});
    if (session.provider === 'java') await session.connection.sendNotification('workspace/didChangeConfiguration', { settings: javaSettings() });
    if (session.provider === 'java') await Promise.race([javaReady, unrefDelay(15_000)]);
    this.#touch(session); return session;
  }

  async #syncDocument(session, file, suppliedContent) {
    const uri = pathToFileURL(file).href; const content = typeof suppliedContent === 'string' ? suppliedContent : fs.readFileSync(file, 'utf8');
    const current = session.documents.get(uri);
    if (current === undefined) {
      session.documents.set(uri, content); session.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: languageId(file), version: ++session.version, text: content } });
    } else if (current !== content) {
      session.documents.set(uri, content); session.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: ++session.version }, contentChanges: [{ text: content }] });
    }
  }

  #normalize(root, value, session) {
    if (Array.isArray(value)) return value.map((item) => this.#normalize(root, item, session)).filter((item) => item !== null);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'uri' || key === 'targetUri') && typeof item === 'string') {
        if (session?.provider === 'java' && (item.startsWith('jdt:') || (item.startsWith('file:') && !fileURLToPath(item).startsWith(`${root}${path.sep}`) && path.extname(fileURLToPath(item)).toLowerCase() === '.java'))) {
          const name = new URL(item).pathname.split('/').pop().replace(/\.class$/, '.java');
          const sourcePath = `@java-source/${crypto.createHash('sha256').update(item).digest('hex').slice(0, 24)}/${name}`;
          this.javaSources.set(`${session.projectId}:${sourcePath}`, { uri: item }); result.path = sourcePath; result.readOnly = true;
          continue;
        }
        try { const file = fileURLToPath(item); if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null; result.path = path.relative(root, file).split(path.sep).join('/'); } catch { return null; }
      } else result[key] = this.#normalize(root, item, session);
    }
    return result;
  }

  #workspaceEdit(root, edit) {
    if (!edit || typeof edit !== 'object') return { edits: [] };
    const edits = [];
    const append = (uri, values) => { const relativePath = workspaceRelativePath(root, uri); if (relativePath && Array.isArray(values)) edits.push({ path: relativePath, edits: values.slice(0, 10_000).map((item) => this.#normalize(root, item)) }); };
    for (const [uri, values] of Object.entries(edit.changes || {})) append(uri, values);
    for (const change of edit.documentChanges || []) if (change?.textDocument?.uri) append(change.textDocument.uri, change.edits);
    return { edits: edits.slice(0, 500) };
  }

  #touch(session) { clearTimeout(session.timer); if (session.leases > 0 || session.stopping) return; session.timer = setTimeout(() => void this.#stop(session), this.idleMs); session.timer.unref?.(); }
  async #stop(session) {
    if (session.stopping) return; session.stopping = true; clearTimeout(session.timer); this.sessions.delete(session.key);
    session.diagnosticWaiters.forEach((resolve) => resolve()); session.diagnosticWaiters.clear();
    try {
      await Promise.race([session.connection?.sendRequest('shutdown'), new Promise((resolve) => setTimeout(resolve, 1_000))]);
      await session.connection?.sendNotification('exit');
    } catch {}
    try { session.connection?.dispose(); } catch {}
    if (session.child && session.child.exitCode === null) {
      const closed = new Promise((resolve) => session.child.once('close', resolve)); session.child.kill();
      await Promise.race([closed, unrefDelay(3_000)]);
    }
  }
}

function languageId(file) { const extension = path.extname(file).toLowerCase(); if (extension === '.py') return 'python'; if (extension === '.java') return 'java'; if (extension === '.go') return 'go'; if (extension === '.rs') return 'rust'; if (extension === '.vue') return 'vue'; if (['.c', '.h'].includes(extension)) return 'c'; if (['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'].includes(extension)) return 'cpp'; return extension === '.ts' || extension === '.tsx' ? 'typescript' : 'javascript'; }
function languageRequest(session, method, params, timeoutMs = 15_000) {
  let timer;
  return Promise.race([
    session.connection.sendRequest(method, params),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${session.provider} 语言服务响应超时`), { code: 'LOCAL_LSP_TIMEOUT' })), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}
function lspPosition(input) { return { line: Math.max(0, Number(input.line || 1) - 1), character: Math.max(0, Number(input.column || 1) - 1) }; }
function workspaceRelativePath(root, uri) { try { const file = fileURLToPath(uri); if (!file.startsWith(`${root}${path.sep}`)) return null; return path.relative(root, file).split(path.sep).join('/'); } catch { return null; } }
function flattenSymbolLocation(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.path) return item;
  if (item.location?.path) return { ...item, path: item.location.path, range: item.location.range };
  return null;
}
function identifierAt(content, line, column) {
  const text = String(content || '').split(/\r?\n/)[Math.max(0, Number(line || 1) - 1)] || '';
  const index = Math.max(0, Math.min(text.length, Number(column || 1) - 1));
  const left = text.slice(0, index + 1).match(/[A-Za-z_$][\w$]*$/)?.[0] || '';
  const right = text.slice(index + 1).match(/^[\w$]*/)?.[0] || '';
  return `${left}${right}` || null;
}
function restoreLspItem(root, item) { if (!item?.path) throw Object.assign(new Error('调用层级项目无效'), { code: 'LOCAL_LSP_REQUEST_INVALID' }); const file = path.resolve(root, item.path); if (!file.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error('调用层级项目无效'), { code: 'LOCAL_LSP_REQUEST_INVALID' }); const { path: _path, ...rest } = item; return { ...rest, uri: pathToFileURL(file).href }; }

function languageServerInvocation(session, dataRoot, commands = {}) {
  if (session.provider === 'java') {
    const home = resolveJdtlsHome(); const plugins = path.join(home, 'plugins');
    const launcher = fs.readdirSync(plugins).find((name) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name));
    if (!launcher) throw Object.assign(new Error('Java 代码智能组件不完整，请重新安装客户端'), { code: 'LOCAL_LSP_UNAVAILABLE' });
    const baseConfig = process.platform === 'darwin' ? 'config_mac' : process.platform === 'win32' ? 'config_win' : 'config_linux';
    const configuration = path.join(home, process.arch === 'arm64' && process.platform !== 'win32' ? `${baseConfig}_arm` : baseConfig);
    const workspaceData = path.join(dataRoot, session.projectId); fs.mkdirSync(workspaceData, { recursive: true });
    return { command: 'java', args: [`-javaagent:${resolveJavaTool('lombok.jar')}`, '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Dlog.level=WARN', '-Xms256m', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', path.join(plugins, launcher), '-configuration', configuration, '-data', workspaceData] };
  }
  if (session.provider === 'clangd') return { command: commands.clangd || process.env.CODE_STUDIO_CLANGD_COMMAND || 'clangd', args: ['--background-index=false', '--clang-tidy=false', '--header-insertion=never'] };
  if (session.provider === 'gopls') return { command: commands.gopls || process.env.CODE_STUDIO_GOPLS_COMMAND || 'gopls', args: ['serve'] };
  if (session.provider === 'rust-analyzer') return { command: commands['rust-analyzer'] || process.env.CODE_STUDIO_RUST_ANALYZER_COMMAND || 'rust-analyzer', args: [] };
  if (session.provider === 'vue') {
    const configured = commands.vue || process.env.CODE_STUDIO_VUE_LANGUAGE_SERVER_COMMAND;
    if (configured) return { command: configured, args: ['--stdio'] };
    const cli = path.join(path.dirname(require.resolve('@vue/language-server/package.json')), 'bin', 'vue-language-server.js');
    const tsdk = path.dirname(require.resolve('typescript/lib/typescript.js'));
    return { command: process.execPath, args: [cli, '--stdio', `--tsdk=${tsdk}`] };
  }
  const cli = session.provider === 'python' ? path.join(path.dirname(require.resolve('pyright/package.json')), 'langserver.index.js') : path.join(path.dirname(require.resolve('typescript-language-server/package.json')), 'lib', 'cli.mjs');
  return { command: process.execPath, args: [cli, '--stdio'] };
}

function waitForLanguageServer(initialization, child, provider) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.off('error', onError); child.off('close', onClose);
      if (error) reject(Object.assign(new Error(`${provider} 语言服务无法启动：${error.message || error}`), { code: 'LOCAL_LSP_UNAVAILABLE' }));
      else resolve(value);
    };
    const onError = (error) => finish(error);
    const onClose = (code) => finish(new Error(`进程已退出（${code ?? 'unknown'}）`));
    const timer = setTimeout(() => finish(new Error('初始化超时')), 15_000);
    child.once('error', onError); child.once('close', onClose);
    Promise.resolve(initialization).then((value) => finish(null, value), (error) => finish(error));
  });
}

function resolveJdtlsHome() {
  const candidates = [process.env.CODE_STUDIO_JDTLS_HOME, process.resourcesPath && path.join(process.resourcesPath, 'jdtls'), path.resolve(__dirname, '..', '.cache', 'jdtls', '1.61.0')].filter(Boolean);
  const home = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'plugins')));
  if (!home) throw Object.assign(new Error('Java 代码智能组件尚未安装'), { code: 'LOCAL_LSP_UNAVAILABLE' });
  return home;
}

function resolveJavaTool(name) {
  const roots = [process.resourcesPath && path.join(process.resourcesPath, 'java-tools'), path.resolve(__dirname, '../.cache/java-tools')].filter(Boolean);
  const file = roots.map((root) => path.join(root, name)).find((file) => fs.existsSync(file));
  if (!file) throw new Error('Java 运行组件尚未安装，请执行 prepare-language-servers');
  return file;
}
function javaSettings() { return { java: { autobuild: { enabled: true }, import: { maven: { enabled: true }, gradle: { enabled: false } }, configuration: { updateBuildConfiguration: 'automatic' } } }; }
function unrefDelay(milliseconds) { return new Promise((resolve) => { const timer = setTimeout(resolve, milliseconds); timer.unref?.(); }); }

function detectProviders(root) {
  const found = new Set(); const pending = [root]; let visited = 0;
  while (pending.length && visited < 2_000) {
    const directory = pending.pop(); let entries = []; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > 2_000) break;
      if (entry.isDirectory() && !['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target'].includes(entry.name)) pending.push(path.join(directory, entry.name));
      else if (entry.isFile()) { const provider = LANGUAGE_PROVIDERS.get(path.extname(entry.name).toLowerCase()); if (provider) found.add(provider); }
    }
  }
  return found.size ? [...found] : ['typescript'];
}

module.exports = { LocalLspManager };
