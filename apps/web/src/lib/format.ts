// 用浏览器版 Prettier 格式化代码。插件按需动态加载，不进主包。

export function fileExt(path?: string): string {
  return path?.split('.').pop()?.toLowerCase() ?? '';
}

// 该扩展名是否支持格式化
export function canFormat(path?: string): boolean {
  return !!parserFor(fileExt(path));
}
export function canFormatDocument(path?: string) { return canFormat(path) || ['java', 'py', 'sh', 'bash', 'zsh', 'vue'].includes(fileExt(path)); }

function parserFor(ext: string): string | null {
  const map: Record<string, string> = {
    js: 'babel',
    jsx: 'babel',
    mjs: 'babel',
    cjs: 'babel',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    xml: 'xml',
    sql: 'sql',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
  };
  return map[ext] ?? null;
}

async function pluginsFor(parser: string): Promise<any[]> {
  const plugin = (value: any) => value.default || value;
  switch (parser) {
    case 'babel':
    case 'json':
      return [
        plugin(await import('prettier/plugins/babel')),
        plugin(await import('prettier/plugins/estree')),
      ];
    case 'typescript':
      return [
        plugin(await import('prettier/plugins/typescript')),
        plugin(await import('prettier/plugins/estree')),
      ];
    case 'css':
    case 'scss':
    case 'less':
      return [plugin(await import('prettier/plugins/postcss'))];
    case 'html':
      return [plugin(await import('prettier/plugins/html'))];
    case 'markdown':
      return [plugin(await import('prettier/plugins/markdown'))];
    case 'yaml':
      return [plugin(await import('prettier/plugins/yaml'))];
    case 'xml': return [plugin(await import('@prettier/plugin-xml'))];
    default:
      return [];
  }
}

/** 格式化代码；不支持的类型或解析失败时抛错 */
export async function formatCode(code: string, path?: string): Promise<string> {
  const parser = parserFor(fileExt(path));
  if (!parser) throw new Error('该文件类型不支持格式化');
  if (parser === 'sql') return (await import('sql-formatter')).format(code, { language: 'sql', tabWidth: 2 });
  const prettier = await import('prettier/standalone');
  const plugins = await pluginsFor(parser);
  return prettier.format(code, {
    parser,
    plugins,
    singleQuote: true,
    semi: true,
    tabWidth: 2,
    printWidth: 100,
    ...(parser === 'xml' ? { xmlWhitespaceSensitivity: 'strict' } : {}),
  });
}
export async function formatDocument(code: string, path: string, language: (input: { path: string; content: string }) => Promise<any>) {
  if (canFormat(path)) return formatCode(code, path);
  const response = await language({ path, content: code });
  const edits = response.result;
  if (!Array.isArray(edits)) throw Error('语言服务暂未提供格式化；Shell 需要本机安装 shfmt');
  const starts = [0]; for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  const offset = (position: any) => { if (!Number.isInteger(position?.line) || !Number.isInteger(position.character) || position.line < 0 || position.line >= starts.length || position.character < 0) throw Error('格式化位置无效'); const end = code.indexOf('\n', starts[position.line]); const limit = end < 0 ? code.length : end; const value = starts[position.line] + position.character; if (value > limit) throw Error('格式化位置超出文件'); return value; };
  const changes = edits.map((edit: any) => ({ start: offset(edit.range?.start), end: offset(edit.range?.end), text: edit.newText })).sort((a: any, b: any) => b.start - a.start);
  let boundary = code.length, output = code;
  for (const edit of changes) { if (edit.end < edit.start || edit.end > boundary || typeof edit.text !== 'string') throw Error('格式化编辑范围无效'); output = output.slice(0, edit.start) + edit.text + output.slice(edit.end); boundary = edit.start; }
  return output;
}
