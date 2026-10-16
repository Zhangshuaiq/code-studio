declare module '@codegen/code-intelligence/editor-appearance.cjs' {
  const schema: { defaults: import('./lib/editor-appearance').EditorAppearance; presets: Record<string, NonNullable<import('./lib/editor-appearance').EditorAppearance['customTheme']>>; validateAppearance: (input: unknown) => import('./lib/editor-appearance').EditorAppearance };
  export default schema;
}
declare module '@codegen/code-intelligence/terminal-theme.cjs' {
  const schema: { terminalTheme: (appearance: import('./lib/editor-appearance').EditorAppearance, uiTheme: 'light' | 'dark') => import('@xterm/xterm').ITheme };
  export default schema;
}
