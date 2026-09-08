import { Outlet, useNavigate } from "react-router-dom";
import { Shield } from "lucide-react";
import { useMe } from "../../hooks/useMe";
import { GOVERNANCE_ACCESS, hasAnyAccess } from "../../lib/access";

// 管理后台容器：分类导航已并入全局左侧菜单。
// 保留无权限兜底页，拦截直接访问 /admin URL 且无任何治理权限的用户。
export function AdminLayout() {
  const navigate = useNavigate();
  const me = useMe();
  const canAccess = hasAnyAccess(me.data?.permissions ?? [], GOVERNANCE_ACCESS);

  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center rounded-[22px] border border-white/80 bg-white/45 text-sm text-muted dark:border-slate-800/80 dark:bg-slate-950/25">
        加载中…
      </div>
    );
  }
  if (!canAccess) {
    return (
      <div className="card mx-auto mt-20 max-w-md px-8 py-12 text-center">
        <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800">
          <Shield size={28} />
        </span>
        <p className="mt-5 text-base font-bold">无权访问管理后台</p>
        <p className="mt-1 text-xs text-muted">
          需要相应的平台治理权限，请联系平台管理员。
        </p>
        <button
          onClick={() => navigate("/")}
          className="btn btn-ghost btn-sm mt-4"
        >
          返回首页
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto rounded-[22px] border border-white/80 bg-white/45 backdrop-blur-sm dark:border-slate-800/80 dark:bg-slate-950/25">
      <div className="page-shell max-w-7xl">
        <Outlet />
      </div>
    </div>
  );
}
