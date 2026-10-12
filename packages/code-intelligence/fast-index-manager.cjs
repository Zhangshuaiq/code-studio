const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { FastIndexClient } = require('./fast-index-client.cjs');

// Shared by local and remote APIs. Authorization belongs to the calling API;
// identity must already include its user/project/workspace/branch scope.
class FastIndexManager {
  constructor(options) {
    this.directory = path.resolve(options.directory);
    this.maxWorkers = options.maxWorkers ?? 2;
    this.intervalMs = options.intervalMs ?? 120_000;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.debounceMs = options.debounceMs ?? 180;
    this.maxDebounceMs = options.maxDebounceMs ?? 1000;
    if (!Number.isInteger(this.maxWorkers) || this.maxWorkers < 1 || this.maxWorkers > 32 || !Number.isFinite(this.intervalMs) || this.intervalMs < 10 || !Number.isFinite(this.idleMs) || this.idleMs < 10) throw new TypeError('Invalid fast-index resource limits');
    if (!Number.isFinite(this.debounceMs) || this.debounceMs < 0 || !Number.isFinite(this.maxDebounceMs) || this.maxDebounceMs < this.debounceMs) throw new TypeError('Invalid fast-index debounce limits');
    fs.mkdirSync(this.directory, { recursive: true });
    this.entries = new Map(); this.tail = Promise.resolve(); this.closed = false;
    this.timer = setInterval(() => { void this.maintain().catch(() => {}); }, Math.min(this.intervalMs, this.idleMs));
    this.timer.unref();
  }
  serialize(task) {
    const next = this.tail.catch(() => {}).then(task);
    this.tail = next;
    return next;
  }
  async acquire(project) {
    return this.serialize(async () => {
      if (this.closed) throw Object.assign(new Error('Fast-index manager is closed'), { code: 'FAST_INDEX_CLOSED' });
      if (!project?.id || typeof project.path !== 'string') throw new TypeError('Scoped project identity required');
      const root = fs.realpathSync(project.path);
      const key = createHash('sha256').update(JSON.stringify([project.id, root])).digest('hex');
      let entry = this.entries.get(key);
      if (!entry) {
        if (this.entries.size >= this.maxWorkers) {
          const victim = [...this.entries.values()].filter(item => !item.leases).sort((a, b) => a.usedAt - b.usedAt)[0];
          if (!victim) throw Object.assign(new Error('Fast-index workers are busy'), { code: 'FAST_INDEX_BUSY' });
          this.entries.delete(victim.key); clearTimeout(victim.invalidationTimer); await victim.client.close();
        }
        const client = new FastIndexClient({ root, databasePath: path.join(this.directory, `${key}.sqlite3`) });
        entry = { key, root, client, leases: 0, usedAt: Date.now(), refreshedAt: 0, revision: 0, dirty: false };
        this.entries.set(key, entry);
        this.scan(entry);
      }
      entry.leases++; entry.usedAt = Date.now();
      return entry;
    });
  }
  scan(entry, force = false) {
    clearTimeout(entry.invalidationTimer); entry.invalidationTimer = null; entry.firstInvalidatedAt = null;
    entry.refreshedAt = Date.now();
    const revision = entry.revision;
    const pending = entry.client.refresh(force);
    // A background failure is observable via status, never an unhandled rejection.
    pending.then(result => { entry.error = null; if (revision === entry.revision && !result.cancelled) entry.dirty = false; }, error => { entry.error = error; });
    return pending;
  }
  scheduleValidation(entry) {
    entry.dirty = true; entry.revision++;
    const now = Date.now();
    entry.firstInvalidatedAt ??= now;
    clearTimeout(entry.invalidationTimer);
    const delay = Math.max(0, Math.min(this.debounceMs, this.maxDebounceMs - (now - entry.firstInvalidatedAt)));
    entry.invalidationTimer = setTimeout(() => {
      entry.invalidationTimer = null;
      if (!this.closed && this.entries.get(entry.key) === entry) this.scan(entry, true);
    }, delay);
    entry.invalidationTimer.unref();
  }
  result(entry, result) {
    if (!entry.dirty) return result;
    // A pending save invalidates completeness even before the worker starts.
    if (result.index) return { ...result, index: { ...result.index, state: 'needs-validation', complete: false }, ...(Array.isArray(result.items) && 'sourceTruncated' in result ? { sourceTruncated: true, truncated: true } : {}) };
    return { ...result, state: 'needs-validation', complete: false };
  }
  async use(project, operation) {
    const entry = await this.acquire(project);
    try { return await operation(entry); }
    finally { entry.leases--; entry.usedAt = Date.now(); }
  }
  warm(project) { return this.use(project, async entry => this.result(entry, await entry.client.status())); }
  search(project, query, limit = 200, documents = []) { return this.use(project, async entry => this.result(entry, await entry.client.search(query, limit, documents))); }
  outline(project, file, documents = []) { return this.use(project, async entry => this.result(entry, await entry.client.outlineWithDocuments(file, documents))); }
  status(project) { return this.use(project, async entry => ({ ...this.result(entry, await entry.client.status()), ...(entry.error ? { backgroundError: entry.error.code || 'FAST_INDEX_ERROR' } : {}) })); }
  refresh(project) { return this.use(project, entry => this.scan(entry, true)); }
  // Save/create/delete callers can schedule validation without waiting for a scan.
  invalidate(project, immediate = false) { return this.use(project, entry => { if (immediate) { entry.dirty = true; entry.revision++; this.scan(entry, true); } else this.scheduleValidation(entry); }); }
  invalidateRoot(workspacePath) {
    return this.serialize(() => {
      if (this.closed) return;
      const root = fs.realpathSync(workspacePath);
      for (const entry of this.entries.values()) if (entry.root === root) this.scheduleValidation(entry);
    });
  }
  maintain() {
    return this.serialize(async () => {
      if (this.closed) return;
      const now = Date.now();
      for (const entry of this.entries.values()) {
        if (!entry.leases && !entry.dirty && !entry.invalidationTimer && now - entry.usedAt >= this.idleMs) {
          this.entries.delete(entry.key); await entry.client.close();
        } else if (!entry.invalidationTimer && now - entry.refreshedAt >= this.intervalMs && !entry.client.refreshPromise) this.scan(entry);
      }
    });
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; clearInterval(this.timer);
    this.closePromise = this.serialize(async () => {
      const entries = [...this.entries.values()]; this.entries.clear();
      for (const entry of entries) { clearTimeout(entry.invalidationTimer); entry.invalidationTimer = null; }
      await Promise.all(entries.map(entry => entry.client.close()));
    });
    return this.closePromise;
  }
}
module.exports = { FastIndexManager };
