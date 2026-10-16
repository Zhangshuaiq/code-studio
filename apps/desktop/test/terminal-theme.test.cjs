const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalTheme } = require('@codegen/code-intelligence/terminal-theme.cjs');
const { defaults, presets } = require('@codegen/code-intelligence/editor-appearance.cjs');
test('terminal follows application light/dark mode when editor theme is automatic', () => {
  const light = terminalTheme({ ...defaults, theme: 'auto' }, 'light'), dark = terminalTheme({ ...defaults, theme: 'auto' }, 'dark');
  assert.equal(light.background, '#ffffff'); assert.equal(dark.background, '#1e1e1e');
  assert.notEqual(light.foreground, dark.foreground); assert.notEqual(light.red, dark.red);
  for (const theme of [light, dark]) assert.equal(Object.keys(theme).length, 21);
});
test('every preset reuses editor colors regardless of page theme; custom ANSI overrides are honored', () => {
  for (const [name, preset] of Object.entries(presets)) {
    const theme = terminalTheme({ ...defaults, theme: name }, 'dark');
    assert.equal(theme.background, preset.colors['editor.background']);
    assert.equal(theme.foreground, preset.colors['editor.foreground']);
  }
  const custom = terminalTheme({ theme: 'custom', customTheme: { base: 'vs-dark', colors: { 'editor.background': '#123456', 'terminal.background': '#223344', 'terminal.ansiRed': '#abcdef' } } }, 'light');
  assert.equal(custom.background, '#223344'); assert.equal(custom.red, '#abcdef');
});
