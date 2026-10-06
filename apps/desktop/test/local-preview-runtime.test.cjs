const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalPreviewRuntime, readPreviewScripts, detectPreviewTargets, previewInvocation } = require('../src/local-preview-runtime.cjs');

test('preview runtime exposes allowlisted package scripts and cleans up its process', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-preview-'));
  const fakeCommand = path.join(directory, 'fake-preview');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'node --test', preview: 'vite preview' } }));
  fs.writeFileSync(fakeCommand, `#!/usr/bin/env node
const http = require('node:http');
http.createServer((_request, response) => response.end('preview-ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready'));
`);
  fs.chmodSync(fakeCommand, 0o700);
  const runtime = new LocalPreviewRuntime({ command: fakeCommand });
  t.after(async () => { await runtime.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  const project = { id: 'project', path: directory };
  assert.deepEqual(readPreviewScripts(directory), ['dev', 'preview']);
  await runtime.start(project, 'dev');
  let state = runtime.inspect(project);
  for (let attempt = 0; attempt < 100 && state.status === 'starting'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25)); state = runtime.inspect(project);
  }
  assert.equal(state.status, 'running');
  let previewText = '';
  for (let attempt = 0; attempt < 100 && !previewText; attempt += 1) {
    try { previewText = await (await fetch(state.url)).text(); } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.equal(previewText, 'preview-ok');
  await assert.rejects(() => runtime.start(project, 'test'), /已在运行/);
  assert.equal(runtime.stop(project.id), true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runtime.inspect(project).status, 'stopped');
});

test('preview runtime rejects scripts outside its explicit preview allowlist', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-preview-invalid-'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const runtime = new LocalPreviewRuntime();
  await assert.rejects(() => runtime.start({ id: 'project', path: directory }, 'test'), /检测到的预览配置/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('preview runtime detects Python and Java projects and pins their loopback arguments', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-preview-targets-'));
  fs.writeFileSync(path.join(directory, 'manage.py'), '');
  fs.writeFileSync(path.join(directory, 'pom.xml'), '<plugin>spring-boot-maven-plugin</plugin>');
  fs.writeFileSync(path.join(directory, 'mvnw'), '');
  const targets = detectPreviewTargets(directory);
  assert.deepEqual(targets.map((item) => item.id), ['python:django', 'java:maven-spring']);
  assert.deepEqual(previewInvocation(targets[0], 43123, { pythonCommand: 'python-test' }), { command: 'python-test', args: ['manage.py', 'runserver', '127.0.0.1:43123', '--noreload'] });
  const java = previewInvocation(targets[1], 43124);
  assert.equal(java.command, './mvnw'); assert.match(java.args.join(' '), /server\.address=127\.0\.0\.1/); assert.match(java.args.join(' '), /server\.port=43124/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Docker is an optional preview target with bounded port binding and cleanup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-preview-docker-'));
  const fakeDocker = path.join(directory, 'fake-docker');
  fs.writeFileSync(path.join(directory, 'Dockerfile'), 'FROM scratch\nEXPOSE 8080\n');
  fs.writeFileSync(fakeDocker, `#!${process.execPath}
const http = require('node:http'); const args = process.argv.slice(2);
if (args[0] === 'build') { console.log('fake image built'); process.exit(0); }
if (args[0] === 'run') { const value = args[args.indexOf('--publish') + 1]; const port = Number(value.split(':')[1]); http.createServer((_req, res) => res.end('docker-preview-ok')).listen(port, '127.0.0.1', () => console.log('container ready')); }
else process.exit(0);
`);
  fs.chmodSync(fakeDocker, 0o700);
  const runtime = new LocalPreviewRuntime({ dockerCommand: fakeDocker });
  t.after(async () => { await runtime.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  const project = { id: 'dockerproject', path: directory };
  const target = detectPreviewTargets(directory).find((item) => item.kind === 'docker');
  assert.deepEqual(target, { id: 'docker:Dockerfile', kind: 'docker', label: 'Docker · Dockerfile (8080)', file: 'Dockerfile', containerPort: 8080 });
  assert.equal((await runtime.start(project, target.id)).status, 'building');
  let state = runtime.inspect(project);
  for (let attempt = 0; attempt < 100 && state.status !== 'running'; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 25)); state = runtime.inspect(project); }
  assert.equal(state.status, 'running', state.logs.join('\n')); assert.match(state.logs.join('\n'), /fake image built/);
  let previewText = '';
  for (let attempt = 0; attempt < 100 && !previewText; attempt += 1) { try { previewText = await (await fetch(state.url)).text(); } catch { await new Promise((resolve) => setTimeout(resolve, 25)); } }
  assert.equal(previewText, 'docker-preview-ok');
  assert.equal(runtime.stop(project.id), true);
});
