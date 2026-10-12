const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

async function build() {
  const { DatabaseSync } = require('node:sqlite');
  const { JavaSyntaxIndex, PARSER_VERSION } = require('@codegen/code-intelligence/java-syntax-index.cjs');
  const { summary } = require('./benchmark-real-workspace.cjs');
  const started = performance.now();
  const parser = await JavaSyntaxIndex.create();
  const initMs = performance.now() - started;
  let database;
  try {
    database = new DatabaseSync(workerData.databasePath);
    database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE symbols(file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, column_number INTEGER NOT NULL);
      CREATE VIRTUAL TABLE symbol_search USING fts5(name, content='symbols', content_rowid='rowid');`);
    const insert = database.prepare('INSERT INTO symbols VALUES (?, ?, ?, ?, ?)');
    const searchInsert = database.prepare('INSERT INTO symbol_search(rowid, name) VALUES (?, ?)');
    const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea']);
    const pending = [workerData.root];
    const timings = [], counts = { javaFiles: 0, sourceBytes: 0, indexedFiles: 0, symbols: 0, syntaxErrorFiles: 0, truncatedFiles: 0, rejectedFiles: 0, unreadableDirectories: 0 };
    while (pending.length) {
      const directory = pending.pop();
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (!['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw error; counts.unreadableDirectories++; continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory() && !ignored.has(entry.name)) pending.push(absolute);
        if (!entry.isFile() || !entry.name.endsWith('.java')) continue;
        counts.javaFiles++;
        const before = performance.now();
        let result;
        try {
          const stat = await fs.stat(absolute); counts.sourceBytes += stat.size;
          if (stat.size > 1024 * 1024) { counts.rejectedFiles++; continue; }
          const source = await fs.readFile(absolute, 'utf8');
          result = parser.parse(source, path.relative(workerData.root, absolute).split(path.sep).join('/'));
        } catch (error) {
          if (!['EACCES', 'EPERM', 'ENOENT', 'FAST_INDEX_FILE_TOO_LARGE', 'FAST_INDEX_PARSE_TIMEOUT'].includes(error.code)) throw error;
          counts.rejectedFiles++; continue;
        }
        counts.indexedFiles++; counts.symbols += result.symbols.length;
        if (result.hasErrors) counts.syntaxErrorFiles++;
        if (result.truncated) counts.truncatedFiles++;
        database.exec('BEGIN');
        try {
          for (const symbol of result.symbols) {
            const inserted = insert.run(symbol.path, symbol.name, symbol.kind, symbol.line, symbol.column);
            searchInsert.run(inserted.lastInsertRowid, symbol.name);
          }
          database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
        timings.push(performance.now() - before);
      }
    }
    const buildMs = performance.now() - started;
    database.close(); database = null;
    const reopenStart = performance.now(); database = new DatabaseSync(workerData.databasePath);
    const reopenMs = performance.now() - reopenStart;
    const search = database.prepare(`SELECT s.file, s.name, s.kind, s.line, s.column_number FROM symbol_search JOIN symbols s ON s.rowid=symbol_search.rowid WHERE symbol_search MATCH ? LIMIT 200`);
    const queryTimes = [];
    let matchingRows = 0;
    for (let i = 0; i < 30; i++) { const before = performance.now(); matchingRows = search.all('Service*').length; queryTimes.push(performance.now() - before); }
    return { parserVersion: PARSER_VERSION, sqliteVersion: database.prepare('SELECT sqlite_version() version').get().version, initMs: +initMs.toFixed(3), buildMs: +buildMs.toFixed(3), reopenMs: +reopenMs.toFixed(3), counts, fileReadParseAndInsert: timings.length ? summary(timings) : null, prefixQuery: { query: 'Service*', matchingRows, ...summary(queryTimes) }, ignoredDirectories: [...ignored], method: 'Compatibility spike, not production index. One background thread, one file transaction, 1 MiB per-file limit, no 500/project-file cap. FTS token-prefix search only, not substring/camel-case or resolved references. No renderer or JDT measurements. Syntax errors, rejected files and omitted build directories are reported.' };
  } finally { parser.close(); database?.close(); }
}

async function main() {
  const root = await fs.realpath(process.argv[2] || '.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'java-fast-index-spike-'));
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  let worker;
  try {
    const result = await new Promise((resolve, reject) => {
      worker = new Worker(__filename, { workerData: { root, databasePath: path.join(directory, 'spike.sqlite3') } });
      worker.once('message', value => value.error ? reject(new Error(value.error)) : resolve(value));
      worker.once('error', reject); worker.once('exit', code => { if (code !== 0) reject(new Error(`Worker exited ${code}`)); });
    });
    console.log(JSON.stringify({ runtime: { node: process.versions.node, electron: process.versions.electron || null, platform: process.platform, arch: process.arch }, project: path.basename(root), ...result, mainEventLoop: { p95Ms: +(delay.percentile(95) / 1e6).toFixed(3), maxMs: +(delay.max / 1e6).toFixed(3) } }, null, 2));
  } finally { delay.disable(); await worker?.terminate(); await fs.rm(directory, { recursive: true, force: true }); }
}
if (!isMainThread) build().then(value => parentPort.postMessage(value)).catch(error => { parentPort.postMessage({ error: String(error.stack || error) }); process.exitCode = 1; });
else if (process.versions.electron) {
  const { app } = require('electron');
  app.whenReady().then(main).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
} else main().catch(error => { console.error(error); process.exitCode = 1; });
