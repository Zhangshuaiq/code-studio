import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api } from '../../lib/api';

interface Approval {
  id: string;
  requesterName: string;
  toolName: string;
  riskLevel: 'W1' | 'X2' | 'D3';
  environment?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceVersion?: string | null;
  argumentsSummary: Record<string, unknown>;
  impactSummary: string;
  expiresAt: string;
  createdAt: string;
}

export function McpApprovalsPage() {
  const queryClient = useQueryClient();
  const approvals = useQuery<Approval[]>({
    queryKey: ['mcp-approvals-pending'],
    queryFn: async () => (await api.get('/mcp-approvals/review-pending', { params: { pageSize: 100 } })).data.items,
    refetchInterval: 10_000,
  });
  const action = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: 'approve' | 'reject'; reason?: string }) => api.post(`/mcp-approvals/review/${id}/${action}`, reason ? { reason } : {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mcp-approvals-pending'] }),
  });
  const decide = (approval: Approval, decision: 'approve' | 'reject') => {
    const reason = decision === 'reject' || approval.riskLevel === 'D3'
      ? window.prompt(decision === 'reject' ? '请输入拒绝理由' : 'D3 高风险操作必须填写批准理由')
      : undefined;
    if ((decision === 'reject' || approval.riskLevel === 'D3') && !reason?.trim()) return;
    action.mutate({ id: approval.id, action: decision, reason: reason?.trim() });
  };
  return <div className="h-full overflow-y-auto rounded-[22px] border border-white/80 bg-white/45 dark:border-slate-800/80 dark:bg-slate-950/25"><div className="page-shell max-w-[1300px]">
    <header className="mb-5 flex items-end justify-between gap-4"><div><div className="eyebrow">MCP / Agent Governance</div><h1 className="mt-1 text-2xl font-bold">工具调用审批</h1><p className="mt-1 text-sm text-muted">这里只展示明确分配给你且你当前仍有业务权限处理的待审批操作</p></div><button className="btn btn-secondary" onClick={()=>approvals.refetch()}><RefreshCw size={14} className={approvals.isFetching?'animate-spin':''}/>刷新</button></header>
    {(approvals.error||action.error)&&<div className="mb-3 rounded-xl bg-red-50 p-3 text-xs text-red-600 dark:bg-red-500/10">{apiError(approvals.error||action.error)}</div>}
    <div className="space-y-3">{(approvals.data??[]).map((approval)=><article key={approval.id} className="card p-5"><div className="flex flex-wrap items-start gap-4"><span className={`grid h-11 w-11 place-items-center rounded-xl ${approval.riskLevel==='D3'?'bg-red-50 text-red-600 dark:bg-red-500/10':approval.riskLevel==='X2'?'bg-amber-50 text-amber-600 dark:bg-amber-500/10':'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10'}`}><ShieldCheck size={20}/></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><b>{approval.toolName}</b><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] dark:bg-slate-800">{approval.riskLevel}</span>{approval.environment&&<span className="text-xs text-muted">{approval.environment}</span>}</div><p className="mt-1 text-sm">{approval.impactSummary}</p><p className="mt-2 text-xs text-muted">申请人：{approval.requesterName} · 过期：{new Date(approval.expiresAt).toLocaleString('zh-CN')}</p></div><div className="flex gap-2"><button className="btn btn-secondary text-red-500" disabled={action.isPending} onClick={()=>decide(approval,'reject')}><X size={14}/>拒绝</button><button className="btn btn-primary" disabled={action.isPending} onClick={()=>decide(approval,'approve')}><Check size={14}/>批准</button></div></div><div className="mt-4 grid gap-3 md:grid-cols-2"><Info label="目标资源" value={[approval.resourceType,approval.resourceId].filter(Boolean).join(' / ')||'未指定'}/><Info label="资源版本" value={approval.resourceVersion||'未指定'}/></div><pre className="mt-3 max-h-48 overflow-auto rounded-xl bg-slate-950 p-3 text-[11px] text-slate-100">{JSON.stringify(approval.argumentsSummary,null,2)}</pre></article>)}{!approvals.isLoading&&!approvals.data?.length&&<div className="card p-16 text-center text-sm text-muted">暂无分配给你的待审批操作</div>}</div>
  </div></div>;
}

function Info({label,value}:{label:string;value:string}){return <div className="rounded-xl border p-3 text-xs dark:border-slate-800"><span className="text-muted">{label}</span><p className="mt-1 break-all font-medium">{value}</p></div>}
function apiError(error:unknown){const value=error as {response?:{data?:{message?:string}},message?:string};return value.response?.data?.message||value.message||'操作失败'}
