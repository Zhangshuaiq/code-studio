const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { EventEmitter } = require('node:events');
const { inspectJdk, discoverJdks, selectJdk, javaMajor } = require('../src/local-java-jdks.cjs');
const { LocalJavaRuntime } = require('../src/local-java-runtime.cjs');
const { validateConfiguration } = require('../src/java-run-configuration.cjs');
const { buildMaven, parseMavenIssues, mavenInvocation } = require('../src/local-java-build.cjs');
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-environment-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function jdk(root, version) { const home = path.join(root, 'jdk-' + version); fs.mkdirSync(path.join(home, 'bin'), { recursive: true }); fs.writeFileSync(path.join(home, 'release'), `JAVA_VERSION="${version}"\nIMPLEMENTOR="Test JDK"\nOS_ARCH="test"`); for (const file of ['java','javac']) { fs.writeFileSync(path.join(home, 'bin', file), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(home, 'bin', file), 0o755); } return inspectJdk(home); }
test('discover installed JDKs from release metadata without executing files, deduplicate and enforce project minimum', t => {
  const root = fixture(t), v17 = jdk(root, '17.0.12'), v11 = jdk(root, '11.0.23'), v21 = jdk(root, '21.0.3');
  const jdks = discoverJdks({ roots: [root], candidates: [v17.home], env: {}, home: root });
  assert.equal(jdks.length, 3); assert.equal(javaMajor('1.8.0_401'), 8);
  assert.equal(selectJdk(jdks, 17).home, v17.home); assert.equal(selectJdk(jdks, 17, v21.home).home, v21.home);
  assert.throws(() => selectJdk(jdks, 17, v11.home), /不兼容/); assert.throws(() => selectJdk(jdks, 26), /兼容 JDK/);
  fs.unlinkSync(path.join(v17.home, 'bin/javac')); assert.equal(inspectJdk(v17.home), null);
  assert.throws(() => selectJdk(jdks, 17, v17.home), /不再可用/);
});
test('environment follows selected main source/module effective project configuration, not host Java version', async t => {
  const root = fixture(t), v17 = jdk(root, '17.0.12'), v21 = jdk(root, '21.0.3');
  const source = path.join(root, 'Main.java'); fs.writeFileSync(source, 'class Main {}'); fs.writeFileSync(path.join(root, 'pom.xml'), '<project/>');
  const calls = [], runtime = new LocalJavaRuntime({ async javaCommand(_project, command, args) { calls.push({ command, args }); return { 'org.eclipse.jdt.core.compiler.source': '17', 'org.eclipse.jdt.core.compiler.codegen.targetPlatform': '17', 'org.eclipse.jdt.core.compiler.release': 'enabled', 'org.eclipse.jdt.ls.core.vm.location': v21.home }; } }, { discoverJdks: () => [v21, v17] });
  const target = { mainClass: 'Main', projectName: 'module', filePath: source };
  const result = await runtime.environment({ path: root }, {}, target);
  assert.equal(result.selected.home, v17.home); assert.equal(result.required, 17); assert.equal(result.buildTool, 'maven'); assert.equal(result.release, true);
  assert.equal(calls[0].command, 'java.project.getSettings'); assert.ok(calls[0].args[0].endsWith('/Main.java'));
  assert.equal((await runtime.environment({ path: root }, { javaHome: v21.home }, target)).selected.home, v21.home);
  assert.throws(() => validateConfiguration({ mainClass: 'Main', javaHome: '../jdk' }), /无效/);
  assert.equal(validateConfiguration({ mainClass: 'Main', javaHome: v17.home }).javaHome, v17.home);
});
test('Maven uses selected JAVA_HOME, fixed compile goal and project settings, no clean/install or source override', async t => {
  const root = fixture(t), v17 = jdk(root, '17.0.12'); fs.writeFileSync(path.join(root, 'mvnw'), '#!/bin/sh\n');
  let invocation; const session = { logs: [] };
  await buildMaven({ path: root }, v17, session, (command, args, options) => {
    invocation = { command, args, options }; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; setImmediate(() => { child.stdout.emit('data', Buffer.from('BUILD SUCCESS')); child.emit('close', 0); }); return child;
  });
  assert.equal(invocation.options.env.JAVA_HOME, v17.home); assert.ok(invocation.options.env.PATH.startsWith(path.join(v17.home, 'bin')));
  assert.equal(invocation.args.at(-1), 'compile'); assert.ok(!invocation.args.some(arg => /source=|target=|release=|clean|install/.test(arg))); assert.equal(session.buildChild, null);
  assert.ok(mavenInvocation(root, {}, process.platform, 'dev,!prod').args.includes('-Pdev,!prod'));
  assert.throws(() => mavenInvocation(root, {}, process.platform, 'dev;echo bad'), /profile 无效/);
});
test('Maven compilation issues preserve localized symbol details, bound paths and deduplicate repeated errors', t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'Main.java'), 'class Main {}');
  const block = `[ERROR] ${root}/Main.java:[7,30] cannot find symbol\n[ERROR]   symbol: method notGenerated()\n[ERROR]   location: class Person\n`;
  const issues = parseMavenIssues(fs.realpathSync(root), block + block + '[ERROR] /outside/Main.java:[1,1] no\n');
  assert.equal(issues.length, 1); assert.equal(issues[0].line, 7); assert.match(issues[0].message, /notGenerated/);
});
test('Maven console preserves Chinese split across stdout and stderr byte chunks', async t => {
  const root = fixture(t), v17 = jdk(root, '17.0.12'); fs.writeFileSync(path.join(root, 'mvnw'), '#!/bin/sh\n');
  const session = { logs: [] };
  await buildMaven({ path: root }, v17, session, () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => {
      for (const stream of [child.stdout, child.stderr]) { const data = Buffer.from('中文编译消息：符号、位置\n'); for (const byte of data) stream.emit('data', Buffer.from([byte])); stream.emit('end'); }
      child.emit('close', 0);
    }); return child;
  });
  const output = session.logs.join(''); assert.equal(output.split('中文编译消息：符号、位置').length - 1, 2); assert.ok(!output.includes('\ufffd'));
});
test('stop during Maven compilation cancels child and waits for it to finish', async t => {
  const root = fixture(t), v17 = jdk(root, '17.0.12'); fs.writeFileSync(path.join(root, 'mvnw'), '#!/bin/sh\n');
  const project = { id: 'stop-fixture', path: root }, runtime = new LocalJavaRuntime({}); let released = false, killed = false;
  const session = { id: 'test', status: 'starting', logs: [], frames: [], breakpoints: [], release: () => { released = true; } }; runtime.sessions.set(project.id, session);
  const pending = buildMaven(project, v17, session, () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { killed = true; setImmediate(() => child.emit('close', 143)); }; return child; });
  const rejection = assert.rejects(pending, /取消/);
  const result = await runtime.action(project, 'stop'); await rejection;
  assert.equal(result.status, 'stopped'); assert.equal(killed, true); assert.equal(released, true); assert.equal(session.buildChild, null);
});
