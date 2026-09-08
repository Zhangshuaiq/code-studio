import { create } from 'zustand';

// 侧边栏折叠状态：持久化到 localStorage，刷新后保持
function initial(): boolean {
  return localStorage.getItem('sidebar-collapsed') === '1';
}

interface SidebarState {
  collapsed: boolean;
  toggle: () => void;
  set: (v: boolean) => void;
}

export const useSidebar = create<SidebarState>((set, get) => ({
  collapsed: initial(),
  toggle: () => get().set(!get().collapsed),
  set: (v) => {
    localStorage.setItem('sidebar-collapsed', v ? '1' : '0');
    set({ collapsed: v });
  },
}));
