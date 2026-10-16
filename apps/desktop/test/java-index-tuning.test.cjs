const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildConcurrency, sharedIndexArguments, flightRecordingArguments } = require('@codegen/code-intelligence/java-index-tuning.cjs');
const { LocalLspManager } = require('@codegen/code-intelligence');
test('diagnostic bundles are absent by default and accept only bounded trusted files', t => {
  assert.deepEqual(new LocalLspManager().diagnosticJavaBundles, []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdt-bundle-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jar = path.join(root, 'probe.jar'); fs.writeFileSync(jar, 'trusted fixture');
  assert.deepEqual(new LocalLspManager({ resources: { diagnosticJavaBundles: [jar] } }).diagnosticJavaBundles, [fs.realpathSync(jar)]);
  for (const value of [null, {}, 'probe.jar', ['relative.jar'], [jar, jar, jar], [jar + '\n'], [path.join(root, 'missing.jar')]]) assert.throws(() => new LocalLspManager({ resources: { diagnosticJavaBundles: value } }), /absolute trusted/);
});
test('GC profiles are bounded and keep the default and heap budget unchanged', () => {
  const { garbageCollectorArguments } = require('@codegen/code-intelligence/java-index-tuning.cjs');
  assert.deepEqual(garbageCollectorArguments(undefined), []);
  assert.deepEqual(garbageCollectorArguments('default'), []);
  assert.deepEqual(garbageCollectorArguments('parallel'), ['-XX:+UseParallelGC', '-XX:GCTimeRatio=4', '-XX:AdaptiveSizePolicyWeight=90']);
  for (const value of [null, '', 'g1', '-javaagent:untrusted', [], {}]) assert.throws(() => new LocalLspManager({ javaGcProfile: value }), /GC profile/);
});
test('JDT tuning is opt-in and build concurrency is bounded', () => {
  assert.equal(buildConcurrency(undefined), undefined);
  for (const count of [1, 2, 4, 8]) assert.equal(buildConcurrency(count), count);
  for (const count of [0, 9, -1, 1.2, NaN, Infinity, '2', null]) assert.throws(() => new LocalLspManager({ javaMaxConcurrentBuilds: count }), /concurrency/);
  assert.deepEqual(sharedIndexArguments('not-opened', undefined), []);
});
test('shared index uses the JVM property and partitions cache by bundled core version', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdt-tuning-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), plugins = path.join(home, 'plugins'), cache = path.join(root, 'cache with spaces');
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, 'org.eclipse.jdt.core_3.47.0.test.jar'), 'fixture');
  assert.deepEqual(sharedIndexArguments(home, cache), [`-Djdt.core.sharedIndexLocation=${path.join(cache, 'org.eclipse.jdt.core_3.47.0.test')}`]);
  assert.ok(fs.statSync(path.join(cache, 'org.eclipse.jdt.core_3.47.0.test')).isDirectory());
  assert.throws(() => sharedIndexArguments(home, 'relative-cache'), /absolute/);
  assert.throws(() => sharedIndexArguments(home, '/bad\0cache'), /absolute/);
  const blocked = path.join(root, 'file-not-directory'); fs.writeFileSync(blocked, 'preserve');
  assert.deepEqual(sharedIndexArguments(home, blocked), []);
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'preserve');
});
test('flight recording is diagnostic-only, bounded, and does not add startup chatter to LSP stdout', () => {
  assert.deepEqual(flightRecordingArguments(undefined), []);
  const filename = path.join(os.tmpdir(), 'profile with spaces.jfr');
  const args = flightRecordingArguments(filename);
  assert.ok(args.includes('-Xlog:jfr*=off'));
  assert.ok(args.some(arg => arg.includes(`filename=${filename},settings=profile,dumponexit=true,maxsize=64m`)));
  for (const value of ['relative.jfr', null, '/tmp/file,bad.jfr', '/tmp/file\n.jfr', '/tmp/file\0.jfr']) assert.throws(() => flightRecordingArguments(value), /absolute/);
});
test('an explicit Java tooling command is actually used without altering JVM arguments', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdt-command-test-'));
  const home = path.join(root, 'jdt'), tools = path.join(root, 'tools'), projectRoot = path.join(root, 'project');
  for (const dir of [path.join(home, 'plugins'), tools, projectRoot]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins/org.eclipse.equinox.launcher_fixture.jar'), 'fixture');
  for (const name of ['lombok.jar', 'java-debug.jar']) fs.writeFileSync(path.join(tools, name), 'fixture');
  fs.writeFileSync(path.join(projectRoot, 'Main.java'), 'class Main {}');
  const marker = path.join(root, 'arguments.json'), command = path.join(root, 'fake-java');
  fs.writeFileSync(command, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))); process.exit(1);\n`, { mode: 0o700 });
  const manager = new LocalLspManager({ dataRoot: path.join(root, 'data'), commands: { java: command }, resources: { jdtlsHome: home, javaToolsRoot: tools } });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const prepared = await manager.prepareProject({ id: 'command-fixture', path: projectRoot });
  assert.equal(prepared.providers[0].ready, false);
  const args = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.ok(args.includes('-Xmx1G')); assert.ok(args.includes('-data'));
  assert.ok(!args.includes('-XX:+UseParallelGC'), 'Default startup must not silently enable the experimental collector');
  assert.ok(args.includes(`-javaagent:${path.join(tools, 'lombok.jar')}`));
});
