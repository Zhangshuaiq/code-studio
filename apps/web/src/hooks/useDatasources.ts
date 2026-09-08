import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface Datasource {
  id: string;
  teamId: string;
  name: string;
  type: 'mysql' | 'postgresql' | 'redis' | 'mongodb';
  category: 'relational' | 'nosql';
  summary?: string;
  createdAt: string;
  updatedAt: string;
  team?: {
    id: string;
    name: string;
    members?: Array<{ id: string; username: string; email?: string }>;
  };
  members?: Array<{ user: { id: string; username: string; email: string | null } }>;
  approvers?: Array<{ id: string; username: string; email?: string | null; displayName?: string | null }>;
  _count?: { members: number; approvers?: number };
  config?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    database?: string;
    db?: number;
    authSource?: string;
  };
  hasPassword?: boolean;
}

export function useDatasources(category?: 'relational' | 'nosql') {
  return useQuery<Datasource[]>({
    queryKey: ['datasources', category],
    queryFn: async () => {
      return (await api.get('/admin/datasources', { params: { category, pageSize: 500 } })).data.items;
    },
  });
}

export function useDatasource(id?: string) {
  return useQuery<Datasource>({
    queryKey: ['datasource', id],
    enabled: !!id,
    queryFn: async () => (await api.get(`/admin/datasources/${id}`)).data,
  });
}

export function useCreateDatasource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      teamId: string;
      name: string;
      type: 'mysql' | 'postgresql' | 'redis' | 'mongodb';
      config: Datasource['config'];
    }) => (await api.post('/admin/datasources', data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['datasources'] }),
  });
}

export function useUpdateDatasource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: { name?: string; config?: Datasource['config'] };
    }) => (await api.patch(`/admin/datasources/${id}`, data)).data,
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['datasources'] });
      qc.invalidateQueries({ queryKey: ['datasource', vars.id] });
    },
  });
}

export function useDeleteDatasource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/admin/datasources/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['datasources'] }),
  });
}

export function useDatasourceMembers() {
  const qc = useQueryClient();
  const invalidate = (datasourceId: string) => {
    qc.invalidateQueries({ queryKey: ['datasource', datasourceId] });
    qc.invalidateQueries({ queryKey: ['datasources'] });
  };

  const add = useMutation({
    mutationFn: async ({
      datasourceId,
      userIds,
    }: {
      datasourceId: string;
      userIds: string[];
    }) => (await api.post(`/admin/datasources/${datasourceId}/members`, { userIds })).data,
    onSuccess: (_data, vars) => invalidate(vars.datasourceId),
  });

  const remove = useMutation({
    mutationFn: async ({
      datasourceId,
      userIds,
    }: {
      datasourceId: string;
      userIds: string[];
    }) =>
      (await api.delete(`/admin/datasources/${datasourceId}/members`, { data: { userIds } }))
        .data,
    onSuccess: (_data, vars) => invalidate(vars.datasourceId),
  });

  return { add, remove };
}

export function useDatasourceApprovers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ datasourceId, userIds }: { datasourceId: string; userIds: string[] }) =>
      (await api.patch(`/admin/datasources/${datasourceId}/approvers`, { userIds })).data,
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['datasource', vars.datasourceId] });
      qc.invalidateQueries({ queryKey: ['datasources'] });
    },
  });
}
