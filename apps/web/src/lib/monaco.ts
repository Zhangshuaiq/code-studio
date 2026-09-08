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
