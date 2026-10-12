export interface EditorLocation { path: string; line: number; column: number }
export interface NavigationHistory { entries: EditorLocation[]; index: number }

export function editorLocation(path: string, line = 1, column = 1): EditorLocation {
  return { path, line: Number.isFinite(line) ? Math.max(1, Math.floor(line)) : 1, column: Number.isFinite(column) ? Math.max(1, Math.floor(column)) : 1 };
}

function sameLocation(left: EditorLocation | undefined, right: EditorLocation) {
  return left?.path === right.path && left.line === right.line && left.column === right.column;
}

export function appendNavigation(history: NavigationHistory, from: EditorLocation, target: EditorLocation, limit = 100): NavigationHistory {
  from = editorLocation(from.path, from.line, from.column);
  target = editorLocation(target.path, target.line, target.column);
  if (sameLocation(from, target)) return history;
  const entries = history.entries.slice(0, history.index + 1);
  if (entries[entries.length - 1]?.path === from.path) entries[entries.length - 1] = from;
  else entries.push(from);
  if (!sameLocation(entries[entries.length - 1], target)) entries.push(target);
  const bounded = entries.slice(-Math.max(2, limit));
  return { entries: bounded, index: bounded.length - 1 };
}

export function restoreNavigation(history: NavigationHistory, index: number, current?: EditorLocation): NavigationHistory {
  if (!Number.isInteger(index) || index < 0 || index >= history.entries.length || index === history.index) return history;
  const entries = history.entries.slice();
  if (current && entries[history.index]?.path === current.path) entries[history.index] = editorLocation(current.path, current.line, current.column);
  return { entries, index };
}
