declare module '@codegen/code-intelligence/editor-appearance.cjs' {
  const schema: { defaults: import('./lib/editor-appearance').EditorAppearance; presets: Record<'idea' | 'darcula', NonNullable<import('./lib/editor-appearance').EditorAppearance['customTheme']>>; validateAppearance: (input: unknown) => import('./lib/editor-appearance').EditorAppearance };
  export default schema;
}
