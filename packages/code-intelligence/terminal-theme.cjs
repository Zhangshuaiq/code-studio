const { presets } = require('./editor-appearance.cjs');
function terminalTheme(appearance, uiTheme) {
  const selected = appearance.theme === 'custom' ? appearance.customTheme : presets[appearance.theme];
  const dark = selected ? ['vs-dark', 'hc-black'].includes(selected.base) : ['dark', 'contrast'].includes(appearance.theme) || (appearance.theme === 'auto' && uiTheme === 'dark');
  const colors = selected?.colors || {};
  const highContrast = appearance.theme === 'contrast' || selected?.base === 'hc-black';
  const palette = dark
    ? ['#000000','#f14c4c','#23d18b','#f5f543','#3b8eea','#d670d6','#29b8db','#e5e5e5','#666666','#f14c4c','#23d18b','#f5f543','#3b8eea','#d670d6','#29b8db','#ffffff']
    : ['#000000','#cd3131','#008000','#795e00','#0451a5','#a626a4','#007d9a','#555555','#666666','#c72e2e','#087f23','#856600','#0066bf','#b520b5','#007c91','#767676'];
  const names = ['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
  return {
    background: colors['terminal.background'] || colors['editor.background'] || (highContrast ? '#000000' : dark ? '#1e1e1e' : '#ffffff'),
    foreground: colors['terminal.foreground'] || colors['editor.foreground'] || (highContrast ? '#ffffff' : dark ? '#d4d4d4' : '#1f2937'),
    cursor: colors['terminalCursor.foreground'] || colors['editorCursor.foreground'] || colors['editor.foreground'] || (dark ? '#ffffff' : '#1f2937'),
    cursorAccent: colors['editor.background'] || (dark ? '#1e1e1e' : '#ffffff'),
    selectionBackground: colors['terminal.selectionBackground'] || colors['editor.selectionBackground'] || (dark ? '#264f78' : '#add6ff'),
    ...Object.fromEntries(names.map((name, i) => [name, colors[`terminal.ansi${name[0].toUpperCase()}${name.slice(1)}`] || palette[i]])),
  };
}
module.exports = { terminalTheme };
