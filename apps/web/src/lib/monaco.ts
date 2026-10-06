// 自托管 Monaco：从 public/monaco/vs 加载（0.56 min 自带 loader 与各语言 worker），
// 不走 CDN、也不用打包器处理 worker，规避国内网络与 ESM worker 打包问题。
import { loader } from '@monaco-editor/react';

loader.config({ paths: { vs: '/monaco/vs' } });

let intelliSenseReady = false;
/**
 * 配置 TS/JS 语言服务，让补全更聪明：
 * - 开启 JSX / ESNext / allowJs，识别 React 写法
 * - 关闭语义校验（避免"找不到模块 react"这类红波浪噪音），保留语法提示与补全
 */
export function setupIntelliSense(monaco: any) {
  if (intelliSenseReady) return;
  intelliSenseReady = true;
  const ts = monaco.languages.typescript;
  const compilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.React,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    isolatedModules: true,
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);
  // 只保留语法校验，关掉语义/模块解析告警（没装 @types，避免满屏红）
  const diag = { noSemanticValidation: true, noSyntaxValidation: false };
  ts.typescriptDefaults.setDiagnosticsOptions(diag);
  ts.javascriptDefaults.setDiagnosticsOptions(diag);
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);
}

// 根据文件扩展名映射 Monaco 语言 id
export function monacoLang(path?: string): string {
  const ext = path?.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    java: 'java',
    py: 'python',
    go: 'go',
    rs: 'rust',
    vue: 'vue',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    hh: 'cpp',
    hpp: 'cpp',
    hxx: 'cpp',
    sh: 'shell',
  };
  return (ext && map[ext]) || 'plaintext';
}

