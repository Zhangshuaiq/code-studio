const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JavaSyntaxIndex } = require('@codegen/code-intelligence/java-syntax-index.cjs');
const { javaDeclarations, xmlDeclarations, buildRelationIndex, updateRelationIndex, queryRelationIndex, relatedLocations, closeRelations, invalidateRelations } = require('@codegen/code-intelligence/workspace-relations.cjs');
test('same-named method-local classes retain separate graph contributions', async () => {
  const syntax = await JavaSyntaxIndex.create();
  try {
    const api = 'package p; interface Api { void run(); }';
    const outer = 'package p; class Outer { void a() { class Local implements Api { public void run(){} } } void b() { class Local implements Api { public void run(){} } } }';
    const files = new Map([['Api.java', { java: javaDeclarations(syntax, api, 'Api.java') }], ['Outer.java', { java: javaDeclarations(syntax, outer, 'Outer.java') }]]);
    const graph = buildRelationIndex(files);
    const links = queryRelationIndex(graph, 'Api.java', { line: 1, column: api.indexOf('run') + 1 }).flatMap(row => row.links);
    assert.equal(links.length, 2);
    assert.notEqual(links[0].column, links[1].column);
    assert.equal(updateRelationIndex(graph, files, files).mode, 'full');
  } finally { syntax.close(); }
});
test('incremental inherited-method partitions match full rebuild across edits and conservative fallbacks', async () => {
  const syntax = await JavaSyntaxIndex.create();
  const sources = {
    'Api.java': 'package p; interface Api<T> { void run(T value); }',
    'Base.java': 'package p; class Base implements Api<String> { public void run(String value){} }',
    'Child.java': 'package p; class Child extends Base {}',
    'OtherChild.java': 'package p; class OtherChild extends Base {}',
    'Unrelated.java': 'package p; class Unrelated {}',
    'Mapper.xml': '<mapper namespace="p.Api"><select id="run">select 1</select></mapper>',
  };
  const parse = values => new Map(Object.entries(values).map(([file, content]) => [file, file.endsWith('.java') ? { java: javaDeclarations(syntax, content, file) } : { xml: xmlDeclarations(content, file) }]));
  try {
    let before = parse(sources), graph = buildRelationIndex(before);
    const check = (nextSources, mode, count) => {
      const after = parse(nextSources), updated = updateRelationIndex(graph, before, after), full = buildRelationIndex(after);
      assert.equal(updated.mode, mode);
      if (count !== undefined) assert.equal(updated.recomputedTypes, count);
      for (const file of new Set([...before.keys(), ...after.keys()])) {
        assert.deepEqual(queryRelationIndex(updated, file), queryRelationIndex(full, file), file);
        for (const type of after.get(file)?.java || []) for (const method of type.methods) assert.deepEqual(queryRelationIndex(updated, file, method), queryRelationIndex(full, file, method));
      }
      assert.equal(updated.edgeCount, full.edgeCount);
      before = after; graph = updated;
    };
    sources['Base.java'] = sources['Base.java'].replace('run(String', 'run(int');
    check(sources, 'incremental', 3);
    sources['Base.java'] = sources['Base.java'].replace('run(int', 'run(String');
    check(sources, 'incremental', 3); // Shared inherited edges survive both contributors.
    sources['Api.java'] = '\n' + sources['Api.java'];
    check(sources, 'incremental', 4); // Parent declaration positions affect descendants.
    sources['Mapper.xml'] = sources['Mapper.xml'].replace('id="run"', 'id="other"');
    check(sources, 'incremental', 0);
    sources['Base.java'] = sources['Base.java'].replace('{}', '{ int ignored = 1; }');
    check(sources, 'reused', 0);
    sources['Base.java'] = sources['Base.java'].replace('package p;', 'package p; import java.util.*;');
    check(sources, 'full');
    sources['New.java'] = 'package p; class New {}'; check(sources, 'full');
    delete sources['New.java']; check(sources, 'full');
    sources['Child.java'] = 'package p; class Child {}'; check(sources, 'full');
  } finally { syntax.close(); }
});
test('worker disk refresh and unsaved method edits use incremental graph updates without leaking overlays', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relation-incremental-'));
  t.after(async () => { await closeRelations(); await fs.rm(root, { recursive: true, force: true }); });
  const api = 'package p; interface Api { void run(); }';
  const impl = 'package p; class Impl implements Api { public void run(){} }';
  await fs.writeFile(path.join(root, 'Api.java'), api); await fs.writeFile(path.join(root, 'Impl.java'), impl);
  const query = documents => relatedLocations(root, { path: 'Api.java', content: api, documents });
  const initial = await query(); assert.equal(initial.validation.graphMode, 'full');
  const edit = impl.replace('run()', 'other()');
  const draft = await query([{ path: 'Impl.java', content: edit }]);
  assert.equal(draft.validation.graphMode, 'incremental'); assert.equal(draft.validation.recomputedTypes, 1);
  assert.ok(!draft.rows.some(row => row.links.some(link => link.label.endsWith('.run'))));
  assert.deepEqual((await query()).rows, initial.rows);
  await fs.writeFile(path.join(root, 'Impl.java'), edit); invalidateRelations(root);
  const saved = await query(); assert.equal(saved.validation.graphMode, 'incremental'); assert.deepEqual(saved.rows, draft.rows);
  const builds = saved.validation.graphBuilds;
  invalidateRelations(root);
  const unchanged = await query(); assert.equal(unchanged.validation.graphMode, 'reused'); assert.equal(unchanged.validation.graphBuilds, builds);
});
