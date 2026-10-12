const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalStore } = require('./local-store.cjs');

const ignored = new Set(require('@codegen/code-intelligence/file-types.json').ignoredDirectories);
const skippable = (error) => ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code);

// File metadata is separate from language-server semantic indexes. Never load
// the entire project into Monaco just to make navigation work.
class WorkspaceIndex {
  constructor({ store, directory, storage = 'file', intervalMs = 120_000, onChanges = async () => {} } = {}) {
    this.directory = directory;
    this.store = store || (storage === 'sqlite' && directory ? new LocalStore(path.join(directory, 'index.sqlite3')) : null);
    this.ownsStore = !store && Boolean(this.store);
    this.intervalMs = intervalMs;
    this.onChanges = onChanges;
    this.states = new Map();
    this.closed = false;
  }

  async get(project, force = false) {
    const root = await fs.realpath(project.path);
    const key = crypto.createHash('sha256').update(root).digest('hex');
    let state = this.states.get(key);
    if (!state) {
      state = { root, project, key, snapshot: null, navigation: new Map(), navigationBytes: 0, recentQueries: new Map(), loading: null, refreshing: null, timer: null, lastUsed: Date.now() };
      this.states.set(key, state);
      state.loading = this.load(state);
    }
    await state.loading;
    state.lastUsed = Date.now();
    if (this.states.size > 6) {
      const oldest = [...this.states.values()].filter((item) => item !== state && !item.refreshing).sort((a,b) => a.lastUsed-b.lastUsed)[0];
      if (oldest) { clearInterval(oldest.timer); this.states.delete(oldest.key); }
    }
    if (force || !state.snapshot) await this.refresh(state);
    else if (!state.timer) void this.refresh(state).catch(() => {});
    if (!state.timer && !this.closed) {
      state.timer = setInterval(() => {
        if (Date.now() - state.lastUsed > 10 * 60 * 1000) {
          clearInterval(state.timer); this.states.delete(state.key); return;
        }
        void this.refresh(state).catch(() => {});
      }, this.intervalMs);
      state.timer.unref();
    }
    return state.snapshot;
  }

  async load(state) {
    if (!this.store && !this.directory) return;
    try {
      let value;
      if (this.store) value = this.store.readWorkspaceIndex(state.root);
      else {
        const file = path.join(this.directory, `${state.key}.json`);
        if ((await fs.stat(file)).size > 8 * 1024 * 1024) return;
        value = JSON.parse(await fs.readFile(file, 'utf8'));
      }
      if (!value) return;
      if (value.version !== 1 || value.root !== state.root || !Array.isArray(value.items) || value.items.length > 10_000) return;
      if (value.items.some((item) => typeof item.path !== 'string' || path.isAbsolute(item.path) || item.path.split('/').includes('..'))) return;
      state.snapshot = value;
      // Read navigation results on demand, not all 2000 records at project open.
    } catch { /* Missing/corrupt cache is rebuilt, never fatal to project open. */ }
  }

  refresh(state) {
    if (this.closed) return Promise.resolve();
    if (state.refreshing) return state.refreshing;
    state.refreshing = this.scan(state).finally(() => { state.refreshing = null; });
    return state.refreshing;
  }

