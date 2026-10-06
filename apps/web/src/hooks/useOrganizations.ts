import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface EnterprisePolicy { terminalEnabled: boolean; allowedModelEngines: string[]; allowedConnectorTypes: string[]; allowedGitHosts: string[]; allowedNetworkHosts: string[]; minimumClientVersion: string; offlineDays: number }
export interface Organization { id: string; name: string; slug: string; seatLimit: number; verifiedDomains: string[]; policy: EnterprisePolicy; _count: { members: number } }
export interface OrganizationMember { id: string; userId: string; role: string; status: string; user: { id: string; username: string; email?: string | null; displayName?: string | null } }

export function useOrganizations() {
  const qc = useQueryClient(); const invalidate = () => qc.invalidateQueries({ queryKey: ['organizations'] });
  const organizations = useQuery<Organization[]>({ queryKey: ['organizations'], queryFn: async () => (await api.get('/admin/organizations')).data });
  const create = useMutation({ mutationFn: (body: { name: string; slug: string; seatLimit: number }) => api.post('/admin/organizations', body), onSuccess: invalidate });
  const savePolicy = useMutation({ mutationFn: ({ id, policy }: { id: string; policy: EnterprisePolicy }) => api.put(`/admin/organizations/${id}/policy`, policy), onSuccess: invalidate });
  const addMember = useMutation({ mutationFn: ({ id, userId, role }: { id: string; userId: string; role: string }) => api.post(`/admin/organizations/${id}/members`, { userId, role }), onSuccess: (_data, input) => { invalidate(); qc.invalidateQueries({ queryKey: ['organization-members', input.id] }); } });
  const removeMember = useMutation({ mutationFn: ({ id, userId }: { id: string; userId: string }) => api.delete(`/admin/organizations/${id}/members/${userId}`), onSuccess: (_data, input) => { invalidate(); qc.invalidateQueries({ queryKey: ['organization-members', input.id] }); } });
  return { organizations, create, savePolicy, addMember, removeMember };
}
export function useOrganizationMembers(id?: string) { return useQuery<OrganizationMember[]>({ queryKey: ['organization-members', id], enabled: Boolean(id), queryFn: async () => (await api.get(`/admin/organizations/${id}/members`)).data }); }
