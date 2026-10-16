const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { WorkspaceLanguageService } = require('../dist/lsp/workspace-language.service.js');

function fixture(t, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-language-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-language-data-'));
  let branch = 'main'; let revoked = false;
  const access = { requireSession: async (user, session, permission) => {
    const { ForbiddenException } = require('@nestjs/common');
    if (revoked || !['owner', 'viewer'].includes(user) || !['session', 'session-two'].includes(session) || (permission === 'edit' && user === 'viewer')) throw new ForbiddenException('无项目权限');
    return { projectId: 'project' };
  } };
  const settings = {
    LSP_ENABLED: enabled ? 'true' : 'false', LSP_DATA_ROOT: dataRoot, FAST_INDEX_ROOT: path.join(dataRoot, 'fast-index'), RELATIONS_INDEX_ROOT: path.join(dataRoot, 'relations-index'),
    CODE_STUDIO_JDTLS_HOME: path.resolve(__dirname, '../../desktop/.cache/jdtls/1.61.0'),
    CODE_STUDIO_JAVA_TOOLS_ROOT: path.resolve(__dirname, '../../desktop/.cache/java-tools'),
  };
  const recreate = () => new WorkspaceLanguageService({ get: (key, fallback) => settings[key] ?? fallback }, access, { ensureForSession: async () => ({ path: root, branch }) });
  const service = recreate();
  t.after(async () => { await service.onModuleDestroy(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  return { service, root, recreate, switchBranch: () => { branch = 'changed'; }, revoke: () => { revoked = true; } };
}

test('web static file relations work without LSP and enforce project read permissions', async t => {
  const { service, root } = fixture(t, false);
  fs.writeFileSync(path.join(root, 'Mapper.java'), 'package p; interface Mapper { void get(); }');
  fs.writeFileSync(path.join(root, 'Mapper.xml'), '<mapper namespace="p.Mapper"><select id="get">select 1</select></mapper>');
  await assert.rejects(service.execute('outsider', 'session', 'related-locations', { path: 'Mapper.java' }), error => error.getStatus() === 403);
  const result = await service.execute('viewer', 'session', 'related-locations', { path: 'Mapper.java' });
  assert.equal(result.result.rows[0].links[0].path, 'Mapper.xml');
  assert.equal(service.manager.sessions.size, 0);
});
test('web fast-index progress bypasses a blocked fast query without skipping authorization', async t => {
  const { service } = fixture(t, false);
  let release, started;
  const beginning = new Promise(resolve => { started = resolve; });
  service.fastIndex.search = async () => { started(); await new Promise(resolve => { release = resolve; }); return { items: [] }; };
  service.fastIndex.status = async () => ({ state: 'indexing', complete: false });
  const blocked = service.execute('owner', 'session', 'fast-symbols', { query: 'Service' });
  await beginning;
  let timer;
  try {
    const status = await Promise.race([service.execute('owner', 'session', 'index-status'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('progress blocked')), 500); })]);
    assert.equal(status.index.state, 'indexing');
    await assert.rejects(service.execute('outsider', 'session', 'index-status'), error => error.getStatus() === 403);
  } finally { clearTimeout(timer); release(); await blocked; }
});
test('web project implementation query uses positioned overlays without starting JDT', async t => {
  const { service, root } = fixture(t, false);
  const content = 'package p; interface Api { void run(); }';
  fs.writeFileSync(path.join(root, 'Api.java'), content);
  const input = { path: 'Api.java', content, line: 1, column: content.indexOf('run') + 1,
    documents: [{ path: 'Impl.java', content: 'package p; class Impl implements Api { public void run(){} }' }] };
  await assert.rejects(service.execute('outsider', 'session', 'related-locations', input), error => error.getStatus() === 403);
  const body = await service.execute('viewer', 'session', 'related-locations', input);
  assert.equal(body.result.rows[0].links[0].path, 'Impl.java');
  assert.equal(body.result.scope, 'project');
  assert.equal(body.result.semanticComplete, false);
  assert.equal(service.manager.sessions.size, 0);
  const diskOnly = await service.execute('viewer', 'session', 'related-locations', { ...input, documents: [] });
  assert.deepEqual(diskOnly.result.rows, []);
});

