import { create } from 'zustand';

type Theme = 'light' | 'dark';

function initial(): Theme {
  const saved = localStorage.getItem('theme') as Theme | null;
  if (saved === 'light' || saved === 'dark') return saved;
  // 跟随系统偏好
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
}

export const useTheme = create<ThemeState>((set, get) => {
  const theme = initial();
  apply(theme);
  return {
    theme,
    toggle: () => get().set(get().theme === 'dark' ? 'light' : 'dark'),
    set: (t) => {
      localStorage.setItem('theme', t);
      apply(t);
      set({ theme: t });
    },
  };
});
