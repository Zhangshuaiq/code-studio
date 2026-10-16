// Read-only project inputs. Only the explicitly supplied cache directory is written.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { relatedLocations, closeRelations } = require('@codegen/code-intelligence/workspace-relations.cjs');
async function main() {
  const [root, file, cacheDirectory, expectedPath] = process.argv.slice(2);
  if (!root || !file || !cacheDirectory || !expectedPath) throw new Error('Usage: PROJECT FILE CACHE EXPECTED_IMPLEMENTATION');
  const content = await fs.readFile(path.join(root, file), 'utf8');
  const lines = content.split('\n');
  const row = lines.findIndex(line => /\bquery\s*\(/.test(line));
  assert.ok(row >= 0);
  const input = { path: file, content, line: row + 1, column: lines[row].indexOf('query') + 1 };
  try {
    for (const cycle of ['cold-worker', 'persisted-worker']) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = performance.now();
        const result = await relatedLocations(root, input, { cacheDirectory });
        const links = result.rows.flatMap(row => row.links);
        assert.equal(result.incomplete, false);
        assert.equal(result.semanticComplete, false);
        assert.ok(links.some(link => link.path === expectedPath && link.label.endsWith('.query')));
        console.log(JSON.stringify({ cycle, attempt, elapsedMs: Math.round(performance.now() - started), links, validation: result.validation }));
      }
      const targetContent = await fs.readFile(path.join(root, expectedPath), 'utf8');
      const switchedAt = performance.now();
      const switched = await relatedLocations(root, { path: expectedPath, content: targetContent }, { cacheDirectory });
      assert.ok(switched.rows.some(row => row.links.some(link => link.path === file && link.direction === 'up')));
      assert.equal(switched.validation.graphBuilds, 1, 'Opening a second clean file must reuse the graph');
      console.log(JSON.stringify({ cycle, switchedFile: true, elapsedMs: Math.round(performance.now() - switchedAt), rows: switched.rows.length, validation: switched.validation }));
      await closeRelations();
    }
  } finally { await closeRelations(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
