import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type NavigationKeymap = 'idea' | 'vscode' | 'eclipse';
export const useEditorPreferences = create<{ navigationKeymap: NavigationKeymap; setNavigationKeymap: (value: NavigationKeymap) => void }>()(persist((set) => ({
  navigationKeymap: 'idea',
  setNavigationKeymap: (navigationKeymap) => set({ navigationKeymap }),
}), { name: 'code-studio-editor-preferences' }));
