// Derived cache recovery only. Never infer ownership from a filename or delete
// an unknown database. The marker is created after the store verifies ownership.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { FastIndexStore } = require('./fast-index-store.cjs');

function regularFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Object.assign(new Error('Unsafe fast-index cache file'), { code: 'FAST_INDEX_UNSAFE_CACHE' });
  return true;
}
function markerMatches(filename, identity) {
  if (!regularFile(filename)) return false;
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (stat.size > 4096 || stat.nlink !== 1) return false;
    const marker = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    return marker.format === 'code-studio-fast-index-owner-v1' && marker.identity === identity;
  } catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  finally { fs.closeSync(descriptor); }
}
function openRecoverableFastIndexStore(filename, root) {
  if (!path.isAbsolute(filename) || !path.isAbsolute(root)) throw new TypeError('Absolute cache and workspace paths required');
  const marker = filename + '.owner.json';
  const identity = createHash('sha256').update(JSON.stringify([path.resolve(filename), root])).digest('hex');
  const files = [filename, filename + '-wal', filename + '-shm'];
  for (const file of files) regularFile(file);
  const hasMarker = regularFile(marker);
  const owned = hasMarker && markerMatches(marker, identity);
  if (hasMarker && !owned) throw Object.assign(new Error('Fast-index cache identity mismatch'), { code: 'FAST_INDEX_CACHE_IDENTITY' });
  let store;
  try {
    if (fs.existsSync(filename)) {
      const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const header = Buffer.alloc(16), size = fs.fstatSync(descriptor).size;
        const bytes = fs.readSync(descriptor, header, 0, header.length, 0);
        if ((size || owned) && (bytes !== 16 || !header.equals(Buffer.from('SQLite format 3\0')))) throw Object.assign(new Error('Invalid fast-index database header'), { code: 'ERR_SQLITE_ERROR', errcode: 26 });
      } finally { fs.closeSync(descriptor); }
    }
    if (owned && fs.existsSync(filename)) {
      // Detect unreadable schema before a read/write open. SQLite may still
      // refresh its transient SHM bookkeeping while opening in read-only mode.
      const probe = new DatabaseSync(filename, { readOnly: true });
      try { probe.prepare('PRAGMA application_id').get(); probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(); }
      finally { probe.close(); }
    }
    store = new FastIndexStore(filename, root);
  }
  catch (error) {
    const sqliteCode = Number(error.errcode) & 255;
    if (!owned || error.code !== 'ERR_SQLITE_ERROR' || ![11, 26].includes(sqliteCode)) throw error;
    // Keep the complete database/WAL/SHM set for recovery or diagnostics.
    // Recheck every target before any move; do not quarantine links or aliases.
    const existing = files.filter(regularFile);
    const backup = filename + '.corrupt-' + randomUUID();
    fs.mkdirSync(backup, { mode: 0o700 });
    const moved = [];
    try {
      for (const file of existing) { fs.renameSync(file, path.join(backup, path.basename(file))); moved.push(file); }
    } catch (moveError) {
      for (const file of moved.reverse()) fs.renameSync(path.join(backup, path.basename(file)), file);
      throw moveError;
    }
    store = new FastIndexStore(filename, root);
    store.setMeta('cacheRecovery', JSON.stringify({ reason: 'sqlite-corruption', recoveredAt: Date.now() }));
  }
  try {
    if (!hasMarker) fs.writeFileSync(marker, JSON.stringify({ format: 'code-studio-fast-index-owner-v1', identity }), { flag: 'wx', mode: 0o600 });
    return store;
  } catch (error) { store.close(); throw error; }
}
module.exports = { openRecoverableFastIndexStore };
