import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { defaultAppearance, validateAppearance, type EditorAppearance } from '../lib/editor-appearance';

export type NavigationKeymap = 'idea' | 'vscode' | 'eclipse';
const local = import.meta.env.VITE_RUNTIME_MODE === 'desktop-local';
let writes = Promise.resolve();
const report = (error: unknown) => window.dispatchEvent(new CustomEvent('code-studio:preferences-error', { detail: error instanceof Error ? error.message : '设置保存失败' }));
const storage: StateStorage = {
  async getItem(name) {
    if (!local) return localStorage.getItem(name);
    const response = await fetch('/api/local/editor-preferences');
    if (!response.ok) throw Error('无法读取本机编辑器设置');
    const body = await response.json(); return body.preferences ? JSON.stringify({ state: body.preferences, version: 1 }) : null;
  },
  async setItem(name, value) {
    if (!local) { localStorage.setItem(name, value); return; }
    writes = writes.catch(() => {}).then(async () => {
      const response = await fetch('/api/local/editor-preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(JSON.parse(value).state) });
      if (!response.ok) throw Error((await response.json()).message || '无法保存本机编辑器设置');
    });
    try { await writes; } catch (error) { report(error); }
  },
  async removeItem(name) { if (!local) localStorage.removeItem(name); },
};
interface Preferences {
  navigationKeymap: NavigationKeymap; appearance: EditorAppearance; chatVisible: boolean;
  setNavigationKeymap: (value: NavigationKeymap) => void; setAppearance: (value: EditorAppearance) => void; setChatVisible: (value: boolean) => void;
}
export const useEditorPreferences = create<Preferences>()(persist((set) => ({
  navigationKeymap: 'idea', appearance: defaultAppearance, chatVisible: true,
  setNavigationKeymap: (navigationKeymap) => set({ navigationKeymap }),
  setAppearance: appearance => set({ appearance: validateAppearance(appearance) }),
  setChatVisible: chatVisible => set({ chatVisible }),
}), { name: 'code-studio-editor-preferences', version: 1, storage: createJSONStorage(() => storage),
  migrate: (old: unknown) => ({ ...old as object, appearance: defaultAppearance, chatVisible: true }),
  partialize: state => ({ navigationKeymap: state.navigationKeymap, appearance: state.appearance, chatVisible: state.chatVisible }),
  merge: (saved, current) => { try { const value = saved as Partial<Preferences>; return { ...current, navigationKeymap: ['idea','vscode','eclipse'].includes(value.navigationKeymap || '') ? value.navigationKeymap! : current.navigationKeymap, appearance: validateAppearance(value.appearance || {}), chatVisible: value.chatVisible !== false }; } catch { return current; } },
  onRehydrateStorage: () => (_state, error) => { if (error) report(error); },
}));
