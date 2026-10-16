const defaults = Object.freeze({ fontSize: 13, fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", lineHeight: 20, fontLigatures: false, minimap: false, wordWrap: 'off', lineNumbers: true, theme: 'auto', customTheme: null });
const presets = {
  idea: { base: 'vs', inherit: true, rules: [{ token: 'keyword', foreground: '000080', fontStyle: 'bold' }, { token: 'string', foreground: '008000' }, { token: 'comment', foreground: '808080' }], colors: { 'editor.background': '#ffffff', 'editor.foreground': '#000000', 'editor.selectionBackground': '#add6ff' } },
  darcula: { base: 'vs-dark', inherit: true, rules: [{ token: 'keyword', foreground: 'CC7832' }, { token: 'string', foreground: '6A8759' }, { token: 'comment', foreground: '808080' }, { token: 'number', foreground: '6897BB' }], colors: { 'editor.background': '#2b2b2b', 'editor.foreground': '#a9b7c6', 'editorLineNumber.foreground': '#606366', 'editor.selectionBackground': '#214283' } },
};
// Original, self-contained palettes inspired by familiar IDE styles; no plugin code/assets.
function palette(base, background, foreground, keyword, string, comment, number, selection) {
  return { base, inherit: true, rules: [
    { token: 'keyword', foreground: keyword }, { token: 'string', foreground: string },
    { token: 'comment', foreground: comment, fontStyle: 'italic' }, { token: 'number', foreground: number },
    { token: 'type', foreground: number }, { token: 'tag', foreground: keyword },
    { token: 'attribute.name', foreground: number }, { token: 'delimiter', foreground: foreground.slice(1) },
  ], colors: { 'editor.background': background, 'editor.foreground': foreground,
    'editor.selectionBackground': selection, 'editor.inactiveSelectionBackground': selection + '80',
    'editorLineNumber.foreground': '#' + comment, 'editorLineNumber.activeForeground': foreground,
    'editorCursor.foreground': foreground, 'editor.lineHighlightBackground': selection + '30',
    'editorIndentGuide.background1': '#' + comment + '40', 'editorIndentGuide.activeBackground1': '#' + comment + '90',
    'editorWidget.background': background, 'editorWidget.foreground': foreground,
    'editorSuggestWidget.background': background, 'editorSuggestWidget.foreground': foreground,
    'editorSuggestWidget.selectedBackground': selection, 'editorGutter.background': background,
  } };
}
Object.assign(presets, {
  'xcode-light': palette('vs', '#FFFFFF', '#262626', '9B2393', 'C41A16', '707F8A', '1C00CF', '#B4D8FD'),
  'xcode-dark': palette('vs-dark', '#292A30', '#DFDFE0', 'FC5FA3', 'FC6A5D', '9AA5B1', 'D0BF69', '#515B70'),
  'jetbrains-light': palette('vs', '#FFFFFF', '#27282E', '0033B3', '067D17', '72777D', '1750EB', '#B2D7FF'),
  'jetbrains-dark': palette('vs-dark', '#1E1F22', '#BCBEC4', 'CF8E6D', '6AAB73', '8B8E95', '2AACB8', '#214283'),
  'github-light': palette('vs', '#FFFFFF', '#24292F', 'CF222E', '0A3069', '57606A', '0550AE', '#B6D7FF'),
  'github-dark': palette('vs-dark', '#0D1117', '#E6EDF3', 'FF7B72', 'A5D6FF', '8B949E', '79C0FF', '#264F78'),
  'material-default': palette('vs-dark', '#263238', '#EEFFFF', 'C792EA', 'C3E88D', '81959E', 'F78C6C', '#425B67'),
  'material-ocean': palette('vs-dark', '#0F111A', '#BFC7D5', 'C792EA', 'C3E88D', '7886A5', 'F78C6C', '#31445C'),
  'material-darker': palette('vs-dark', '#212121', '#EEFFFF', 'C792EA', 'C3E88D', '8A8A8A', 'F78C6C', '#424242'),
  'material-palenight': palette('vs-dark', '#292D3E', '#A6ACCD', 'C792EA', 'C3E88D', '8792B5', 'F78C6C', '#434758'),
  'material-light': palette('vs', '#FAFAFA', '#37474F', '7C4DFF', '558B2F', '68777D', 'B85B00', '#C9E9EF'),
});
function validateAppearance(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('编辑器样式必须是 JSON 对象');
  const value = { ...defaults };
  for (const [key, min, max] of [['fontSize',8,40],['lineHeight',12,80]]) {
    if (input[key] !== undefined) { if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw Error(`${key} 必须为 ${min}–${max} 的整数`); value[key] = input[key]; }
  }
  if (input.fontFamily !== undefined) {
    if (typeof input.fontFamily !== 'string' || !input.fontFamily.trim() || input.fontFamily.length > 256 || /[\x00-\x1f;{}<>]/.test(input.fontFamily) || /url\s*\(/i.test(input.fontFamily)) throw Error('字体名称无效');
    value.fontFamily = input.fontFamily;
  }
  for (const key of ['fontLigatures','minimap','lineNumbers']) if (input[key] !== undefined) { if (typeof input[key] !== 'boolean') throw Error(`${key} 必须是布尔值`); value[key] = input[key]; }
  for (const [key, allowed] of [['wordWrap',['off','on']],['theme',['auto','light','dark',...Object.keys(presets),'contrast','custom']]]) if (input[key] !== undefined) { if (!allowed.includes(input[key])) throw Error(`${key} 无效`); value[key] = input[key]; }
  if (input.customTheme != null) {
    const theme = input.customTheme;
    if (!['vs','vs-dark','hc-black','hc-light'].includes(theme.base) || !Array.isArray(theme.rules) || theme.rules.length > 500 || !theme.colors || typeof theme.colors !== 'object' || Array.isArray(theme.colors) || Object.keys(theme.colors).length > 200) throw Error('自定义主题格式无效');
    const color = c => typeof c === 'string' && /^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/.test(c);
    const colors = Object.create(null);
    for (const [key, v] of Object.entries(theme.colors)) { if (!/^[a-zA-Z][a-zA-Z0-9.]{0,100}$/.test(key) || !color(v)) throw Error('主题颜色必须为 #RRGGBB 或 #RRGGBBAA'); colors[key] = v; }
    const rules = theme.rules.map(rule => {
      if (!rule || typeof rule.token !== 'string' || rule.token.length > 120 || !/^[a-zA-Z0-9_.-]*$/.test(rule.token) || rule.token.split('.').some(part => ['__proto__','constructor','prototype'].includes(part))) throw Error('语法颜色规则无效');
      const result = { token: rule.token };
      for (const key of ['foreground','background']) if (rule[key] !== undefined) { if (typeof rule[key] !== 'string' || !/^[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/.test(rule[key])) throw Error('语法颜色规则无效'); result[key] = rule[key]; }
      if (rule.fontStyle !== undefined) { if (typeof rule.fontStyle !== 'string' || rule.fontStyle.length > 64 || !/^(?:(?:italic|bold|underline|strikethrough)(?: |$))*$/.test(rule.fontStyle)) throw Error('语法字体样式无效'); result.fontStyle = rule.fontStyle; }
      return result;
    });
    value.customTheme = { base: theme.base, inherit: theme.inherit !== false, colors, rules };
  }
  if (value.theme === 'custom' && !value.customTheme) throw Error('请选择一个自定义主题文件');
  if (new TextEncoder().encode(JSON.stringify(value)).length > 120 * 1024) throw Error('完整编辑器样式最多 120 KiB');
  return value;
}
function validatePreferences(input) {
  if (!input || typeof input !== 'object') throw Error('编辑器设置无效');
  const navigationKeymap = input.navigationKeymap === undefined ? 'idea' : input.navigationKeymap;
  if (!['idea','vscode','eclipse'].includes(navigationKeymap) || (input.chatVisible !== undefined && typeof input.chatVisible !== 'boolean')) throw Error('工作区设置无效');
  return { navigationKeymap, chatVisible: input.chatVisible !== false, appearance: validateAppearance(input.appearance === undefined ? {} : input.appearance) };
}
module.exports = { defaults, presets, validateAppearance, validatePreferences };