test('web fast-index recovers its owned corrupt cache on restart and keeps authorization and source intact', async t => {
  const { service, root, recreate } = fixture(t, false);
  const source = 'class RecoveryService {}';
  fs.writeFileSync(path.join(root, 'A.java'), source);
  await service.execute('owner', 'session', 'index-status');
  const entry = [...service.fastIndex.entries.values()][0];
  await entry.client.refresh();
  assert.equal((await service.execute('owner', 'session', 'fast-symbols', { query: 'Recovery' })).items.length, 1);
  await service.onModuleDestroy();
  const database = path.join(service.fastIndex.directory, entry.key + '.sqlite3');
  fs.writeFileSync(database, 'corrupt owned web index');
  const restarted = recreate(); t.after(() => restarted.onModuleDestroy());
  await assert.rejects(restarted.execute('outsider', 'session', 'index-status'), error => error.getStatus() === 403);
  assert.equal(restarted.fastIndex.entries.size, 0, 'unauthorized requests must not open or rebuild a cache');
  const status = await restarted.execute('owner', 'session', 'index-status');
  assert.equal(status.index.cacheRecovery.reason, 'sqlite-corruption');
  assert.ok(!JSON.stringify(status).includes(root));
  await [...restarted.fastIndex.entries.values()][0].client.refresh();
  const restored = await restarted.execute('owner', 'session', 'fast-symbols', { query: 'Recovery' });
  assert.equal(restored.index.complete, true);
  assert.equal(restored.items[0].path, 'A.java');
  assert.equal(fs.readFileSync(path.join(root, 'A.java'), 'utf8'), source);
  assert.equal(fs.readdirSync(service.fastIndex.directory).filter(name => name.includes('.corrupt-')).length, 1);
});

test('web status remains readable during initialization and language cache root survives service recreation', async t => {
  const { service, root } = fixture(t);
  assert.equal(path.basename(service.manager.dataRoot).startsWith('web-language-data-'), true, 'cache root must not include a PID');
  const config = { get: (key, fallback) => ({ LSP_ENABLED: 'true', LSP_DATA_ROOT: service.manager.dataRoot, FAST_INDEX_ROOT: path.join(service.manager.dataRoot, 'fast-index') })[key] ?? fallback };
  const recreated = new WorkspaceLanguageService(config, {}, {});
  t.after(() => recreated.onModuleDestroy());
  assert.equal(recreated.manager.dataRoot, service.manager.dataRoot);
  let release, begin;
  const started = new Promise(resolve => { begin = resolve; });
  service.manager.prepareProject = async () => { begin(); await new Promise(resolve => { release = resolve; }); return { providers: [] }; };
  service.manager.projectStatus = () => ({ providers: [{ provider: 'java', phase: 'importing', message: '正在加载项目与缓存索引', elapsedMs: 45000, projectId: 'private-id' }] });
  const preparing = service.execute('owner', 'session', 'prepare');
  await started;
  try {
    const status = await Promise.race([service.execute('owner', 'session', 'status'), new Promise((_, reject) => setTimeout(() => reject(new Error('status queued behind initialization')), 500))]);
    assert.equal(status.providers[0].elapsedMs, 45000); assert.equal(status.providers[0].projectId, undefined);
    await assert.rejects(service.execute('outsider', 'session', 'status'), error => error.getStatus() === 403);
    assert.ok(!JSON.stringify(status).includes(root));
  } finally { release(); await preparing; }
});

