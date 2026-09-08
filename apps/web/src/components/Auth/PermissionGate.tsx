import { type ReactNode } from 'react';
import { Shield } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useMe } from '../../hooks/useMe';
import { hasAnyAccess } from '../../lib/access';

export function PermissionGate({ anyOf, children }: { anyOf: readonly string[]; children: ReactNode }) {
  const me = useMe();
  const navigate = useNavigate();
  if (me.isLoading) return <div className="grid h-full place-items-center text-sm text-muted">正在校验权限…</div>;
  if (!hasAnyAccess(me.data?.permissions ?? [], anyOf)) {
    return (
      <div className="card mx-auto mt-20 max-w-md px-8 py-12 text-center">
        <Shield size={28} className="mx-auto text-slate-400" />
        <p className="mt-5 text-base font-bold">无权访问此页面</p>
        <p className="mt-1 text-xs text-muted">当前角色缺少该页面所需权限，请联系平台管理员。</p>
        <button onClick={() => navigate('/')} className="btn btn-ghost btn-sm mt-4">返回首页</button>
      </div>
    );
  }
  return <>{children}</>;
}
