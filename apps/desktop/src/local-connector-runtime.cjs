const { Client } = require('pg');
const mysql = require('mysql2/promise');
const { Kafka, logLevel } = require('kafkajs');

class LocalConnectorRuntime {
  async test(config, secret = '') {
    const started = Date.now();
    if (config.type === 'postgres') await testPostgres(config.settings, secret);
    else if (config.type === 'mysql') await testMysql(config.settings, secret);
    else if (config.type === 'kafka') await testKafka(config.settings, secret);
    else if (config.type === 'kubernetes') await testKubernetes(config.settings, secret);
    else throw invalid('不支持的连接类型');
    return { ok: true, latencyMs: Date.now() - started, testedAt: new Date().toISOString() };
  }

  async explore(config, secret = '', input = {}) {
    if (config.type === 'postgres' || config.type === 'mysql') return queryDatabase(config, secret, input.sql, input.readOnly !== false);
    if (config.type === 'kafka') return listKafkaTopics(config.settings, secret);
    if (config.type === 'kubernetes') return listKubernetesPods(config.settings, secret);
    throw invalid('该连接暂不支持浏览');
  }
}

async function queryDatabase(config, password, value, readOnly = true) {
  const sql = String(value || '').trim();
  if (!sql || sql.length > 100_000) throw invalid('请输入 SQL，长度不能超过 100000 字符');
  if (readOnly && (!/^(select|with|show|describe|desc|explain)\b/i.test(sql) || /;\s*\S/.test(sql))) throw invalid('当前工作区仅允许执行单条只读查询');
  if (config.type === 'postgres') {
    const client = new Client({ host: config.settings.host, port: config.settings.port, database: config.settings.database, user: config.settings.username, password: password || undefined, ssl: config.settings.ssl ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      if (readOnly) await client.query('BEGIN READ ONLY');
      const result = await client.query({ text: sql, queryMode: 'extended' });
      if (readOnly) await client.query('ROLLBACK');
      return databaseResult(result.fields, result.rows, { command: result.command, affectedRows: result.rowCount ?? 0 });
    } finally { await client.end().catch(() => {}); }
  }
  const connection = await mysql.createConnection({ host: config.settings.host, port: config.settings.port, database: config.settings.database || undefined, user: config.settings.username, password: password || undefined, ssl: config.settings.ssl ? {} : undefined, connectTimeout: 5_000 });
  try {
    if (readOnly) { await connection.query('SET SESSION TRANSACTION READ ONLY'); await connection.beginTransaction(); }
    const [rows, fields] = await connection.query(sql);
    if (readOnly) await connection.rollback();
    return databaseResult(fields, Array.isArray(rows) ? rows : [], { affectedRows: Array.isArray(rows) ? rows.length : rows.affectedRows ?? 0, ...(rows.insertId ? { insertId: rows.insertId } : {}) });
  } finally { await connection.end(); }
}

function databaseResult(fields, rows, metadata) {
  if (!fields?.length) return { kind: 'command', ...metadata };
  return { kind: 'table', columns: fields.map((field) => field.name), rows: rows.slice(0, 500), truncated: rows.length > 500, ...metadata };
}

async function listKafkaTopics(settings, password) {
  const kafka = new Kafka({ clientId: settings.clientId || 'code-studio', brokers: settings.brokers, ssl: Boolean(settings.ssl), sasl: settings.username ? { mechanism: 'plain', username: settings.username, password } : undefined, connectionTimeout: 5_000, requestTimeout: 8_000, logLevel: logLevel.NOTHING });
  const admin = kafka.admin(); try { await admin.connect(); return { kind: 'list', items: (await admin.listTopics()).sort().slice(0, 1_000) }; } finally { await admin.disconnect().catch(() => {}); }
}

async function listKubernetesPods(settings, token) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8_000);
  try { const response = await fetch(`${settings.server}/api/v1/namespaces/${encodeURIComponent(settings.namespace)}/pods`, { signal: controller.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} }); if (!response.ok) throw new Error(`Kubernetes 返回 HTTP ${response.status}`); const body = await response.json(); return { kind: 'resources', items: (body.items || []).slice(0, 500).map((pod) => ({ name: pod.metadata?.name, phase: pod.status?.phase, node: pod.spec?.nodeName })) }; } finally { clearTimeout(timer); }
}

