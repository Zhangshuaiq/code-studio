// Reuse a declaration cache produced by benchmark-project-navigation.cjs.
// Reads project metadata/cache only; does not modify either.
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { load } = require('@codegen/code-intelligence/relations-cache.cjs');
const { buildRelationIndex, queryRelationIndex } = require('@codegen/code-intelligence/workspace-relations.cjs');
async function main() {
  const [root, cache] = process.argv.slice(2);
  if (!root || !cache) throw new Error('Usage: PROJECT DECLARATION_CACHE');
  const files = await load(cache, await fs.realpath(root));
  assert.ok(files.size > 0, 'Expected an existing declaration cache');
  const queries = [...files.entries()].filter(([, file]) => file.java?.some(type => type.supers.length)).slice(0, 30).map(([file]) => file);
  assert.ok(queries.length);
  const started = performance.now();
  const graph = buildRelationIndex(files);
  const built = performance.now();
  const expected = queries.map(file => queryRelationIndex(graph, file));
  const queried = performance.now();
  const baseline = [];
  for (const file of queries) baseline.push(queryRelationIndex(buildRelationIndex(files), file));
  const completed = performance.now();
  assert.deepEqual(expected, baseline);
  console.log(JSON.stringify({ files: files.size, queries: queries.length, edgeCount: graph.edgeCount, incomplete: graph.incomplete, buildMs: Math.round(built - started), reusedQueriesMs: Math.round(queried - built), withoutGraphReuseMs: Math.round(completed - queried), resultsIdentical: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
