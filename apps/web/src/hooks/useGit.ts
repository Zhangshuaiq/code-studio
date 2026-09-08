import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { FileChange } from "./useSessionChanges";

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  date: number;
  authorName: string;
  authorEmail: string;
}

export function useCommits(sessionId?: string) {
  return useQuery<Commit[]>({
    queryKey: ["commits", sessionId],
    enabled: !!sessionId,
    queryFn: async () =>
      (await api.get(`/sessions/${sessionId}/git/commits`)).data,
  });
}

export function useCommitDiff(sessionId?: string, hash?: string) {
  return useQuery<FileChange[]>({
    queryKey: ["commit-diff", sessionId, hash],
    enabled: !!sessionId && !!hash,
    queryFn: async () =>
      (await api.get(`/sessions/${sessionId}/git/commits/${hash}/diff`)).data,
  });
}

export interface RemoteConfig {
  remoteUrl: string;
  branch: string;
  host: string;
  hasCredential: boolean;
  identity: GitIdentitySettings;
  canManageRepository: boolean;
  canImportRepository: boolean;
}

export function useRemote(sessionId?: string) {
  return useQuery<RemoteConfig | null>({
    queryKey: ["git-remote", sessionId],
    enabled: !!sessionId,
    queryFn: async () =>
      (await api.get(`/sessions/${sessionId}/git/remote`)).data,
  });
}

export function useSaveRemote(sessionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { remoteUrl: string; branch?: string }) =>
      api.put(`/sessions/${sessionId}/git/remote`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["git-remote", sessionId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["project"] });
    },
  });
}

export interface GitIdentitySettings {
  authorName: string;
  authorEmail: string;
  configured: boolean;
}

export interface GitCredentialSummary {
  id: string;
  host: string;
  username: string | null;
  authType: string;
  hasToken: boolean;
  updatedAt: string;
}

export interface GitSettings {
  identity: GitIdentitySettings;
  credentials: GitCredentialSummary[];
}

export interface RemoteSyncStatus {
  branch: string;
  remoteBranch: string;
  ahead: number;
  behind: number;
  conflicts: string[];
  mergeInProgress: boolean;
  fetched: boolean;
  status?: "synced" | "conflict";
}

export interface ConflictVersion {
  exists: boolean;
  size: number;
  content: string | null;
}

export interface ConflictHunk {
  index: number;
  ours: string;
  theirs: string;
  base: string;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
  resultStart: number;
  resultEnd: number;
}

export interface ConflictDetail {
  path: string;
  conflictType:
    "content" | "both-added" | "deleted-by-us" | "deleted-by-them" | "other";
  fileType: "text" | "binary" | "too-large";
  base: ConflictVersion;
  ours: ConflictVersion;
  theirs: ConflictVersion;
  result: ConflictVersion;
  suggestions: {
    ours: string | null;
    theirs: string | null;
    both: string | null;
  };
  hunks: ConflictHunk[];
}

export type ConflictResolution =
  "manual" | "ours" | "theirs" | "both" | "delete";

export function useRemoteSyncStatus(sessionId?: string) {
  return useQuery<RemoteSyncStatus | null>({
    queryKey: ["git-sync-status", sessionId],
    enabled: !!sessionId,
    queryFn: async () =>
      (await api.get(`/sessions/${sessionId}/git/sync-status`)).data,
  });
}

export function useConflictDetail(sessionId?: string, path?: string) {
  return useQuery<ConflictDetail>({
    queryKey: ["git-conflict-detail", sessionId, path],
    enabled: !!sessionId && !!path,
    queryFn: async () =>
      (
        await api.get(`/sessions/${sessionId}/git/conflicts/detail`, {
          params: { path },
        })
      ).data,
  });
}

export function useResolveConflict(sessionId?: string) {
  const qc = useQueryClient();
  return useMutation<
    { path: string; resolved: true; remaining: string[] },
    unknown,
    { path: string; resolution: ConflictResolution; content?: string }
  >({
    mutationFn: async (body) =>
      (await api.put(`/sessions/${sessionId}/git/conflicts/resolve`, body))
        .data,
    onSuccess: (result, variables) => {
      qc.setQueryData<RemoteSyncStatus | null>(
        ["git-sync-status", sessionId],
        (current) =>
          current
            ? {
                ...current,
                conflicts: result.remaining,
                mergeInProgress: true,
              }
            : current,
      );
      qc.removeQueries({
        queryKey: ["git-conflict-detail", sessionId, variables.path],
      });
      for (const key of ["git-sync-status", "changes", "files", "file"]) {
        qc.invalidateQueries({ queryKey: [key, sessionId] });
      }
    },
  });
}

