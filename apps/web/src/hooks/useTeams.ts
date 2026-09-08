import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface Team {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  _count?: {
    members: number;
    projects: number;
    datasources: number;
    deployTargets: number;
  };
  members?: Array<{ id: string; username: string; email?: string }>;
  projects?: Array<{ id: string; name: string }>;
  datasources?: Array<{ id: string; name: string; type: string }>;
}

export function useTeams() {
  return useQuery<Team[]>({
    queryKey: ['teams'],
    queryFn: async () => (await api.get('/admin/teams', { params: { pageSize: 500 } })).data.items,
  });
}

export function useTeam(id?: string) {
  return useQuery<Team>({
    queryKey: ['team', id],
    enabled: !!id,
    queryFn: async () => (await api.get(`/admin/teams/${id}`)).data,
  });
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; description?: string }) =>
      (await api.post('/admin/teams', data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams'] }),
  });
}

export function useUpdateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: { name?: string; description?: string };
    }) => (await api.patch(`/admin/teams/${id}`, data)).data,
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['team', vars.id] });
    },
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/admin/teams/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams'] }),
  });
}

export function useAddTeamMembers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, userIds }: { id: string; userIds: string[] }) =>
      (await api.post(`/admin/teams/${id}/members`, { userIds })).data,
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['team', vars.id] });
    },
  });
}

export function useRemoveTeamMembers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, userIds }: { id: string; userIds: string[] }) =>
      (await api.delete(`/admin/teams/${id}/members`, { data: { userIds } })).data,
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['team', vars.id] });
    },
  });
}
