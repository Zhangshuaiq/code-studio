import { ComponentType } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Code2,
  FolderKanban,
  Settings,
  ShieldCheck,
  Cpu,
  Rocket,
  Package,
  User,
  Users,
  Shield,
  ScrollText,
  Boxes,
  Database,
  Server,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  Activity,
  CloudCog,
  Gauge,
  HeartPulse,
  ListChecks,
  AlertTriangle,
  RotateCcw,
  Hammer,
  CalendarClock,
  Waypoints,
  RadioTower,
  ClipboardList,
} from "lucide-react";
import { ThemeToggle } from "../ThemeToggle";
import { useAuth } from "../../store/auth";
import { useSidebar } from "../../store/sidebar";
import { useMe } from "../../hooks/useMe";
import { ACCESS, GOVERNANCE_ACCESS, hasAnyAccess } from "../../lib/access";

type Icon = ComponentType<{ size?: number | string; className?: string }>;

interface NavItem {
  to: string;
  icon: Icon;
  label: string;
  section?: string;
  anyOf?: readonly string[]; // 至少具备其中一个权限；缺省=所有登录用户可见
  soon?: boolean; // 即将上线，禁用
  children?: NavItem[];
}

// 全局导航结构。子项在父项展开时缩进显示，路由前缀匹配则自动展开。
const NAV: NavItem[] = [
  { to: "/", icon: FolderKanban, label: "项目", section: "工作空间", anyOf: [ACCESS.projectRead] },
  { to: "/requirements", icon: ClipboardList, label: "需求管理", anyOf: [ACCESS.requirements] },
  { to: "/tasks", icon: ListChecks, label: "生成任务", anyOf: [ACCESS.projectRead] },
  {
    to: "/monitoring",
    icon: Gauge,
    label: "应用监控",
    anyOf: [ACCESS.observability],
    children: [
      { to: "/monitoring", icon: Gauge, label: "服务概览" },
      { to: "/monitoring/traces", icon: Waypoints, label: "链路追踪" },
      { to: "/monitoring/pods", icon: Boxes, label: "Pod 监控" },
      { to: "/monitoring/exceptions", icon: AlertTriangle, label: "异常中心" },
    ],
  },
  { to: "/health", icon: HeartPulse, label: "平台健康", anyOf: [ACCESS.observability] },
  {
    to: "/logs",
    icon: Activity,
    label: "业务日志",
    anyOf: [ACCESS.observability],
  },
  {
    to: "/deployments",
    icon: Rocket,
    label: "部署中心",
    section: "资源与发布",
    anyOf: [ACCESS.deploy],
  },
  {
    to: "/resources",
    icon: CloudCog,
    label: "运行资源",
    children: [
      { to: "/resources/targets", icon: Server, label: "运行目标", anyOf: [ACCESS.deployTargets] },
      { to: "/resources/registries", icon: Package, label: "镜像仓库", anyOf: [ACCESS.registries] },
    ],
  },
  {
    to: "/settings",
    icon: Settings,
    label: "设置",
    section: "配置中心",
    children: [
      { to: "/settings/models", icon: Cpu, label: "模型", anyOf: [ACCESS.models] },
      { to: "/settings/account", icon: User, label: "账户" },
    ],
  },
  {
    to: "/database-approvals",
    icon: Database,
    label: "数据库审批",
    section: "平台治理",
    anyOf: [ACCESS.projectRead],
  },
  { to: "/mcp-approvals", icon: ShieldCheck, label: "Agent 审批", anyOf: [ACCESS.mcpApprovalReview] },
  {
    to: "/scheduled-tasks",
    icon: CalendarClock,
    label: "定时任务",
    anyOf: [ACCESS.scheduledTasks],
  },
  { to: "/kafka", icon: RadioTower, label: "Kafka 工作台", anyOf: [ACCESS.kafka] },
  {
    to: "/admin",
    icon: ShieldCheck,
    label: "管理后台",
    section: "平台治理",
    anyOf: GOVERNANCE_ACCESS,
    children: [
      { to: "/admin/users", icon: Users, label: "用户", anyOf: [ACCESS.adminUsers] },
      { to: "/admin/roles", icon: Shield, label: "角色", anyOf: [ACCESS.adminRoles] },
      { to: "/admin/audit", icon: ScrollText, label: "操作日志", anyOf: [ACCESS.audit] },
      { to: "/admin/task-dlq", icon: AlertTriangle, label: "任务死信", anyOf: [ACCESS.systemSettings] },
      { to: "/admin/generation-queue", icon: ListChecks, label: "生成队列", anyOf: [ACCESS.systemSettings] },
      { to: "/admin/project-cleanups", icon: RotateCcw, label: "资源回收", anyOf: [ACCESS.systemSettings] },
      { to: "/admin/preview-builds", icon: Hammer, label: "预览构建", anyOf: [ACCESS.systemSettings] },
      { to: "/admin/teams", icon: Users, label: "项目组", anyOf: [ACCESS.teams] },
      {
        to: "/admin/datasources/relational",
        icon: Database,
        label: "关系型数据库",
        anyOf: [ACCESS.datasources],
      },
      { to: "/admin/datasources/nosql", icon: Server, label: "非关系型数据库", anyOf: [ACCESS.datasources] },
      { to: "/admin/namespaces", icon: Boxes, label: "Namespace", anyOf: [ACCESS.deployTargets] },
    ],
  },
];

