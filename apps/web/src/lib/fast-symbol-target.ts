export interface FastSymbolTarget {
  path: string;
  name: string;
  line: number;
  column: number;
  hash: string;
  hashSource: 'disk' | 'overlay';
}
export function staleFastSymbol() {
  return Object.assign(new Error('代码已变化，请从更新后的搜索结果打开'), { code: 'FAST_SYMBOL_STALE' });
}
// Validate the exact content that will be displayed, not a cached baseline or
// filesystem stat. Coordinates are Monaco UTF-16 positions, not UTF-8 bytes.
export async function verifyFastSymbolTarget(target: FastSymbolTarget, content: string) {
  if (typeof content !== 'string' || !target || typeof target.path !== 'string' || !target.path.endsWith('.java') || /[\0\\]/.test(target.path) || target.path.startsWith('/') || /^[A-Za-z]:/.test(target.path) || target.path.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/i.test(target.hash || '') || !['disk', 'overlay'].includes(target.hashSource) || !target.name || !Number.isInteger(target.line) || target.line < 1 || !Number.isInteger(target.column) || target.column < 1) throw staleFastSymbol();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const line = content.split(/\r\n|\r|\n/)[target.line - 1];
  if (hash !== target.hash.toLowerCase() || line?.slice(target.column - 1, target.column - 1 + target.name.length) !== target.name) throw staleFastSymbol();
}
