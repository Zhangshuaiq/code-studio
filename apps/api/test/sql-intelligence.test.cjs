const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const Module = require('node:module'); const ts = require('typescript');
const filename = path.resolve(__dirname, '../../web/src/lib/sql-intelligence.ts');
const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);
const { sqlConfig, sqlIdentifierParts, sqlDdlMetadata, completeSql, installSqlWorkspaceCompletions } = compiled.exports;
const metadata = { dialect: 'postgresql', defaultSchema: 'public', tables: ['"public"."users"', '"public"."orders"'], tableStructures: { '"public"."users"': [{ column_name: 'id', data_type: 'integer' }, { column_name: 'display_name', data_type: 'text' }], '"public"."orders"': [{ column_name: 'order_only' }] } };
test('SQL reference discovery handles joins, comma tables, nested queries and CTEs without parsing strings/comments', () => {
  const references = compiled.exports.sqlReferencedTables;
  assert.deepEqual(references('SELECT u. FROM public.users u JOIN orders o ON u.id=o.uid', 'postgresql'), ['public.users', 'orders']);
  assert.deepEqual(references('WITH tmp AS (SELECT * FROM users) SELECT * FROM tmp, orders', 'postgresql'), ['users', 'orders']);
  assert.deepEqual(references('WITH TMP AS (SELECT * FROM users) SELECT * FROM tmp', 'postgresql'), ['users']);
  assert.deepEqual(references('SELECT * FROM (WITH tmp AS (SELECT * FROM users) SELECT * FROM tmp) x JOIN tmp ON true', 'postgresql'), ['users', 'tmp']);
  assert.deepEqual(references('SELECT * FROM (SELECT * FROM "order.items") x WHERE x.id IN (SELECT id FROM audit)', 'postgresql'), ['"order.items"', 'audit']);
  assert.deepEqual(references("SELECT 'FROM secret' FROM users -- JOIN private\n/* FROM hidden */", 'postgresql'), ['users']);
  assert.deepEqual(references('UPDATE users SET x=1; INSERT INTO orders VALUES(1); DELETE FROM audit', 'postgresql'), ['users', 'orders', 'audit']);
  assert.deepEqual(references('SELECT * FROM generate_series(1,2)', 'postgresql'), []);
  assert.deepEqual(references('SELECT * FROM `user.records`', 'mysql'), ['`user.records`']);
  assert.deepEqual(references('x'.repeat(1_000_001)), []);
  assert.equal(references('SELECT * FROM ' + Array.from({ length: 200 }, (_, i) => 'table_' + i).join(',')).length, 129);
});
test('SQL identifiers preserve quoted spaces and PostgreSQL folds only unquoted names', () => {
  assert.deepEqual(sqlIdentifierParts(' PUBLIC . Users ', true), ['public', 'users']);
  assert.deepEqual(sqlIdentifierParts('public." Users "', true), ['public', ' Users ']);
  assert.deepEqual(sqlIdentifierParts('"a.b"."x""y"', true), ['a.b', 'x"y']);
  assert.deepEqual(sqlIdentifierParts('"users"suffix'), []);
});
const labels = results => results.flatMap(result => result.options.map(option => option.label));
const contextFile = path.resolve(__dirname, '../../web/src/lib/workspace-sql-context.ts'); const contextModule = new Module(contextFile, module); contextModule.filename = contextFile;
contextModule._compile(ts.transpileModule(fs.readFileSync(contextFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, contextFile);
const contexts = contextModule.exports;
test('SQL connection metadata is scoped, expiring, immutable and does not retain connection secrets', () => {
  const local = contexts.workspaceSqlScope('local', 'workspace'); const remote = contexts.workspaceSqlScope('remote', 'workspace', 'user-a'); const other = contexts.workspaceSqlScope('remote', 'workspace', 'user-b');
  assert.notEqual(local, remote); assert.notEqual(remote, other); assert.throws(() => contexts.workspaceSqlScope('remote', 'workspace'));
  const source = { ...metadata, password: 'private-secret', tableStructures: { users: [{ column_name: 'name', password: 'private-secret' }] } };
  const snapshot = contexts.publishWorkspaceSqlContext(remote, 'connection-a/db-a', source, 1000);
  assert.equal(contexts.readWorkspaceSqlContext(remote, 2000), snapshot); assert.equal(contexts.readWorkspaceSqlContext(other, 2000), undefined); assert.equal(contexts.readWorkspaceSqlContext(remote, 31000), undefined);
  source.tableStructures.users[0].column_name = 'mutated'; assert.equal(snapshot.metadata.tableStructures.users[0].column_name, 'name'); assert.ok(Object.isFrozen(snapshot.metadata.tableStructures.users));
  assert.equal(JSON.stringify(snapshot).includes('private-secret'), false);
  contexts.clearWorkspaceSqlContext(remote); assert.equal(contexts.readWorkspaceSqlContext(remote, 2000), undefined);
  const next = contexts.publishWorkspaceSqlContext(remote, 'connection-b/db-b', metadata, 1000); assert.ok(next.revision > snapshot.revision);
  contexts.clearWorkspaceSqlContext(remote);
});
test('SQL workspace provider uses bound columns and cancels expired or switched connection results', async () => {
  const scope = contexts.workspaceSqlScope('local', 'binding-provider'); const query = model('project', 'query.sql', 'SELECT u. FROM public.users u');
  const ddl = model('project', 'schema.sql', 'CREATE TABLE users (local_only TEXT);');
  const monaco = { languages: { CompletionItemKind: { Keyword: 17, Field: 3, Class: 5, Text: 18 } }, editor: { getModels: () => [query, ddl] }, Range: class {} };
  const provider = compiled.exports.createSqlWorkspaceCompletionProvider(monaco, 'project', () => contexts.readWorkspaceSqlContext(scope));
  contexts.publishWorkspaceSqlContext(scope, 'connection-a/db-a', metadata);
  const first = await provider.provideCompletionItems(query, { column: 10 }); assert.ok(first.suggestions.some(item => item.label === 'display_name')); assert.ok(!first.suggestions.some(item => item.label === 'local_only'));
  const pending = provider.provideCompletionItems(query, { column: 10 });
  contexts.publishWorkspaceSqlContext(scope, 'connection-b/db-b', { ...metadata, tableStructures: { '"public"."users"': [{ column_name: 'new_connection_column' }] } });
  assert.deepEqual((await pending).suggestions, []);
  const second = await provider.provideCompletionItems(query, { column: 10 }); assert.ok(second.suggestions.some(item => item.label === 'new_connection_column')); assert.ok(!second.suggestions.some(item => item.label === 'display_name'));
  contexts.publishWorkspaceSqlContext(scope, 'expired', metadata, Date.now() - 31000); assert.ok(!(await provider.provideCompletionItems(query, { column: 10 })).suggestions.some(item => item.label === 'display_name'));
  contexts.clearWorkspaceSqlContext(scope); provider.dispose();
});
test('SQL schema preserves quoted qualification, escaped identifiers and prototype-like names', () => {
  assert.deepEqual(sqlIdentifierParts('"public"."order.items"'), ['public', 'order.items']);
  assert.deepEqual(sqlIdentifierParts('`a``b`.`c.d`'), ['a`b', 'c.d']);
  assert.deepEqual(sqlIdentifierParts('"unterminated'), []);
  const config = sqlConfig({ tables: ['__proto__.constructor'], tableStructures: { '__proto__.constructor': [{ column_name: 'toString' }] } });
  assert.equal(Object.getPrototypeOf(config.schema), null);
  assert.equal(config.schema.__proto__.constructor[0].label, 'toString');
});
test('SQL parsed CREATE TABLE discovers columns without treating strings, comments or constraints as tables', () => {
  const source = '-- CREATE TABLE fake (bad text);\nCREATE TABLE "public"."users" (id INTEGER PRIMARY KEY, "display_name" TEXT, amount DECIMAL(10,2), CONSTRAINT fk FOREIGN KEY (id) REFERENCES others(id));\nSELECT \'CREATE TABLE nope (bad int)\';';
  const parsed = sqlDdlMetadata(source, 'postgresql');
  assert.deepEqual(parsed.tables, ['"public"."users"']);
  assert.deepEqual(parsed.tableStructures[parsed.tables[0]].map(column => column.column_name), ['id', 'display_name', 'amount']);
});
test('SQL keyword completion works without a connection and is suppressed in comments and strings', async () => {
  assert.ok(labels(await completeSql('SEL', 3)).includes('SELECT'));
  assert.equal(labels(await completeSql('-- SEL', 6)).length, 0);
  assert.equal(labels(await completeSql("SELECT 'SEL", 11)).length, 0);
});
test('SQL schema completion resolves aliases and does not leak columns from unrelated tables', async () => {
  const content = 'SELECT u. FROM public.users AS u';
  const results = await completeSql(content, 9, metadata);
  assert.ok(labels(results).includes('display_name'), JSON.stringify(results));
  assert.ok(!labels(results).includes('order_only'), JSON.stringify(results));
  const other = await completeSql(content, 9, { ...metadata, tableStructures: { '"public"."users"': [{ column_name: 'other_connection' }] } });
  assert.ok(labels(other).includes('other_connection'));
  assert.ok(!labels(other).includes('display_name'));
});
test('MySQL completion accepts backtick identifiers with dots and uses the matching column namespace', async () => {
  const content = 'SELECT u. FROM `user.records` AS u';
  const results = await completeSql(content, 9, { dialect: 'mysql', tables: ['`user.records`'], tableStructures: { '`user.records`': [{ Field: 'full_name' }] } });
  assert.ok(labels(results).includes('full_name'), JSON.stringify(results));
});
function model(project, file, content) {
  return { uri: { scheme: 'codegen', authority: project, path: '/' + file }, version: 1, content, isDisposed: () => false, getLanguageId: () => 'sql', getVersionId() { return this.version; }, getValue() { return this.content; }, getOffsetAt(position) { return position.column - 1; }, getPositionAt(offset) { return { lineNumber: 1, column: offset + 1 }; } };
}
test('Monaco SQL completion reads same-project DDL drafts, isolates projects, updates schemas and discards stale results', async () => {
  let provider; let removed = false;
  const ddl = model('project', 'schema.sql', 'CREATE TABLE users (display_name TEXT);');
  const secret = model('another', 'schema.sql', 'CREATE TABLE private_table (private_column TEXT);');
  const query = model('project', 'query.sql', 'SELECT u. FROM users u');
  const monaco = { languages: { CompletionItemKind: { Keyword: 17, Field: 3, Class: 5, Text: 18 }, registerCompletionItemProvider(language, implementation) { assert.equal(language, 'sql'); provider = implementation; return { dispose() { removed = true; } }; } }, editor: { getModels: () => [ddl, secret, query] }, Range: class { constructor(startLineNumber, startColumn, endLineNumber, endColumn) { Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn }); } } };
  const registration = installSqlWorkspaceCompletions(monaco, 'project');
  const position = { lineNumber: 1, column: 10 };
  const first = await provider.provideCompletionItems(query, position);
  assert.ok(first.suggestions.some(item => item.label === 'display_name'));
  assert.ok(!first.suggestions.some(item => item.label === 'private_column'));
  ddl.content = 'CREATE TABLE users (new_column TEXT);'; ddl.version++;
  const second = await provider.provideCompletionItems(query, position);
  assert.ok(second.suggestions.some(item => item.label === 'new_column'));
  assert.ok(!second.suggestions.some(item => item.label === 'display_name'));
  const pending = provider.provideCompletionItems(query, position); query.version++;
  assert.deepEqual((await pending).suggestions, []);
  const staleSchema = provider.provideCompletionItems(query, position); ddl.version++;
  assert.deepEqual((await staleSchema).suggestions, []);
  assert.deepEqual((await provider.provideCompletionItems(secret, position)).suggestions, []);
  assert.deepEqual((await provider.provideCompletionItems(query, position, {}, { isCancellationRequested: true })).suggestions, []);
  registration.dispose(); assert.equal(removed, true);
  assert.deepEqual((await provider.provideCompletionItems(query, position)).suggestions, []);
});

