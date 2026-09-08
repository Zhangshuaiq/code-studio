import { create } from 'zustand';

interface TabState {
  openFiles: string[]; // 打开的文件路径列表
  activeFile: string | undefined; // 当前激活的文件
  drafts: Record<string, EditorDraft>; // 跨标签/页面保留的未保存草稿
  navigation?: { path: string; line: number; column: number };
  openFile: (path: string, line?: number, column?: number) => void; // 打开文件（如果已打开则切换）
  clearNavigation: () => void;
  closeFile: (path: string) => void; // 关闭文件
  setActiveFile: (path: string) => void; // 切换活动文件
  closeAllFiles: () => void; // 关闭所有文件
  closeOtherFiles: (path: string) => void; // 关闭其他文件
  syncDraft: (path: string, content: string) => void;
  setDraftContent: (path: string, content: string) => void;
  markDraftSaved: (path: string, content: string) => void;
  discardDrafts: (paths?: string[]) => void;
  resetForBranch: (validFiles: string[]) => void;
}

export interface EditorDraft {
  content: string;
  baseline: string;
}

export const useEditorTabs = create<TabState>((set) => ({
  openFiles: [],
  activeFile: undefined,
  drafts: {},

  openFile: (path: string, line?: number, column?: number) =>
    set((state) => {
      const navigation = line ? { path, line, column: column || 1 } : undefined;
      // 如果文件已打开，只切换激活状态
      if (state.openFiles.includes(path)) {
        return { activeFile: path, navigation };
      }
      // 否则添加到打开列表
      return {
        openFiles: [...state.openFiles, path],
        activeFile: path,
        navigation,
      };
    }),

  clearNavigation: () => set({ navigation: undefined }),

  closeFile: (path: string) =>
    set((state) => {
      const newOpenFiles = state.openFiles.filter((f) => f !== path);
      let newActiveFile = state.activeFile;

      // 如果关闭的是当前激活的文件，需要切换到其他文件
      if (state.activeFile === path) {
        const currentIndex = state.openFiles.indexOf(path);
        // 优先切换到右侧的标签，如果没有则切换到左侧
        if (currentIndex < state.openFiles.length - 1) {
          newActiveFile = state.openFiles[currentIndex + 1];
        } else if (currentIndex > 0) {
          newActiveFile = state.openFiles[currentIndex - 1];
        } else {
          newActiveFile = undefined;
        }
      }

      return {
        openFiles: newOpenFiles,
        activeFile: newActiveFile,
        navigation: state.navigation?.path === path ? undefined : state.navigation,
      };
    }),

  setActiveFile: (path: string) =>
    set({ activeFile: path }),

  closeAllFiles: () =>
    set({ openFiles: [], activeFile: undefined, drafts: {}, navigation: undefined }),

  closeOtherFiles: (path: string) =>
    set({ openFiles: [path], activeFile: path, navigation: undefined }),

  // 磁盘内容变化时只覆盖干净草稿，防止后台刷新冲掉用户输入。
  syncDraft: (path: string, content: string) =>
    set((state) => {
      const current = state.drafts[path];
      if (current && current.content !== current.baseline) return state;
      if (
        current &&
        current.content === content &&
        current.baseline === content
      ) {
        return state;
      }
      return {
        drafts: {
          ...state.drafts,
          [path]: { content, baseline: content },
        },
      };
    }),

  setDraftContent: (path: string, content: string) =>
    set((state) => {
      const current = state.drafts[path];
      return {
        drafts: {
          ...state.drafts,
          [path]: {
            content,
            baseline: current?.baseline ?? content,
          },
        },
      };
    }),

  markDraftSaved: (path: string, content: string) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [path]: { content, baseline: content },
      },
    })),

  discardDrafts: (paths?: string[]) =>
    set((state) => {
      if (!paths) return { drafts: {} };
      const next = { ...state.drafts };
      for (const path of paths) delete next[path];
      return { drafts: next };
    }),

  resetForBranch: (validFiles: string[]) =>
    set((state) => {
      const valid = new Set(validFiles);
      const openFiles = state.openFiles.filter((path) => valid.has(path));
      const activeFile =
        state.activeFile && valid.has(state.activeFile)
          ? state.activeFile
          : openFiles[0];
      return { openFiles, activeFile, drafts: {}, navigation: undefined };
    }),
}));
