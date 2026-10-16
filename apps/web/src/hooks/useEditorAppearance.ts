import { useEffect, useState } from 'react';
import { useEditorPreferences } from '../store/editorPreferences';
import { presetThemes } from '../lib/editor-appearance';
export function useEditorAppearance(monaco: any, uiTheme: 'light' | 'dark') {
  const appearance = useEditorPreferences(state => state.appearance);
  const [registered, setRegistered] = useState(false);
  const themes: Record<string, string> = { auto: uiTheme === 'dark' ? 'vs-dark' : 'light', light: 'light', dark: 'vs-dark', ...Object.fromEntries(Object.keys(presetThemes).map(key => [key, `code-studio-${key}`])), contrast: 'hc-black', custom: 'code-studio-custom' };
  useEffect(() => {
    document.documentElement.style.setProperty('--code-editor-font-family', appearance.fontFamily);
    document.documentElement.style.setProperty('--code-editor-font-size', `${appearance.fontSize}px`);
  }, [appearance.fontFamily, appearance.fontSize]);
  useEffect(() => {
    if (!monaco) return;
    for (const [key, theme] of Object.entries(presetThemes)) monaco.editor.defineTheme(`code-studio-${key}`, theme);
    if (appearance.customTheme) monaco.editor.defineTheme('code-studio-custom', appearance.customTheme);
    monaco.editor.setTheme(themes[appearance.theme]);
    setRegistered(true);
  }, [monaco, appearance.customTheme, appearance.theme, uiTheme]);
  const baseAppearanceOptions = { fontSize: appearance.fontSize, fontFamily: appearance.fontFamily, lineHeight: appearance.lineHeight, fontLigatures: appearance.fontLigatures, minimap: { enabled: appearance.minimap }, wordWrap: appearance.wordWrap };
  return { editorTheme: registered ? themes[appearance.theme] : themes.auto, baseAppearanceOptions, appearanceOptions: { ...baseAppearanceOptions, lineNumbers: appearance.lineNumbers ? 'on' as const : 'off' as const } };
}