test('lazy SQL provider skips foreign workspaces and cancels stale requests while loading the parser', async () => {
  const lazyFile = path.resolve(__dirname, '../../web/src/lib/sql-workspace-provider.ts');
  const lazy = new Module(lazyFile, module); lazy.filename = lazyFile; lazy.paths = Module._nodeModulePaths(path.dirname(lazyFile));
  let loads = 0; const originalRequire = lazy.require.bind(lazy);
  lazy.require = id => { if (id === './sql-intelligence') { loads++; return compiled.exports; } return originalRequire(id); };
  lazy._compile(ts.transpileModule(fs.readFileSync(lazyFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, lazyFile);
  let provider;
  const query = model('project', 'query.sql', 'SEL');
  const monaco = { languages: { CompletionItemKind: { Keyword: 17, Field: 3, Class: 5, Text: 18 }, registerCompletionItemProvider(_language, implementation) { provider = implementation; return { dispose() {} }; } }, editor: { getModels: () => [query] }, Range: class {} };
  const registration = lazy.exports.installSqlWorkspaceCompletions(monaco, 'project');
  assert.deepEqual((await provider.provideCompletionItems(model('another', 'query.sql', 'SEL'), { column: 4 })).suggestions, []);
  assert.equal(loads, 0);
  const pending = provider.provideCompletionItems(query, { column: 4 }); query.version++;
  assert.deepEqual((await pending).suggestions, []);
  assert.equal(loads, 1);
  assert.ok((await provider.provideCompletionItems(query, { column: 4 })).suggestions.some(item => item.label === 'SELECT'));
  assert.equal(loads, 1, 'reuse the parser module');
  registration.dispose();
  assert.deepEqual((await provider.provideCompletionItems(query, { column: 4 })).suggestions, []);
});
