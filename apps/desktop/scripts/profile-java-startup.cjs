// Read-only source snapshot; never attach to, restart or modify a user's IDE.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { LocalLspManager } = require('@codegen/code-intelligence');
const exec = promisify(execFile);
const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea']);
async function sample(dataRoot) {
  try {
    const listed = (await exec('jcmd', ['-l'], { timeout: 4000 })).stdout;
    const row = listed.split('\n').find(row => row.includes(dataRoot));
    const pid = row?.match(/^(\d+) /)?.[1];
    if (!pid) return { available: false };
    const dump = (await exec('jcmd', [pid, 'Thread.print', '-l'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    const threads = dump.split(/\n\n+/).filter(block => /java.lang.Thread.State:/.test(block));
    const important = threads.filter(block => /org\.eclipse\.(?:jdt\.ls|m2e)|org\.eclipse\.aether|SocketDispatcher|SSLSocket|InitializeWorkspace/.test(block));
    const selected = [...important, ...threads.filter(block => !important.includes(block) && /"(?:Worker-|main|pool-)/.test(block))];
    return { available: true, threads: selected.slice(0, 12).map(block => block.split('\n').slice(0, 32).join('\n')) };
  } catch (error) { return { available: false, code: error.code || 'attach-unavailable' }; }
}
(async () => {
  if (!process.argv[2]) throw new Error('Usage: node profile-java-startup.cjs <Java project>');
  const source = fs.realpathSync(process.argv[2]);
  const javaAutobuild = !process.argv.includes('--no-autobuild');
  const deferJavaAutobuild = !process.argv.includes('--eager-autobuild');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-startup-profile-'));
  const root = path.join(directory, 'project');
  let count = 0, bytes = 0;
  try {
    fs.cpSync(source, root, { recursive: true, filter: file => {
      const relative = path.relative(source, file);
      if (relative.split(path.sep).some(part => ignored.has(part))) return false;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return false;
      if (stat.isFile()) { count++; bytes += stat.size; if (count > 50000 || bytes > 256 * 1024 * 1024) throw new Error('Snapshot budget exceeded'); }
      return true;
    } });
    console.log(JSON.stringify({ snapshotFiles: count, snapshotBytes: bytes, javaAutobuild, deferJavaAutobuild }));
    for (const mode of ['fresh', 'persisted']) {
      const events = []; let sampling = false;
      const dataRoot = path.join(directory, 'data');
      const manager = new LocalLspManager({ dataRoot, javaAutobuild, deferJavaAutobuild, javaReadyMs: 240000, onLifecycle: event => { events.push(event); if (['spawn', 'initialize-complete', 'project-ready', 'autobuild-enabled'].includes(event.event)) console.log(JSON.stringify({ mode, event })); } });
      const started = performance.now();
      const timer = setInterval(() => {
        if (sampling) return;
        sampling = true;
        void sample(dataRoot).then(profile => console.log(JSON.stringify({ mode, elapsedMs: Math.round(performance.now() - started), profile }))).finally(() => { sampling = false; });
      }, 15000);
      try {
        const project = { id: 'startup-profile', path: root };
        const prepared = await manager.prepareProject(project);
        const session = manager.sessions.get('startup-profile:java');
        console.log(JSON.stringify({ mode, providers: prepared.providers, genuinelyReady: Boolean(session?.serviceReady), elapsedMs: Math.round(performance.now() - started) }));
        if (!session?.serviceReady) throw new Error('Java project did not become genuinely ready within the profiling deadline');
      } finally { clearInterval(timer); await manager.shutdown(); }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
