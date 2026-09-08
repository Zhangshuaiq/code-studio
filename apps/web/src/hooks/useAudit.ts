import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface AuditItem {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorName: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  resourceName: string | null;
  result: string;
  ip: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  detail: unknown;
}
export interface AuditPage {
  items: AuditItem[];
  total: number;
  page: number;
  pageSize: number;
}
export interface AuditParams {
  q?: string;
  actor?: string;
  action?: string;
  resourceType?: string;
  result?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function useAuditSearch(params: AuditParams) {
  return useQuery<AuditPage>({
    queryKey: ['audit', params],
    queryFn: async () =>
      (await api.get('/admin/audit', { params })).data,
    placeholderData: keepPreviousData,
  });
}

export function useAuditFacets() {
  return useQuery<{ actions: string[]; resourceTypes: string[] }>({
    queryKey: ['audit-facets'],
    queryFn: async () => (await api.get('/admin/audit/facets')).data,
  });
}
