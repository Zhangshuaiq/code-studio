const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const ExcelJS = require('exceljs');
const { FilesService } = require('../dist/files/files.service.js');
const { encodeText } = require('@codegen/code-intelligence/file-text.cjs');
const { ForbiddenException, Module } = require('@nestjs/common');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-file-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '图片.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await fs.writeFile(path.join(root, 'manual.pdf'), '%PDF-1.4\n');
  await fs.writeFile(path.join(root, 'rows.csv'), '名称,数量\n苹果,3\n');
  await fs.writeFile(path.join(root, 'Main.java'), 'class Main {}');
  for (const name of ['settings.json', 'pom.xml', 'migration.sql', 'run.sh', 'README.md', '.env', '.gitignore', 'Dockerfile', 'custom.unknown']) await fs.writeFile(path.join(root, name), 'mixed project text');
  await fs.writeFile(path.join(root, 'unknown.bin'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, 'old.xls'), 'not supported');
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('数据').addRows([['名称', '数量'], ['苹果', 3]]); workbook.addWorksheet('Other').addRow(['second']);
  await workbook.xlsx.writeFile(path.join(root, 'report.xlsx'));
  const access = { requireSession: async (user, session) => { if (user !== 'owner' || session !== 'session') throw new ForbiddenException(); return { project: { name: 'fixture' } }; } };
  const workspaces = { ensureForSession: async () => ({ path: root }), withSessionLock: async (_u, _s, fn) => fn() };
  const service = new FilesService(access, workspaces, { get: (_key, fallback) => fallback });
  return { root, service, access, workspaces };
}
test('web file metadata separates text, images, PDF, spreadsheets and unsupported binaries', async t => {
  const { service } = await fixture(t);
  for (const [name, kind] of [['图片.png', 'image'], ['manual.pdf', 'pdf'], ['report.xlsx', 'spreadsheet'], ['rows.csv', 'spreadsheet'], ['unknown.bin', 'unsupported'], ['old.xls', 'unsupported']]) {
    const file = await service.read('owner', 'session', name);
    assert.equal(file.kind, kind); assert.equal(file.readOnly, true); assert.equal(file.content, '');
  }
  const text = await service.read('owner', 'session', 'Main.java');
  assert.equal(text.kind, 'text'); assert.equal(text.content, 'class Main {}'); assert.match(text.version, /^[a-f0-9]{64}$/);
  assert.deepEqual((await service.spreadsheet('owner', 'session', 'report.xlsx')).sheets.map(sheet => sheet.name), ['数据', 'Other']);
  assert.deepEqual((await service.spreadsheet('owner', 'session', 'rows.csv')).sheets[0].rows, [['名称', '数量'], ['苹果', '3']]);
  assert.equal((await service.preview('owner', 'session', '图片.png')).content[0], 137);
});
test('mixed Java project includes text/config files and returns their shared editor languages', async t => {
  const { service } = await fixture(t);
  const listed = await service.list('owner', 'session');
  for (const [name, language] of [['settings.json', 'json'], ['pom.xml', 'xml'], ['migration.sql', 'sql'], ['run.sh', 'shell'], ['README.md', 'markdown'], ['.env', 'ini'], ['.gitignore', 'plaintext'], ['Dockerfile', 'dockerfile'], ['custom.unknown', 'plaintext']]) {
    assert.ok(listed.includes(name), name); const file = await service.read('owner', 'session', name);
    assert.equal(file.kind, 'text'); assert.equal(file.language, language); assert.equal(file.content, 'mixed project text');
  }
});
test('web text reads/saves preserve BOM, UTF-16 byte order and raw-byte version conflicts', async t => {
  const { service, root } = await fixture(t);
  for (const [name, format] of [['bom.md', { encoding: 'utf-8', bom: true }], ['little.sql', { encoding: 'utf-16le', bom: true }], ['big.xml', { encoding: 'utf-16be', bom: true }], ['empty.sql', { encoding: 'utf-16le', bom: true }]]) {
    await fs.writeFile(path.join(root, name), encodeText(name === 'empty.sql' ? '' : '原文 😀\r\n', format));
    const before = await service.read('owner', 'session', name); assert.equal(before.encoding, format.encoding); assert.equal(before.bom, true);
    const result = await service.write('owner', 'session', name, '修改 😀\r\n', before.version); const bytes = await fs.readFile(path.join(root, name)); assert.deepEqual(bytes, encodeText('修改 😀\r\n', format)); assert.equal(result.bytes, bytes.length);
    const after = await service.read('owner', 'session', name); assert.equal(after.content, '修改 😀\r\n');
    await fs.writeFile(path.join(root, name), encodeText('修改 😀\r\n'));
    await assert.rejects(service.write('owner', 'session', name, 'do not write', after.version), error => error.getStatus() === 409);
  }
});
test('web mixed files support compound suffixes, wrappers, unknown text and protect unknown binaries', async t => {
  const { service, root } = await fixture(t);
  for (const [name, language, content] of [['schema.svg.xml', 'xml', '<schema/>'], ['mvnw', 'shell', '#!/bin/sh\necho build'], ['Guide.MDWN', 'markdown', '# Guide'], ['empty.custom', 'plaintext', ''], ['notes.custom', 'plaintext', '中文\r\n']]) {
    await fs.writeFile(path.join(root, name), content);
    const file = await service.read('owner', 'session', name);
    assert.equal(file.kind, 'text', name); assert.equal(file.language, language, name); assert.equal(file.content, content);
    if (language === 'markdown') assert.equal(file.preview, 'markdown');
    await service.write('owner', 'session', name, content + '\nchanged', file.version);
    assert.equal((await service.read('owner', 'session', name)).content, content + '\nchanged');
  }
  const bytes = Buffer.from([65, 1, 66]); await fs.writeFile(path.join(root, 'opaque.custom'), bytes);
  assert.equal((await service.read('owner', 'session', 'opaque.custom')).kind, 'unsupported');
  await assert.rejects(service.write('owner', 'session', 'opaque.custom', 'overwrite'), error => error.getResponse().code === 'FILE_READ_ONLY');
  assert.deepEqual(await fs.readFile(path.join(root, 'opaque.custom')), bytes);
});
test('preview enforces project authorization, path boundaries, regular files, type and size limits', async t => {
  const { service, root } = await fixture(t);
  for (const operation of ['read', 'preview', 'spreadsheet']) {
    await assert.rejects(service[operation]('outsider', 'session', '图片.png'), error => error.getStatus() === 403);
    await assert.rejects(service[operation]('owner', 'other-session', '图片.png'), error => error.getStatus() === 403);
    await assert.rejects(service[operation]('owner', 'session', '../secret.png'));
  }
  await fs.symlink(path.join(root, '图片.png'), path.join(root, 'link.png'));
  await assert.rejects(service.preview('owner', 'session', 'link.png'));
  await assert.rejects(service.preview('owner', 'session', 'Main.java'), error => error.getStatus() === 400);
  await assert.rejects(service.spreadsheet('owner', 'session', 'old.xls'), error => error.getStatus() === 400);
  await fs.mkdir(path.join(root, 'directory.png'));
  await assert.rejects(service.preview('owner', 'session', 'directory.png'), error => error.getStatus() === 400);
  const file = await fs.open(path.join(root, 'huge.png'), 'w'); await file.truncate(100 * 1024 * 1024 + 1); await file.close();
  await assert.rejects(service.preview('owner', 'session', 'huge.png'), error => error.getResponse().code === 'FILE_VIEW_TOO_LARGE');
  const sheet = await fs.open(path.join(root, 'huge.xlsx'), 'w'); await sheet.truncate(20 * 1024 * 1024 + 1); await sheet.close();
  await assert.rejects(service.spreadsheet('owner', 'session', 'huge.xlsx'), error => error.getResponse().code === 'FILE_VIEW_TOO_LARGE');
  await fs.writeFile(path.join(root, 'broken.xlsx'), 'invalid zip');
  await assert.rejects(service.spreadsheet('owner', 'session', 'broken.xlsx'), error => error.getResponse().code === 'FILE_SPREADSHEET_INVALID');
});
test('preview-only files cannot be overwritten by the text save API', async t => {
  const { service, root } = await fixture(t);
  for (const name of ['图片.png', 'manual.pdf', 'report.xlsx', 'rows.csv', 'unknown.bin']) {
    const before = await fs.readFile(path.join(root, name));
    await assert.rejects(service.write('owner', 'session', name, 'destroyed'), error => error.getResponse().code === 'FILE_READ_ONLY');
    assert.deepEqual(await fs.readFile(path.join(root, name)), before);
  }
});
test('large binary metadata remains readable and bounded table previews report clipping', async t => {
  const { root, service } = await fixture(t);
  await fs.writeFile(path.join(root, 'larger.png'), Buffer.alloc(700 * 1024));
  const metadata = await service.read('owner', 'session', 'larger.png');
  assert.equal(metadata.kind, 'image'); assert.equal(metadata.content, ''); assert.equal(metadata.size, 700 * 1024);
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([0, 1]));
  assert.equal((await service.read('owner', 'session', 'binary.txt')).kind, 'unsupported');
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Big');
  sheet.addRow(['x'.repeat(10001)]); sheet.addRow(Array(101).fill('value'));
  for (let row = 3; row <= 501; row++) sheet.addRow([row]);
  await workbook.xlsx.writeFile(path.join(root, 'big.xlsx'));
  const result = await service.spreadsheet('owner', 'session', 'big.xlsx');
  assert.equal(result.truncated, true); assert.equal(result.sheets[0].rows.length, 500);
  assert.equal(result.sheets[0].rows[0][0].length, 10000); assert.equal(result.sheets[0].rows[1].length, 100);
});
test('real preview REST endpoints require JWT/read permission and preserve binary response headers', async t => {
  const { service, workspaces, access } = await fixture(t);
  const { NestFactory } = require('@nestjs/core');
  const { JwtService } = require('@nestjs/jwt');
  const { PassportStrategy } = require('@nestjs/passport');
  const { Strategy, ExtractJwt } = require('passport-jwt');
  const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard.js');
  const { PermissionsGuard } = require('../dist/auth/permissions.guard.js');
  const { FilesController } = require('../dist/files/files.controller.js');
  const { WorkspaceService } = require('../dist/workspace/workspace.service.js');
  const { ProjectAccessService } = require('../dist/project-access/project-access.service.js');
  const { DistributedWorkspaceLockService } = require('../dist/workspace/distributed-workspace-lock.service.js');
  const jwt = new JwtService({ secret: 'preview-fixture-only' });
  class FixtureStrategy extends PassportStrategy(Strategy) {
    constructor() { super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: 'preview-fixture-only' }); }
    validate(claims) { return { id: claims.sub, permissions: claims.permissions }; }
  }
  class FixtureModule {}
  Module({ controllers: [FilesController], providers: [JwtAuthGuard, PermissionsGuard, FixtureStrategy, { provide: FilesService, useValue: service }, { provide: WorkspaceService, useValue: workspaces }, { provide: ProjectAccessService, useValue: access }, { provide: DistributedWorkspaceLockService, useValue: { runExclusive: (_key, fn) => fn() } }] })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false }); await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const origin = await app.getUrl();
  const request = (endpoint, file, user = 'owner', permissions = ['project:read']) => fetch(`${origin}/sessions/session/files/${endpoint}?path=${encodeURIComponent(file)}`, { headers: user ? { Authorization: `Bearer ${jwt.sign({ sub: user, permissions })}` } : {} });
  for (const endpoint of ['content', 'preview', 'spreadsheet']) {
    assert.equal((await request(endpoint, '图片.png', '')).status, 401);
    assert.equal((await request(endpoint, '图片.png', 'owner', [])).status, 403);
    assert.equal((await request(endpoint, '图片.png', 'outsider')).status, 403);
  }
  const response = await request('preview', '图片.png'); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await response.arrayBuffer())[0], 137);
  assert.equal((await request('preview', 'manual.pdf')).headers.get('content-type'), 'application/pdf');
  assert.equal((await request('spreadsheet', 'report.xlsx')).status, 200);
});