  async scan(state) {
    const items = [];
    let truncated = false;
    const visit = async (directory, depth) => {
      if (depth > 20) { truncated = true; return; }
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (skippable(error)) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) truncated = true; return; } throw error; }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (items.length >= 10_000) { truncated = true; break; }
        if (entry.isSymbolicLink() || ignored.has(entry.name) || entry.name.startsWith('.aider')) continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(state.root, absolute).split(path.sep).join('/');
        if (entry.isDirectory()) {
          items.push({ path: relative, name: entry.name, type: 'directory', depth });
          await visit(absolute, depth + 1);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.stat(absolute);
            items.push({ path: relative, name: entry.name, type: 'file', depth, size: stat.size, stamp: `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` });
          } catch (error) { if (!skippable(error)) throw error; }
        }
      }
    };
    await visit(state.root, 0);
    const hadSnapshot = Boolean(state.snapshot);
    const oldFiles = new Map((state.snapshot?.items || []).filter((item) => item.type === 'file').map((item) => [item.path, item.stamp]));
    const changes = [];
    for (const item of items) {
      if (item.type !== 'file') continue;
      if (oldFiles.get(item.path) !== item.stamp) changes.push({ path: item.path, type: oldFiles.has(item.path) ? 2 : 1 });
      oldFiles.delete(item.path);
    }
    if (!truncated) for (const file of oldFiles.keys()) changes.push({ path: file, type: 3 });
    const previous = state.snapshot;
    const snapshot = { version: 1, root: state.root, updatedAt: Date.now(), items, truncated };
    if (this.store && !this.closed) {
      snapshot.revision = this.store.writeWorkspaceIndex(snapshot, previous);
    } else {
      const oldEntries = new Map((previous?.items || []).map((item) => [item.path, JSON.stringify(item)]));
      const changed = !previous || previous.items.length !== items.length || items.some((item) => oldEntries.get(item.path) !== JSON.stringify(item));
      snapshot.revision = (previous?.revision || 0) + Number(changed);
      if (this.directory && !this.closed) await this.writeJson(path.join(this.directory, `${state.key}.json`), snapshot);
    }
    state.snapshot = snapshot;
    if (previous && previous.revision !== snapshot.revision) {
      state.pendingNavigation = [...state.recentQueries.values()];
      state.navigation.clear();
      state.navigationBytes = 0;
    }
    if (this.directory && !this.store && !this.closed) void this.pruneNavigation(state).catch(() => {});
    if (hadSnapshot && changes.length && !this.closed) await this.onChanges(state.project, changes);
  }

  async navigationContext(project, operation, input) {
    if (!['definition', 'declaration', 'typeDefinition', 'implementation', 'references'].includes(operation) || input.path?.startsWith('@java-source/')) return null;
    const snapshot = await this.get(project);
    const state = this.states.get(crypto.createHash('sha256').update(snapshot.root).digest('hex'));
    const file = path.resolve(snapshot.root, input.path || '');
    const actual = await fs.realpath(file);
    if (!actual.startsWith(`${snapshot.root}${path.sep}`)) return null;
    const disk = await fs.readFile(actual, 'utf8');
    if (typeof input.content === 'string' && input.content !== disk) return null; // Never persist unsaved edits.
    const contentHash = crypto.createHash('sha256').update(disk).digest('hex');
    const query = { operation, path: input.path, line: input.line, column: input.column, contentHash };
    const key = crypto.createHash('sha256').update(JSON.stringify(query)).digest('hex');
    return { state, key, query, revision: state.snapshot.revision };
  }

  async getNavigation(project, operation, input) {
    const context = await this.navigationContext(project, operation, input);
    return context ? this.readNavigation(context) : undefined;
  }

  remember(state, key, entry) {
    const bytes = Buffer.byteLength(JSON.stringify(entry.result));
    const previous = state.navigation.get(key);
    if (previous) state.navigationBytes -= previous.bytes;
    state.navigation.delete(key);
    state.navigation.set(key, { ...entry, bytes });
    state.navigationBytes += bytes;
    state.recentQueries.delete(key);
    state.recentQueries.set(key, { input: entry.input });
    while (state.recentQueries.size > 2000) state.recentQueries.delete(state.recentQueries.keys().next().value);
    while (state.navigation.size > 200 || state.navigationBytes > 8 * 1024 * 1024) {
      const first = state.navigation.keys().next().value;
      state.navigationBytes -= state.navigation.get(first).bytes;
      state.navigation.delete(first);
    }
  }

  async readNavigation(context) {
    const { state, key, revision } = context;
    let entry = state.navigation.get(key);
    if (!entry && this.store) entry = this.store.readWorkspaceNavigationEntry(state.root, revision, key);
    else if (!entry && this.directory) {
      try {
        const file = path.join(this.directory, 'navigation', state.key, `${key}.json`);
        if ((await fs.stat(file)).size > 160 * 1024) return undefined;
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (value.root !== state.root || value.revision !== revision || !Array.isArray(value.result)) return undefined;
        entry = value;
      } catch { return undefined; }
    }
    if (entry && state.snapshot.revision === revision) {
      this.remember(state, key, entry);
      return entry.result;
    }
  }

  forgetNavigation(context) {
    const { state, key } = context;
    const previous = state.navigation.get(key);
    if (previous) state.navigationBytes -= previous.bytes;
    state.navigation.delete(key);
  }

  pruneNavigation(state) {
    if (state.pruning) return state.pruning;
    state.pruning = (async () => {
      const directory = path.join(this.directory, 'navigation', state.key);
      let files;
      try { files = (await fs.readdir(directory)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file)); } catch { return; }
      if (files.length <= 2000) return;
      const dated = [];
      let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < files.length && !this.closed) {
          const file = files[next++];
          try { dated.push({ file, time: (await fs.stat(path.join(directory, file))).mtimeMs }); } catch {}
        }
      }));
      dated.sort((a,b) => a.time-b.time);
      for (const { file } of dated.slice(0, Math.max(0, dated.length-2000))) {
        if (this.closed) break;
        await fs.unlink(path.join(directory, file)).catch(() => {});
      }
    })().finally(() => { state.pruning = null; });
    return state.pruning;
  }

  async writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temporary, file);
  }

  async setNavigation(project, operation, input, result, expectedRevision) {
    // Virtual dependency URIs are owned by a live language session, so they
    // cannot be restored from a navigation cache after process restart.
    if (!Array.isArray(result) || !result.length || result.some((item) => !item?.path || item.path.startsWith('@java-source/')) || JSON.stringify(result).length > 128 * 1024) return;
    const context = await this.navigationContext(project, operation, input);
    if (!context || context.revision !== context.state.snapshot.revision || (expectedRevision !== undefined && context.revision !== expectedRevision) || this.closed) return;
    const { state, key, query, revision } = context;
    if (this.store) this.store.writeWorkspaceNavigation(state.root, revision, key, operation, query, result);
    else if (this.directory) await this.writeJson(path.join(this.directory, 'navigation', state.key, `${key}.json`), { root: state.root, revision, input: query, result });
    if (state.snapshot.revision === revision) this.remember(state, key, { input: query, result });
  }

  pendingQueries(project) {
    const state = [...this.states.values()].find((item) => item.project.id === project.id);
    const pending = state?.pendingNavigation || [];
    if (state) state.pendingNavigation = [];
    return pending.slice(0, 50).map((item) => item.input);
  }

  async close() {
    this.closed = true;
    for (const state of this.states.values()) clearInterval(state.timer);
    await Promise.allSettled([...this.states.values()].flatMap((state) => [state.loading, state.refreshing, state.pruning]));
    this.states.clear();
    if (this.ownsStore) this.store.close();
  }
}

module.exports = { WorkspaceIndex };
