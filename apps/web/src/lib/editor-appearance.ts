import schema from '@codegen/code-intelligence/editor-appearance.cjs';
export interface EditorAppearance {
  fontSize: number; fontFamily: string; lineHeight: number; fontLigatures: boolean; minimap: boolean; wordWrap: 'off' | 'on'; lineNumbers: boolean;
  theme: 'auto' | 'light' | 'dark' | 'idea' | 'darcula' | 'contrast' | 'custom';
  customTheme: { base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'; inherit: boolean; rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>; colors: Record<string, string> } | null;
}
export const defaultAppearance: EditorAppearance = schema.defaults;
export const presetThemes = schema.presets;
export const validateAppearance = (value: unknown): EditorAppearance => schema.validateAppearance(value);
export function importAppearance(content: string): EditorAppearance {
  if (new TextEncoder().encode(content).length > 128 * 1024) throw Error('样式文件最多 128 KiB');
  const value = JSON.parse(content);
  if (value?.format === 'code-studio-editor-style') { if (value.version !== 1) throw Error('不支持的样式版本'); return validateAppearance(value.appearance); }
  if (value?.base && value?.rules) return validateAppearance({ theme: 'custom', customTheme: value });
  if (!value || typeof value !== 'object' || !Object.keys(value).some(key => Object.prototype.hasOwnProperty.call(defaultAppearance, key))) throw Error('不是有效的编辑器样式文件');
  return validateAppearance(value);
}
export function exportAppearance(appearance: EditorAppearance) {
  const profile = { format: 'code-studio-editor-style', version: 1, appearance: validateAppearance(appearance) };
  const pretty = JSON.stringify(profile, null, 2);
  return new TextEncoder().encode(pretty).length <= 128 * 1024 ? pretty : JSON.stringify(profile);
}
