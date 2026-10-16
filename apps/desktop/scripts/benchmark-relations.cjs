// Read-only benchmark. Pass a project root; never writes into that project.
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { relatedLocations, closeRelations } = require('@codegen/code-intelligence/workspace-relations.cjs');
async function main() {
  const root = await fs.realpath(process.argv[2]);
  const file = process.argv[3];
  if (!file) throw new Error('Usage: node benchmark-relations.cjs PROJECT RELATIVE_JAVA_FILE');
  try {
    const cacheDirectory = process.argv[4];
    const content = await fs.readFile(path.join(root, file), 'utf8');
    for (const cycle of ['first-worker', 'reopened-worker']) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const start = performance.now();
        const result = await relatedLocations(root, { path: file, content }, { cacheDirectory });
        console.log(JSON.stringify({ cycle, attempt, elapsedMs: Math.round(performance.now() - start), rows: result.rows.length, incomplete: result.incomplete, validation: result.validation }));
      }
      await closeRelations();
    }
  } finally { await closeRelations(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
