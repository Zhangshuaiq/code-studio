import { useCallback, useState } from 'react';
export function useFolderExpansion(scope: string) {
  const [state, setState] = useState<{ scope: string; paths: Record<string, boolean> }>({ scope, paths: {} });
  const paths = state.scope === scope ? state.paths : {};
  const isOpen = (path: string, depth: number) => Object.prototype.hasOwnProperty.call(paths, path) ? paths[path] : depth <= 1;
  const toggle = useCallback((path: string, depth: number) => setState(current => {
    const paths = current.scope === scope ? current.paths : {};
    return { scope, paths: { ...paths, [path]: !(Object.prototype.hasOwnProperty.call(paths, path) ? paths[path] : depth <= 1) } };
  }), [scope]);
  return { isOpen, toggle };
}
