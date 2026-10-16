import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useEffect, useState } from 'react';
import { useEditorTabs } from '../store/editorTabs';
import { collectJavaDrafts } from '../lib/fast-index-drafts';
import type { WorkspaceFileView } from '../components/CodeEditor/WorkspaceFileViewer';
export type WorkspaceFile = { path: string; content: string; readOnly?: boolean; version?: string } & Partial<WorkspaceFileView>;

const draftIdentities = new WeakMap<object, number>();
let nextDraftIdentity = 0;
function draftIdentity(drafts: object) {
  if (!draftIdentities.has(drafts)) draftIdentities.set(drafts, ++nextDraftIdentity);
  return draftIdentities.get(drafts)!;
}

export function useSessionFiles(sessionId?: string) {
  return useQuery<string[]>({
    queryKey: ['files', sessionId],
    enabled: !!sessionId,
    queryFn: async () => (await api.get(`/sessions/${sessionId}/files`)).data,
  });
}

export async function fetchWorkspaceFile(sessionId: string, path: string): Promise<WorkspaceFile> {
  const endpoint = path.startsWith('@java-source/') ? 'language/source' : 'files/content';
  return (await api.get(`/sessions/${sessionId}/${endpoint}`, { params: { path }, timeout: 60_000 })).data;
}

export function useFileContent(sessionId?: string, path?: string) {
  return useQuery<WorkspaceFile>({
    queryKey: ['file', sessionId, path],
    enabled: !!sessionId && !!path,
    // 编辑器要覆盖本地改动时手动 refetch，这里避免自动刷新把用户输入冲掉
    staleTime: Infinity,
    queryFn: () => fetchWorkspaceFile(sessionId!, path!),
  });
}

export interface WorkspaceSourceIndex {
  files: Array<{ path: string; content: string }>;
  bytes: number;
  truncated: boolean;
}

export interface WorkspaceSearchResult {
  path: string;
  line: number | null;
  column: number | null;
  preview: string;
  kind: 'path' | 'content';
  name?: string;
  hash?: string;
  hashSource?: 'disk' | 'overlay';
}

export interface FastIndexStatus {
  state: string;
  files?: number;
  symbols?: number;
  complete: boolean;
  discoveredFiles?: number;
  parsedFiles?: number;
  unchangedFiles?: number;
  elapsedMs?: number;
}
export function isFastIndexLoading(index?: FastIndexStatus) {
  return !!index && ['starting', 'needs-scan', 'needs-validation', 'scanning'].includes(index.state);
}
export function useWorkspaceFastSymbols(sessionId?: string, query?: string) {
  const drafts = useEditorTabs(state => state.drafts);
  const identity = draftIdentity(drafts);
  const [settledIdentity, setSettledIdentity] = useState(identity);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledIdentity(identity), 250);
    return () => window.clearTimeout(timer);
  }, [identity, sessionId]);
  const waitingForDraft = identity !== settledIdentity;
  const result = useQuery<{ items: WorkspaceSearchResult[]; truncated: boolean; sourceTruncated: boolean; overlayTruncated?: boolean; index: FastIndexStatus }>({
    queryKey: ['workspace-fast-symbols', sessionId, query, identity],
    enabled: !!sessionId && !!query?.trim() && !waitingForDraft,
    gcTime: 0,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const documents = collectJavaDrafts(Object.entries(drafts).map(([path, draft]) => ({ path, ...draft })));
      const body = (await api.post(`/sessions/${sessionId}/language/fast-symbols`, { query: query!.trim(), ...(documents.length ? { documents } : {}) }, { signal })).data;
      return { ...body, items: body.items.map((item: { path: string; line: number; column: number; name: string; container?: string }) => ({ ...item, kind: 'content', preview: item.container ? `${item.container}.${item.name}` : item.name })) };
    },
    refetchInterval: state => isFastIndexLoading(state.state.data?.index) || (state.state.error as any)?.response?.data?.code === 'FAST_INDEX_BUSY' ? 2_000 : false,
  });
  return { ...result, isLoading: result.isLoading || (!!sessionId && !!query?.trim() && waitingForDraft) };
}
export function useWorkspaceFastIndexStatus(sessionId?: string, enabled = false) {
  return useQuery<{ index: FastIndexStatus }>({
    queryKey: ['workspace-fast-index-status', sessionId],
    enabled: !!sessionId && enabled,
    queryFn: async ({ signal }) => (await api.post(`/sessions/${sessionId}/language/index-status`, {}, { signal })).data,
    refetchInterval: state => isFastIndexLoading(state.state.data?.index) ? 2_000 : 120_000,
  });
}

export function useWorkspaceSourceIndex(sessionId?: string, enabled = true) {
  return useQuery<WorkspaceSourceIndex>({
    queryKey: ['workspace-source-index', sessionId],
    enabled: !!sessionId && enabled,
    staleTime: 30_000,
    queryFn: async () => (await api.get(`/sessions/${sessionId}/files/index`)).data,
  });
}

export function useWorkspaceSearch(sessionId?: string, query?: string) {
  return useQuery<{ items: WorkspaceSearchResult[]; truncated: boolean }>({
    queryKey: ['workspace-search', sessionId, query],
    enabled: !!sessionId && !!query?.trim(),
    staleTime: 10_000,
    queryFn: async () => (await api.get(`/sessions/${sessionId}/files/search`, { params: { query: query!.trim() } })).data,
  });
}

export function useSaveFile(sessionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { path: string; content: string; expectedVersion?: string }) =>
      api.put(`/sessions/${sessionId}/files/content`, vars, { timeout: 30_000 }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['file', sessionId, vars.path] });
      qc.invalidateQueries({ queryKey: ['files', sessionId] });
      qc.invalidateQueries({ queryKey: ['workspace-source-index', sessionId] });
      qc.invalidateQueries({ queryKey: ['workspace-search', sessionId] });
    },
  });
}
