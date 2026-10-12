import type { NavigationKeymap } from '../store/editorPreferences';

export function navigationShortcuts(keymap: NavigationKeymap, platform: string) {
  const mac = /mac/i.test(platform);
  if (keymap === 'idea') return mac ? ['⌘[', '⌘]'] : ['Ctrl+Alt+←', 'Ctrl+Alt+→'];
  if (keymap === 'vscode') return mac ? ['Ctrl+-', 'Ctrl+Shift+-'] : /linux/i.test(platform) ? ['Ctrl+Alt+-', 'Ctrl+Shift+-'] : ['Alt+←', 'Alt+→'];
  return ['Alt+←', 'Alt+→'];
}

export function navigationDirection(keymap: NavigationKeymap, platform: string, event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>): number {
  const mac = /mac/i.test(platform);
  const arrow = event.code === 'ArrowLeft' ? -1 : event.code === 'ArrowRight' ? 1 : 0;
  if (keymap === 'idea') {
    if (mac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey)
      return event.code === 'BracketLeft' ? -1 : event.code === 'BracketRight' ? 1 : 0;
    if (!mac && event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey) return arrow;
  } else if (keymap === 'vscode' && (mac || /linux/i.test(platform))) {
    if (event.code === 'Minus' && event.ctrlKey && !event.metaKey && (mac ? !event.altKey : event.altKey === !event.shiftKey)) return event.shiftKey ? 1 : -1;
  } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) return arrow;
  return 0;
}
