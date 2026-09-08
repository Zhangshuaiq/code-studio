import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  status: string;
  source: string;
  createdAt: string;
  roles: { id: string; name: string }[];
}
export interface AdminRole {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  builtin: boolean;
  userCount: number;
}
export interface PermissionItem {
  key: string;
  label: string;
}

export function useAdminUsers() {
  return useQuery<AdminUser[]>({
    queryKey: ['admin-users'],
    queryFn: async () => (await api.get('/admin/users', { params: { pageSize: 500 } })).data.items,
  });
}

export function useAdminUserOps() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-users'] });
  const create = useMutation({
    mutationFn: (body: {
      username: string;
      email?: string;
      displayName?: string;
      password: string;
      roleIds?: string[];
    }) => api.post('/admin/users', body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      email?: string | null;
      displayName?: string | null;
      status?: string;
      roleIds?: string[];
    }) => api.patch(`/admin/users/${id}`, body),
    onSuccess: invalidate,
  });
  const resetPassword = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.post(`/admin/users/${id}/reset-password`, { password }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onSuccess: invalidate,
  });
  return { create, update, resetPassword, remove };
}

export function useAdminRoles() {
  return useQuery<AdminRole[]>({
    queryKey: ['admin-roles'],
    queryFn: async () => (await api.get('/admin/roles', { params: { pageSize: 500 } })).data.items,
  });
}

export function usePermissionCatalog() {
  return useQuery<PermissionItem[]>({
    queryKey: ['admin-permissions'],
    queryFn: async () => (await api.get('/admin/permissions')).data,
  });
}

export function useAdminRoleOps() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-roles'] });
  const create = useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      permissions: string[];
    }) => api.post('/admin/roles', body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      description?: string;
      permissions?: string[];
    }) => api.patch(`/admin/roles/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/roles/${id}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

// 别名导出，用于项目组成员管理
export const useUsers = useAdminUsers;
