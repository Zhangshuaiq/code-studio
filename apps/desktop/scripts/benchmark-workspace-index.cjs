const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { LocalStore } = require('../src/local-store.cjs');

async function measure(operation, rounds = 30) {
  await operation();
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const start = performance.now(); await operation(); samples.push(performance.now() - start);
  }
  samples.sort((a,b) => a-b);
  return { medianMs: +samples[Math.floor(rounds / 2)].toFixed(3), p95Ms: +samples[Math.floor(rounds * .95)].toFixed(3) };
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'index-benchmark-'));
  let store;
  try {
    store = new LocalStore(path.join(directory, 'bench.sqlite3'));
    for (const count of [1000, 10000]) {
      const root = `/benchmark/${count}`;
      const snapshot = { version: 1, revision: 1, root, updatedAt: Date.now(), truncated: false, items: Array.from({ length: count }, (_, index) => ({ path: `src/module-${index % 100}/File${index}.java`, name: `File${index}.java`, type: 'file', depth: 2, size: 4096, stamp: '1791597600000:1791597600000:4096' })) };
      store.writeWorkspaceIndex(snapshot);
      const file = path.join(directory, `${count}.json`);
      const serialized = JSON.stringify(snapshot);
      await fs.writeFile(file, serialized);
      const memory = new Map([[root, snapshot]]);
      const jsonRead = await measure(async () => JSON.parse(await fs.readFile(file, 'utf8')));
      const sqliteRead = await measure(() => store.readWorkspaceIndex(root));
      const memoryRead = await measure(() => { for (let index = 0; index < 10000; index++) memory.get(root); }, 100);
      const changed = { ...snapshot, updatedAt: Date.now(), items: snapshot.items.map((item, index) => index < 10 ? { ...item, stamp: `${Date.now()}:new:4096` } : item) };
      const fileUpdate = await measure(async () => { await fs.writeFile(file, JSON.stringify(changed)); });
      const dbUpdate = await measure(() => {
        store.writeWorkspaceIndex(changed, snapshot);
      });
      console.log(JSON.stringify({ entries: count, jsonBytes: Buffer.byteLength(serialized), jsonRead, sqliteRead, memoryReadPerLookupMs: +(memoryRead.medianMs / 10000).toFixed(7), update10Files: { jsonRewrite: fileUpdate, sqliteDelta: dbUpdate } }));
    }
    console.log('Method: synthetic metadata, warmed OS cache and open SQLite connection, 30 measured reads/updates after warmup; no fsync durability equivalence, no true cold disk benchmark, no semantic reindex or source parsing included. Memory lookup excludes initial hydration.');
  } finally {
    store?.close(); await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
