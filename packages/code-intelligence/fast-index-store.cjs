const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { PARSER_VERSION } = require('./java-syntax-index.cjs');
const APPLICATION_ID = 0x43534649;
const SCHEMA_VERSION = 1;
const normalized = value => value.toLowerCase();
function abbreviation(name) { return (name.match(/(?:^[\p{L}])|[A-Z]|(?<=[_\s])[\p{L}]/gu) || []).join('').toLowerCase(); }
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) throw new TypeError('Index paths must be workspace-relative');
  return value.replace(/\\/g, '/');
}
class FastIndexStore {
  constructor(filename, root, parserVersion = PARSER_VERSION) {
    if (!path.isAbsolute(root)) throw new TypeError('Index workspace root must be absolute');
    this.db = new DatabaseSync(filename);
    this.closed = false;
    try {
      const application = this.db.prepare('PRAGMA application_id').get().application_id;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (application !== APPLICATION_ID && (application !== 0 || tables.length)) throw new Error('Refusing a database not owned by Code Studio fast index');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) throw new Error('Fast index schema is newer than this client');
      this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, stamp TEXT NOT NULL, hash TEXT NOT NULL, generation INTEGER NOT NULL, data TEXT NOT NULL, has_errors INTEGER NOT NULL, truncated INTEGER NOT NULL, rejected INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS symbols(id INTEGER PRIMARY KEY, file TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE, name TEXT NOT NULL, normalized TEXT NOT NULL, abbreviation TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, column_number INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file);
        CREATE INDEX IF NOT EXISTS symbols_name ON symbols(normalized);
        CREATE INDEX IF NOT EXISTS symbols_abbreviation ON symbols(abbreviation);
        CREATE VIRTUAL TABLE IF NOT EXISTS symbol_search USING fts5(normalized, abbreviation, content='symbols', content_rowid='id', tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS symbols_insert AFTER INSERT ON symbols BEGIN INSERT INTO symbol_search(rowid, normalized, abbreviation) VALUES(new.id, new.normalized, new.abbreviation); END;
        CREATE TRIGGER IF NOT EXISTS symbols_delete AFTER DELETE ON symbols BEGIN INSERT INTO symbol_search(symbol_search, rowid, normalized, abbreviation) VALUES('delete', old.id, old.normalized, old.abbreviation); END;
        CREATE TRIGGER IF NOT EXISTS symbols_update AFTER UPDATE ON symbols BEGIN
          INSERT INTO symbol_search(symbol_search, rowid, normalized, abbreviation) VALUES('delete', old.id, old.normalized, old.abbreviation);
          INSERT INTO symbol_search(rowid, normalized, abbreviation) VALUES(new.id, new.normalized, new.abbreviation);
        END;`);
      const savedRoot = this.meta('root');
      if (savedRoot && savedRoot !== root) throw new Error('Fast index belongs to a different workspace');
      this.transaction(() => {
        this.setMeta('root', root);
        if (this.meta('parserVersion') !== parserVersion) {
          this.db.exec('DELETE FROM files');
          this.setMeta('parserVersion', parserVersion); this.setMeta('state', 'needs-scan');
        }
        if (!this.meta('generation')) this.setMeta('generation', '0');
      });
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }
  meta(key) { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  transaction(action) { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  generation(value) { if (!Number.isInteger(value) || value !== Number(this.meta('generation'))) throw Object.assign(new Error('Stale index generation'), { code: 'FAST_INDEX_STALE' }); }
  beginScan() {
    return this.transaction(() => { const generation = Number(this.meta('generation')) + 1; this.setMeta('generation', generation); this.setMeta('state', 'scanning'); return generation; });
  }
  requireValidation() { this.setMeta('state', 'needs-validation'); }
  file(filePath) { const row = this.db.prepare('SELECT * FROM files WHERE path=?').get(relative(filePath)); return row ? { ...row, data: JSON.parse(row.data) } : null; }
  markSeen(filePath, generation, stamp) {
    this.generation(generation);
    return stamp === undefined ? this.db.prepare('UPDATE files SET generation=? WHERE path=?').run(generation, relative(filePath)).changes : this.db.prepare('UPDATE files SET generation=?,stamp=? WHERE path=?').run(generation, stamp, relative(filePath)).changes;
  }
  replace(filePath, stamp, hash, parsed, generation, rejected = false) {
    this.generation(generation); filePath = relative(filePath);
    if (typeof stamp !== 'string' || typeof hash !== 'string' || !parsed || !Array.isArray(parsed.symbols)) throw new TypeError('Invalid parsed file record');
    // Persist only explicit syntax metadata, never full source text or arbitrary
    // properties attached to a caller's parse result.
    const fileData = { packageName: parsed.packageName || '', imports: parsed.imports || [], inheritance: parsed.inheritance || [] };
    return this.transaction(() => {
      this.db.prepare('DELETE FROM files WHERE path=?').run(filePath);
      this.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)').run(filePath, stamp, hash, generation, JSON.stringify(fileData), Number(!!parsed.hasErrors), Number(!!parsed.truncated), Number(!!rejected));
      const insert = this.db.prepare('INSERT INTO symbols(file,name,normalized,abbreviation,kind,line,column_number,data) VALUES(?,?,?,?,?,?,?,?)');
      for (const symbol of parsed.symbols) {
        if (typeof symbol.name !== 'string' || !symbol.name || !Number.isInteger(symbol.line) || symbol.line < 1 || !Number.isInteger(symbol.column) || symbol.column < 1) throw new TypeError('Invalid syntax symbol');
        const data = { container: symbol.container || '', range: symbol.range, selectionRange: symbol.selectionRange, incomplete: !!symbol.incomplete };
        insert.run(filePath, symbol.name, normalized(symbol.name), abbreviation(symbol.name), symbol.kind, symbol.line, symbol.column, JSON.stringify(data));
      }
    });
  }
  remove(filePath) { return this.db.prepare('DELETE FROM files WHERE path=?').run(relative(filePath)).changes; }
  finishScan(generation, directoryErrors = 0) {
    this.generation(generation);
    if (!Number.isInteger(directoryErrors) || directoryErrors < 0) throw new TypeError('Invalid scan error count');
    this.transaction(() => {
      // An unreadable directory is not evidence that its old files were deleted.
      if (!directoryErrors) this.db.prepare('DELETE FROM files WHERE generation<>?').run(generation);
      this.setMeta('state', directoryErrors ? 'partial' : 'ready'); this.setMeta('directoryErrors', directoryErrors); this.setMeta('updatedAt', Date.now());
    });
  }
  status() {
    const counts = this.db.prepare('SELECT count(*) files, coalesce(sum(has_errors),0) syntaxErrorFiles, coalesce(sum(truncated),0) truncatedFiles, coalesce(sum(rejected),0) rejectedFiles FROM files').get();
    const state = this.meta('state') || 'needs-scan';
    const recovery = this.meta('cacheRecovery');
    return { state, generation: Number(this.meta('generation')), parserVersion: this.meta('parserVersion'), updatedAt: Number(this.meta('updatedAt') || 0), ...counts, symbols: this.db.prepare('SELECT count(*) count FROM symbols').get().count, directoryErrors: Number(this.meta('directoryErrors') || 0), complete: state === 'ready' && !counts.truncatedFiles && !counts.rejectedFiles, ...(recovery ? { cacheRecovery: JSON.parse(recovery) } : {}) };
  }
  search(query, limit = 200, excludedPaths = []) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || query.includes('\0')) throw new TypeError('Symbol query length must be 1..200');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Symbol result limit must be 1..500');
    if (!Array.isArray(excludedPaths) || excludedPaths.length > 20) throw new TypeError('Invalid overlay exclusions');
    const exclusions = excludedPaths.map(relative);
    const excludeSql = exclusions.length ? ` AND s.file NOT IN (${exclusions.map(() => '?').join(',')})` : '';
    const needle = normalized(query.trim());
    const ranked = `SELECT s.name,s.kind,s.file path,s.line,s.column_number column,s.data,f.hash,f.data file_data
      FROM symbols s JOIN files f ON f.path=s.file`;
    const order = `ORDER BY CASE WHEN s.normalized=? THEN 0 WHEN substr(s.normalized,1,length(?))=? THEN 1 WHEN substr(s.abbreviation,1,length(?))=? THEN 2 ELSE 3 END,s.normalized,s.file,s.line,s.column_number LIMIT ?`;
    const rankValues = [needle, needle, needle, needle, needle, limit + 1];
    let rows;
    if ([...needle].length >= 3) {
      const fts = `"${needle.replace(/"/g, '""')}"`;
      rows = this.db.prepare(`WITH candidates AS (
        SELECT rowid id FROM symbol_search WHERE symbol_search MATCH ?
        UNION SELECT id FROM symbols WHERE abbreviation>=? AND abbreviation<?
      ) ${ranked} JOIN candidates c ON c.id=s.id WHERE (instr(s.normalized,?)>0 OR substr(s.abbreviation,1,length(?))=?) ${excludeSql} ${order}`).all(fts, needle, needle + '\uffff', needle, needle, needle, ...exclusions, ...rankValues);
    } else rows = this.db.prepare(`${ranked} WHERE (instr(s.normalized,?)>0 OR substr(s.abbreviation,1,length(?))=?) ${excludeSql} ${order}`).all(needle, needle, needle, ...exclusions, ...rankValues);
    const items = rows.slice(0, limit).map(row => { const { data, file_data, ...symbol } = row; return { ...symbol, ...JSON.parse(data), packageName: JSON.parse(file_data).packageName, semantic: false }; });
    const status = this.status();
    return { items, truncated: rows.length > limit || !status.complete, sourceTruncated: !status.complete, sourceFiles: status.files, index: status };
  }
  outline(filePath) {
    return this.db.prepare('SELECT name,kind,file path,line,column_number column,data FROM symbols WHERE file=? ORDER BY line,column_number,id').all(relative(filePath)).map(row => { const { data, ...symbol } = row; return { ...symbol, ...JSON.parse(data), semantic: false }; });
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
module.exports = { FastIndexStore, abbreviation };
