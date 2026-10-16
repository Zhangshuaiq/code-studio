const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JavaSyntaxIndex } = require('@codegen/code-intelligence/java-syntax-index.cjs');
const { javaDeclarations, xmlDeclarations, relate, relatedLocations, closeRelations, invalidateRelations } = require('@codegen/code-intelligence/workspace-relations.cjs');
test('worker shares a reverse graph across files and isolates overlays, disk changes, rename and deletion', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relation-graph-'));
  t.after(async () => { await closeRelations(); await fs.rm(root, { recursive: true, force: true }); });
  const api = 'package p; interface Api { void run(); }';
  const impl = 'package p; class Impl implements Api { public void run(){} }';
  await fs.writeFile(path.join(root, 'Api.java'), api);
  await fs.writeFile(path.join(root, 'Impl.java'), impl);
  const query = (file, content, documents) => relatedLocations(root, { path: file, content, documents });
  assert.equal((await query('Api.java', api)).validation.graphBuilds, 1);
  assert.equal((await query('Impl.java', impl)).validation.graphBuilds, 1);
  assert.equal((await query('Impl.java', impl.replace('{}', '{ int x = 1; }'))).validation.graphBuilds, 1);
  const detached = impl.replace('implements Api', '');
  const overlay = [{ path: 'Impl.java', content: detached }];
  const hidden = await query('Api.java', api, overlay);
  assert.deepEqual(hidden.rows, []); assert.equal(hidden.validation.graphBuilds, 2);
  assert.equal((await query('Impl.java', detached)).validation.graphBuilds, 2);
  assert.equal((await query('Api.java', api)).rows[0].links[0].path, 'Impl.java');
  await fs.rename(path.join(root, 'Impl.java'), path.join(root, 'Renamed.java'));
  invalidateRelations(root);
  const renamed = await query('Api.java', api);
  assert.equal(renamed.validation.graphBuilds, 3);
  assert.equal(renamed.rows[0].links[0].path, 'Renamed.java');
  await fs.writeFile(path.join(root, 'Renamed.java'), detached);
  invalidateRelations(root);
  assert.deepEqual((await query('Api.java', api)).rows, []);
  await fs.unlink(path.join(root, 'Renamed.java'));
  invalidateRelations(root);
  const deleted = await query('Api.java', api);
  assert.deepEqual(deleted.rows, []); assert.equal(deleted.validation.graphBuilds, 5);
});
test('project declaration query isolates same-line overloads and rejects non-declaration positions', async () => {
  const syntax = await JavaSyntaxIndex.create();
  try {
    const sources = {
      'Api.java': 'package p; interface Api { void get(String s); void get(int n); }',
      'Impl.java': 'package p; class Impl implements Api { public void get(String s){} public void get(int n){} }',
    };
    const files = new Map(Object.entries(sources).map(([file, content]) => [file, { java: javaDeclarations(syntax, content, file) }]));
    const methods = files.get('Api.java').java[0].methods;
    for (let i = 0; i < methods.length; i++) {
      const rows = relate(files, 'Api.java', { line: 1, column: methods[i].column + 1 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].links.length, 1);
      assert.equal(rows[0].links[0].column, files.get('Impl.java').java[0].methods[i].column);
    }
    assert.deepEqual(relate(files, 'Api.java', { line: 1, column: 1 }), []);
    assert.deepEqual(relate(files, 'Impl.java', { line: 1, column: files.get('Impl.java').java[0].methods[0].column }), []);
    await assert.rejects(relatedLocations('/unused', { path: 'Api.java', line: 1 }), /位置无效/);
  } finally { syntax.close(); }
});
test('native declaration traversal retains member and method-local Java types', async () => {
  const syntax = await JavaSyntaxIndex.create();
  try {
    const types = javaDeclarations(syntax, 'package p; class Outer { class Member {} void run() { class Local {} } }', 'Outer.java');
    assert.deepEqual(types.map(type => type.fullName).sort(), ['p.Outer', 'p.Outer.Local', 'p.Outer.Member']);
  } finally { syntax.close(); }
});
test('type and overloaded method arrows are bidirectional and private/static are excluded', async () => {
  const syntax = await JavaSyntaxIndex.create();
  try {
    const files = new Map([
      ['Api.java', { java: javaDeclarations(syntax, 'package p; public interface Api { void get(String id); void get(int id); }', 'Api.java') }],
      ['Impl.java', { java: javaDeclarations(syntax, 'package p; class Impl implements Api { public void get(String id){} public void get(int id){} private void hidden(){} }', 'Impl.java') }],
    ]);
    const api = relate(files, 'Api.java');
    assert.equal(api.flatMap(r => r.links).length, 3);
    assert.ok(api.flatMap(r => r.links).every(l => l.path === 'Impl.java' && l.direction === 'down'));
    assert.ok(relate(files, 'Impl.java').flatMap(r => r.links).every(l => l.path === 'Api.java' && l.direction === 'up'));
    const other = javaDeclarations(syntax, 'package p; class Other { private void hidden(){} static void get(int id){} }', 'Other.java')[0];
    assert.equal(other.methods.filter(m => m.inheritable).length, 0);
  } finally { syntax.close(); }
});
test('explicit and wildcard DTO imports match NavigationAdminService.query in both directions', async () => {
  const syntax = await JavaSyntaxIndex.create();
  try {
    const sources = {
      'NavigationAdminService.java': 'package service; import dto.navigation.NavigationQueryFilterDto; public interface NavigationAdminService { void query(NavigationQueryFilterDto filter); }',
      'NavigationAdminServiceImpl.java': 'package service.impl; import service.NavigationAdminService; import dto.navigation.*; public class NavigationAdminServiceImpl implements NavigationAdminService { public void query(NavigationQueryFilterDto filter) {} }',
    };
    const files = new Map(Object.entries(sources).map(([file, source]) => [file, {java:javaDeclarations(syntax, source, file)}]));
    assert.ok(relate(files, 'NavigationAdminService.java').flatMap(row=>row.links).some(link=>link.label === 'service.impl.NavigationAdminServiceImpl.query' && link.direction === 'down'));
    assert.ok(relate(files, 'NavigationAdminServiceImpl.java').flatMap(row=>row.links).some(link=>link.label === 'service.NavigationAdminService.query' && link.direction === 'up'));
    files.set('Dto.java', {java:javaDeclarations(syntax, 'package dto.navigation; public class NavigationQueryFilterDto {}', 'Dto.java')});
    files.get('NavigationAdminServiceImpl.java').java[0].imports.push('other.*');
    assert.ok(relate(files, 'NavigationAdminService.java').flatMap(row=>row.links).some(link=>link.label.endsWith('.query')));
  } finally { syntax.close(); }
});
test('nested parent types and annotated or postfix array parameters keep method arrows', async () => {
  const syntax = await JavaSyntaxIndex.create();
  try {
    const files = new Map([
      ['Outer.java', {java:javaDeclarations(syntax, 'package p; class Outer { interface Api { void accept(String[] values); } class Impl implements Api { public void accept(@NotNull String values[]) {} } }', 'Outer.java')}],
    ]);
    const links = relate(files, 'Outer.java').flatMap(row => row.links);
    assert.ok(links.some(link => link.label === 'p.Outer.Api.accept'), JSON.stringify(links));
    assert.ok(links.some(link => link.label === 'p.Outer.Impl.accept'), JSON.stringify(links));
  } finally { syntax.close(); }
});
test('MyBatis namespace and id link only matching Java mapper, ignoring XML comments and CDATA', async () => {
  const syntax = await JavaSyntaxIndex.create();
  try {
    const xml = xmlDeclarations(`<?xml version="1.0"?><mapper namespace="a.UserMapper">
      <!-- <select id="fake">ignored</select> -->
      <select id="get">SELECT <![CDATA[ <select id="fake2"> ]]> 1</select>
      <sql id="get">fragment is not a mapped method</sql></mapper>`, 'UserMapper.xml');
    assert.equal(xml.length, 1); assert.equal(xml[0].name, 'get'); assert.equal(xml[0].line, 3);
    const files = new Map([
      ['UserMapper.java', { java: javaDeclarations(syntax, 'package a; interface UserMapper { String get(); }', 'UserMapper.java') }],
      ['Wrong.java', { java: javaDeclarations(syntax, 'package b; interface UserMapper { String get(); }', 'Wrong.java') }],
      ['UserMapper.xml', { xml }],
    ]);
    assert.equal(relate(files, 'UserMapper.java')[0].links[0].path, 'UserMapper.xml');
    assert.equal(relate(files, 'UserMapper.xml')[0].links[0].path, 'UserMapper.java');
    assert.deepEqual(relate(files, 'Wrong.java'), []);
  } finally { syntax.close(); }
});
test('generic, inherited, wildcard-imported and varargs interface methods retain their arrows', async () => {
  const syntax = await JavaSyntaxIndex.create();
  try {
    const sources = {
      'Api.java': 'package api; import java.util.List; public interface Api<T> { void save(T value); void list(List<? extends T> items); void args(String... names); <M> void generic(M value); }',
      'Base.java': 'package impl; public class Base<X> { public void save(X value) {} }',
      'Impl.java': 'package impl; import api.Api; import java.util.*; public class Impl extends Base<String> implements Api<String> { public void list(List<? extends String> items){} public void args(String[] names){} public <N> void generic(N value){} }',
    };
    const files = new Map(Object.entries(sources).map(([file, source]) => [file, { java: javaDeclarations(syntax, source, file) }]));
    const api = files.get('Api.java').java[0]; assert.deepEqual(api.typeParameters, ['T']);
    assert.deepEqual(api.methods.find(m => m.name === 'generic').typeParameters, ['M']);
    const links = relate(files, 'Api.java').flatMap(row => row.links);
    for (const name of ['save', 'list', 'args', 'generic']) assert.ok(links.some(link => link.label.endsWith('.' + name)), `missing ${name}`);
    assert.ok(links.some(link => link.path === 'Base.java' && link.label.endsWith('.save')));
  } finally { syntax.close(); }
});
test('worker uses unsaved Java/XML overlays and rejects traversal without starting LSP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-relations-test-'));
  try {
    await fs.writeFile(path.join(root, 'Mapper.java'), 'package p; interface Mapper { void get(); }');
    await fs.writeFile(path.join(root, 'Mapper.xml'), '<mapper namespace="p.Mapper"><select id="get">select 1</select></mapper>');
    const first = await relatedLocations(root, { path: 'Mapper.java' });
    assert.equal(first.rows[0].links[0].path, 'Mapper.xml');
    const changed = await relatedLocations(root, { path: 'Mapper.java', documents: [{ path: 'Mapper.xml', content: '<mapper namespace="p.Mapper"><select id="other">select 1</select></mapper>' }] });
    assert.deepEqual(changed.rows, []);
    assert.equal((await relatedLocations(root, { path: 'Mapper.java' })).rows[0].links[0].path, 'Mapper.xml');
    await assert.rejects(relatedLocations(root, { path: '../outside.java' }), /无效/);
    await assert.rejects(relatedLocations(root, { path: 'Mapper.java', documents: [{ path: '/outside.xml', content: '' }] }), /无效/);
    await assert.rejects(relatedLocations(root, { path: 'Mapper.java', documents: {} }), /无效/);
    await fs.writeFile(path.join(root, 'Mapper.xml'), '<mapper namespace="p.Mapper"><select id="changed">select 1</select></mapper>');
    invalidateRelations(root);
    assert.deepEqual((await relatedLocations(root, { path: 'Mapper.java' })).rows, []);
  } finally { await closeRelations(); await fs.rm(root, { recursive: true, force: true }); }
});
test('switching among three projects evicts an idle worker instead of losing relation markers', async () => {
  const roots = [];
  try {
    for (let i = 0; i < 3; i++) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relations-project-switch-')); roots.push(root);
      await fs.writeFile(path.join(root, 'Api.java'), 'interface Api {}');
      await fs.writeFile(path.join(root, 'Impl.java'), 'class Impl implements Api {}');
      assert.equal((await relatedLocations(root, { path: 'Api.java' })).rows[0].links[0].path, 'Impl.java');
    }
    assert.equal((await relatedLocations(roots[0], { path: 'Api.java' })).rows[0].links[0].path, 'Impl.java');
  } finally { await closeRelations(); await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))); }
});
test('persisted declarations are validated, incremental, corruption tolerant, and never contain unsaved buffers', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relations-cache-test-'));
  const root = path.join(directory, 'project'), cacheDirectory = path.join(directory, 'cache');
  const options = { cacheDirectory };
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'Api.java'), 'interface Api {\n void run();\n }');
    await fs.writeFile(path.join(root, 'Impl.java'), 'class Impl implements Api { public void run() {} }');
    const content = 'interface Api { void unsavedSecret(); }';
    const first = await relatedLocations(root, { path: 'Api.java', content }, options);
    assert.equal(first.validation.parsedFiles, 2);
    const filename = path.join(cacheDirectory, (await fs.readdir(cacheDirectory))[0]);
    assert.ok(!(await fs.readFile(filename, 'utf8')).includes('unsavedSecret'));
    await closeRelations();
    const warm = await relatedLocations(root, { path: 'Api.java' }, options);
    assert.equal(warm.validation.parsedFiles, 0); assert.equal(warm.validation.reusedFiles, 2);
    assert.equal(warm.rows.length, 2);
    // Repeated overlays must remain isolated from both disk and other content versions.
    assert.equal((await relatedLocations(root, { path: 'Api.java', content }, options)).rows.length, 1);
    assert.equal((await relatedLocations(root, { path: 'Api.java', content }, options)).rows.length, 1);
    assert.equal((await relatedLocations(root, { path: 'Api.java' }, options)).rows.length, 2);
    await fs.writeFile(path.join(root, 'Impl.java'), 'class Impl {}');
    invalidateRelations(root);
    const changed = await relatedLocations(root, { path: 'Api.java' }, options);
    assert.equal(changed.validation.parsedFiles, 1); assert.equal(changed.rows.length, 0);
    await closeRelations();
    await fs.writeFile(filename, '{invalid');
    assert.equal((await relatedLocations(root, { path: 'Api.java' }, options)).validation.parsedFiles, 2);
    await closeRelations();
    await fs.unlink(path.join(root, 'Impl.java'));
    const removed = await relatedLocations(root, { path: 'Api.java' }, options);
    assert.equal(removed.validation.reusedFiles, 1); assert.equal(removed.rows.length, 0);
  } finally { await closeRelations(); await fs.rm(directory, { recursive: true, force: true }); }
});
