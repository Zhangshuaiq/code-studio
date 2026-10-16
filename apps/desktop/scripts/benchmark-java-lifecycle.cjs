const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { LocalLspManager } = require('../src/local-lsp-manager.cjs');
const exec = promisify(execFile);
async function exitThreads(dataRoot) {
  try {
    const listed = (await exec('jcmd', ['-l'], { timeout: 3000 })).stdout;
    // Attach only to the JVM created in this disposable benchmark directory.
    const pid = listed.split('\n').find(row => row.includes(dataRoot))?.match(/^(\d+) /)?.[1];
    if (!pid) return { available: false, reason: 'benchmark-jvm-not-found' };
    const dump = (await exec('jcmd', [pid, 'Thread.print', '-l'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    return { available: true, threads: dump.split(/\n\n+/).filter(block => /java.lang.Thread.State:/.test(block)).map(block => ({
      name: block.split('\n')[0].match(/^"([^"]+)"/)?.[1],
      state: block.match(/java.lang.Thread.State: ([A-Z_]+)/)?.[1],
      frames: block.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 20).map(line => line.trim()),
    })).filter(thread => thread.frames.some(frame => /eclipse|lsp4j|Socket|FileDispatcher|ProcessImpl/.test(frame))).slice(0, 30) };
  } catch (error) { return { available: false, code: error.code || 'attach-unavailable' }; }
}

(async () => {
  const cycles = Number(process.argv.find(value => value.startsWith('--cycles='))?.slice(9) || 1);
  const guard = process.argv.find(value => value.startsWith('--index-thread-guard='))?.slice('--index-thread-guard='.length);
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 10) throw new Error('cycles must be 1..10');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-lifecycle-'));
  try {
    const root = path.join(directory, 'project');
    fs.mkdirSync(path.join(root, 'src/main/java/demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>lifecycle</artifactId><version>1</version><properties><maven.compiler.release>17</maven.compiler.release></properties></project>');
    fs.writeFileSync(path.join(root, 'src/main/java/demo/Main.java'), 'package demo; public class Main { public static void main(String[] args) { System.out.println("hello"); } }');
    for (let cycle = 1; cycle <= cycles; cycle++) for (const mode of ['fresh-index', 'persisted-index']) {
      const events = [];
      const dataRoot = path.join(directory, `data-${cycle}`);
      const manager = new LocalLspManager({ dataRoot, resources: guard ? { indexThreadGuardJar: fs.realpathSync(guard) } : {}, javaAutobuild: !process.argv.includes('--no-autobuild'), onLifecycle: event => events.push(event) });
      const started = performance.now();
      let reuseMs, preparationMs, stages;
      try {
        const prepared = await manager.prepareProject({ id: 'benchmark', path: root });
        if (!prepared.providers[0]?.ready) throw new Error(JSON.stringify(prepared));
        if (!manager.sessions.get('benchmark:java')?.serviceReady) throw new Error('Java service is still importing; preparation fallback is not real readiness');
        if (guard && !manager.sessions.get('benchmark:java')?.indexGuardApplied) throw new Error('Diagnostic agent was selected but its transformation was not confirmed');
        preparationMs = Math.round(performance.now() - started);
        stages = manager.projectStatus({ id: 'benchmark', path: root }).providers[0]?.startupTimings;
        const reuseStarted = performance.now();
        await manager.prepareProject({ id: 'benchmark', path: root });
        reuseMs = Math.round((performance.now() - reuseStarted) * 100) / 100;
      } finally {
        let profile, timer;
        if (process.argv.includes('--profile-exit')) timer = setTimeout(() => { profile = exitThreads(dataRoot); }, 2000);
        await manager.shutdown(); clearTimeout(timer);
        if (profile) console.log(JSON.stringify({ cycle, mode, exitProfile: await profile }));
      }
      const stopped = events.find(event => event.event === 'stopped');
      console.log(JSON.stringify({ cycle, mode, preparationMs, stages, reuseMs, shutdownMs: stopped?.durationMs, forced: stopped?.forced, totalMs: Math.round(performance.now() - started), ...(process.argv.includes('--summary') ? {} : { events }) }));
    }
  } finally {
    if (process.argv.includes('--keep-data')) console.log(JSON.stringify({ diagnosticDirectory: directory }));
    else fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
