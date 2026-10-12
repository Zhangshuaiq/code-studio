const { Worker } = require('node:worker_threads');
class FastIndexClient {
  constructor(options) {
    this.pending = new Map(); this.sequence = 0; this.closed = false; this.latestStatus = { state: 'starting', complete: false };
    this.worker = new Worker(require.resolve('./fast-index-worker.cjs'), { workerData: { root: options.root, databasePath: options.databasePath } });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Initialization rejection may arrive before the first public request.
    this.ready.catch(() => {});
    this.worker.on('message', message => {
      if (message.event === 'ready') { this.latestStatus = message.status; this.resolveReady(); }
      if (message.event === 'status') this.latestStatus = message.status;
      if (message.event === 'failed') this.fail(Object.assign(new Error(message.error.message), { code: message.error.code }));
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else { if (message.result?.state) this.latestStatus = message.result; request.resolve(message.result); }
      }
    });
    this.worker.on('error', error => this.fail(error));
    this.exited = new Promise(resolve => this.worker.once('exit', code => { this.fail(new Error(`Fast-index thread exited (${code})`)); resolve(code); }));
    this.startupTimer = setTimeout(() => this.fail(Object.assign(new Error('Fast-index initialization timed out'), { code: 'FAST_INDEX_TIMEOUT' })), 15000);
    this.ready.finally(() => clearTimeout(this.startupTimer)).catch(() => {});
  }
  fail(error) {
    this.failure ||= error; this.rejectReady(error);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  async request(operation, input = {}, timeout = 15000) {
    if (this.closed && operation !== 'close') throw new Error('Fast index is closed');
    if (this.failure) throw this.failure;
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.pending.size >= 64) throw Object.assign(new Error('Fast-index request queue is full'), { code: 'FAST_INDEX_BUSY' });
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('Fast-index request timed out'), { code: 'FAST_INDEX_TIMEOUT' })); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, operation, input }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  search(query, limit, documents) { return this.request('search', { query, limit, documents }); }
  async outline(path) { return (await this.request('outline', { path })).items; }
  outlineWithDocuments(path, documents) { return this.request('outline', { path, documents }); }
  status() { return this.request('status'); }
  refresh(force = false) {
    if (this.refreshPromise && !force) return this.refreshPromise;
    const next = this.request('refresh', {}, 10 * 60 * 1000).finally(() => { if (this.refreshPromise === next) this.refreshPromise = null; });
    this.refreshPromise = next;
    return next;
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      let deadline;
      try { await Promise.race([this.request('close', {}, 5000).catch(() => {}), new Promise(resolve => { deadline = setTimeout(resolve, 5000); })]); }
      finally { clearTimeout(deadline); clearTimeout(this.startupTimer); await this.worker.terminate(); await this.exited; }
    })();
    return this.closePromise;
  }
}
module.exports = { FastIndexClient };
