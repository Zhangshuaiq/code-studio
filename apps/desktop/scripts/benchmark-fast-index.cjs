const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { FastIndexClient } = require('@codegen/code-intelligence/fast-index-client.cjs');
const { summary } = require('./benchmark-real-workspace.cjs');
async function main() {
  const root = await fs.realpath(process.argv[2] || '.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-index-benchmark-'));
  const options = { root, databasePath: path.join(directory, 'index.sqlite3') };
  let client;
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  try {
    const started = performance.now(); client = new FastIndexClient(options);
    const first = await client.refresh(); const buildMs = performance.now() - started;
    await client.close(); client = null;
    const reopenStart = performance.now(); client = new FastIndexClient(options);
    const cached = await client.search('Service'); const reopenSearchMs = performance.now() - reopenStart;
    const validationStart = performance.now(); const validated = await client.refresh(); const validationMs = performance.now() - validationStart;
    const samples = [];
    for (let i = 0; i < 30; i++) { const start = performance.now(); await client.search('Service'); samples.push(performance.now() - start); }
    console.log(JSON.stringify({ runtime: { node: process.versions.node, electron: process.versions.electron || null, platform: process.platform, arch: process.arch }, project: path.basename(root), first, buildMs: +buildMs.toFixed(3), reopenSearchMs: +reopenSearchMs.toFixed(3), cachedBeforeValidation: { results: cached.items.length, state: cached.index.state, complete: cached.index.complete }, validationMs: +validationMs.toFixed(3), validated, searchWithThreadRoundTrip: summary(samples), mainEventLoop: { p95Ms: +(delay.percentile(95) / 1e6).toFixed(3), maxMs: +(delay.max / 1e6).toFixed(3) }, method: 'Formal shared worker/client/store, real read-only project, isolated temporary index. Reopen search includes starting the worker. Search matches substring/abbreviations and includes IPC but not HTTP/UI. Warm revalidation stats all files but reparses only changed content; metadata stamps and SHA-256 gate incremental reuse. No JDT, Electron input or packaged asar benchmark.' }, null, 2));
  } finally { delay.disable(); await client?.close(); await fs.rm(directory, { recursive: true, force: true }); }
}
if (process.versions.electron) {
  const { app } = require('electron'); app.whenReady().then(main).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
} else main().catch(error => { console.error(error); process.exitCode = 1; });