async function testPostgres(settings, password) {
  const client = new Client({ host: settings.host, port: settings.port, database: settings.database, user: settings.username, password: password || undefined, ssl: settings.ssl ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 5_000 });
  try { await client.connect(); await client.query('SELECT 1'); } finally { await client.end().catch(() => {}); }
}
async function testMysql(settings, password) {
  const connection = await mysql.createConnection({ host: settings.host, port: settings.port, database: settings.database || undefined, user: settings.username, password: password || undefined, ssl: settings.ssl ? {} : undefined, connectTimeout: 5_000 });
  try { await connection.ping(); } finally { await connection.end(); }
}
async function testKafka(settings, password) {
  const kafka = new Kafka({ clientId: settings.clientId || 'code-studio', brokers: settings.brokers, ssl: Boolean(settings.ssl), sasl: settings.username ? { mechanism: 'plain', username: settings.username, password } : undefined, connectionTimeout: 5_000, requestTimeout: 5_000, logLevel: logLevel.NOTHING });
  const admin = kafka.admin(); try { await admin.connect(); await admin.listTopics(); } finally { await admin.disconnect().catch(() => {}); }
}
async function testKubernetes(settings, token) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${settings.server.replace(/\/$/, '')}/version`, { signal: controller.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) throw new Error(`Kubernetes 返回 HTTP ${response.status}`);
    const body = await response.json().catch(() => ({})); if (!body.gitVersion && !body.major) throw new Error('服务未返回 Kubernetes 版本信息');
  } finally { clearTimeout(timer); }
}

function validateConnector(input, id) {
  const type = typeof input.type === 'string' ? input.type : ''; const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100 || !['postgres', 'mysql', 'kafka', 'kubernetes'].includes(type)) throw invalid('连接名称或类型无效');
  const source = input.settings && typeof input.settings === 'object' ? input.settings : {};
  let settings;
  if (type === 'postgres' || type === 'mysql') settings = { host: hostname(source.host), port: port(source.port, type === 'postgres' ? 5432 : 3306), database: text(source.database, 200), username: text(source.username, 200), ssl: Boolean(source.ssl) };
  else if (type === 'kafka') {
    const brokers = Array.isArray(source.brokers) ? source.brokers : String(source.brokers || '').split(',');
    settings = { brokers: brokers.map((item) => String(item).trim()).filter(Boolean).map(broker).slice(0, 20), clientId: text(source.clientId, 100) || 'code-studio', username: text(source.username, 200), ssl: Boolean(source.ssl) };
    if (!settings.brokers.length) throw invalid('请填写至少一个 Kafka Broker');
  } else {
    let server; try { server = new URL(String(source.server || '').trim()); } catch {}
    if (!server || !['http:', 'https:'].includes(server.protocol) || server.username || server.password) throw invalid('Kubernetes 地址无效');
    settings = { server: server.toString().replace(/\/$/, ''), namespace: text(source.namespace, 200) || 'default' };
  }
  return { id, name, type, settings };
}
function hostname(value) { const result = text(value, 253); if (!result || /[\s/]/.test(result)) throw invalid('主机地址无效'); return result; }
function port(value, fallback) { const number = value === '' || value == null ? fallback : Number(value); if (!Number.isInteger(number) || number < 1 || number > 65535) throw invalid('端口无效'); return number; }
function broker(value) { const match = value.match(/^([^:\s]+):(\d{1,5})$/); if (!match || Number(match[2]) > 65535) throw invalid(`Broker 地址无效：${value}`); return `${match[1]}:${Number(match[2])}`; }
function text(value, limit) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function invalid(message) { const error = new Error(message); error.code = 'LOCAL_CONNECTOR_INVALID'; return error; }

module.exports = { LocalConnectorRuntime, validateConnector };
