const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const CURRENT_SCHEMA_VERSION = 7;

class LocalStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    try { fs.chmodSync(databasePath, 0o600); } catch {}
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    const version = Number(this.database.prepare('PRAGMA user_version').get().user_version);
    if (version > CURRENT_SCHEMA_VERSION) throw new Error(`本地数据库版本 ${version} 高于客户端支持的版本`);
    if (version < 1) this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE recent_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, opened_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      PRAGMA user_version = 1;
      COMMIT;
    `);
    if (version < 2) this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE model_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        engine TEXT NOT NULL,
        provider TEXT NOT NULL,
        base_url TEXT,
        model TEXT NOT NULL,
        credential_ciphertext TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 2;
      COMMIT;
    `);
    if (version < 3) this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        model_config_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX agent_tasks_project_created_idx ON agent_tasks(project_id, created_at DESC);
      CREATE TABLE agent_events (
        task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT,
        tool_name TEXT,
        tool_input_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, sequence),
        FOREIGN KEY(task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
      );
      PRAGMA user_version = 3;
      COMMIT;
    `);
    if (version < 4) this.database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE agent_tasks ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'read-only';
      PRAGMA user_version = 4;
      COMMIT;
    `);
    if (version < 5) this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE connector_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        credential_ciphertext TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 5;
      COMMIT;
    `);
    if (version < 6) this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE privacy_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        setting_key TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        changed_at TEXT NOT NULL
      );
      CREATE INDEX privacy_audit_changed_idx ON privacy_audit(changed_at DESC);
      PRAGMA user_version = 6;
      COMMIT;
    `);
    if (version < 7) this.database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE agent_tasks ADD COLUMN selected_model TEXT;
      ALTER TABLE agent_tasks ADD COLUMN reasoning_effort TEXT;
      ALTER TABLE agent_tasks ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agent_tasks ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agent_tasks ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
      PRAGMA user_version = 7;
      COMMIT;
    `);
    this.database.prepare(`UPDATE agent_tasks SET status = 'interrupted', error = ?, finished_at = ?
      WHERE status IN ('queued', 'running', 'cancelling')`).run('客户端重启，任务已中断', new Date().toISOString());
  }

  upsertProject(project) {
    this.database.prepare(`INSERT INTO recent_projects (id, name, path, opened_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET id = excluded.id, name = excluded.name, opened_at = excluded.opened_at`)
      .run(project.id, project.name, project.path, project.openedAt);
  }
  listProjects() {
    return this.database.prepare('SELECT id, name, path, opened_at AS openedAt FROM recent_projects ORDER BY opened_at DESC')
      .all().map((row) => ({ id: row.id, name: row.name, path: row.path, openedAt: row.openedAt }));
  }
  removeProject(id) { this.database.prepare('DELETE FROM recent_projects WHERE id = ?').run(id); }
  setSetting(key, value) {
    this.database.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
  getSetting(key) {
    const row = this.database.prepare('SELECT value_json AS valueJson FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.valueJson) : undefined;
  }
  deleteSetting(key) { this.database.prepare('DELETE FROM settings WHERE key = ?').run(key); }
  setPrivacySetting(key, enabled) {
    const now = new Date().toISOString();
    this.setSetting(`privacy.${key}`, Boolean(enabled));
    this.database.prepare('INSERT INTO privacy_audit (setting_key, enabled, changed_at) VALUES (?, ?, ?)').run(key, enabled ? 1 : 0, now);
  }
  listPrivacyAudit(limit = 20) {
    return this.database.prepare('SELECT setting_key AS key, enabled, changed_at AS changedAt FROM privacy_audit ORDER BY id DESC LIMIT ?').all(limit)
      .map((item) => ({ ...item, enabled: Boolean(item.enabled) }));
  }
  upsertModelConfig(config, credentialCiphertext) {
    const now = new Date().toISOString();
    const existing = this.database.prepare('SELECT created_at AS createdAt, credential_ciphertext AS credentialCiphertext FROM model_configs WHERE id = ?').get(config.id);
    this.database.prepare(`INSERT INTO model_configs (id, name, engine, provider, base_url, model, credential_ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, engine = excluded.engine, provider = excluded.provider,
        base_url = excluded.base_url, model = excluded.model, credential_ciphertext = excluded.credential_ciphertext, updated_at = excluded.updated_at`)
      .run(config.id, config.name, config.engine, config.provider, config.baseUrl || null, config.model || '', credentialCiphertext === undefined ? (existing?.credentialCiphertext || null) : credentialCiphertext, existing?.createdAt || now, now);
  }
  listModelConfigs() {
    return this.database.prepare(`SELECT id, name, engine, provider, base_url AS baseUrl, model,
      credential_ciphertext AS credentialCiphertext, created_at AS createdAt, updated_at AS updatedAt
      FROM model_configs ORDER BY updated_at DESC`).all();
  }
  getModelConfig(id) {
    return this.database.prepare(`SELECT id, name, engine, provider, base_url AS baseUrl, model,
      credential_ciphertext AS credentialCiphertext, created_at AS createdAt, updated_at AS updatedAt FROM model_configs WHERE id = ?`).get(id);
  }
  deleteModelConfig(id) { this.database.prepare('DELETE FROM model_configs WHERE id = ?').run(id); }
  upsertConnector(config, credentialCiphertext) {
    const now = new Date().toISOString();
    const existing = this.database.prepare('SELECT created_at AS createdAt, credential_ciphertext AS credentialCiphertext FROM connector_configs WHERE id = ?').get(config.id);
    this.database.prepare(`INSERT INTO connector_configs (id, name, type, config_json, credential_ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, config_json = excluded.config_json,
        credential_ciphertext = excluded.credential_ciphertext, updated_at = excluded.updated_at`)
      .run(config.id, config.name, config.type, JSON.stringify(config.settings), credentialCiphertext === undefined ? (existing?.credentialCiphertext || null) : credentialCiphertext, existing?.createdAt || now, now);
  }
  listConnectors() { return this.database.prepare(`SELECT id, name, type, config_json AS configJson, credential_ciphertext AS credentialCiphertext, created_at AS createdAt, updated_at AS updatedAt FROM connector_configs ORDER BY updated_at DESC`).all().map(parseConnector); }
  getConnector(id) { const row = this.database.prepare(`SELECT id, name, type, config_json AS configJson, credential_ciphertext AS credentialCiphertext, created_at AS createdAt, updated_at AS updatedAt FROM connector_configs WHERE id = ?`).get(id); return row ? parseConnector(row) : undefined; }
  deleteConnector(id) { this.database.prepare('DELETE FROM connector_configs WHERE id = ?').run(id); }
  createAgentTask(task) {
    this.database.prepare(`INSERT INTO agent_tasks (id, project_id, model_config_id, prompt, status, permission_profile, selected_model, reasoning_effort, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(task.id, task.projectId, task.modelConfigId, task.prompt, task.status, task.permissionProfile || 'read-only', task.selectedModel || null, task.reasoningEffort || null, task.createdAt);
  }
  updateAgentTask(id, status, fields = {}) {
    this.database.prepare(`UPDATE agent_tasks SET status = ?, error = COALESCE(?, error),
      started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at),
      input_tokens = COALESCE(?, input_tokens), cached_input_tokens = COALESCE(?, cached_input_tokens), output_tokens = COALESCE(?, output_tokens) WHERE id = ?`)
      .run(status, fields.error || null, fields.startedAt || null, fields.finishedAt || null,
        integerOrNull(fields.inputTokens), integerOrNull(fields.cachedInputTokens), integerOrNull(fields.outputTokens), id);
  }
  addAgentEvent(taskId, event) {
    const row = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_events WHERE task_id = ?').get(taskId);
    const sequence = Number(row.sequence);
    this.database.prepare(`INSERT INTO agent_events (task_id, sequence, kind, text, tool_name, tool_input_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(taskId, sequence, event.kind, event.text || null, event.toolName || null, event.toolInput === undefined ? null : JSON.stringify(event.toolInput), new Date().toISOString());
    return sequence;
  }
  getAgentTask(id) {
    const task = this.database.prepare(`SELECT id, project_id AS projectId, model_config_id AS modelConfigId, prompt, status, permission_profile AS permissionProfile,
      selected_model AS selectedModel, reasoning_effort AS reasoningEffort, input_tokens AS inputTokens, cached_input_tokens AS cachedInputTokens, output_tokens AS outputTokens, error,
      created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt FROM agent_tasks WHERE id = ?`).get(id);
    if (!task) return undefined;
    return { ...task, events: this.listAgentEvents(id) };
  }
  listAgentTasks(projectId, limit = 50) {
    return this.database.prepare(`SELECT id, project_id AS projectId, model_config_id AS modelConfigId, prompt, status, permission_profile AS permissionProfile,
      selected_model AS selectedModel, reasoning_effort AS reasoningEffort, input_tokens AS inputTokens, cached_input_tokens AS cachedInputTokens, output_tokens AS outputTokens, error,
      created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt FROM agent_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`).all(projectId, limit);
  }
  listAgentUsage() {
    return this.database.prepare(`SELECT COALESCE(NULLIF(selected_model, ''), 'default') AS model,
      COUNT(*) AS tasks, SUM(input_tokens) AS inputTokens, SUM(cached_input_tokens) AS cachedInputTokens, SUM(output_tokens) AS outputTokens
      FROM agent_tasks GROUP BY COALESCE(NULLIF(selected_model, ''), 'default') ORDER BY SUM(input_tokens + output_tokens) DESC`).all().map((row) => ({ ...row }));
  }
  listAgentEvents(taskId, after = 0) {
    return this.database.prepare(`SELECT sequence, kind, text, tool_name AS toolName, tool_input_json AS toolInputJson,
      created_at AS createdAt FROM agent_events WHERE task_id = ? AND sequence > ? ORDER BY sequence`).all(taskId, after)
      .map(({ toolInputJson, ...event }) => ({ ...event, ...(toolInputJson ? { toolInput: JSON.parse(toolInputJson) } : {}) }));
  }
  getSchemaVersion() { return Number(this.database.prepare('PRAGMA user_version').get().user_version); }
  close() { this.database.close(); }
}

function parseConnector({ configJson, ...row }) { return { ...row, settings: JSON.parse(configJson) }; }
function integerOrNull(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

module.exports = { LocalStore, CURRENT_SCHEMA_VERSION };
