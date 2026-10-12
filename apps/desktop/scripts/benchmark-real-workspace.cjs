// Read-only source workload. All API/cache state lives in a disposable directory.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createLocalApi } = require('../src/local-api.cjs');

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => +sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)].toFixed(3);
  return { samples: sorted.length, medianMs: percentile(.5), p95Ms: percentile(.95), maxMs: percentile(1) };
}
async function main() {
  const root = await fs.realpath(process.argv[2] || '.');
  const rounds = Number(process.argv[3] || 20);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('rounds must be 1..100');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'real-workspace-benchmark-'));
  const storePath = path.join(directory, 'benchmark.sqlite3');
  let api;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  const baselineMemory = process.memoryUsage();
  const cpu = process.cpuUsage();
  let peakRss = baselineMemory.rss;
  const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  delay.enable();
  const started = performance.now();
  try {
    const open = async () => {
      api = await createLocalApi({ token: 'benchmark-only', storePath });
      const project = api.registerWorkspace(root);
      const base = `${api.origin}/api/local/projects/${project.id}`;
      const request = async route => {
        const before = performance.now();
        const response = await fetch(`${base}/${route}`, { headers: { Authorization: 'Bearer benchmark-only' } });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        return { elapsedMs: +(performance.now() - before).toFixed(3), body };
      };
      return request;
    };
    let request = await open();
    const firstTree = await request('files');
    const tree = firstTree.body;
    const java = tree.items.filter(item => item.type === 'file' && item.path.endsWith('.java'));
    const modules = tree.items.filter(item => item.type === 'file' && item.name === 'pom.xml');
    const source = await request('index');
    const timings = {};
    for (const [name, route] of [['tree', 'files'], ['symbols', 'symbols?query=Service'], ['sourceRead', 'index']]) {
      const values = [];
      for (let i = 0; i < rounds; i++) values.push((await request(route)).elapsedMs);
      timings[name] = summary(values);
    }
    await api.close(); api = null;
    request = await open();
    const reopened = await request('files');
    const resource = process.cpuUsage(cpu);
    console.log(JSON.stringify({
      version: 1, runtime: process.versions, platform: process.platform, arch: process.arch,
      machine: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() },
      project: { name: path.basename(root), treeEntries: tree.items.length, treeTruncated: tree.truncated, javaFiles: java.length, javaBytes: java.reduce((sum, item) => sum + (item.size || 0), 0), pomFiles: modules.length, sourceFilesRead: source.body.files.length, sourceBytesRead: source.body.totalBytes, sourceTruncated: source.body.truncated, sourceLimits: source.body.limits },
      firstTreeMs: firstTree.elapsedMs, firstSourceReadMs: source.elapsedMs,
      reopenedTreeMs: reopened.elapsedMs, timings,
      resources: { peakRssBytes: peakRss, baselineRssBytes: baselineMemory.rss, cpuUserMs: resource.user / 1000, cpuSystemMs: resource.system / 1000, eventLoopP95Ms: +(delay.percentile(95) / 1e6).toFixed(3), eventLoopMaxMs: +(delay.max / 1e6).toFixed(3), wallMs: +(performance.now() - started).toFixed(3) },
      method: 'Real read-only Local API workload, temporary empty application cache then reopened persisted cache. OS cache is uncontrolled. HTTP/JSON and client/server share this Node process; RSS and event-loop values are process-wide, not Electron UI or JDT measurements. POM count is not resolved dependency count. Source limits/omissions remain in force; no semantic index or parser is benchmarked. No project paths or source text are emitted.',
    }, null, 2));
  } finally {
    clearInterval(memoryTimer); delay.disable();
    await api?.close(); await fs.rm(directory, { recursive: true, force: true });
  }
}
module.exports = { summary };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
