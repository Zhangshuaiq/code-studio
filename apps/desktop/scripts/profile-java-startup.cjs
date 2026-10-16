// Read-only source snapshot; never attach to, restart or modify a user's IDE.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { LocalLspManager } = require('@codegen/code-intelligence');
const { decodeText } = require('@codegen/code-intelligence/file-text.cjs');
const { languageRequest } = require('@codegen/code-intelligence/language-request.cjs');
const { summarizeClasspaths, runtimeSnapshot } = require('./java-startup-diagnostics.cjs');
const { projectionDiagnostics } = require('./projection-diagnostics.cjs');
const exec = promisify(execFile);
const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea', '.project', '.classpath', '.settings']);
function indexSnapshot(root) {
  const files = new Map();
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.index')) continue;
    const file = path.join(entry.parentPath || entry.path, entry.name), stat = fs.statSync(file);
    files.set(path.relative(root, file), `${stat.mtimeMs}:${stat.size}`);
  }
  return files;
}
const ownedPids = new Map();
async function sample(dataRoot) {
  try {
    const listed = (await exec('jcmd', ['-l'], { timeout: 4000 })).stdout;
    const row = listed.split('\n').find(row => row.includes(dataRoot));
    const pid = ownedPids.get(dataRoot) || row?.match(/^(\d+) /)?.[1];
    if (!pid) return { available: false };
    ownedPids.set(dataRoot, pid);
    const gc = await exec('jstat', ['-gcutil', pid], { timeout: 4000 }).then(result => result.stdout.trim()).catch(() => 'unavailable');
    const dump = (await exec('jcmd', [pid, 'Thread.print', '-l'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    const threads = dump.split(/\n\n+/).filter(block => /java.lang.Thread.State:/.test(block));
    const important = threads.filter(block => /org\.eclipse\.(?:jdt\.ls|m2e)|org\.eclipse\.aether|SocketDispatcher|SSLSocket|InitializeWorkspace/.test(block));
    const selected = [...important, ...threads.filter(block => !important.includes(block) && /"(?:Worker-|main|pool-)/.test(block))];
    return { available: true, gc, threads: selected.slice(0, 12).map(block => block.split('\n').slice(0, 32).join('\n')) };
  } catch (error) { return { available: false, code: error.code || 'attach-unavailable' }; }
}
(async () => {
  if (!process.argv[2]) throw new Error('Usage: node profile-java-startup.cjs <Java project>');
  const source = fs.realpathSync(process.argv[2]);
  const javaAutobuild = !process.argv.includes('--no-autobuild');
  const deferJavaAutobuild = !process.argv.includes('--eager-autobuild');
  const guard = process.argv.find(value => value.startsWith('--index-thread-guard='))?.slice('--index-thread-guard='.length);
  const navigationPath = process.argv.find(value => value.startsWith('--navigation-path='))?.slice('--navigation-path='.length);
  const summaryOnly = process.argv.includes('--summary');
  const concurrencyArgument = process.argv.find(value => value.startsWith('--build-concurrency='));
  const javaMaxConcurrentBuilds = concurrencyArgument ? Number(concurrencyArgument.split('=')[1]) : undefined;
  const sharedIndexes = process.argv.includes('--shared-index');
  const javaGcProfile = process.argv.find(value => value.startsWith('--java-gc='))?.split('=')[1];
  const flightRecording = process.argv.includes('--flight-recording');
  const javaCommand = process.argv.find(value => value.startsWith('--java-command='))?.slice('--java-command='.length);
  const jdtlsHome = process.argv.find(value => value.startsWith('--jdtls-home='))?.slice('--jdtls-home='.length);
  if (jdtlsHome && !path.isAbsolute(jdtlsHome)) throw new Error('Diagnostic JDT home must be absolute');
  const requireProjection = process.argv.includes('--require-package-projection');
  if (javaCommand && !path.isAbsolute(javaCommand)) throw new Error('Diagnostic Java command must be an absolute path');
  // Diagnostic override on the internal session only, never supplied by API callers.
  const requestMs = Number(process.argv.find(value => value.startsWith('--java-request-ms='))?.split('=')[1] || 15000);
  if (!Number.isInteger(requestMs) || requestMs < 1 || requestMs > 120000) throw new Error('Invalid diagnostic request budget');
  let navigationFailed = false;
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
    console.log(JSON.stringify({ snapshotFiles: count, snapshotBytes: bytes, javaAutobuild, deferJavaAutobuild, javaMaxConcurrentBuilds, sharedIndexes, javaGcProfile: javaGcProfile || 'default', flightRecording, toolingJava: javaCommand || 'PATH java' }));
    for (const mode of process.argv.includes('--fresh-only') ? ['fresh'] : sharedIndexes ? ['fresh', 'persisted', 'fresh-workspace-shared-cache'] : ['fresh', 'persisted']) {
      const events = [], projection = projectionDiagnostics(); let sampling = false;
      const dataRoot = path.join(directory, mode === 'fresh-workspace-shared-cache' ? 'other-data' : 'data');
      const sharedBefore = sharedIndexes ? indexSnapshot(path.join(directory, 'shared-index')) : null;
      const manager = new LocalLspManager({ dataRoot, commands: javaCommand ? { java: javaCommand } : {}, javaGcProfile, javaMaxConcurrentBuilds, javaSharedIndexRoot: sharedIndexes ? path.join(directory, 'shared-index') : undefined, resources: { ...(jdtlsHome ? { jdtlsHome: fs.realpathSync(jdtlsHome) } : {}), ...(guard ? { indexThreadGuardJar: fs.realpathSync(guard) } : {}), ...(flightRecording ? { javaFlightRecording: path.join(directory, `${mode}.jfr`) } : {}) }, javaAutobuild, deferJavaAutobuild, javaReadyMs: 240000, onLifecycle: event => {
        events.push(event);
        if (event.event === 'spawn' && event.provider === 'java') queueMicrotask(() => manager.sessions.get('startup-profile:java')?.child.stderr.on('data', chunk => projection.accept(chunk)));
        if (['spawn', 'index-guard-applied', 'initialize-complete', 'project-ready', 'autobuild-enabled'].includes(event.event)) console.log(JSON.stringify({ mode, event }));
      } });
      const started = performance.now();
      const timer = setInterval(() => {
        if (sampling) return;
        if (summaryOnly) { console.log(JSON.stringify({ mode, elapsedMs: Math.round(performance.now() - started), status: manager.projectStatus({ id: 'startup-profile' }) })); return; }
        sampling = true;
        void sample(dataRoot).then(profile => console.log(JSON.stringify({ mode, elapsedMs: Math.round(performance.now() - started), profile }))).finally(() => { sampling = false; });
      }, 15000);
      try {
        const project = { id: 'startup-profile', path: root };
        const prepared = await manager.prepareProject(project);
        const session = manager.sessions.get('startup-profile:java');
        console.log(JSON.stringify({ mode, providers: prepared.providers, genuinelyReady: Boolean(session?.serviceReady), elapsedMs: Math.round(performance.now() - started) }));
        if (!session?.serviceReady) throw new Error('Java project did not become genuinely ready within the profiling deadline');
        if (guard && !session.indexGuardApplied) throw new Error('Guard transformation was not confirmed');
        session.requestTimeoutMs = requestMs;
        if (navigationPath) {
          let operation = 'documentSymbols', operationStarted = performance.now();
          try {
          const symbolsStarted = performance.now();
          const symbols = await manager.request(project, 'documentSymbols', { path: navigationPath });
          console.log(JSON.stringify({ mode, operation: 'documentSymbols', durationMs: Math.round(performance.now() - symbolsStarted), requestMs }));
          const declaration = symbols.find(item => item.kind === 11) || symbols[0];
          const position = declaration?.selectionRange?.start || declaration?.range?.start || declaration?.location?.range?.start;
          if (!position) throw new Error('Navigation fixture has no declaration');
          const name = path.basename(navigationPath, '.java');
          const content = decodeText(fs.readFileSync(path.join(root, navigationPath))).content;
          const match = new RegExp('\\b(?:class|interface|enum|record)\\s+(' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b').exec(content);
          if (!match) throw new Error('Navigation fixture has no matching type declaration');
          const prefix = content.slice(0, match.index + match[0].lastIndexOf(name));
          for (const attempt of ['first', 'repeat']) {
          const queryStarted = performance.now();
          operation = `implementation:${attempt}`; operationStarted = queryStarted;
          const implementations = await manager.request(project, 'implementation', { path: navigationPath, line: prefix.split('\n').length, column: prefix.length - prefix.lastIndexOf('\n') });
          if (!implementations.length) throw new Error('No implementation found in the snapshot');
          if (requireProjection && (!projection.result.used || !projection.result.hit)) throw new Error('Actual JDT projection use and cache hit were not confirmed');
          console.log(JSON.stringify({ mode, attempt, durationMs: Math.round(performance.now() - queryStarted), totalElapsedMs: Math.round(performance.now() - started), navigation: { symbols: symbols.length, implementations: implementations.length, targetPaths: implementations.map(item => item.path || item.location?.path) } }));
          }
          if (process.argv.includes('--runtime-stats')) {
            operation = 'runtime-stats'; operationStarted = performance.now();
            console.log(JSON.stringify({ mode, runtime: await runtimeSnapshot(dataRoot, session.child.pid) }));
          }
          if (process.argv.includes('--dependency-summary')) {
            operation = 'dependency-summary'; operationStarted = performance.now();
            const command = (command, args) => languageRequest(session, 'workspace/executeCommand', { command, arguments: args }, 15000);
            const projects = await command('java.project.getAll', []);
            if (!Array.isArray(projects) || projects.length > 128) throw new Error('Dependency diagnostic project budget exceeded');
            const classpaths = [];
            // This bundled command's JSONUtility expects serialized options.
            for (const uri of projects) classpaths.push(await command('java.project.getClasspaths', [uri, JSON.stringify({ scope: 'runtime' })]));
            console.log(JSON.stringify({ mode, dependencies: summarizeClasspaths(classpaths) }));
          }
          } catch (error) {
            navigationFailed = true;
            console.log(JSON.stringify({ mode, operation, durationMs: Math.round(performance.now() - operationStarted), navigationError: error.code || 'NAVIGATION_FAILED', message: error.message, requestMs }));
            if (process.argv.includes('--navigation-diagnostics')) console.log(JSON.stringify({ mode, navigationError: error.code || 'NAVIGATION_FAILED', profile: await sample(dataRoot) }));
          }
        }
      } finally {
        clearInterval(timer); await manager.shutdown();
        ownedPids.delete(dataRoot);
        const stop = events.find(event => event.provider === 'java' && event.event === 'stopped');
        console.log(JSON.stringify({ mode, shutdownMs: stop?.durationMs, forced: stop?.forced, exited: stop?.exited }));
        if (requireProjection || projection.result.used) {
          console.log(JSON.stringify({ mode, projection: projection.result }));
          if (requireProjection && !projection.result.stats) navigationFailed = true;
        }
        if (flightRecording) console.log(JSON.stringify({ mode, flightRecording: await require('./summarize-java-recording.cjs').readRecording(path.join(directory, `${mode}.jfr`)) }));
        if (sharedIndexes) {
          const sharedRoot = path.join(directory, 'shared-index');
          const after = indexSnapshot(sharedRoot);
          let unchanged = 0, rewritten = 0, added = 0;
          for (const [file, stamp] of after) { if (!sharedBefore.has(file)) added++; else if (sharedBefore.get(file) === stamp) unchanged++; else rewritten++; }
          console.log(JSON.stringify({ mode, sharedIndexFiles: after.size, sharedIndexWrites: { added, rewritten, unchanged } }));
        }
      }
    }
    if (navigationFailed) process.exitCode = 1;
  } finally {
    if (process.argv.includes('--keep-data')) console.log(JSON.stringify({ diagnosticDirectory: directory, retained: true }));
    else fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
