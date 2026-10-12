import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { WorkspaceFileViewer, type WorkspaceFileView } from './WorkspaceFileViewer';

export function RemoteFilePreview({ sessionId, path, view }: { sessionId: string; path: string; view: WorkspaceFileView }) {
  const identity = JSON.stringify([sessionId, path, view.kind, view.mime]);
  const [state, setState] = useState<{ identity: string; view: WorkspaceFileView; rawUrl?: string; error?: string }>({ identity: '', view });
  useEffect(() => {
    const controller = new AbortController();
    let rawUrl: string | undefined;
    const load = async () => {
      try {
        if (view.kind === 'spreadsheet') {
          const response = await api.get(`/sessions/${sessionId}/files/spreadsheet`, { params: { path }, signal: controller.signal, timeout: 30000 });
          if (!controller.signal.aborted) setState({ identity, view: { ...view, sheets: response.data.sheets, truncated: response.data.truncated } });
        } else if (view.kind === 'image' || view.kind === 'pdf') {
          // DOM img/iframe requests cannot attach our Authorization header.
          // Fetch through the authenticated API, never put tokens into URLs.
          const response = await api.get(`/sessions/${sessionId}/files/preview`, { params: { path }, responseType: 'blob', signal: controller.signal, timeout: 30000 });
          if (controller.signal.aborted) return;
          rawUrl = URL.createObjectURL(new Blob([response.data], { type: view.mime }));
          setState({ identity, view, rawUrl });
        } else setState({ identity, view });
      } catch (error: any) {
        if (controller.signal.aborted) return;
        let message = error?.response?.data?.message;
        if (error?.response?.data instanceof Blob) {
          try { message = JSON.parse(await error.response.data.text()).message; } catch { /* generic safe message below */ }
        }
        if (!controller.signal.aborted) setState({ identity, view, error: typeof message === 'string' ? message : '无法预览此文件，请重试' });
      }
    };
    void load();
    return () => { controller.abort(); if (rawUrl) URL.revokeObjectURL(rawUrl); };
  }, [identity]);
  if (state.identity !== identity) return <div role="status" className="grid h-full place-items-center text-sm text-muted">加载预览中…</div>;
  if (state.error) return <div role="status" className="grid h-full place-items-center px-6 text-center text-sm text-muted">{state.error}</div>;
  return <WorkspaceFileViewer path={path} view={state.view} rawUrl={state.rawUrl} />;
}
