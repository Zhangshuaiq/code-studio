import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Home, X } from "lucide-react";

type RouteTab = { path: string; title: string };

const STORAGE_KEY = "code-studio-route-tabs";

function routeTitle(path: string) {
  if (path === "/") return "项目列表";
  if (/^\/projects\/[^/]+$/.test(path)) return "项目工作区";
  if (/^\/db-query\/[^/]+$/.test(path)) return "数据库查询";
  const routes: Array<[string, string]> = [
    ["/tasks", "任务中心"], ["/logs", "业务日志"], ["/monitoring", "应用监控"],
    ["/monitoring/traces", "链路追踪"],
    ["/monitoring/exceptions", "异常中心"],
    ["/monitoring/pods", "Pod 监控"],
    ["/health", "平台健康"], ["/database-approvals", "数据库审批"], ["/deployments", "部署中心"],
    ["/scheduled-tasks", "定时任务"],
    ["/resources/targets", "部署目标"], ["/resources/registries", "镜像仓库"],
    ["/settings/models", "模型配置"], ["/settings/account", "账户设置"],
    ["/admin/users", "用户管理"], ["/admin/roles", "角色权限"], ["/admin/audit", "审计日志"],
    ["/admin/project-cleanups", "项目任务"],
    ["/admin/task-dlq", "失败任务"], ["/admin/generation-queue", "生成队列"],
    ["/requirements", "需求管理"], ["/admin/preview-builds", "预览构建"], ["/admin/teams", "项目组"],
    ["/admin/datasources/relational", "关系型数据库"], ["/admin/datasources/nosql", "非关系型数据库"],
    ["/admin/namespaces", "Namespace"],
  ];
  return routes.find(([route]) => path === route)?.[1] || "页面";
}

function loadTabs(): RouteTab[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((tab) => tab?.path && tab?.title) : [];
  } catch {
    return [];
  }
}

export function RouteTabs() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const currentPath = pathname + search;
  const [tabs, setTabs] = useState<RouteTab[]>(loadTabs);

  useEffect(() => {
    setTabs((current) => {
      if (current.some((tab) => tab.path === currentPath)) return current;
      return [...current, { path: currentPath, title: routeTitle(pathname) }];
    });
  }, [currentPath, pathname]);

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
  }, [tabs]);

  const activeIndex = useMemo(() => tabs.findIndex((tab) => tab.path === currentPath), [tabs, currentPath]);

  function closeTab(event: React.MouseEvent, path: string) {
    event.stopPropagation();
    const index = tabs.findIndex((tab) => tab.path === path);
    const nextTabs = tabs.filter((tab) => tab.path !== path);
    setTabs(nextTabs);
    if (path !== currentPath) return;
    const next = nextTabs[Math.min(index, nextTabs.length - 1)];
    navigate(next?.path || "/");
  }

  return (
    <div className="mb-2 flex h-10 shrink-0 items-end gap-1 overflow-x-auto rounded-2xl border border-white/80 bg-white/55 px-2 pt-1 shadow-sm backdrop-blur dark:border-slate-800/80 dark:bg-slate-950/45">
      {tabs.map((tab, index) => {
        const active = index === activeIndex;
        return <button key={tab.path} onClick={() => navigate(tab.path)} title={tab.path} className={`group flex h-8 shrink-0 items-center gap-2 rounded-t-xl border border-b-0 px-3 text-xs transition ${active ? "border-slate-200 bg-white font-semibold text-indigo-600 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-indigo-300" : "border-transparent text-slate-500 hover:bg-white/70 hover:text-slate-800 dark:hover:bg-slate-900/70 dark:hover:text-slate-200"}`}>
          {tab.path === "/" && <Home size={13} />}
          <span className="max-w-40 truncate">{tab.title}</span>
          <span role="button" aria-label={`关闭${tab.title}`} onClick={(event) => closeTab(event, tab.path)} className="grid h-5 w-5 place-items-center rounded-md opacity-50 hover:bg-slate-200 hover:opacity-100 dark:hover:bg-slate-700"><X size={12} /></span>
        </button>;
      })}
    </div>
  );
}
