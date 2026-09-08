import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { RouteTabs } from "./RouteTabs";

// 全局骨架：左侧持久菜单 + 右侧内容区
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <div className="pointer-events-none absolute -left-24 top-1/3 h-72 w-72 rounded-full bg-indigo-400/5 blur-3xl dark:bg-indigo-500/5" />
      <div className="pointer-events-none absolute -right-20 -top-24 h-80 w-80 rounded-full bg-sky-400/5 blur-3xl dark:bg-sky-500/5" />
      <Sidebar />
      <main className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2">
        <RouteTabs />
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
