import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useSessionFiles(sessionId?: string) {
  return useQuery<string[]>({
    queryKey: ['files', sessionId],
    enabled: !!sessionId,
    queryFn: async () => (await api.get(`/sessions/${sessionId}/files`)).data,
  });
}

export function useFileContent(sessionId?: string, path?: string) {
  return useQuery<{ path: string; content: string }>({
    queryKey: ['file', sessionId, path],
    enabled: !!sessionId && !!path,
    // 编辑器要覆盖本地改动时手动 refetch，这里避免自动刷新把用户输入冲掉
    staleTime: Infinity,
    queryFn: async () =>
      (
        await api.get(`/sessions/${sessionId}/files/content`, {
          params: { path },
        })
      ).data,
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
}

export function useWorkspaceSourceIndex(sessionId?: string) {
  return useQuery<WorkspaceSourceIndex>({
    queryKey: ['workspace-source-index', sessionId],
    enabled: !!sessionId,
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
    mutationFn: (vars: { path: string; content: string }) =>
      api.put(`/sessions/${sessionId}/files/content`, vars),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['file', sessionId, vars.path] });
      qc.invalidateQueries({ queryKey: ['files', sessionId] });
      qc.invalidateQueries({ queryKey: ['workspace-source-index', sessionId] });
      qc.invalidateQueries({ queryKey: ['workspace-search', sessionId] });
    },
  });
}
