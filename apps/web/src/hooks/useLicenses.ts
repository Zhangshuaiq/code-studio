import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface LicenseSubscription { id: string; userId: string; edition: string; status: string; expiresAt: string; graceDays: number; maxDevices: number; user: { id: string; username: string; email?: string | null; displayName?: string | null } }
export interface RedeemCode { id: string; codePrefix: string; edition: string; durationDays: number; graceDays: number; maxDevices: number; maxRedemptions: number; redemptionCount: number; expiresAt?: string | null; disabledAt?: string | null; createdAt: string }

export function useLicenseAdmin() {
  const qc = useQueryClient(); const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['license-subscriptions'] }), qc.invalidateQueries({ queryKey: ['license-codes'] })]);
  const subscriptions = useQuery<LicenseSubscription[]>({ queryKey: ['license-subscriptions'], queryFn: async () => (await api.get('/admin/licenses/subscriptions')).data });
  const codes = useQuery<RedeemCode[]>({ queryKey: ['license-codes'], queryFn: async () => (await api.get('/admin/licenses/redeem-codes')).data });
  const assign = useMutation({ mutationFn: (body: { userId: string; edition: string; expiresAt: string; graceDays: number; maxDevices: number }) => api.post('/admin/licenses/subscriptions', body), onSuccess: refresh });
  const createCode = useMutation({ mutationFn: async (body: { edition: string; durationDays: number; graceDays: number; maxDevices: number; maxRedemptions: number; expiresAt?: string }) => (await api.post('/admin/licenses/redeem-codes', body)).data as RedeemCode & { code: string }, onSuccess: refresh });
  const disableCode = useMutation({ mutationFn: (id: string) => api.delete(`/admin/licenses/redeem-codes/${id}`), onSuccess: refresh });
  const issueOffline = useMutation({ mutationFn: async (body: { userId: string; challenge: Record<string, unknown> }) => (await api.post('/admin/licenses/offline-license', body)).data as { format: string; challengeNonce: string; token: string } });
  return { subscriptions, codes, assign, createCode, disableCode, issueOffline };
}
