import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface RequirementUser { id: string; username: string; displayName?: string | null }
export interface RequirementStage { id: string; type: string; status: string; progress: number; ownerId?: string | null; owner?: RequirementUser | null; descriptionMarkdown: string; blockedReason?: string | null; plannedStartAt?: string | null; plannedEndAt?: string | null }
export interface RequirementProject { id: string; projectId: string; serviceKey: string; developerId?: string | null; developer?: RequirementUser | null; branchName?: string | null; sessionId?: string | null; changeRequired: boolean; status: string; project: { id: string; name: string; language: string } }
export interface RequirementPreview { id: string; sessionId: string; serviceKey?: string | null; status: string; url?: string | null; targetName?: string | null; lastActiveAt: string }
export interface RequirementRouteEndpoint { id: string; serviceKey: string; targetId: string; namespace: string; serviceName: string; port: number; endpointUrl: string; publicUrl?: string | null; readyAt: string; leaseExpiresAt: string }
export interface RequirementActivity { id: string; action: string; detail?: Record<string, unknown> | null; actor?: RequirementUser | null; createdAt: string }
export interface RequirementRevision { id: string; version: number; changeSummary?: string | null; createdBy: RequirementUser; createdAt: string }
export interface Requirement {
  id: string; requirementNo: string; teamId: string; title: string; summary?: string | null; status: string; currentStage: string; progress: number; updatedAt: string;
  ownerId: string; owner: RequirementUser; contentMarkdown: string; documentVersion: number; plannedStartAt?: string | null; plannedEndAt?: string | null;
  team: { id: string; name: string; members: RequirementUser[] }; stages: RequirementStage[]; projects: RequirementProject[]; previews: RequirementPreview[]; routeEndpoints: RequirementRouteEndpoint[]; activities: RequirementActivity[];
  _count?: { projects: number; previews: number };
}
export interface RequirementMetadata { teams: Array<{ id: string; name: string; members: RequirementUser[]; projects: Array<{ id: string; name: string; language: string }> }> }

export function useRequirementList() { return useQuery<{ items: Requirement[]; total: number }>({ queryKey: ['requirements'], queryFn: async () => (await api.get('/requirements', { params: { pageSize: 200 } })).data }); }
export function useRequirement(id?: string) { return useQuery<Requirement>({ queryKey: ['requirement', id], enabled: !!id, queryFn: async () => (await api.get(`/requirements/${id}`)).data }); }
export function useRequirementRevisions(id?: string) { return useQuery<{ items: RequirementRevision[]; total: number }>({ queryKey: ['requirement-revisions', id], enabled: !!id, queryFn: async () => (await api.get(`/requirements/${id}/revisions`, { params: { pageSize: 50 } })).data }); }
export function useRequirementMetadata() { return useQuery<RequirementMetadata>({ queryKey: ['requirement-metadata'], queryFn: async () => (await api.get('/requirements/metadata')).data }); }
export function useStopRequirementPreview(requirementId: string) { const qc = useQueryClient(); return useMutation({ mutationFn: (sessionId: string) => api.post(`/preview/sessions/${sessionId}/stop`), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['requirement', requirementId] }); void qc.invalidateQueries({ queryKey: ['requirements'] }); } }); }

export function useRequirementMutations(id?: string, baseUpdatedAt?: string) {
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['requirements'] }); if (id) { void qc.invalidateQueries({ queryKey: ['requirement', id] }); void qc.invalidateQueries({ queryKey: ['requirement-revisions', id] }); } };
  const create = useMutation({ mutationFn: (body: { teamId: string; title: string; ownerId?: string; summary?: string; plannedStartAt?: string; plannedEndAt?: string }) => api.post('/requirements', body), onSuccess: invalidate });
  const update = useMutation({ mutationFn: (body: { title?: string; summary?: string; ownerId?: string; status?: string; plannedStartAt?: string | null; plannedEndAt?: string | null }) => api.patch(`/requirements/${id}`, { ...(body.title !== undefined ? { ...body, plannedStartAt: body.plannedStartAt ?? null, plannedEndAt: body.plannedEndAt ?? null } : body), baseUpdatedAt }), onSuccess: invalidate });
  const saveDocument = useMutation({ mutationFn: (body: { baseVersion: number; contentMarkdown: string; changeSummary?: string }) => api.put(`/requirements/${id}/document`, body), onSuccess: invalidate });
  const updateStage = useMutation({ mutationFn: ({ stageId, ...body }: { stageId: string; ownerId?: string; status?: string; progress?: number; descriptionMarkdown?: string; blockedReason?: string; transitionReason?: string }) => { if (body.status === 'skipped' && !body.transitionReason) { const reason = window.prompt('跳过阶段必须说明原因')?.trim(); if (!reason) return Promise.reject(new Error('已取消跳过阶段')); body.transitionReason = reason; } return api.patch(`/requirements/${id}/stages/${stageId}`, body); }, onSuccess: invalidate });
  const addProject = useMutation({ mutationFn: (body: { projectId: string; serviceKey: string; developerId?: string; changeRequired: boolean }) => api.post(`/requirements/${id}/projects`, body), onSuccess: invalidate });
  const removeProject = useMutation({ mutationFn: (linkId: string) => api.delete(`/requirements/${id}/projects/${linkId}`), onSuccess: invalidate });
  const updateProject = useMutation({ mutationFn: ({ linkId, ...body }: { linkId: string; developerId?: string; changeRequired?: boolean }) => api.patch(`/requirements/${id}/projects/${linkId}`, body), onSuccess: invalidate });
  const createBranch = useMutation({ mutationFn: (linkId: string) => api.post(`/requirements/${id}/projects/${linkId}/branch`), onSuccess: invalidate });
  return { create, update, saveDocument, updateStage, addProject, updateProject, removeProject, createBranch };
}
