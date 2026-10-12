import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import type { EnterprisePolicy } from '../../hooks/useOrganizations';
import { useOrganizationControl } from '../../lib/organization-control';
import { PolicyCard } from '../Admin/EnterprisePolicyCard';
import { useFeedback } from '../common/FeedbackProvider';
import { errText } from './ui';

type Snapshot = EnterprisePolicy & { updatedAt: string };
function fields(value: EnterprisePolicy): EnterprisePolicy {
  return { terminalEnabled: value.terminalEnabled, allowedModelEngines: value.allowedModelEngines, allowedConnectorTypes: value.allowedConnectorTypes, allowedGitHosts: value.allowedGitHosts, allowedNetworkHosts: value.allowedNetworkHosts, minimumClientVersion: value.minimumClientVersion, offlineDays: value.offlineDays };
}
export function OrganizationPolicy({ organizationId, actorRole }: { organizationId: string; actorRole?: string }) {
  const { api, identity } = useOrganizationControl(); const qc = useQueryClient(); const { confirm } = useFeedback();
  const [draft, setDraft] = useState<Snapshot | null>(null); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  const key = ['organization-policy', identity, organizationId]; const base = `/control/enterprise/organizations/${organizationId}/policy`;
  const query = useQuery<Snapshot>({ queryKey: key, queryFn: async () => (await api.get(base)).data, retry: (count, reason) => !(isAxiosError(reason) && [401, 403, 404].includes(reason.response?.status ?? 0)) && count < 2 });
  useEffect(() => { if (!draft && query.data && !query.isFetching) setDraft({ ...fields(query.data), updatedAt: query.data.updatedAt }); }, [draft, query.data, query.isFetching]);
  const mutation = useMutation({ mutationFn: async (snapshot: Snapshot) => (await api.put(base, { ...fields(snapshot), expectedUpdatedAt: snapshot.updatedAt })).data as Snapshot,
    onSuccess: (result) => { qc.setQueryData(key, result); setDraft({ ...fields(result), updatedAt: result.updatedAt }); setSaved(true); void qc.invalidateQueries({ queryKey: ['organization-audit', identity, organizationId] }); },
  });
  async function save() {
    if (!draft || actorRole !== 'owner' || mutation.isPending) return;
    if (!await confirm({ title: '修改组织安全策略', message: '修改将在后续策略签发或刷新时生效，已签发的离线策略不会立即替换。确定保存？', confirmText: '保存策略' })) return;
    setError(''); setSaved(false); try { await mutation.mutateAsync(draft); } catch (reason) { setError(errText(reason)); }
  }
  async function reload() {
    if (draft && query.data && JSON.stringify(fields(draft)) !== JSON.stringify(fields(query.data)) && !await confirm({ title: '重新读取策略', message: '重新读取会放弃尚未保存的修改，确定继续？' })) return;
    setDraft(null); setError(''); setSaved(false); await query.refetch();
  }
  return <div data-organization-policy>
    {(error || query.error) && <p role="alert" className="mb-3 text-xs text-red-500">{error || errText(query.error)}</p>}
    {query.isFetching && <p className="mb-3 text-xs text-muted">加载策略…</p>}
    {draft && !query.error && <PolicyCard value={draft} readOnly={actorRole !== 'owner'} saving={mutation.isPending} onChange={(value) => { setDraft({ ...fields(value), updatedAt: draft.updatedAt }); setSaved(false); }} onSave={() => void save()} />}
    {saved && <p role="status" className="mt-2 text-xs text-emerald-600">策略已保存，客户端刷新策略后生效。</p>}
    <button type="button" className="btn btn-ghost btn-sm mt-2" disabled={query.isFetching || mutation.isPending} onClick={() => void reload()}>重新读取策略</button>
  </div>;
}