export function useRemoteSyncOps(sessionId?: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    for (const key of [
      "git-sync-status",
      "git-branch",
      "git-branches",
      "commits",
      "changes",
      "files",
      "file",
      "git-conflict-detail",
    ]) {
      qc.invalidateQueries({ queryKey: [key, sessionId] });
    }
  };
  const fetchRemote = useMutation({
    mutationFn: async () =>
      (await api.post(`/sessions/${sessionId}/git/fetch`))
        .data as RemoteSyncStatus,
    onSuccess: invalidate,
  });
  const sync = useMutation({
    mutationFn: async () =>
      (await api.post(`/sessions/${sessionId}/git/sync`))
        .data as RemoteSyncStatus,
    onSuccess: invalidate,
  });
  const continueMerge = useMutation({
    mutationFn: async () =>
      (await api.post(`/sessions/${sessionId}/git/conflicts/continue`))
        .data as RemoteSyncStatus,
    onSuccess: invalidate,
  });
  const abortMerge = useMutation({
    mutationFn: async () =>
      (await api.post(`/sessions/${sessionId}/git/conflicts/abort`))
        .data as RemoteSyncStatus,
    onSuccess: invalidate,
  });
  const importRemote = useMutation({
    mutationFn: async () =>
      (await api.post(`/sessions/${sessionId}/git/import`))
        .data as RemoteSyncStatus,
    onSuccess: invalidate,
  });
  return { fetchRemote, sync, continueMerge, abortMerge, importRemote };
}

export function useGitSettings() {
  return useQuery<GitSettings>({
    queryKey: ["git-settings"],
    queryFn: async () => (await api.get("/git/settings")).data,
  });
}

export function useGitSettingsMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["git-settings"] });
    qc.invalidateQueries({ queryKey: ["git-remote"] });
  };
  const saveIdentity = useMutation({
    mutationFn: (body: { authorName: string; authorEmail: string }) =>
      api.put("/git/identity", body),
    onSuccess: invalidate,
  });
  const saveCredential = useMutation({
    mutationFn: (body: { host: string; username?: string; token?: string }) =>
      api.put("/git/credentials", body),
    onSuccess: invalidate,
  });
  const removeCredential = useMutation({
    mutationFn: (id: string) => api.delete(`/git/credentials/${id}`),
    onSuccess: invalidate,
  });
  return { saveIdentity, saveCredential, removeCredential };
}

export function useBranch(sessionId?: string) {
  return useQuery<{ branch: string }>({
    queryKey: ["git-branch", sessionId],
    enabled: !!sessionId,
    queryFn: async () =>
      (await api.get(`/sessions/${sessionId}/git/branch`)).data,
  });
}

export function useBranches(sessionId?: string) {
  return useQuery<{ current: string; list: string[] }>({
    queryKey: ["git-branches", sessionId],
    enabled: !!sessionId,
    queryFn: async () =>
      (await api.get(`/sessions/${sessionId}/git/branches`)).data,
  });
}

// 分支变更后需要刷新的所有查询（代码/预览/历史都变了）
function invalidateAfterBranch(
  qc: ReturnType<typeof useQueryClient>,
  sessionId?: string,
) {
  for (const key of [
    "files",
    "file",
    "changes",
    "commits",
    "git-branch",
    "git-branches",
    "git-sync-status",
    "preview",
  ]) {
    qc.invalidateQueries({ queryKey: [key, sessionId] });
  }
}

export function useBranchOps(sessionId?: string) {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (name: string) =>
      api.post(`/sessions/${sessionId}/git/branches`, { name }),
    onSuccess: () => invalidateAfterBranch(qc, sessionId),
  });
  const checkout = useMutation({
    mutationFn: (name: string) =>
      api.post(`/sessions/${sessionId}/git/checkout`, { name }),
    onSuccess: () => invalidateAfterBranch(qc, sessionId),
  });
  const remove = useMutation({
    mutationFn: (name: string) =>
      api.post(`/sessions/${sessionId}/git/branches/${name}/delete`),
    onSuccess: () => invalidateAfterBranch(qc, sessionId),
  });
  return { create, checkout, remove };
}

export function usePush(sessionId?: string) {
  return useMutation<
    { branch: string; output: string },
    unknown,
    boolean | void
  >({
    mutationFn: async (force) =>
      (await api.post(`/sessions/${sessionId}/git/push`, { force: !!force }))
        .data,
  });
}

export function useRollback(sessionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hash: string) =>
      api.post(`/sessions/${sessionId}/git/rollback/${hash}`),
    onSuccess: () => {
      // 回滚后代码/预览/历史都变了，全部刷新
      for (const key of ["files", "file", "changes", "commits", "preview"]) {
        qc.invalidateQueries({ queryKey: [key, sessionId] });
      }
    },
  });
}
