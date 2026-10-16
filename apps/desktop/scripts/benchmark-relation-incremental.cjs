// Read-only cached declarations. Simulated method edits exist only in memory.
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { load } = require('@codegen/code-intelligence/relations-cache.cjs');
const { buildRelationIndex, updateRelationIndex, queryRelationIndex } = require('@codegen/code-intelligence/workspace-relations.cjs');
async function main() {
  const [root, cache] = process.argv.slice(2);
  if (!root || !cache) throw new Error('Usage: PROJECT DECLARATION_CACHE');
  const before = await load(cache, await fs.realpath(root));
  const file = [...before.keys()].find(file => file.endsWith('/NavigationAdminService.java'));
  assert.ok(file, 'Expected NavigationAdminService.java in the existing cache');
  const after = new Map(before), changed = structuredClone(before.get(file));
  const method = changed.java.flatMap(type => type.methods).find(method => method.name === 'query');
  assert.ok(method); method.parameters.push('int'); after.set(file, changed);
  const base = buildRelationIndex(before), timings = [];
  for (let round = 0; round < 5; round++) {
    let updated, full, incrementalMs, fullMs;
    const incremental = () => { const start = performance.now(); updated = updateRelationIndex(base, before, after); incrementalMs = performance.now() - start; };
    const rebuild = () => { const start = performance.now(); full = buildRelationIndex(after); fullMs = performance.now() - start; };
    if (round % 2) { rebuild(); incremental(); } else { incremental(); rebuild(); }
    assert.equal(updated.mode, 'incremental');
    assert.equal(updated.incomplete, false);
    for (const file of after.keys()) assert.deepEqual(queryRelationIndex(updated, file), queryRelationIndex(full, file), file);
    assert.equal(updated.edgeCount, full.edgeCount);
    timings.push({ incrementalMs: Math.round(incrementalMs), fullMs: Math.round(fullMs) });
    console.log(JSON.stringify({ round, recomputedTypes: updated.recomputedTypes, ...timings.at(-1), allFilesIdentical: true }));
  }
  const median = key => timings.map(timing => timing[key]).sort((a, b) => a - b)[2];
  console.log(JSON.stringify({ files: before.size, totalTypes: [...before.values()].reduce((sum, file) => sum + (file.java?.length || 0), 0), changedFile: file, incrementalMedianMs: median('incrementalMs'), fullMedianMs: median('fullMs') }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