function visibleNavItem(item: NavItem, permissions: readonly string[]): NavItem | null {
  if (item.anyOf && !hasAnyAccess(permissions, item.anyOf)) return null;
  const children = item.children
    ?.map((child) => visibleNavItem(child, permissions))
    .filter((child): child is NavItem => Boolean(child));
  if (item.children && !children?.length) return null;
  return { ...item, children };
}

export function Sidebar() {
  const collapsed = useSidebar((s) => s.collapsed);
  const toggle = useSidebar((s) => s.toggle);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const me = useMe();
  const perms = me.data?.permissions ?? [];
  const username = useAuth((s) => s.username);
  const logout = useAuth((s) => s.logout);

  const visible = NAV.map((item) => visibleNavItem(item, perms)).filter((item): item is NavItem => Boolean(item));

  return (
    <aside
      className={`panel relative z-20 my-2 ml-2 flex shrink-0 flex-col overflow-hidden rounded-[22px] border shadow-[0_16px_45px_-28px_rgba(15,23,42,0.45)] transition-[width] duration-300 dark:shadow-[0_18px_50px_-26px_rgba(0,0,0,0.85)] ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      {/* 顶部 logo */}
      <button
        onClick={() => navigate("/")}
        className={`flex items-center gap-3 border-b border-slate-200/70 py-4 dark:border-slate-800/70 ${collapsed ? "justify-center px-2" : "px-4"}`}
        title="AI 代码生成平台"
      >
        <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-[14px] bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-700 text-white shadow-[0_10px_24px_-10px_rgba(79,70,229,0.9)] ring-1 ring-white/30">
          <Code2 size={19} strokeWidth={2.25} />
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-400 dark:border-slate-900" />
        </span>
        {!collapsed && (
          <span className="min-w-0 text-left">
            <span className="block truncate text-sm font-bold tracking-tight text-slate-900 dark:text-white">
              Code Studio
            </span>
            <span className="mt-0.5 block truncate text-[10px] font-medium uppercase tracking-[0.13em] text-slate-400">
              AI Workspace
            </span>
          </span>
        )}
      </button>

      {/* 菜单 */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        {visible.map((n, index) => (
          <div key={n.to} className={index ? "mt-4" : ""}>
            {!collapsed && n.section && (
              <div className="mb-1.5 px-2 text-[9px] font-bold uppercase tracking-[0.18em] text-slate-400/90 dark:text-slate-500">
                {n.section}
              </div>
            )}
            {collapsed && index > 0 && (
              <div className="mx-auto mb-3 h-px w-7 bg-slate-200 dark:bg-slate-800" />
            )}
            <NavGroup item={n} collapsed={collapsed} pathname={pathname} />
          </div>
        ))}
      </nav>

      {/* 底部：折叠 / 主题 / 用户 / 退出 */}
      <div className="space-y-2 border-t border-slate-200/70 p-2.5 dark:border-slate-800/70">
        <button
          onClick={toggle}
          className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200 ${collapsed ? "justify-center" : ""}`}
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {collapsed ? (
            <PanelLeftOpen size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
          {!collapsed && <span>收起</span>}
        </button>
        <div
          className={`rounded-2xl border border-slate-200/80 bg-slate-50/80 p-2 dark:border-slate-800 dark:bg-slate-950/40 ${collapsed ? "flex flex-col items-center gap-1.5" : "flex items-center gap-2"}`}
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-100 to-violet-100 text-xs font-bold text-indigo-700 dark:from-indigo-500/20 dark:to-violet-500/20 dark:text-indigo-300">
            {(username || "U").slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
                {username}
              </span>
              <span className="block text-[9px] uppercase tracking-wider text-slate-400">
                已登录
              </span>
            </span>
          )}
          {!collapsed && <ThemeToggle />}
          <button
            onClick={logout}
            className="icon-btn h-8 w-8 rounded-lg"
            title="退出登录"
          >
            <LogOut size={15} />
          </button>
          {collapsed && <ThemeToggle />}
        </div>
      </div>
    </aside>
  );
}

function NavGroup({
  item,
  collapsed,
  pathname,
}: {
  item: NavItem;
  collapsed: boolean;
  pathname: string;
}) {
  const Icon = item.icon;
  // 路由前缀匹配则视为激活；父项激活时自动展开子菜单
  const active =
    item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
  const hasChildren = !!item.children?.length;
  const expanded = hasChildren && !collapsed && active;

  return (
    <div>
      <NavLink
        to={item.to}
        end={item.to === "/"}
        title={collapsed ? item.label : undefined}
        className={({ isActive }) =>
          `group flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm transition-all duration-200 ${
            isActive || active
              ? "bg-gradient-to-r from-indigo-50 to-violet-50 font-semibold text-indigo-700 shadow-sm ring-1 ring-indigo-100/80 dark:from-indigo-500/15 dark:to-violet-500/10 dark:text-indigo-300 dark:ring-indigo-500/20"
              : "font-medium text-slate-600 hover:bg-slate-100/90 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/80 dark:hover:text-slate-100"
          } ${collapsed ? "justify-center" : ""}`
        }
      >
        <Icon
          size={18}
          className="shrink-0 transition-transform group-hover:scale-105"
        />
        {!collapsed && <span className="truncate">{item.label}</span>}
      </NavLink>

      {expanded && (
        <div className="ml-4 mt-1.5 space-y-0.5 border-l border-slate-200 pl-2.5 dark:border-slate-800">
          {item.children!.map((c) =>
            c.soon ? (
              <div
                key={c.to}
                className="flex cursor-not-allowed items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-slate-400 opacity-70"
                title="即将上线"
              >
                <c.icon size={15} className="shrink-0" />
                <span className="truncate">{c.label}</span>
                <span className="ml-auto rounded bg-slate-200 px-1 text-[9px] text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                  即将
                </span>
              </div>
            ) : (
              <NavLink
                key={c.to}
                to={c.to}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] transition ${
                    isActive
                      ? "bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                      : "text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                  }`
                }
              >
                <c.icon size={15} className="shrink-0" />
                <span className="truncate">{c.label}</span>
              </NavLink>
            ),
          )}
        </div>
      )}
    </div>
  );
}
