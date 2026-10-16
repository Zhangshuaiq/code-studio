// Construct this service inside a worker thread, never the Electron main loop.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { decodeText } = require('./file-text.cjs');
const { abbreviation } = require('./fast-index-store.cjs');
const { openRecoverableFastIndexStore } = require('./recoverable-fast-index-store.cjs');
const { JavaSyntaxIndex } = require('./java-syntax-index.cjs');
const DEFAULT_IGNORED = ['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea'];
const stamp = stat => `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
class JavaFastIndex {
  constructor(options) {
    this.root = fs.realpathSync(options.root);
    this.store = openRecoverableFastIndexStore(options.databasePath, this.root);
    this.store.requireValidation();
    this.ignored = new Set(DEFAULT_IGNORED);
    this.onProgress = options.onProgress || (() => {});
    this.maxBytes = 1024 * 1024;
    this.buffer = Buffer.alloc(this.maxBytes + 1);
    this.parser = null; this.epoch = 0; this.closed = false; this.tail = Promise.resolve();
  }
  refresh() {
    if (this.closed) return Promise.reject(new Error('Fast index is closed'));
    const epoch = ++this.epoch;
    const next = this.tail.catch(() => {}).then(() => this.scan(epoch));
    this.tail = next; return next;
  }
  getParser() {
    if (this.closed) return Promise.reject(new Error('Fast index is closed'));
    if (!this.parserPromise) this.parserPromise = JavaSyntaxIndex.create().then(parser => {
      if (this.closed) { parser.close(); throw new Error('Fast index is closed'); }
      this.parser = parser; return parser;
    }).catch(error => { this.parserPromise = null; throw error; });
    return this.parserPromise;
  }
  async scan(epoch) {
    if (epoch !== this.epoch || this.closed) return { cancelled: true };
    const generation = this.store.beginScan();
    const current = () => epoch === this.epoch && !this.closed;
    // Commit metadata validation in bounded synchronous batches. Never hold a
    // SQLite transaction across filesystem awaits or block live symbol queries.
    const validated = [];
    const flushValidated = () => { if (validated.length) { this.store.markSeenBatch(validated, generation); validated.length = 0; } };
    const markValidated = (file, fileStamp) => {
      validated.push({ path: file, stamp: fileStamp });
      if (validated.length === 128) flushValidated();
    };
    const counts = { discoveredFiles: 0, parsedFiles: 0, unchangedFiles: 0, rejectedFiles: 0, directoryErrors: 0 };
    const startedAt = performance.now();
    let reportedAt = -Infinity;
    const report = () => {
      const now = performance.now();
      // Bound worker -> API traffic, including cached metadata validation.
      if (!current() || now - reportedAt < 100) return;
      reportedAt = now;
      this.lastProgress = { ...this.store.status(), ...counts, state: 'scanning', complete: false, generation, elapsedMs: Math.round(now - startedAt) };
      try { this.onProgress(this.lastProgress); } catch { /* Observers cannot corrupt indexing. */ }
    };
    report();
    const pending = [this.root];
    while (pending.length && current()) {
      const directory = pending.pop();
      let entries;
      try {
        const actualDirectory = await fs.promises.realpath(directory);
        if (actualDirectory !== this.root && !actualDirectory.startsWith(this.root + path.sep)) { counts.directoryErrors++; continue; }
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      }
      catch (error) { if (!['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error; counts.directoryErrors++; continue; }
      report();
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!current()) return { cancelled: true };
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory() && !this.ignored.has(entry.name)) pending.push(absolute);
        if (!entry.isFile() || !entry.name.endsWith('.java')) continue;
        counts.discoveredFiles++;
        const relative = path.relative(this.root, absolute).split(path.sep).join('/');
        let handle, fileStamp = '', hash = '';
        try {
          const stat = await fs.promises.lstat(absolute);
          if (stat.isSymbolicLink() || !stat.isFile()) continue;
          fileStamp = stamp(stat);
          const previous = this.store.file(relative);
          if (previous?.stamp === fileStamp && !previous.rejected && !previous.truncated) {
            if (!current()) return { cancelled: true };
            markValidated(relative); counts.unchangedFiles++; continue;
          }
          if (stat.size > this.maxBytes) throw Object.assign(new Error('Source file exceeds byte budget'), { code: 'FAST_INDEX_FILE_TOO_LARGE' });
          handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          const actual = await fs.promises.realpath(absolute);
          if (!actual.startsWith(this.root + path.sep)) throw Object.assign(new Error('Source escaped workspace'), { code: 'FAST_INDEX_UNSAFE_PATH' });
          const opened = await handle.stat();
          let bytes = 0;
          while (bytes <= this.maxBytes) {
            const read = await handle.read(this.buffer, bytes, this.buffer.length - bytes, null);
            if (!read.bytesRead) break;
            bytes += read.bytesRead;
            if (bytes > this.maxBytes) throw Object.assign(new Error('Source file exceeds byte budget'), { code: 'FAST_INDEX_FILE_TOO_LARGE' });
          }
          if (stamp(opened) !== stamp(await handle.stat())) throw Object.assign(new Error('Source changed during read'), { code: 'FAST_INDEX_UNSTABLE_FILE' });
          fileStamp = stamp(opened);
          const sourceBytes = this.buffer.subarray(0, bytes);
          let source;
          try { source = decodeText(sourceBytes).content; } catch { throw Object.assign(new Error('Invalid Java text encoding'), { code: 'FAST_INDEX_BINARY_FILE' }); }
          hash = crypto.createHash('sha256').update(sourceBytes).digest('hex');
          if (!current()) return { cancelled: true };
          if (previous?.hash === hash && !previous.rejected && !previous.truncated) {
            markValidated(relative, fileStamp); counts.unchangedFiles++; continue;
          }
          const parser = await this.getParser();
          const parsed = parser.parse(source, relative);
          if (!current()) return { cancelled: true };
          this.store.replace(relative, fileStamp, hash, parsed, generation); counts.parsedFiles++;
        } catch (error) {
          if (!['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code) && !String(error.code || '').startsWith('FAST_INDEX_')) throw error;
          if (!current()) return { cancelled: true };
          this.store.replace(relative, fileStamp, hash, { symbols: [], truncated: true }, generation, true); counts.rejectedFiles++;
        } finally { await handle?.close(); report(); }
      }
    }
    if (!current()) return { cancelled: true };
    flushValidated();
    this.store.finishScan(generation, counts.directoryErrors);
    const result = { ...counts, ...this.store.status(), elapsedMs: Math.round(performance.now() - startedAt) };
    this.lastProgress = result;
    try { this.onProgress(result); } catch {}
    return result;
  }
  validateDocuments(documents) {
    const invalid = message => Object.assign(new Error(message), { code: 'FAST_INDEX_OVERLAY_INVALID' });
    if (!Array.isArray(documents) || documents.length > 20) throw invalid('At most 20 overlay documents are supported');
    const paths = new Set(); let bytes = 0;
    return documents.map(document => {
      if (!document || typeof document.path !== 'string' || typeof document.content !== 'string' || document.path.length > 1024 || document.content.includes('\0')) throw invalid('Invalid overlay document');
      const relative = document.path.replace(/\\/g, '/');
      const segments = relative.split('/');
      if (!relative.endsWith('.java') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.includes('\0') || segments.some(segment => !segment || segment === '.' || segment === '..' || this.ignored.has(segment)) || paths.has(relative)) throw invalid('Unsafe or duplicate overlay path');
      let absolute = this.root;
      for (let i = 0; i < segments.length; i++) {
        absolute = path.join(absolute, segments[i]);
        try {
          const stat = fs.lstatSync(absolute);
          if (stat.isSymbolicLink() || (i < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw invalid('Overlay path is not a regular workspace file');
        } catch (error) { if (error.code !== 'ENOENT' || i !== segments.length - 1) throw invalid('Overlay path is not available in workspace'); }
      }
      bytes += Buffer.byteLength(document.content, 'utf8');
      if (bytes > this.maxBytes) throw invalid('Overlay source exceeds aggregate byte budget');
      paths.add(relative);
      return { path: relative, content: document.content };
    });
  }
  async parseDocuments(documents) {
    const inputs = this.validateDocuments(documents);
    if (!inputs.length) return [];
    const parser = await this.getParser();
    if (this.closed) throw new Error('Fast index is closed');
    const deadline = Date.now() + 2000;
    const parsed = []; let symbolCount = 0;
    for (const input of inputs) {
      if (Date.now() >= deadline) throw Object.assign(new Error('Overlay parsing exceeded time budget'), { code: 'FAST_INDEX_PARSE_TIMEOUT' });
      const syntax = parser.parse(input.content, input.path, { budgetMs: Math.max(1, Math.min(1000, deadline - Date.now())), maxSymbols: Math.max(1, 20000 - symbolCount) });
      symbolCount += syntax.symbols.length;
      if (symbolCount >= 20000 && parsed.length + 1 < inputs.length) throw Object.assign(new Error('Overlay symbol budget exceeded'), { code: 'FAST_INDEX_OVERLAY_INVALID' });
      const hash = crypto.createHash('sha256').update(input.content).digest('hex');
      parsed.push({ path: input.path, truncated: syntax.truncated, symbols: syntax.symbols.map(symbol => ({ ...symbol, hash, hashSource: 'overlay', semantic: false })) });
    }
    return parsed;
  }
  async search(query, limit = 200, documents = []) {
    const parsed = await this.parseDocuments(documents);
    const disk = this.store.search(query, limit, parsed.map(document => document.path));
    const needle = query.trim().toLowerCase();
    const matches = parsed.flatMap(document => document.symbols).filter(symbol => symbol.name.toLowerCase().includes(needle) || abbreviation(symbol.name).startsWith(needle));
    const rank = symbol => { const name = symbol.name.toLowerCase(); return name === needle ? 0 : name.startsWith(needle) ? 1 : abbreviation(symbol.name).startsWith(needle) ? 2 : 3; };
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const items = [...disk.items.map(item => ({ ...item, hashSource: 'disk' })), ...matches].sort((a, b) => rank(a) - rank(b) || compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.path, b.path) || a.line - b.line || a.column - b.column);
    const overlayTruncated = parsed.some(document => document.truncated);
    return { ...disk, items: items.slice(0, limit), truncated: disk.truncated || overlayTruncated || items.length > limit, overlayApplied: parsed.length > 0, overlayFiles: parsed.length, overlayTruncated };
  }
  async outline(relative, documents = []) {
    const parsed = await this.parseDocuments(documents);
    const normalized = typeof relative === 'string' ? relative.replace(/\\/g, '/') : relative;
    const overlay = parsed.find(document => document.path === normalized);
    return { items: overlay ? overlay.symbols : this.store.outline(normalized), index: this.store.status(), overlayApplied: !!overlay, overlayTruncated: !!overlay?.truncated };
  }
  status() {
    const stored = this.store.status();
    return this.lastProgress?.generation === stored.generation ? { ...this.lastProgress, ...stored } : stored;
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; ++this.epoch;
    this.closePromise = Promise.all([this.tail.catch(() => {}), this.parserPromise?.catch(() => {})]).then(() => { this.parser?.close(); this.store.close(); this.buffer = null; });
    return this.closePromise;
  }
}
module.exports = { JavaFastIndex, DEFAULT_IGNORED };
