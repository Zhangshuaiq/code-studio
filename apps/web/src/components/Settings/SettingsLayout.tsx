import { Outlet } from "react-router-dom";

// 设置区容器：分类导航已并入全局左侧菜单，这里只渲染内容
export function SettingsLayout() {
  return (
    <div className="h-full overflow-y-auto rounded-[22px] border border-white/80 bg-white/45 backdrop-blur-sm dark:border-slate-800/80 dark:bg-slate-950/25">
      <div className="page-shell max-w-5xl">
        <Outlet />
      </div>
    </div>
  );
}
