export interface WorkspaceTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: WorkspaceTreeNode[];
}

export function buildWorkspaceFileTree(entries: readonly (string | { path: string; type: 'file' | 'directory' })[]): WorkspaceTreeNode[] {
  const root: WorkspaceTreeNode = { name: '', path: '', isDir: true, children: [] };
  const nodes = new Map<string, WorkspaceTreeNode>([['', root]]);
  for (const entry of entries) {
    const relative = typeof entry === 'string' ? entry : entry.path;
    if (!relative || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) continue;
    const parts = relative.split('/');
    let parent = root, prefix = '';
    for (let index = 0; index < parts.length; index++) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
      const isDir = index < parts.length - 1 || (typeof entry !== 'string' && entry.type === 'directory');
      let node = nodes.get(prefix);
      if (!node) {
        node = { name: parts[index], path: prefix, isDir, children: [] };
        nodes.set(prefix, node); parent.children.push(node);
      } else if (isDir) node.isDir = true;
      parent = node;
    }
  }
  // Iterating the map avoids recursive construction/sorting stack limits.
  for (const node of nodes.values()) node.children.sort((left, right) => left.isDir === right.isDir ? left.name.localeCompare(right.name) : left.isDir ? -1 : 1);
  return root.children;
}
