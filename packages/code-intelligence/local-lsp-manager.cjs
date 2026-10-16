const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodeText } = require('./file-text.cjs');
const { supportsBashLanguage } = require('./shell-language.cjs');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const { spawnGuarded } = require('./guarded-process.cjs');
const { languageRequest, cancelLanguageRequests } = require('./language-request.cjs');
const { updateLanguageProgress, registerLanguageProgress } = require('./language-progress.cjs');
const { validChange, javaRelevant } = require('./workspace-change-scope.cjs');
const { buildConcurrency, sharedIndexArguments, flightRecordingArguments, garbageCollectorArguments } = require('./java-index-tuning.cjs');

const LANGUAGE_PROVIDERS = new Map([
  ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.js', 'typescript'], ['.jsx', 'typescript'], ['.mjs', 'typescript'], ['.cjs', 'typescript'], ['.py', 'python'], ['.java', 'java'],
  ['.c', 'clangd'], ['.h', 'clangd'], ['.cc', 'clangd'], ['.cpp', 'clangd'], ['.cxx', 'clangd'], ['.hh', 'clangd'], ['.hpp', 'clangd'], ['.hxx', 'clangd'],
  ['.go', 'gopls'], ['.rs', 'rust-analyzer'], ['.vue', 'vue'],
]);
function fileProvider(file) {
  return supportsBashLanguage(file) ? 'bash' : LANGUAGE_PROVIDERS.get(path.extname(file).toLowerCase());
}

class LocalLspManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.idleMs = options.idleMs || 10 * 60 * 1000;
    this.dataRoot = options.dataRoot || path.join(os.tmpdir(), 'code-studio-language-data');
    this.commands = options.commands || {};
    this.resources = options.resources || {};
    this.diagnosticJavaBundles = trustedJavaBundles(this.resources.diagnosticJavaBundles);
    this.javaGcArguments = garbageCollectorArguments(options.javaGcProfile);
    this.maxSessions = options.maxSessions || Infinity;
    this.javaSources = new Map();
    this.navigationCache = options.navigationCache;
    this.shuttingDown = false;
    this.javaInitializationMs = options.javaInitializationMs ?? 120_000;
    this.initializationMs = options.initializationMs ?? 15_000;
    this.javaReadyMs = options.javaReadyMs ?? 30_000;
    this.javaAutobuild = options.javaAutobuild !== false;
    // Restore/import cached projects before scheduling a workspace-wide build.
    this.deferJavaAutobuild = options.deferJavaAutobuild !== false;
    this.javaMaxConcurrentBuilds = buildConcurrency(options.javaMaxConcurrentBuilds);
    this.javaSharedIndexRoot = options.javaSharedIndexRoot;
    this.onLifecycle = options.onLifecycle;
    this.stoppingSessions = new Set();
    this.stoppingByKey = new Map();
    this.blockedRestarts = new Map();
    this.projectStatuses = new Map();
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
    const hasDirtyBuffers = () => [...this.sessions.values()].some((item) => item.projectId === project.id && [...item.documents].some(([uri, content]) => content !== item.diskContents?.get(uri)));
    let cacheContext;
    if (this.navigationCache && !hasDirtyBuffers()) {
      cacheContext = await this.navigationCache.navigationContext(project, operation, input).catch(() => null);
      const cached = cacheContext && !input.__skipCache ? await this.navigationCache.readNavigation(cacheContext).catch(() => undefined) : undefined;
      if (!input.__skipCache && cached?.length) {
        try {
          for (const item of cached) this.#file(project, item.path);
          return cached;
        } catch { this.navigationCache.forgetNavigation(cacheContext); }
      }
    }
    const session = await this.#session(project, provider);
    await this.#syncDocument(session, file, input.content);
    this.#touch(session);
    if (operation === 'completion-resolve') {
      const entry = session.completionItems?.get(input.item?.token);
      if (!entry || entry.file !== file || entry.content !== session.documents.get(pathToFileURL(file).href) || Date.now() - entry.created > 120_000) return null;
      if (!session.capabilities?.completionProvider?.resolveProvider) return entry.item;
      return await languageRequest(session, 'completionItem/resolve', entry.item);
    }
    if (operation === 'format') return await languageRequest(session, 'textDocument/formatting', { textDocument: { uri: pathToFileURL(file).href }, options: { tabSize: 4, insertSpaces: true } });
    const position = input.line ? { line: Math.max(0, input.line - 1), character: Math.max(0, (input.column || 1) - 1) } : undefined;
    const params = { textDocument: { uri: pathToFileURL(file).href }, ...(position ? { position } : {}) };
    const methods = {
      definition: 'textDocument/definition', declaration: 'textDocument/declaration', typeDefinition: 'textDocument/typeDefinition', implementation: 'textDocument/implementation',
      references: 'textDocument/references', hover: 'textDocument/hover', completion: 'textDocument/completion', documentSymbols: 'textDocument/documentSymbol',
    };
    if (!methods[operation]) throw Object.assign(new Error('不支持该代码导航操作'), { code: 'LOCAL_LSP_REQUEST_INVALID' });
    if (operation === 'references') params.context = { includeDeclaration: true };
    if (operation === 'completion') params.context = { triggerKind: 1 };
    if (provider === 'typescript' && ['implementation', 'references'].includes(operation)) {
      // didOpen is acknowledged before tsserver has loaded the configured
      // project's complete graph. Ensure it exists before cross-file queries,
      // without opening every source file or transferring a huge filename list.
      session.projectGraphs ||= new Map();
      const uri = params.textDocument.uri;
      if (!session.projectGraphs.has(uri)) {
        const ready = languageRequest(session, 'workspace/executeCommand', {
          command: 'typescript.tsserverRequest', arguments: ['projectInfo', { file: uri, needFileNameList: false }, {}],
        }).catch(() => { session.projectGraphs.delete(uri); });
        session.projectGraphs.set(uri, ready);
      }
      await session.projectGraphs.get(uri);
    }
    let result;
    try { result = await languageRequest(session, methods[operation], params); }
    catch (error) {
      // Some servers (including TypeScript) expose declaration locations via
      // definition only. Do not substitute a definition for a type/implementation.
      if (operation !== 'declaration' || error.code !== -32601) throw error;
      result = await languageRequest(session, methods.definition, params);
    }
    if (provider === 'typescript' && operation === 'definition') {
      // TypeScript's ordinary definition may stop at the local import alias.
      // Its source-definition command resolves the implementation instead.
      const sourceDefinition = await languageRequest(session, 'workspace/executeCommand', {
        command: '_typescript.goToSourceDefinition', arguments: [params.textDocument.uri, position],
      }).catch(() => null);
      if (Array.isArray(sourceDefinition) && sourceDefinition.length) result = sourceDefinition;
    }
    if (provider === 'java' && operation === 'definition' && (!Array.isArray(result) || !result.length)) {
      await unrefDelay(250);
      result = await languageRequest(session, methods[operation], params);
      if (!Array.isArray(result) || !result.length) {
        const identifier = identifierAt(typeof input.content === 'string' ? input.content : decodeText(fs.readFileSync(file)).content, input.line, input.column);
        if (identifier) {
          const symbols = this.#normalize(session.root, await languageRequest(session, 'workspace/symbol', { query: identifier }));
          const exact = (Array.isArray(symbols) ? symbols : []).map(flattenSymbolLocation).find((item) => item?.path && item.name === identifier && item.range);
          if (exact) result = [{ path: exact.path, range: exact.range }];
        }
      }
    }
    if (operation === 'completion') {
      session.completionItems ||= new Map();
      const items = Array.isArray(result) ? result : result?.items || [];
      const proposals = items.slice(0, 500).map(item => {
        const token = crypto.randomBytes(18).toString('hex');
        session.completionItems.set(token, { item, file, content: session.documents.get(params.textDocument.uri), created: Date.now() });
        return { ...item, resolveToken: token };
      });
      while (session.completionItems.size > 1500) session.completionItems.delete(session.completionItems.keys().next().value);
      return Array.isArray(result) ? proposals : { ...result, items: proposals };
    }
    if (process.env.CODE_STUDIO_LSP_DEBUG === '1') process.stderr.write(`[language:${operation}] ${JSON.stringify(result)}\n`);
    const normalized = Array.isArray(result) && result.some((item) => item?.path) ? result : this.#normalize(session.root, result, session);
    if (cacheContext && !hasDirtyBuffers()) await this.navigationCache.setNavigation(project, operation, { ...input, content: session.documents.get(params.textDocument.uri) }, normalized, cacheContext.revision).catch(() => {});
    return normalized;
  }

  async javaSource(project, sourcePath) {
    const source = this.javaSources.get(`${project.id}:${sourcePath}`);
    if (!source) throw Object.assign(new Error('依赖源码引用无效，请从代码定义跳转打开'), { code: 'LOCAL_LSP_SOURCE_INVALID' });
    const session = await this.#session(project, 'java'); this.#touch(session);
    let content;
    if (source.uri.startsWith('file:')) {
      const file = fileURLToPath(source.uri);
      if (path.extname(file).toLowerCase() !== '.java' || fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('依赖源码文件无效或过大');
      content = decodeText(fs.readFileSync(file)).content;
    } else {
      try { const result = await languageRequest(session, 'workspace/textDocumentContent', { uri: source.uri }); content = typeof result === 'string' ? result : result?.text; }
      catch (error) { if (error.code !== -32601) throw error; content = await languageRequest(session, 'java/classFileContents', { uri: source.uri }); }
    }
    if (typeof content !== 'string' || !content.trim()) throw new Error('语言服务未返回依赖源码');
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('依赖源码内容过大');
    return { kind: 'text', mime: 'text/x-java-source', content, readOnly: true, version: crypto.createHash('sha256').update(content).digest('hex') };
  }

  async syncDocuments(project, documents = []) {
    for (const document of documents) {
      const { file, provider } = this.#file(project, document.path);
      const session = await this.#session(project, provider);
      await this.#syncDocument(session, file, document.content);
      this.#touch(session);
    }
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
    const edit = await languageRequest(session, 'textDocument/rename', { textDocument: { uri: pathToFileURL(file).href }, position: lspPosition(input), newName: input.newName });
    const result = this.#workspaceEdit(session.root, edit);
    if (provider === 'java') {
      // Some servers omit RenameFile when the client does not advertise file
      // operations. Never silently rename a top-level Java type but leave its
      // filename unchanged: that creates a project which no longer compiles.
      for (const change of result.edits) {
        const target = path.join(session.root, change.path);
        const stem = path.basename(target, '.java');
        if (!target.endsWith('.java') || stem === input.newName) continue;
        const content = session.documents.get(pathToFileURL(target).href) ?? decodeText(await fs.promises.readFile(target)).content;
        const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = new RegExp(`\\b(?:class|interface|enum|record)\\s+(${escaped})\\b`).exec(content);
        if (!match) continue;
        const offset = match.index + match[0].lastIndexOf(stem);
        const prefix = content.slice(0, offset).split('\n');
        const line = prefix.length - 1; const character = prefix.at(-1).length;
        if (change.edits.some((item) => item?.range?.start?.line === line && item.range.start.character <= character && item.range.end.line >= line && (item.range.end.line > line || item.range.end.character >= character + stem.length))) {
          throw refactorError('Java 类型重命名需要同步重命名源码文件，当前尚不支持；未应用任何修改');
        }
      }
    }
    return result;
  }

  async codeActions(project, input = {}) {
    if (String(input.path).startsWith('@java-source/')) return [];
    const { file, provider } = this.#file(project, input.path); const session = await this.#session(project, provider);
    await this.#syncDocument(session, file, input.content); this.#touch(session);
    const start = lspPosition(input); const end = { line: Math.max(start.line, Number(input.endLine || input.line) - 1), character: Math.max(0, Number(input.endColumn || input.column) - 1) };
    const diagnostics = Array.isArray(input.diagnostics) ? input.diagnostics.slice(0, 100) : [];
    const actions = await languageRequest(session, 'textDocument/codeAction', { textDocument: { uri: pathToFileURL(file).href }, range: { start, end }, context: { diagnostics, only: ['quickfix'], triggerKind: 1 } });
    return (actions || []).slice(0, 100).map((action) => ({ title: action.title, kind: action.kind, isPreferred: action.isPreferred, disabled: action.disabled, edit: this.#workspaceEdit(session.root, action.edit) })).filter((action) => action.edit?.edits?.length);
  }

  async callHierarchy(project, operation, input = {}) {
    const targetPath = input.path || input.item?.path; const { file, provider } = this.#file(project, targetPath); const session = await this.#session(project, provider); this.#touch(session);
    let params;
    if (operation === 'prepare') { await this.#syncDocument(session, file, input.content); params = { textDocument: { uri: pathToFileURL(file).href }, position: lspPosition(input) }; }
    else params = { item: restoreLspItem(session.root, input.item) };
    const method = operation === 'prepare' ? 'textDocument/prepareCallHierarchy' : operation === 'incoming' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls';
    return this.#normalize(session.root, await languageRequest(session, method, params));
  }

  async workspaceSymbols(project, query) {
    const providers = detectProviders(project.path); const results = await Promise.all(providers.map(async (provider) => {
      const session = await this.#session(project, provider); this.#touch(session);
      return this.#normalize(session.root, await languageRequest(session, 'workspace/symbol', { query }));
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

  projectStatus(project) {
    return { providers: [...this.projectStatuses.values()].filter((item) => item.projectId === project.id).map(({ startedAt, ...item }) => {
      const session = this.sessions.get(`${item.projectId}:${item.provider}`);
      return { ...item, elapsedMs: Math.round(performance.now() - startedAt), ...(session?.startupTimings ? { startupTimings: { ...session.startupTimings }, backgroundTasks: session.progressTasks?.size || 0 } : {}) };
    }) };
  }

  async javaCommand(project, command, args = []) {
    if (!['java.project.getSettings', 'vscode.java.resolveMainClass', 'vscode.java.resolveClasspath', 'vscode.java.buildWorkspace', 'vscode.java.startDebugSession', 'vscode.java.resolveJavaExecutable'].includes(command)) throw new Error('不支持的 Java 命令');
    const session = await this.#session(project, 'java'); this.#touch(session);
    // Builds are intentionally allowed a longer budget than interactive queries.
    // All commands participate in shutdown cancellation, including main discovery.
    const timeoutMs = command === 'vscode.java.buildWorkspace' ? 600_000 : command === 'vscode.java.startDebugSession' ? 60_000 : session.requestTimeoutMs ?? 15_000;
    return languageRequest(session, 'workspace/executeCommand', { command, arguments: args }, timeoutMs);
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
    const provider = fileProvider(relativePath);
    const existing = this.sessions.get(`${project.id}:${provider}`);
    if (!existing) return;
    try {
      const session = await existing.ready; const { file } = this.#file(project, relativePath);
      await this.#syncDocument(session, file);
      await session.connection.sendNotification('textDocument/didSave', { textDocument: { uri: pathToFileURL(file).href } });
      await session.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(file).href, type: 2 }] });
    } catch { /* Saving to disk must not fail if a language server has exited. */ }
  }

  async workspaceChanged(project, changes) {
    // Only notify running servers; a periodic scan must not start idle runtimes.
    const root = fs.realpathSync(project.path);
    const validChanges = changes.filter(validChange);
    await Promise.all([...this.sessions.values()].filter((session) => session.projectId === project.id).map(async (entry) => {
      try {
        const relevant = entry.provider === 'java' ? validChanges.filter(javaRelevant) : validChanges;
        if (!relevant.length) return;
        const files = relevant.map(item => ({ uri: pathToFileURL(path.resolve(root, item.path)).href, type: item.type }));
        const session = await entry.ready;
        session.projectGraphs?.clear();
        for (const change of relevant) {
          if (change.type !== 2) continue;
          const file = path.resolve(root, change.path);
          const uri = pathToFileURL(file).href;
          const previous = session.documents.get(uri);
          if (previous === undefined || previous !== session.diskContents?.get(uri)) continue;
          try {
            const actual = await fs.promises.realpath(file);
            if (!actual.startsWith(`${root}${path.sep}`)) continue;
            const stat = await fs.promises.stat(actual);
            const content = decodeText(await fs.promises.readFile(actual)).content;
            if (session.documents.get(uri) !== previous || session.diskContents.get(uri) !== previous) continue;
            session.diskContents.set(uri, content);
            session.diskVersions.set(uri, `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
            session.documents.set(uri, content);
            await session.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: ++session.version }, contentChanges: [{ text: content }] });
          } catch { /* Removed or unavailable files still receive a watcher event. */ }
        }
        for (let offset = 0; offset < files.length; offset += 200)
          await session.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: files.slice(offset, offset + 200) });
      } catch { /* A stopped language service is refreshed when opened again. */ }
    }));
  }

  async retainJava(project) {
    const session = await this.#session(project, 'java');
    session.leases = (session.leases || 0) + 1; clearTimeout(session.timer);
    let released = false;
    return () => { if (released) return; released = true; session.leases--; this.#touch(session); };
  }

  async refreshNavigation(project, queries) {
    for (const input of queries) {
      const provider = fileProvider(input.path);
      if (this.shuttingDown || !this.sessions.has(`${project.id}:${provider}`)) continue;
      await this.request(project, input.operation, { ...input, __skipCache: true }).catch(() => {});
    }
  }

  async shutdown() { this.shuttingDown = true; await Promise.all([...this.sessions.values()].map((session) => this.#stop(session)).concat([...this.stoppingSessions])); }

  #file(project, relativePath) {
    if (!relativePath || typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\0')) throw Object.assign(new Error('文件路径无效'), { code: 'WORKSPACE_PATH_INVALID' });
    const root = fs.realpathSync(project.path); const candidate = path.resolve(root, relativePath);
    const file = fs.realpathSync(candidate);
    const provider = fileProvider(file);
    if (!file.startsWith(`${root}${path.sep}`) || !fs.statSync(file).isFile() || !provider) throw Object.assign(new Error('该文件暂不支持代码导航'), { code: 'WORKSPACE_PATH_INVALID' });
    return { file, provider };
  }

  async #session(project, provider) {
    if (this.shuttingDown) throw Object.assign(new Error('语言服务正在关闭'), { code: 'LOCAL_LSP_UNAVAILABLE' });
    const key = `${project.id}:${provider}`;
    // A replacement must never open the same persistent workspace while its
    // previous JVM is flushing indexes or still holding the workspace lock.
    const stopping = this.stoppingByKey.get(key);
    if (stopping) await stopping;
    if (this.shuttingDown) throw Object.assign(new Error('语言服务正在关闭'), { code: 'LOCAL_LSP_UNAVAILABLE' });
    if (this.blockedRestarts.has(key)) throw Object.assign(new Error('上一代码智能进程尚未退出，请稍后重试；可以继续编辑'), { code: 'LOCAL_LSP_UNAVAILABLE' });
    const existing = this.sessions.get(key);
    if (existing) return existing.ready;
    if (this.sessions.size >= this.maxSessions) throw Object.assign(new Error('语言服务繁忙，请稍后重试'), { code: 'LSP_CAPACITY_EXCEEDED' });
    const session = { key, projectId: project.id, provider, resources: { ...this.resources, sharedIndexRoot: this.javaSharedIndexRoot, javaGcArguments: this.javaGcArguments }, root: fs.realpathSync(project.path), documents: new Map(), diagnostics: new Map(), diagnosticVersions: new Map(), diagnosticWaiters: new Map(), version: 0, stopping: false };
    session.ready = this.#start(session);
    this.sessions.set(key, session);
    try { return await session.ready; } catch (error) {
      await this.#stop(session);
      this.projectStatuses.set(key, { projectId: project.id, provider, phase: 'failed', startedAt: session.startedAt, message: '代码智能暂未就绪，可继续编辑或重试', code: error.code || 'LOCAL_LSP_UNAVAILABLE' });
      throw error;
    }
  }

  async #start(session) {
    session.startedAt = performance.now();
    session.startupTimings = {};
    session.javaAutobuildEnabled = this.javaAutobuild && !this.deferJavaAutobuild;
    this.#lifecycle(session, 'spawn');
    const invocation = languageServerInvocation(session, this.dataRoot, this.commands);
    // Keep the guardian's environment isolation: only forward executable lookup
    // variables, not API tokens or database credentials from the API process.
    const env = { PATH: process.env.PATH || process.env.Path || (process.platform === 'win32' ? '' : '/usr/bin:/bin') };
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const child = spawnGuarded(invocation.command, invocation.args, { cwd: session.root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    session.child = child;
    child.stderr.on('data', (chunk) => {
      const marker = 'CODE_STUDIO_INDEX_GUARD_APPLIED';
      if (session.resources.indexThreadGuardJar && !session.indexGuardApplied) {
        const text = (session.guardMarkerTail || '') + chunk.toString('utf8');
        session.guardMarkerTail = text.slice(-(marker.length - 1));
        if (text.includes(marker)) { session.indexGuardApplied = true; session.guardMarkerTail = ''; this.#lifecycle(session, 'index-guard-applied'); }
      }
      if (process.env.CODE_STUDIO_LSP_DEBUG === '1') process.stderr.write(chunk);
    });
    session.connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    session.connection.onRequest('workspace/configuration', (params) => (params?.items || []).map((item) => session.provider === 'java' && item?.section === 'java' ? javaSettings(session.javaAutobuildEnabled, this.javaMaxConcurrentBuilds).java : session.provider === 'bash' && item?.section === 'bashIde' ? bashSettings() : {}));
    session.connection.onRequest('client/registerCapability', () => null);
    session.connection.onRequest('window/workDoneProgress/create', () => null);
    registerLanguageProgress(session.connection, progress => updateLanguageProgress(
      session, this.projectStatuses.get(session.key), progress,
      (event, fields) => this.#lifecycle(session, event, fields),
    ));
    session.buildMessages = [];
    const rememberBuildMessage = (event) => { if (event?.type <= 2 && typeof event.message === 'string') { session.buildMessages.push(event.message.slice(0, 8000)); if (session.buildMessages.length > 50) session.buildMessages.shift(); } };
    session.connection.onNotification('window/logMessage', rememberBuildMessage);
    session.connection.onNotification('window/showMessage', rememberBuildMessage);
    let markJavaReady;
    const javaReady = session.provider === 'java' ? new Promise((resolve) => { markJavaReady = resolve; }) : Promise.resolve();
    session.connection.onNotification('language/status', (status) => {
      this.#lifecycle(session, 'java-status', { status: String(status?.type || '').slice(0, 80) });
      if (/serviceready/i.test(`${status?.type || ''} ${status?.message || ''}`)) {
        if (session.serviceReady) return; // Replay must not restart readiness timing/build activation.
        session.serviceReady = true;
        this.#lifecycle(session, 'project-ready'); markJavaReady?.();
        if (this.javaAutobuild && !session.javaAutobuildEnabled && !session.stopping && !this.shuttingDown) {
          session.javaAutobuildEnabled = true;
          session.autobuildActivation = session.connection.sendNotification('workspace/didChangeConfiguration', { settings: javaSettings(true, this.javaMaxConcurrentBuilds) })
            .then(() => this.#lifecycle(session, 'autobuild-enabled'))
            .catch(() => { session.javaAutobuildEnabled = false; this.#lifecycle(session, 'autobuild-enable-failed'); });
        }
      }
    });
    session.connection.onNotification('textDocument/publishDiagnostics', (params) => {
      session.diagnostics.set(params.uri, params.diagnostics || []);
      session.diagnosticVersions.set(params.uri, (session.diagnosticVersions.get(params.uri) || 0) + 1);
      const waiter = session.diagnosticWaiters.get(params.uri); session.diagnosticWaiters.delete(params.uri); waiter?.();
      const bashWaiter = session.bashDocumentWaiters?.get(params.uri);
      if (bashWaiter && params.version >= bashWaiter.version) {
        session.bashDocumentWaiters.delete(params.uri); bashWaiter.resolve();
      }
    });
    session.connection.listen();
    child.once('close', () => {
      if (!session.stopping && this.sessions.get(session.key) === session) {
        this.sessions.delete(session.key);
        this.projectStatuses.set(session.key, { projectId: session.projectId, provider: session.provider, startedAt: session.startedAt, phase: 'failed', message: '代码智能暂未就绪，可继续编辑或重试' });
      }
    });
    this.#lifecycle(session, 'initialize-sent');
    const initialized = await waitForLanguageServer(session.connection.sendRequest('initialize', {
      processId: null, rootUri: pathToFileURL(session.root).href,
      workspaceFolders: [{ uri: pathToFileURL(session.root).href, name: path.basename(session.root) }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, applyEdit: false, symbol: {} },
        textDocument: { definition: { linkSupport: true }, declaration: {}, typeDefinition: {}, implementation: {}, references: {}, hover: {}, completion: { completionItem: { snippetSupport: true, resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] } } }, documentSymbol: {}, callHierarchy: {}, publishDiagnostics: { relatedInformation: true }, synchronization: { didOpen: true, didChange: true } },
      },
      initializationOptions: session.provider === 'java'
        ? { settings: javaSettings(session.javaAutobuildEnabled, this.javaMaxConcurrentBuilds), bundles: [resolveJavaTool('java-debug.jar', session.resources), ...this.diagnosticJavaBundles], extendedClientCapabilities: { classFileContentsSupport: true, progressReportProvider: true, shouldLanguageServerExitOnShutdown: true } }
        : session.provider === 'vue'
          ? { typescript: { tsdk: path.dirname(require.resolve('typescript/lib/typescript.js')), disableAutoImportCache: false }, vue: { hybridMode: false } }
          : session.provider === 'bash'
            ? bashSettings()
            : undefined,
    }), child, session.provider, session.provider === 'java' ? this.javaInitializationMs : this.initializationMs);
    session.capabilities = initialized?.capabilities || {};
    if (session.stopping || this.shuttingDown) throw Object.assign(new Error('语言服务正在关闭'), { code: 'LOCAL_LSP_UNAVAILABLE' });
    this.#lifecycle(session, 'initialize-complete');
    await session.connection.sendNotification('initialized', {});
    if (session.provider === 'java') await session.connection.sendNotification('workspace/didChangeConfiguration', { settings: javaSettings(session.javaAutobuildEnabled, this.javaMaxConcurrentBuilds) });
    if (session.provider === 'java') await Promise.race([javaReady, unrefDelay(this.javaReadyMs)]);
    // Only await writing the configuration notification, never a build job.
    if (session.autobuildActivation) await session.autobuildActivation;
    if (session.stopping || this.shuttingDown) throw Object.assign(new Error('语言服务正在关闭'), { code: 'LOCAL_LSP_UNAVAILABLE' });
    this.#lifecycle(session, 'ready');
    this.#touch(session); return session;
  }

  async #syncDocument(session, file, suppliedContent) {
    const uri = pathToFileURL(file).href;
    session.diskContents ||= new Map();
    session.diskVersions ||= new Map();
    const stat = await fs.promises.stat(file);
    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (session.diskVersions.get(uri) !== stamp) {
      session.diskContents.set(uri, decodeText(await fs.promises.readFile(file)).content);
      session.diskVersions.set(uri, stamp);
    }
    const content = typeof suppliedContent === 'string' ? suppliedContent : session.diskContents.get(uri);
    const current = session.documents.get(uri);
    let bashReady;
    let bashWaiter;
    if (session.provider === 'bash' && current !== content) {
      session.bashDocumentWaiters ||= new Map();
      bashReady = new Promise(resolve => { bashWaiter = { version: session.version + 1, resolve }; session.bashDocumentWaiters.set(uri, bashWaiter); });
      bashWaiter.promise = bashReady;
    } else if (session.provider === 'bash') {
      bashWaiter = session.bashDocumentWaiters?.get(uri);
      bashReady = bashWaiter?.promise;
    }
    if (current === undefined) {
      session.documents.set(uri, content); session.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: languageId(file), version: ++session.version, text: content } });
    } else if (current !== content) {
      session.documents.set(uri, content); session.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: ++session.version }, contentChanges: [{ text: content }] });
    }
    // Bash initializes its analyzer asynchronously after `initialized`. Wait for
    // this document version, not a fixed delay or a stale result from disk.
    if (bashReady) {
      try { await boundedWait(bashReady, 5000); }
      catch { throw Object.assign(new Error('Shell 文件正在分析，请稍后重试'), { code: 'LOCAL_LSP_TIMEOUT' }); }
      finally { if (session.bashDocumentWaiters.get(uri) === bashWaiter) session.bashDocumentWaiters.delete(uri); }
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
    if ((edit.documentChanges || []).some((change) => change?.kind)) throw refactorError('该重构需要创建、删除或重命名文件，当前尚不支持；未应用任何修改');
    const edits = [];
    const append = (uri, values) => {
      const relativePath = workspaceRelativePath(root, uri);
      if (!relativePath || !Array.isArray(values)) throw refactorError('重构包含工作区外或无效的文件，未应用修改');
      if (values.length > 10_000) throw refactorError('单文件重构修改数量超过上限，未应用修改');
      edits.push({ path: relativePath, edits: values.map((item) => this.#normalize(root, item)) });
    };
    for (const [uri, values] of Object.entries(edit.changes || {})) append(uri, values);
    for (const change of edit.documentChanges || []) if (change?.textDocument?.uri) append(change.textDocument.uri, change.edits);
    if (edits.length > 100) throw refactorError('重构涉及超过 100 个文件，未应用修改');
    return { edits };
  }

  #touch(session) { clearTimeout(session.timer); if (session.leases > 0 || session.stopping) return; session.timer = setTimeout(() => void this.#stop(session), this.idleMs); session.timer.unref?.(); }
  #lifecycle(session, event, extra = {}) {
    const elapsedMs = Math.round(performance.now() - session.startedAt);
    if (session.startupTimings) {
      if (event === 'initialize-sent') session.initializeSentMs = elapsedMs;
      if (event === 'initialize-complete') {
        session.initializedMs = elapsedMs;
        session.startupTimings.protocolInitializationMs = Math.max(0, elapsedMs - (session.initializeSentMs || 0));
        if (session.startupTimings.serviceReadyMs !== undefined) session.startupTimings.projectImportMs = Math.max(0, session.startupTimings.serviceReadyMs - elapsedMs);
      }
      if (event === 'project-ready' && session.startupTimings.serviceReadyMs === undefined) {
        session.startupTimings.serviceReadyMs = elapsedMs;
        // Some servers send ServiceReady before the initialize response.
        if (session.initializedMs !== undefined) session.startupTimings.projectImportMs = Math.max(0, elapsedMs - session.initializedMs);
      }
      if (event === 'autobuild-enabled') session.startupTimings.autobuildEnabledMs = elapsedMs;
    }
    const phases = { spawn: ['initializing', '正在启动代码智能'], 'initialize-complete': ['importing', '正在加载项目与缓存索引'], 'project-ready': ['ready', '代码智能已就绪'], ready: ['ready', '代码智能已就绪'], stopped: ['idle', '代码智能已暂停，使用时自动恢复'] };
    const next = phases[event];
    if (next) {
      const indexing = ['ready', 'project-ready'].includes(event) && session.progressTasks?.size;
      const importing = event === 'ready' && session.provider === 'java' && !session.serviceReady;
      this.projectStatuses.set(session.key, { projectId: session.projectId, provider: session.provider, startedAt: session.startedAt, phase: importing ? 'importing' : indexing ? 'indexing' : next[0], message: importing ? '正在加载项目与缓存索引' : indexing ? '正在更新项目索引' : next[1] });
    }
    try { this.onLifecycle?.({ component: 'language-service', provider: session.provider, projectId: session.projectId, event, elapsedMs, ...(['initialize-complete', 'project-ready', 'autobuild-enabled'].includes(event) ? { startupTimings: { ...session.startupTimings } } : {}), ...extra }); } catch {}
  }
  #stop(session) {
    if (session.stopPromise) return session.stopPromise;
    // Publish the barrier before stop callbacks can request a replacement.
    session.stopPromise = Promise.resolve().then(() => this.#stopSession(session));
    this.stoppingSessions.add(session.stopPromise);
    this.stoppingByKey.set(session.key, session.stopPromise);
    session.stopPromise.finally(() => {
      this.stoppingSessions.delete(session.stopPromise);
      if (this.stoppingByKey.get(session.key) === session.stopPromise) this.stoppingByKey.delete(session.key);
    }).catch(() => {});
    return session.stopPromise;
  }
  async #stopSession(session) {
    session.stopping = true; clearTimeout(session.timer); this.sessions.delete(session.key);
    cancelLanguageRequests(session);
    const startedAt = performance.now();
    let forced = false;
    this.#lifecycle(session, 'shutdown-request');
    let exited = !session.child || session.child.exitCode !== null || session.child.signalCode !== null;
    const closed = exited ? Promise.resolve() : new Promise((resolve) => session.child.once('close', () => { exited = true; resolve(); }));
    if (session.provider === 'java') for (const key of this.javaSources.keys()) if (key.startsWith(`${session.projectId}:`)) this.javaSources.delete(key);
    session.diagnosticWaiters.forEach((resolve) => resolve()); session.diagnosticWaiters.clear();
    session.bashDocumentWaiters?.forEach(waiter => waiter.resolve()); session.bashDocumentWaiters?.clear();
    try {
      await boundedWait(session.connection?.sendRequest('shutdown'), session.provider === 'java' ? 20_000 : 5_000);
      this.#lifecycle(session, 'shutdown-reply');
      await session.connection?.sendNotification('exit');
      this.#lifecycle(session, 'exit-sent');
      // Keep stdout alive for the final flush, but deliver EOF on stdin so the
      // server's JSON-RPC reader cannot keep the JVM alive after `exit`.
      session.child?.stdin?.end();
    } catch { this.#lifecycle(session, 'shutdown-timeout-or-error'); }
    await boundedWait(closed, session.provider === 'java' ? 10_000 : 2_000).catch(() => {});
    if (!exited && session.child) {
      forced = true;
      this.#lifecycle(session, 'force-terminate');
      session.child.kill();
      await boundedWait(closed, 4_000).catch(() => {});
    }
    try { session.connection?.dispose(); } catch {}
    this.#lifecycle(session, 'stopped', { durationMs: Math.round(performance.now() - startedAt), forced, exited });
    if (!exited) {
      // Completion of a bounded stop procedure is not evidence that the child
      // actually exited. Retain a per-workspace fence until the close event.
      const marker = {};
      this.blockedRestarts.set(session.key, marker);
      this.projectStatuses.set(session.key, { projectId: session.projectId, provider: session.provider, startedAt: session.startedAt, phase: 'failed', message: '上一代码智能进程尚未退出，可以继续编辑，稍后重试' });
      this.#lifecycle(session, 'restart-blocked');
      closed.then(() => { if (this.blockedRestarts.get(session.key) === marker) this.blockedRestarts.delete(session.key); });
    }
  }
}

function languageId(file) { if (supportsBashLanguage(file)) return 'shellscript'; const extension = path.extname(file).toLowerCase(); if (extension === '.py') return 'python'; if (extension === '.java') return 'java'; if (extension === '.go') return 'go'; if (extension === '.rs') return 'rust'; if (extension === '.vue') return 'vue'; if (['.c', '.h'].includes(extension)) return 'c'; if (['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'].includes(extension)) return 'cpp'; return extension === '.ts' || extension === '.tsx' ? 'typescript' : 'javascript'; }
function lspPosition(input) { return { line: Math.max(0, Number(input.line || 1) - 1), character: Math.max(0, Number(input.column || 1) - 1) }; }
function workspaceRelativePath(root, uri) { try { const file = fileURLToPath(uri); if (!file.startsWith(`${root}${path.sep}`)) return null; return path.relative(root, file).split(path.sep).join('/'); } catch { return null; } }
function refactorError(message) { return Object.assign(new Error(message), { code: 'LOCAL_LSP_REFACTOR_UNSUPPORTED' }); }
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

function bashSettings() {
  return { explainshellEndpoint: '', shellcheckExternalSources: false, backgroundAnalysisMaxFiles: 2000, globPattern: '**/{*.sh,*.bash,mvnw,gradlew,.bashrc,.bash_profile,.profile}' };
}
function languageServerInvocation(session, dataRoot, commands = {}) {
  if (session.provider === 'bash') {
    const configured = commands.bash || process.env.CODE_STUDIO_BASH_LANGUAGE_SERVER_COMMAND;
    if (configured) return { command: configured, args: ['start'] };
    const cli = path.join(path.dirname(require.resolve('bash-language-server/package.json')), 'out', 'cli.js');
    return { command: process.execPath, args: [cli, 'start'] };
  }
  if (session.provider === 'java') {
    const home = resolveJdtlsHome(session.resources); const plugins = path.join(home, 'plugins');
    const launcher = fs.readdirSync(plugins).find((name) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name));
    if (!launcher) throw Object.assign(new Error('Java 代码智能组件不完整，请重新安装客户端'), { code: 'LOCAL_LSP_UNAVAILABLE' });
    const baseConfig = process.platform === 'darwin' ? 'config_mac' : process.platform === 'win32' ? 'config_win' : 'config_linux';
    const configuration = path.join(home, process.arch === 'arm64' && process.platform !== 'win32' ? `${baseConfig}_arm` : baseConfig);
    const workspaceData = path.join(dataRoot, session.projectId); fs.mkdirSync(workspaceData, { recursive: true });
    return { command: commands.java || 'java', args: [...(session.resources.javaGcArguments || []), ...sharedIndexArguments(home, session.resources.sharedIndexRoot), ...flightRecordingArguments(session.resources.javaFlightRecording), ...(session.resources.indexThreadGuardJar ? [`-javaagent:${session.resources.indexThreadGuardJar}`] : []), `-javaagent:${resolveJavaTool('lombok.jar', session.resources)}`, '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Dlog.level=WARN', '-Xms256m', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', path.join(plugins, launcher), '-configuration', configuration, '-data', workspaceData] };
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

function boundedWait(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('等待超时')), timeoutMs); })]).finally(() => clearTimeout(timer));
}
function waitForLanguageServer(initialization, child, provider, timeoutMs = 15_000) {
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
    const timer = setTimeout(() => finish(new Error(`初始化超时（等待 ${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    child.once('error', onError); child.once('close', onClose);
    Promise.resolve(initialization).then((value) => finish(null, value), (error) => finish(error));
  });
}

function resolveJdtlsHome(resources = {}) {
  const candidates = [resources.jdtlsHome, process.env.CODE_STUDIO_JDTLS_HOME, process.resourcesPath && path.join(process.resourcesPath, 'jdtls'), path.resolve(__dirname, '.cache', 'jdtls', '1.61.0')].filter(Boolean);
  const home = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'plugins')));
  if (!home) throw Object.assign(new Error('Java 代码智能组件尚未安装'), { code: 'LOCAL_LSP_UNAVAILABLE' });
  return home;
}

function resolveJavaTool(name, resources = {}) {
  const roots = [resources.javaToolsRoot, process.env.CODE_STUDIO_JAVA_TOOLS_ROOT, process.resourcesPath && path.join(process.resourcesPath, 'java-tools'), path.resolve(__dirname, '.cache/java-tools')].filter(Boolean);
  const file = roots.map((root) => path.join(root, name)).find((file) => fs.existsSync(file));
  if (!file) throw new Error('Java 运行组件尚未安装，请执行 prepare-language-servers');
  return file;
}
function trustedJavaBundles(value) {
  if (value === undefined) return [];
  try {
    if (!Array.isArray(value) || value.length > 2 || value.some(file => typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.jar') || /[\r\n\0]/.test(file) || !fs.statSync(file).isFile())) throw new Error();
    return value.map(file => fs.realpathSync(file));
  } catch { throw new TypeError('Diagnostic Java bundles must be absolute trusted JAR paths'); }
}
function javaSettings(autobuild = true, maxConcurrentBuilds) { return { java: { ...(maxConcurrentBuilds === undefined ? {} : { maxConcurrentBuilds }), completion: { guessMethodArguments: true }, autobuild: { enabled: autobuild }, import: { maven: { enabled: true }, gradle: { enabled: false } }, configuration: { updateBuildConfiguration: 'automatic' } } }; }
function unrefDelay(milliseconds) { return new Promise((resolve) => { const timer = setTimeout(resolve, milliseconds); timer.unref?.(); }); }

function detectProviders(root) {
  const found = new Set(); const pending = [root]; let visited = 0;
  while (pending.length && visited < 2_000) {
    const directory = pending.pop(); let entries = []; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > 2_000) break;
      if (entry.isDirectory() && !['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target'].includes(entry.name)) pending.push(path.join(directory, entry.name));
      else if (entry.isFile()) { const provider = fileProvider(entry.name); if (provider) found.add(provider); }
    }
  }
  return found.size ? [...found] : ['typescript'];
}

module.exports = { LocalLspManager };