test('web fast index covers more than 500 Java files without starting JDT and isolates cache identities', async t => {
  const { service, root } = fixture(t, false);
  for (let i = 0; i < 505; i++) fs.writeFileSync(path.join(root, `A${i}.java`), `class IndexedService${i} { void run() {} }`);
  await assert.rejects(service.execute('outsider', 'session', 'fast-symbols', { query: 'Service504' }), e => e.getStatus() === 403);
  await service.execute('owner', 'session', 'index-status');
  const scoped = [...service.fastIndex.entries.values()][0]; await scoped.client.refresh();
  const result = await service.execute('owner', 'session', 'fast-symbols', { query: 'Service504' });
  assert.equal(result.sourceFiles, 505); assert.equal(result.index.complete, true);
  assert.equal(result.items[0].path, 'A504.java'); assert.equal(result.items[0].semantic, false);
  assert.equal(result.overlayApplied, false); assert.equal(service.manager.sessions.size, 0);
  assert.equal((await service.execute('owner', 'session', 'fast-document-symbols', { path: 'A504.java' })).items.length, 2);
  assert.ok(!JSON.stringify(result).includes(root));
  for (const path of ['../A0.java', '/etc/passwd', 'C:\\secret.java']) await assert.rejects(service.execute('owner', 'session', 'fast-document-symbols', { path }), e => e.getStatus() === 400);
  await assert.rejects(service.execute('owner', 'session', 'fast-symbols', { query: '' }), e => e.getStatus() === 400);
  await service.execute('viewer', 'session', 'index-status');
  assert.equal(service.fastIndex.entries.size, 2);
  const { FilesService } = require('../dist/files/files.service.js');
  const files = new FilesService({ requireSession: async () => ({ project: { name: 'fixture' } }) }, { ensureForSession: async () => ({ path: root }) }, { get: (_key, fallback) => fallback }, service);
  await files.write('owner', 'session', 'A504.java', 'class SavedService504 {}');
  await service.fastIndex.tail;
  const changed = await service.execute('owner', 'session', 'index-status');
  assert.equal(changed.index.complete, false, 'saved files must invalidate cached completeness immediately');
  const deadline = Date.now() + 5000;
  let complete = false;
  while (Date.now() < deadline) {
    const statuses = await Promise.all(['owner', 'viewer'].map(user => service.execute(user, 'session', 'index-status')));
    if (statuses.every(status => status.index.complete)) { complete = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(complete, true, 'debounced save notifications must update every active identity without a forced scan');
  assert.equal((await service.execute('owner', 'session', 'fast-symbols', { query: 'SavedService504' })).items.length, 1);
  assert.equal((await service.execute('viewer', 'session', 'fast-symbols', { query: 'SavedService504' })).items.length, 1);
});

test('web fast-index results recheck authorization and branch after an in-flight query', async t => {
  for (const action of ['revoke', 'switchBranch']) {
    const f = fixture(t, false); let release; let started;
    const begun = new Promise(resolve => { started = resolve; });
    f.service.fastIndex.search = async () => { started(); await new Promise(resolve => { release = resolve; }); return { items: [] }; };
    const pending = f.service.execute('owner', 'session', 'fast-symbols', { query: 'Service' });
    await begun; f[action](); release();
    await assert.rejects(pending, e => e.getStatus() === (action === 'revoke' ? 403 : 409));
  }
});

test('web fast-index overlays reflect unsaved code but remain isolated from another user and disk cache', async t => {
  const { service, root } = fixture(t, false);
  fs.writeFileSync(path.join(root, 'Draft.java'), 'class DiskService {}');
  await service.execute('owner', 'session', 'index-status');
  await [...service.fastIndex.entries.values()][0].client.refresh();
  const documents = [{ path: 'Draft.java', content: '\n\nclass UnsavedService { void draftMethod() {} }' }];
  const draft = await service.execute('owner', 'session', 'fast-symbols', { query: 'Service', documents });
  assert.deepEqual(draft.items.map(item => item.name), ['UnsavedService']); assert.equal(draft.overlayApplied, true);
  assert.equal(draft.items[0].line, 3); assert.equal(draft.items[0].hashSource, 'overlay');
  const outline = await service.execute('owner', 'session', 'fast-document-symbols', { path: 'Draft.java', content: documents[0].content });
  assert.deepEqual(outline.items.map(item => item.name), ['UnsavedService', 'draftMethod']);
  assert.equal((await service.execute('owner', 'session', 'fast-symbols', { query: 'UnsavedService' })).items.length, 0);
  assert.equal((await service.execute('owner', 'session', 'fast-symbols', { query: 'DiskService' })).items.length, 1);
  await service.execute('viewer', 'session', 'index-status');
  await Promise.all([...service.fastIndex.entries.values()].map(entry => entry.client.refresh()));
  assert.equal((await service.execute('viewer', 'session', 'fast-symbols', { query: 'UnsavedService' })).items.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'Draft.java'), 'utf8'), 'class DiskService {}');
  await assert.rejects(service.execute('owner', 'session', 'fast-symbols', { query: 'Service', documents: [{ path: '../Escape.java', content: 'class Escape {}' }] }), e => e.getStatus() === 400);
});

test('remote language API rejects unavailable, unauthorized, invalid and cross-workspace input without leaking server paths', async (t) => {
  const { service, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'main.ts'), 'const x = 1;');
  await assert.rejects(service.execute('outsider', 'session', 'prepare'), (e) => e.getStatus() === 403);
  await assert.rejects(service.execute('owner', 'foreign', 'prepare'), (e) => e.getStatus() === 403);
  await assert.rejects(service.execute('viewer', 'session', 'rename', { path: 'main.ts', line: 1, column: 7, newName: 'y' }), (e) => e.getStatus() === 403);
  for (const file of ['/etc/passwd', '../outside.ts', 'missing.ts']) {
    await assert.rejects(service.execute('owner', 'session', 'definition', { path: file, line: 1, column: 1 }), (e) => e.getStatus() === 400 && !JSON.stringify(e.getResponse()).includes(root));
  }
  await assert.rejects(service.source('owner', 'session', 'file:///etc/passwd'), (e) => e.getStatus() === 400);
  await assert.rejects(service.source('owner', 'session', '@java-source/aaaaaaaaaaaaaaaaaaaaaaaa/String.java'), (e) => e.getStatus() === 409);
  await assert.rejects(service.execute('owner', 'session', 'execute-command'), (e) => e.getStatus() === 400);
  const disabled = fixture(t, false).service;
  await assert.rejects(disabled.execute('owner', 'session', 'prepare'), (e) => e.getResponse().code === 'LSP_DISABLED');
});

