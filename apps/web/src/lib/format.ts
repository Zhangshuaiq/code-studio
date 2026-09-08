// 用浏览器版 Prettier 格式化代码。插件按需动态加载，不进主包。

export function fileExt(path?: string): string {
  return path?.split('.').pop()?.toLowerCase() ?? '';
}

// 该扩展名是否支持格式化
export function canFormat(path?: string): boolean {
  return !!parserFor(fileExt(path));
}

function parserFor(ext: string): string | null {
  const map: Record<string, string> = {
    js: 'babel',
    jsx: 'babel',
    mjs: 'babel',
    cjs: 'babel',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
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
  switch (parser) {
    case 'babel':
    case 'json':
      return [
        (await import('prettier/plugins/babel')).default,
        (await import('prettier/plugins/estree')).default,
      ];
    case 'typescript':
      return [
        (await import('prettier/plugins/typescript')).default,
        (await import('prettier/plugins/estree')).default,
      ];
    case 'css':
    case 'scss':
    case 'less':
      return [(await import('prettier/plugins/postcss')).default];
    case 'html':
      return [(await import('prettier/plugins/html')).default];
    case 'markdown':
      return [(await import('prettier/plugins/markdown')).default];
    case 'yaml':
      return [(await import('prettier/plugins/yaml')).default];
    default:
      return [];
  }
}

/** 格式化代码；不支持的类型或解析失败时抛错 */
export async function formatCode(code: string, path?: string): Promise<string> {
  const parser = parserFor(fileExt(path));
  if (!parser) throw new Error('该文件类型不支持格式化');
  const prettier = await import('prettier/standalone');
  const plugins = await pluginsFor(parser);
  return prettier.format(code, {
    parser,
    plugins,
    singleQuote: true,
    semi: true,
    tabWidth: 2,
    printWidth: 100,
  });
}
