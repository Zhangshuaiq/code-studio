import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
export interface KnowledgeTeam {
  id: string;
  name: string;
  _count: { knowledgeFolders: number; knowledgeDocuments: number };
}
export interface KnowledgeFolder {
  id: string;
  teamId: string;
  parentId?: string | null;
  name: string;
}
export interface KnowledgeDocument {
  id: string;
  teamId: string;
  folderId?: string | null;
  requirementId?: string | null;
  title: string;
  version: number;
  contentMarkdown?: string;
  layoutJson?: Record<string, unknown>;
  createdAt?: string;
  updatedAt: string;
  createdBy?: { username: string; displayName?: string | null };
  updatedBy: { username: string; displayName?: string | null };
  team?: { id: string; name: string };
  folder?: KnowledgeFolder | null;
  requirement?: { id: string; requirementNo: string; title: string } | null;
}
export interface KnowledgeTree {
  team: { id: string; name: string };
  folders: KnowledgeFolder[];
  documents: KnowledgeDocument[];
}
export const useKnowledgeTeams = () =>
  useQuery<KnowledgeTeam[]>({
    queryKey: ["knowledge-teams"],
    queryFn: async () => (await api.get("/knowledge/teams")).data,
  });
export const useKnowledgeTree = (teamId?: string) =>
  useQuery<KnowledgeTree>({
    queryKey: ["knowledge-tree", teamId],
    enabled: !!teamId,
    queryFn: async () =>
      (await api.get(`/knowledge/teams/${teamId}/tree`)).data,
  });
export const useKnowledgeDocument = (id?: string) =>
  useQuery<KnowledgeDocument>({
    queryKey: ["knowledge-document", id],
    enabled: !!id,
    queryFn: async () => (await api.get(`/knowledge/documents/${id}`)).data,
  });
export const useKnowledgeSearch = (query: string) =>
  useQuery<KnowledgeDocument[]>({
    queryKey: ["knowledge-search", query],
    enabled: query.trim().length >= 2,
    queryFn: async () =>
      (await api.get("/knowledge/search", { params: { q: query.trim() } }))
        .data,
    staleTime: 10_000,
  });
export function useKnowledgeMutations(teamId?: string) {
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["knowledge-tree", teamId] });
  return {
    createFolder: useMutation({
      mutationFn: (body: { teamId: string; parentId?: string; name: string }) =>
        api.post("/knowledge/folders", body),
      onSuccess: refresh,
    }),
    createDocument: useMutation({
      mutationFn: (body: {
        teamId: string;
        folderId?: string;
        requirementId?: string;
        title: string;
      }) => api.post("/knowledge/documents", body),
      onSuccess: refresh,
    }),
    updateDocument: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id: string;
        title?: string;
        folderId?: string | null;
      }) => api.patch(`/knowledge/documents/${id}`, body),
      onSuccess: refresh,
    }),
    saveDocument: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id: string;
        baseVersion: number;
        contentMarkdown: string;
        layoutJson?: Record<string, unknown>;
        changeSummary?: string;
      }) => api.put(`/knowledge/documents/${id}/content`, body),
      onSuccess: (_, input) => {
        void refresh();
        void qc.invalidateQueries({
          queryKey: ["knowledge-document", input.id],
        });
      },
    }),
  };
}
export function useResolveRequirementDocument() {
  return useMutation({
    mutationFn: (requirementId: string) =>
      api.post(`/knowledge/requirements/${requirementId}/document`),
  });
}