test('REST controller authenticates JWT, validates DTOs and returns actual TypeScript cross-file definitions', { timeout: 40_000 }, async (t) => {
  const { service, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', moduleResolution: 'node' }, include: ['*.ts'] }));
  fs.writeFileSync(path.join(root, 'value.ts'), 'export const answer = 42;\n');
  const source = "import { answer } from './value';\nconsole.log(answer);\n";
  fs.writeFileSync(path.join(root, 'main.ts'), source);
  const { Module, ValidationPipe } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { JwtService } = require('@nestjs/jwt');
  const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard.js');
  const { PermissionsGuard } = require('../dist/auth/permissions.guard.js');
  const { WorkspaceLanguageController } = require('../dist/lsp/workspace-language.controller.js');
  const jwt = new JwtService({ secret: 'language-http-fixture-only' });
  const { PassportStrategy } = require('@nestjs/passport');
  const { Strategy, ExtractJwt } = require('passport-jwt');
  class FixtureStrategy extends PassportStrategy(Strategy) {
    constructor() { super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: 'language-http-fixture-only' }); }
    validate(claims) { return { id: claims.sub, permissions: claims.permissions }; }
  }
  class FixtureModule {}
  Module({ controllers: [WorkspaceLanguageController], providers: [PermissionsGuard, JwtAuthGuard, FixtureStrategy, { provide: WorkspaceLanguageService, useValue: service }] })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const origin = await app.getUrl();
  const token = (user, permissions = ['project:read']) => jwt.sign({ sub: user, permissions });
  const request = async (operation, body = {}, bearer = token('owner')) => fetch(`${origin}/sessions/session/language/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await request('definition', {}, '')).status, 401);
  assert.equal((await request('definition', {}, token('owner', []))).status, 403);
  assert.equal((await request('status', {}, '')).status, 401);
  assert.equal((await request('status', {}, token('outsider'))).status, 403);
  assert.equal((await request('status')).status, 201);
  assert.equal((await request('definition', { path: 'main.ts', line: '2', column: 14 })).status, 400);
  assert.equal((await request('definition', { path: 'main.ts', line: 2, column: 14, command: 'cat /etc/passwd' })).status, 400);
  const response = await request('definition', { path: 'main.ts', content: source, line: 2, column: 14 });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const definition = (await response.json()).result;
  assert.ok(definition.some((item) => item.path === 'value.ts'), JSON.stringify(definition));
  const changed = "import { renamed } from './value';\nconsole.log(renamed);\n";
  const dirtyResponse = await request('definition', { path: 'main.ts', content: changed, line: 2, column: 14, documents: [{ path: 'value.ts', content: 'export const renamed = 43;\n' }] });
  assert.ok((await dirtyResponse.json()).result.some((item) => item.path === 'value.ts'));
  assert.equal(fs.readFileSync(path.join(root, 'value.ts'), 'utf8'), 'export const answer = 42;\n');
  await service.execute('owner', 'session-two', 'definition', { path: 'main.ts', content: changed, line: 2, column: 14 });
  assert.equal(service.manager.sessions.size, 1, 'same user/project/branch reuses the language process across sessions');
  await service.execute('viewer', 'session', 'definition', { path: 'main.ts', content: source, line: 2, column: 14 });
  assert.equal(service.manager.sessions.size, 2, 'another user has isolated document state');
  fs.writeFileSync(path.join(root, 'FastService.java'), 'class FastService {}');
  assert.equal((await request('fast-symbols', { query: 'FastService' }, '')).status, 401);
  assert.equal((await request('fast-symbols', { query: 'FastService' }, token('outsider'))).status, 403);
  assert.equal((await request('fast-symbols', { query: '' })).status, 400);
  await service.execute('owner', 'session', 'index-status');
  await [...service.fastIndex.entries.values()][0].client.refresh();
  const fast = await request('fast-symbols', { query: 'FastService' });
  assert.equal(fast.status, 201); assert.equal((await fast.json()).items[0].path, 'FastService.java');
  const overlay = await request('fast-symbols', { query: 'EditedService', documents: [{ path: 'FastService.java', content: 'class EditedService {}' }] });
  assert.equal(overlay.status, 201); assert.equal((await overlay.json()).items[0].name, 'EditedService');
  assert.equal((await request('fast-symbols', { query: 'EditedService', documents: [{ path: 'FastService.java', content: 42 }] })).status, 400);
  assert.equal((await request('index-refresh', {}, '')).status, 401);
  assert.equal((await request('index-refresh', {}, token('outsider'))).status, 403);
  assert.equal((await request('index-refresh')).status, 201);
});

test('remote Java API opens project, JDK and unattached JAR sources through project-scoped readonly references', { timeout: 90_000 }, async (t) => {
  const { service, root } = fixture(t);
  const library = path.join(root, 'lib'); fs.mkdirSync(library);
  fs.writeFileSync(path.join(library, 'Dependency.java'), 'public class Dependency { public static String value() { return "jar-body"; } }');
  execFileSync('javac', ['-d', library, path.join(library, 'Dependency.java')]);
  const jar = path.join(root, 'dependency.jar'); execFileSync('jar', ['cf', jar, '-C', library, 'Dependency.class']);
  const sourceRoot = path.join(root, 'src/main/java'); fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'pom.xml'), `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>web-source</artifactId><version>1.0</version><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies><dependency><groupId>fixture</groupId><artifactId>dependency</artifactId><version>1</version><scope>system</scope><systemPath>${jar}</systemPath></dependency></dependencies></project>`);
  fs.writeFileSync(path.join(sourceRoot, 'Greeting.java'), 'public class Greeting { public static String message() { return "hello"; } }\n');
  const source = 'public class Main { static int sharedCount = 1; public static void main(String[] args) { System.out.println(Greeting.message()); System.out.println(Dependency.value()); int localCount = 1; System.out.println(args.length + sharedCount + localCount); } }\n';
  fs.writeFileSync(path.join(sourceRoot, 'Main.java'), source);
  const prepared = await service.execute('owner', 'session', 'prepare'); assert.deepEqual(prepared.providers, [{ provider: 'java', ready: true }]);
  for (const symbol of ['args', 'sharedCount', 'localCount']) {
    const definitions = (await service.execute('owner', 'session', 'definition', { path: 'src/main/java/Main.java', content: source, line: 1, column: source.lastIndexOf(symbol) + 2 })).result;
    assert.ok(definitions.some(item => item.path === 'src/main/java/Main.java' && item.range.start.character === source.indexOf(symbol)), `${symbol}: ${JSON.stringify(definitions)}`);
  }
  for (const [symbol, expected] of [['Greeting', 'src/main/java/Greeting.java'], ['String', 'class String'], ['Dependency', 'jar-body']]) {
    const definitions = (await service.execute('owner', 'session', 'definition', { path: 'src/main/java/Main.java', content: source, line: 1, column: source.indexOf(symbol) + 1 })).result;
    if (symbol === 'Greeting') { assert.ok(definitions.some((item) => item.path === expected), JSON.stringify(definitions)); continue; }
    const target = definitions.find((item) => item.path?.startsWith('@java-source/')); assert.ok(target, JSON.stringify(definitions));
    const opened = await service.source('owner', 'session', target.path); assert.equal(opened.readOnly, true); assert.ok(opened.content.includes(expected));
    assert.ok(!JSON.stringify(definitions).includes(root));
    await assert.rejects(service.source('viewer', 'session', target.path), (error) => error.getStatus() === 409);
  }
});

test('in-flight definitions are discarded after permission revocation or branch change', async (t) => {
  for (const action of ['revoke', 'switchBranch']) {
    const f = fixture(t); fs.writeFileSync(path.join(f.root, 'main.ts'), 'const answer = 42;');
    let release; let started;
    const begun = new Promise((resolve) => { started = resolve; });
    f.service.manager.request = async () => { started(); await new Promise((resolve) => { release = resolve; }); return [{ path: 'main.ts', range: {} }]; };
    const pending = f.service.execute('owner', 'session', 'definition', { path: 'main.ts', line: 1, column: 7 });
    await begun; f[action](); release();
    await assert.rejects(pending, (error) => error.getStatus() === (action === 'revoke' ? 403 : 409));
  }
});
