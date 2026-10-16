// Read-only source benchmark; index files are created in a private temp folder.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JavaFastIndex } = require('@codegen/code-intelligence/java-fast-index.cjs');
async function main() {
  const root = await fs.realpath(process.argv[2]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'code-studio-validation-'));
  const databasePath = path.join(directory, 'index.sqlite3');
  let index;
  try {
    index = new JavaFastIndex({ root, databasePath });
    const cold = await index.refresh();
    console.log(JSON.stringify({ mode: 'cold', elapsedMs: cold.elapsedMs, parsed: cold.parsedFiles, complete: cold.complete }));
    await index.close();
    for (const mode of ['individual', 'batched', 'individual', 'batched']) {
      index = new JavaFastIndex({ root, databasePath });
      if (mode === 'individual') index.store.markSeenBatch = (entries, generation) => { for (const entry of entries) index.store.markSeen(entry.path, generation, entry.stamp); };
      const result = await index.refresh();
      console.log(JSON.stringify({ mode, elapsedMs: result.elapsedMs, parsed: result.parsedFiles, reused: result.unchangedFiles, complete: result.complete }));
      await index.close(); index = undefined;
    }
  } finally {
    await index?.close();
    console.log(JSON.stringify({ diagnosticDirectory: directory, retained: true }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
