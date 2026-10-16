import { api } from './api';
import { useEditorTabs } from '../store/editorTabs';
import { monacoLang } from './monaco';
import { supportsBashLanguage } from './workspace-file-type';

const languages = new Set(['typescript', 'javascript', 'java', 'python', 'c', 'cpp', 'go', 'rust', 'vue']);
export function supportsWorkspaceLanguage(path: string) { return languages.has(monacoLang(path)) || supportsBashLanguage(path); }

export async function requestWorkspaceLanguage(sessionId: string, operation: string, input: Record<string, unknown> = {}) {
  const documents = Object.entries(useEditorTabs.getState().drafts)
    .filter(([path, draft]) => !path.startsWith('@java-source/') && (operation === 'related-locations' ? /\.(java|xml)$/.test(path) : supportsWorkspaceLanguage(path)) && draft.content !== draft.baseline && path !== input.path)
    .map(([path, draft]) => ({ path, content: draft.content }));
  if (documents.length > 20 || new TextEncoder().encode(JSON.stringify({ ...input, documents })).byteLength > 1_000_000) {
    throw new Error('未保存的编辑内容过多，请先保存部分文件后重试代码导航');
  }
  return (await api.post(`/sessions/${sessionId}/language/${operation}`, { ...input, ...(documents.length ? { documents } : {}) }, { timeout: 60_000 })).data;
}

export function workspaceLanguageError(error: any): string {
  if (error?.response?.data?.code === 'LSP_DISABLED') return '服务器尚未启用代码语言服务';
  if (error?.response?.data?.code === 'LSP_UNAVAILABLE') return '语言服务暂不可用，请检查服务器语言组件配置';
  return error?.response?.data?.message || error?.message || '代码语言服务暂不可用';
}
