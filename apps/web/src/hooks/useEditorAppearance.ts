import { useEffect, useState } from 'react';
import { useEditorPreferences } from '../store/editorPreferences';
import { presetThemes } from '../lib/editor-appearance';
export function useEditorAppearance(monaco: any, uiTheme: 'light' | 'dark') {
  const appearance = useEditorPreferences(state => state.appearance);
  const [registered, setRegistered] = useState(false);
  const themes = { auto: uiTheme === 'dark' ? 'vs-dark' : 'light', light: 'light', dark: 'vs-dark', idea: 'code-studio-idea', darcula: 'code-studio-darcula', contrast: 'hc-black', custom: 'code-studio-custom' };
  useEffect(() => {
    if (!monaco) return;
    monaco.editor.defineTheme('code-studio-idea', presetThemes.idea);
    monaco.editor.defineTheme('code-studio-darcula', presetThemes.darcula);
    if (appearance.customTheme) monaco.editor.defineTheme('code-studio-custom', appearance.customTheme);
    monaco.editor.setTheme(themes[appearance.theme]);
    setRegistered(true);
  }, [monaco, appearance.customTheme, appearance.theme, uiTheme]);
  const baseAppearanceOptions = { fontSize: appearance.fontSize, fontFamily: appearance.fontFamily, lineHeight: appearance.lineHeight, fontLigatures: appearance.fontLigatures, minimap: { enabled: appearance.minimap }, wordWrap: appearance.wordWrap };
  return { editorTheme: registered ? themes[appearance.theme] : themes.auto, baseAppearanceOptions, appearanceOptions: { ...baseAppearanceOptions, lineNumbers: appearance.lineNumbers ? 'on' as const : 'off' as const } };
}
