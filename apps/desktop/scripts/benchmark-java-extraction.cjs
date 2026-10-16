// Compare extractors against the same read-only corpus, one file at a time.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { JavaSyntaxIndex } = require('@codegen/code-intelligence/java-syntax-index.cjs');
const { JavaFastIndex } = require('@codegen/code-intelligence/java-fast-index.cjs');
const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea']);
async function main() {
  if (!process.argv[2]) throw new Error('Usage: node benchmark-java-extraction.cjs PROJECT [--full-index]');
  const root = await fs.realpath(process.argv[2]), syntax = await JavaSyntaxIndex.create();
  const pending = [root], totals = { legacyMs: 0, nativeMs: 0, files: 0, symbols: 0 };
  try {
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) { pending.push(absolute); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.java')) continue;
        if ((await fs.stat(absolute)).size > 1024 * 1024) throw new Error('Benchmark source exceeds 1MiB');
        const content = await fs.readFile(absolute, 'utf8'), file = path.relative(root, absolute).split(path.sep).join('/');
        const results = {};
        for (const mode of totals.files % 2 ? ['native', 'legacy'] : ['legacy', 'native']) {
          const start = performance.now();
          const result = syntax.parse(content, file, { legacyTraversal: mode === 'legacy' });
          totals[mode + 'Ms'] += performance.now() - start;
          const { visitedNodes, ...output } = result; results[mode] = output;
        }
        assert.deepEqual(results.native, results.legacy, `Extractor mismatch: ${file}`);
        if (results.native.truncated) throw new Error(`Incomplete benchmark extraction: ${file}`);
        totals.files++; totals.symbols += results.native.symbols.length;
      }
    }
    console.log(JSON.stringify({ ...totals, legacyMs: Math.round(totals.legacyMs), nativeMs: Math.round(totals.nativeMs), identical: true }));
  } finally { syntax.close(); }
  if (process.argv.includes('--full-index')) {
    const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'java-extraction-index-'));
    let attempt = 0;
    for (const mode of ['legacy', 'native', 'native', 'legacy']) {
      const index = new JavaFastIndex({ root, databasePath: path.join(directory, `${attempt++}.sqlite3`) });
      try {
        const parser = await index.getParser(), parse = parser.parse.bind(parser);
        parser.parse = (source, file, options = {}) => parse(source, file, { ...options, legacyTraversal: mode === 'legacy' });
        const result = await index.refresh();
        console.log(JSON.stringify({ mode, coldIndexMs: result.elapsedMs, files: result.parsedFiles, complete: result.complete }));
      } finally { await index.close(); }
    }
    console.log(JSON.stringify({ diagnosticDirectory: directory, retained: true }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