export function workspaceModelUri(sessionId: string, path: string): string {
  return `codegen://${sessionId}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function workspacePathFromUri(uri?: { scheme?: string; path: string } | null): string | null {
  if (!uri || uri.scheme !== 'codegen') return null;
  return uri.path.replace(/^\//, '').split('/').map(decodeURIComponent).join('/');
}

export function syncWorkspaceModels(monaco: any, sessionId: string, files: Array<{ path: string; content: string }>) {
  for (const file of files) {
    const uri = monaco.Uri.parse(workspaceModelUri(sessionId, file.path));
    const existing = monaco.editor.getModel(uri);
    if (!existing) monaco.editor.createModel(file.content, monacoLang(file.path), uri);
    else if (existing.getValue() !== file.content) existing.setValue(file.content);
  }
}

export function installDesktopLanguageProviders(monaco: any, projectId: string) {
  const languages = ['typescript', 'javascript', 'python', 'java', 'c', 'cpp', 'go', 'rust', 'vue'];
  const request = async (operation: string, model: any, position?: any, extra: Record<string, unknown> = {}) => {
    const filePath = workspacePathFromUri(model.uri);
    if (!filePath || model.uri.authority !== projectId) return null;
    const response = await fetch(`/api/local/projects/${projectId}/language/${operation}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: model.getValue(), line: position?.lineNumber, column: position?.column, ...extra }),
    });
    if (!response.ok) return null;
    return (await response.json()).result;
  };
  const range = (value: any) => new monaco.Range(value.start.line + 1, value.start.character + 1, value.end.line + 1, value.end.character + 1);
  // LSP servers may return either Location (`range`) or LocationLink
  // (`targetSelectionRange`/`targetRange`). Monaco expects both forms to be
  // presented as a Location here, otherwise Ctrl/Cmd+click silently does
  // nothing for servers such as clangd and Vue Language Server.
  const location = (value: any) => {
    const targetRange = value?.range || value?.targetSelectionRange || value?.targetRange;
    return value?.path && targetRange
      ? { uri: monaco.Uri.parse(workspaceModelUri(projectId, value.path)), range: range(targetRange) }
      : null;
  };
  const workspaceEdit = (value: any) => ({ edits: (value?.edits || []).flatMap((file: any) => file.edits.map((edit: any) => ({ resource: monaco.Uri.parse(workspaceModelUri(projectId, file.path)), textEdit: { range: range(edit.range), text: edit.newText } }))) });
  const callItem = (item: any) => ({ name: item.name, detail: item.detail, kind: item.kind, uri: monaco.Uri.parse(workspaceModelUri(projectId, item.path)), range: range(item.range), selectionRange: range(item.selectionRange), tags: item.tags, data: item });
  const callRequest = async (operation: 'incoming' | 'outgoing', item: any) => {
    const response = await fetch(`/api/local/projects/${projectId}/language/call-hierarchy-${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: item.data }) });
    return response.ok ? (await response.json()).result || [] : [];
  };
  const disposables: any[] = [];
  const navigationProvider = (operation: string) => ({ provideDefinition: async (model: any, position: any) => ((await request(operation, model, position)) || []).map(location).filter(Boolean) });
  for (const language of languages) {
    disposables.push(monaco.languages.registerDefinitionProvider(language, navigationProvider('definition')));
    if (monaco.languages.registerDeclarationProvider) disposables.push(monaco.languages.registerDeclarationProvider(language, { provideDeclaration: navigationProvider('declaration').provideDefinition }));
    if (monaco.languages.registerTypeDefinitionProvider) disposables.push(monaco.languages.registerTypeDefinitionProvider(language, { provideTypeDefinition: navigationProvider('type-definition').provideDefinition }));
    if (monaco.languages.registerImplementationProvider) disposables.push(monaco.languages.registerImplementationProvider(language, { provideImplementation: navigationProvider('implementation').provideDefinition }));
    disposables.push(monaco.languages.registerReferenceProvider(language, { provideReferences: async (model: any, position: any) => ((await request('references', model, position)) || []).map(location).filter(Boolean) }));
    disposables.push(monaco.languages.registerHoverProvider(language, { provideHover: async (model: any, position: any) => {
      const result = await request('hover', model, position); if (!result) return null;
      const contents = (result.contents ? (Array.isArray(result.contents) ? result.contents : [result.contents]) : []).map((item: any) => typeof item === 'string' ? { value: item } : { value: item.value || '' });
      return { contents, range: result.range ? range(result.range) : undefined };
    } }));
    disposables.push(monaco.languages.registerDocumentSymbolProvider(language, { provideDocumentSymbols: async (model: any) => {
      const result = (await request('document-symbols', model)) || [];
      const convert = (item: any): any => ({ name: item.name, detail: item.detail || '', kind: item.kind || monaco.languages.SymbolKind.Variable, range: range(item.range || item.location?.range), selectionRange: range(item.selectionRange || item.range || item.location?.range), tags: item.tags, children: (item.children || []).map(convert) });
      return result.filter((item: any) => item.range || item.location?.range).map(convert);
    } }));
    disposables.push(monaco.languages.registerCompletionItemProvider(language, { triggerCharacters: ['.', '"', "'", '/'], provideCompletionItems: async (model: any, position: any) => {
      const result = await request('completion', model, position); const items = Array.isArray(result) ? result : result?.items || [];
      return { suggestions: items.slice(0, 500).map((item: any) => ({
        label: typeof item.label === 'string' ? item.label : item.label?.label || '',
        kind: item.kind || monaco.languages.CompletionItemKind.Text,
        detail: item.detail, documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
        insertText: item.insertText || item.textEdit?.newText || (typeof item.label === 'string' ? item.label : item.label?.label || ''),
        range: item.textEdit?.range ? range(item.textEdit.range) : undefined,
        sortText: item.sortText, filterText: item.filterText,
      })) };
    } }));
    disposables.push(monaco.languages.registerRenameProvider(language, { provideRenameEdits: async (model: any, position: any, newName: string) => {
      const result = await request('rename', model, position, { newName }); return result ? workspaceEdit(result) : { edits: [] };
    } }));
    disposables.push(monaco.languages.registerCodeActionProvider(language, { providedCodeActionKinds: ['quickfix'], provideCodeActions: async (model: any, targetRange: any, context: any) => {
      const diagnostics = (context.markers || []).map((item: any) => ({ range: { start: { line: item.startLineNumber - 1, character: item.startColumn - 1 }, end: { line: item.endLineNumber - 1, character: item.endColumn - 1 } }, severity: item.severity === monaco.MarkerSeverity.Error ? 1 : item.severity === monaco.MarkerSeverity.Warning ? 2 : item.severity === monaco.MarkerSeverity.Info ? 3 : 4, message: item.message, code: item.code, source: item.source }));
      const result = await request('code-actions', model, { lineNumber: targetRange.startLineNumber, column: targetRange.startColumn }, { endLine: targetRange.endLineNumber, endColumn: targetRange.endColumn, diagnostics });
      return { actions: (result || []).map((item: any) => ({ title: item.title, kind: item.kind || 'quickfix', isPreferred: item.isPreferred, disabled: item.disabled?.reason, edit: workspaceEdit(item.edit) })), dispose: () => {} };
    } }));
    if (monaco.languages.registerCallHierarchyProvider) disposables.push(monaco.languages.registerCallHierarchyProvider(language, {
      prepareCallHierarchy: async (model: any, position: any) => ((await request('call-hierarchy-prepare', model, position)) || []).map(callItem),
      provideIncomingCalls: async (item: any) => (await callRequest('incoming', item)).map((call: any) => ({ from: callItem(call.from), fromRanges: (call.fromRanges || []).map(range) })),
      provideOutgoingCalls: async (item: any) => (await callRequest('outgoing', item)).map((call: any) => ({ to: callItem(call.to), fromRanges: (call.fromRanges || []).map(range) })),
    }));
  }
  let disposed = false; const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>(); const visibleModels = new Set<string>();
  const scheduleDiagnostics = (model: any) => {
    if (!model || workspacePathFromUri(model.uri) === null || model.uri.authority !== projectId || !languages.includes(model.getLanguageId())) return;
    const key = model.uri.toString(); clearTimeout(diagnosticTimers.get(key));
    diagnosticTimers.set(key, setTimeout(async () => {
      const result = await request('diagnostics', model); if (disposed || !result) return;
      monaco.editor.setModelMarkers(model, 'project-language-service', result.map((item: any) => ({
        startLineNumber: item.range.start.line + 1, startColumn: item.range.start.character + 1,
        endLineNumber: item.range.end.line + 1, endColumn: item.range.end.character + 1,
        message: item.message || '', code: typeof item.code === 'object' ? item.code.value : item.code,
        source: item.source, severity: item.severity === 1 ? monaco.MarkerSeverity.Error : item.severity === 2 ? monaco.MarkerSeverity.Warning : item.severity === 3 ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Hint,
      })));
    }, 350));
  };
  const attachDiagnostics = (model: any) => {
    if (workspacePathFromUri(model.uri) === null || model.uri.authority !== projectId || !languages.includes(model.getLanguageId())) return;
    // Workspace indexing creates models for navigation targets. Starting a
    // language server diagnostic request for every indexed Java file can
    // overwhelm JDT LS before the user has opened a single file. Only edits
    // and models attached to a visible editor should request diagnostics.
    disposables.push(model.onDidChangeContent(() => { if (visibleModels.has(model.uri.toString())) scheduleDiagnostics(model); }));
  };
  monaco.editor.getModels().forEach(attachDiagnostics);
  disposables.push(monaco.editor.onDidCreateModel(attachDiagnostics));
  const attachEditor = (editor: any) => {
    let previous: string | undefined;
    const update = () => {
      if (previous) visibleModels.delete(previous);
      const model = editor.getModel(); previous = model?.uri?.toString();
      if (previous) visibleModels.add(previous);
      scheduleDiagnostics(model);
    };
    disposables.push(editor.onDidChangeModel(update), editor.onDidDispose(() => { if (previous) visibleModels.delete(previous); })); update();
  };
  monaco.editor.getEditors?.().forEach(attachEditor);
  if (monaco.editor.onDidCreateEditor) disposables.push(monaco.editor.onDidCreateEditor(attachEditor));
  return { dispose: () => { disposed = true; diagnosticTimers.forEach(clearTimeout); disposables.forEach((item) => item.dispose()); } };
}
