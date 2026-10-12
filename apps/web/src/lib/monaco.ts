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
export { workspaceFileLanguage as monacoLang } from './workspace-file-type';
import { workspaceFileLanguage as monacoLang } from './workspace-file-type';

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

export type LanguageTransport = (operation: string, input: Record<string, unknown>) => Promise<any>;
export interface LanguageProviderOptions {
  prepareLocations?: (locations: any[]) => Promise<void>;
  prepareEdits?: (edit: any) => Promise<boolean>;
  onError?: (error: unknown) => void;
}
// Monaco's TS worker registers lazily and can otherwise take precedence over
// the workspace rename provider. One exclusive dispatcher handles all mounted
// workspaces without allowing one project's provider to shadow another.
const renameDispatchers = new WeakMap<object, { handlers: Map<string, any>; registrations: any[] }>();

export function installWorkspaceLanguageProviders(monaco: any, projectId: string, transport?: LanguageTransport, options: LanguageProviderOptions = {}) {
  const languages = ['typescript', 'javascript', 'python', 'java', 'c', 'cpp', 'go', 'rust', 'vue'];
  let disposed = false;
  const request = async (operation: string, model: any, position?: any, extra: Record<string, unknown> = {}) => {
    if (disposed || model.isDisposed()) return null;
    const filePath = workspacePathFromUri(model.uri);
    if (!filePath || model.uri.authority !== projectId) return null;
    const version = model.getVersionId();
    const input = { path: filePath, content: model.getValue(), line: position?.lineNumber, column: position?.column, ...extra };
    try {
      const body = transport ? await transport(operation, input) : await fetch(`/api/local/projects/${projectId}/language/${operation}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }).then(async (response) => response.ok ? response.json() : null);
      return disposed || model.isDisposed() || model.getVersionId() !== version ? null : operation === 'fast-document-symbols' ? body : body?.result;
    } catch (error) { if (!disposed) options.onError?.(error); throw error; }
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
  const workspaceEdit = (value: any) => ({ edits: (value?.edits || []).flatMap((file: any) => file.edits.map((edit: any) => {
    const resource = monaco.Uri.parse(workspaceModelUri(projectId, file.path));
    return { resource, versionId: monaco.editor.getModel?.(resource)?.getVersionId(), textEdit: { range: range(edit.range), text: edit.newText } };
  })) });
  const symbolKind = (kind: number) => Number.isInteger(kind) && kind >= 1 && kind <= 26 ? kind - 1 : monaco.languages.SymbolKind.Variable;
  const callItem = (item: any) => ({ name: item.name, detail: item.detail, kind: symbolKind(item.kind), uri: monaco.Uri.parse(workspaceModelUri(projectId, item.path)), range: range(item.range), selectionRange: range(item.selectionRange), tags: item.tags, data: item });
  const callRequest = async (operation: 'incoming' | 'outgoing', item: any) => {
    if (transport) return (await transport(`call-hierarchy-${operation}`, { item: item.data })).result || [];
    const response = await fetch(`/api/local/projects/${projectId}/language/call-hierarchy-${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: item.data }) });
    return response.ok ? (await response.json()).result || [] : [];
  };
  const disposables: any[] = [];
  let renameDispatcher = renameDispatchers.get(monaco);
  if (!renameDispatcher) {
    const handlers = new Map<string, any>();
    const registrations = languages.map((language) => monaco.languages.registerRenameProvider({ language, scheme: 'codegen', exclusive: true }, {
      provideRenameEdits: (model: any, position: any, newName: string) => handlers.get(model.uri.authority)?.provideRenameEdits(model, position, newName) || { edits: [] },
    }));
    renameDispatcher = { handlers, registrations };
    renameDispatchers.set(monaco, renameDispatcher);
  }
  const renameHandler = { provideRenameEdits: async (model: any, position: any, newName: string) => {
    const version = model.getVersionId();
    const result = await request('rename', model, position, { newName });
    if (!result?.edits?.length) return { edits: [], rejectReason: '未找到可重命名的项目符号' };
    try {
      if (options.prepareEdits && !await options.prepareEdits(result)) return { edits: [] };
    } catch (error) { options.onError?.(error); throw error; }
    if (disposed || model.isDisposed() || model.getVersionId() !== version) return { edits: [], rejectReason: '代码已发生变化，请重新执行重命名' };
    return workspaceEdit(result);
  } };
  renameDispatcher.handlers.set(projectId, renameHandler);
  disposables.push({ dispose: () => {
    if (renameDispatcher!.handlers.get(projectId) === renameHandler) renameDispatcher!.handlers.delete(projectId);
    if (!renameDispatcher!.handlers.size) {
      renameDispatcher!.registrations.forEach((item) => item.dispose()); renameDispatchers.delete(monaco);
    }
  } });
  const locations = async (operation: string, model: any, position: any) => {
    const version = model.getVersionId();
    const result = await request(operation, model, position);
    const values = Array.isArray(result) ? result : result ? [result] : [];
    if (values.length && options.prepareLocations) await options.prepareLocations(values);
    return disposed || model.isDisposed() || model.getVersionId() !== version ? [] : values.map(location).filter(Boolean);
  };
  const navigationProvider = (operation: string) => ({ provideDefinition: async (model: any, position: any) => {
    return locations(operation, model, position);
  } });
  for (const language of languages) {
    disposables.push(monaco.languages.registerDefinitionProvider(language, navigationProvider('definition')));
    if (monaco.languages.registerDeclarationProvider) disposables.push(monaco.languages.registerDeclarationProvider(language, { provideDeclaration: navigationProvider('declaration').provideDefinition }));
    if (monaco.languages.registerTypeDefinitionProvider) disposables.push(monaco.languages.registerTypeDefinitionProvider(language, { provideTypeDefinition: navigationProvider('type-definition').provideDefinition }));
    if (monaco.languages.registerImplementationProvider) disposables.push(monaco.languages.registerImplementationProvider(language, { provideImplementation: navigationProvider('implementation').provideDefinition }));
    disposables.push(monaco.languages.registerReferenceProvider(language, { provideReferences: async (model: any, position: any) => locations('references', model, position) }));
    disposables.push(monaco.languages.registerHoverProvider(language, { provideHover: async (model: any, position: any) => {
      const result = await request('hover', model, position); if (!result) return null;
      const contents = (result.contents ? (Array.isArray(result.contents) ? result.contents : [result.contents]) : []).map((item: any) => typeof item === 'string' ? { value: item } : { value: item.value || '' });
      return { contents, range: result.range ? range(result.range) : undefined };
    } }));
    disposables.push(monaco.languages.registerDocumentSymbolProvider(language, { provideDocumentSymbols: async (model: any) => {
      const filePath = workspacePathFromUri(model.uri);
      if (language === 'java' && filePath && !filePath.startsWith('@java-source/')) {
        const body = await request('fast-document-symbols', model);
        if (!body) return [];
        if (body.overlayTruncated) options.onError?.(new Error('文件大纲达到解析上限，仅展示部分符号'));
        return fastJavaDocumentSymbols(monaco, body.items || []);
      }
      const result = (await request('document-symbols', model)) || [];
      const convert = (item: any): any => ({ name: item.name, detail: item.detail || '', kind: symbolKind(item.kind), range: range(item.range || item.location?.range), selectionRange: range(item.selectionRange || item.range || item.location?.range), tags: item.tags, children: (item.children || []).map(convert) });
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
    disposables.push(monaco.languages.registerCodeActionProvider(language, { providedCodeActionKinds: ['quickfix'], provideCodeActions: async (model: any, targetRange: any, context: any) => {
      // Dependency sources are read-only virtual documents, not workspace files.
      // Monaco requests quick fixes automatically when the caret moves.
      if (workspacePathFromUri(model.uri)?.startsWith('@java-source/')) return { actions: [], dispose: () => {} };
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
  const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>(); const visibleModels = new Set<string>();
  const scheduleDiagnostics = (model: any) => {
    if (!model || workspacePathFromUri(model.uri) === null || model.uri.authority !== projectId || !languages.includes(model.getLanguageId())) return;
    const key = model.uri.toString(); clearTimeout(diagnosticTimers.get(key));
    diagnosticTimers.set(key, setTimeout(async () => {
      const result = await request('diagnostics', model).catch(() => null); if (disposed || !result) return;
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

/** Syntax-only outline; never used to infer definition/reference targets. */
export function fastJavaDocumentSymbols(monaco: any, items: any[]) {
  const kinds: Record<string, number> = { class: 4, interface: 10, enum: 9, record: 22, annotation: 10, method: 5, constructor: 8, field: 7, enumMember: 21, recordComponent: 7 };
  const point = (value: any) => value && Number.isInteger(value.line) && value.line >= 1 && Number.isInteger(value.column) && value.column >= 1;
  const compare = (a: any, b: any) => a.line - b.line || a.column - b.column;
  const validRange = (value: any) => point(value?.start) && point(value?.end) && compare(value.start, value.end) <= 0;
  const valid = items.filter(item => typeof item.name === 'string' && validRange(item.range) && validRange(item.selectionRange)
    && compare(item.range.start, item.selectionRange.start) <= 0 && compare(item.selectionRange.end, item.range.end) <= 0)
    .sort((a, b) => compare(a.range.start, b.range.start) || compare(b.range.end, a.range.end));
  const range = (value: any) => new monaco.Range(value.start.line, value.start.column, value.end.line, value.end.column);
  const roots: any[] = [], stack: Array<{ item: any; symbol: any }> = [];
  for (const item of valid) {
    while (stack.length && compare(item.range.end, stack[stack.length - 1].item.range.end) > 0) stack.pop();
    const symbol = { name: item.name, detail: item.container || '', kind: kinds[item.kind] ?? 12, range: range(item.range), selectionRange: range(item.selectionRange), children: [] };
    if (stack.length) stack[stack.length - 1].symbol.children.push(symbol); else roots.push(symbol);
    stack.push({ item, symbol });
  }
  return roots;
}

export const installDesktopLanguageProviders = installWorkspaceLanguageProviders;
