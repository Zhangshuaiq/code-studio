export type SourceBreakpoint = number | { line: number; condition?: string; hitCondition?: string; logMessage?: string };
export interface SourceEdit {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  text: string;
}

const copyPoints = (points: SourceBreakpoint[]) => points.map(point => typeof point === 'number' ? point : { ...point });

// Disk-aligned positions are distinct from both editor drafts and the last
// encrypted write. A partial Save All may advance only some source files.
export class BreakpointDiskCheckpoints {
  private files: Record<string, SourceBreakpoint[]> = {};
  reset(points: Record<string, SourceBreakpoint[]>) {
    this.files = Object.fromEntries(Object.entries(points).map(([file, entries]) => [file, copyPoints(entries)]));
  }
  capture(file: string, points: SourceBreakpoint[]) {
    const snapshot = copyPoints(points);
    return () => { this.files[file] = snapshot; };
  }
  discard(file: string, current: Record<string, SourceBreakpoint[]>) {
    const next = { ...current };
    const saved = this.files[file] || [];
    if (saved.length) next[file] = copyPoints(saved); else delete next[file];
    return next;
  }
}

// Alternative version IDs return to an earlier value on undo. Keep only small
// breakpoint snapshots, never document text. Bound memory across all files.
export class BreakpointEditHistory {
  private snapshots = new Map<string, SourceBreakpoint[]>();
  private size = 0;
  private remember(file: string, version: number, points: SourceBreakpoint[]) {
    const key = JSON.stringify([file, version]);
    const previous = this.snapshots.get(key);
    if (previous) this.size -= previous.length;
    this.snapshots.delete(key);
    this.snapshots.set(key, points.map(point => typeof point === 'number' ? point : { ...point }));
    this.size += points.length;
    while (this.snapshots.size > 256 || this.size > 20000) {
      const first = this.snapshots.keys().next().value!;
      this.size -= this.snapshots.get(first)!.length; this.snapshots.delete(first);
    }
  }
  clear(file?: string) {
    for (const key of this.snapshots.keys()) if (!file || JSON.parse(key)[0] === file) {
      this.size -= this.snapshots.get(key)!.length; this.snapshots.delete(key);
    }
  }
  apply(file: string, before: number, after: number, points: SourceBreakpoint[], changes: SourceEdit[], undoRedo: boolean) {
    this.remember(file, before, points);
    const saved = undoRedo ? this.snapshots.get(JSON.stringify([file, after])) : undefined;
    const result = saved ? saved.map(point => typeof point === 'number' ? point : { ...point }) : migrateBreakpoints(points, changes);
    this.remember(file, after, result);
    return result;
  }
}

// Monaco changes refer to the pre-edit document. Apply from bottom to top,
// so every remaining range still addresses its original lines.
export function migrateBreakpoints(points: SourceBreakpoint[], changes: SourceEdit[]): SourceBreakpoint[] {
  let result = points;
  for (const { range: r, text } of [...changes].sort((a, b) => b.range.startLineNumber - a.range.startLineNumber || b.range.startColumn - a.range.startColumn)) {
    const added = (text.match(/\r\n|\r|\n/g) || []).length;
    const delta = added - (r.endLineNumber - r.startLineNumber);
    result = result.flatMap(point => {
      let line = typeof point === 'number' ? point : point.line;
      // Fully removed source lines lose their breakpoint. A replacement on the
      // starting line keeps its breakpoint if replacement text remains.
      if (r.endLineNumber > r.startLineNumber && line >= r.startLineNumber && line < r.endLineNumber && (line > r.startLineNumber || r.startColumn === 1)) {
        if (line !== r.startLineNumber || !text) return [];
      } else if (line > r.endLineNumber || (line === r.endLineNumber && (r.endLineNumber > r.startLineNumber || r.startColumn === 1))) {
        line += delta;
      }
      return [typeof point === 'number' ? line : { ...point, line }];
    });
  }
  // Joining lines may merge anchors. Keep one deterministic breakpoint per line.
  return [...new Map(result.map(point => [typeof point === 'number' ? point : point.line, point])).values()]
    .sort((a, b) => (typeof a === 'number' ? a : a.line) - (typeof b === 'number' ? b : b.line));
}
