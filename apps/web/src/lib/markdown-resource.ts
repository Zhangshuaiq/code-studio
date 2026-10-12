export function markdownResourcePath(documentPath: string, source: string): string | null {
  if (!source || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(source.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!decoded || /[\0\r\n\\]/.test(decoded) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(decoded)) return null;
  const parts = decoded.startsWith('/') ? [] : documentPath.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

export interface MarkdownNavigation { path: string; line?: number; column?: number; anchor?: string }
export function markdownNavigation(documentPath: string, href: string): MarkdownNavigation | null {
  const separator = href.indexOf('#');
  const file = separator < 0 ? href : href.slice(0, separator);
  const path = !file && separator >= 0 ? documentPath : markdownResourcePath(documentPath, file);
  if (!path) return null;
  let anchor = '';
  try { if (separator >= 0) anchor = decodeURIComponent(href.slice(separator + 1)); } catch { return null; }
  if (anchor.length > 500 || /[\0\r\n]/.test(anchor)) return null;
  const position = /^L([1-9]\d{0,6})(?:C([1-9]\d{0,6}))?(?:-L[1-9]\d{0,6})?$/.exec(anchor);
  if (position) {
    const line = Number(position[1]), column = Number(position[2] || 1);
    if (line > 1000000 || column > 1000000) return null;
    return { path, line, column };
  }
  if (/^L\d/.test(anchor)) return null;
  return { path, ...(anchor ? { anchor } : {}) };
}

interface MarkdownNode { type: string; value?: string; children?: MarkdownNode[]; data?: { hProperties?: Record<string, unknown> } }
export function remarkHeadingAnchors() {
  return (tree: MarkdownNode) => {
    const used = new Set<string>();
    const text = (node: MarkdownNode): string => {
      const pending = [node], parts: string[] = [];
      while (pending.length) {
        const current = pending.pop()!;
        if (current.value) parts.push(current.value);
        else for (let index = (current.children?.length || 0) - 1; index >= 0; index--) pending.push(current.children![index]);
      }
      return parts.join('');
    };
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'heading') {
        const base = text(node).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
        let id = base, index = 1;
        while (used.has(id)) id = `${base}-${index++}`;
        used.add(id); node.data ||= {}; node.data.hProperties = { ...node.data.hProperties, id };
      }
      for (let index = (node.children?.length || 0) - 1; index >= 0; index--) pending.push(node.children![index]);
    }
  };
}
