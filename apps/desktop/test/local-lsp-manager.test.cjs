const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { LocalLspManager } = require('../src/local-lsp-manager.cjs');

test('TypeScript project navigation resolves definitions, references and symbols', { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-lsp-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', moduleResolution: 'node' }, include: ['src'] }));
  fs.writeFileSync(path.join(root, 'src/value.ts'), 'export const answer = 42;\nexport function compute() { return answer; }\n');
  const source = "import { answer, compute } from './value';\nconsole.log(answer);\nconsole.log(compute());\n";
  fs.writeFileSync(path.join(root, 'src/main.ts'), source);
  const manager = new LocalLspManager({ idleMs: 60_000 });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = { id: 'test-project', path: root };

  const definition = await manager.request(project, 'definition', { path: 'src/main.ts', content: source, line: 2, column: 14 });
  assert.ok(definition.some((item) => item.path === 'src/main.ts'));
  const references = await manager.request(project, 'references', { path: 'src/value.ts', line: 1, column: 14 });
  assert.ok(references.some((item) => item.path === 'src/value.ts'));
  assert.ok(references.some((item) => item.path === 'src/main.ts'));
  const rename = await manager.rename(project, { path: 'src/value.ts', line: 1, column: 14, newName: 'ultimateAnswer' });
  assert.ok(rename.edits.some((item) => item.path === 'src/value.ts'));
  assert.ok(rename.edits.some((item) => item.path === 'src/main.ts'));
  const symbols = await manager.request(project, 'documentSymbols', { path: 'src/value.ts' });
  assert.ok(symbols.some((item) => item.name === 'answer'));
  const workspaceSymbols = await manager.workspaceSymbols(project, 'answer');
  assert.ok(workspaceSymbols.some((item) => item.name === 'answer' && item.location?.path === 'src/value.ts'));
  const hierarchy = await manager.callHierarchy(project, 'prepare', { path: 'src/main.ts', content: source, line: 3, column: 14 });
  assert.ok(hierarchy.some((item) => item.name === 'compute'));
  const incoming = await manager.callHierarchy(project, 'incoming', { item: hierarchy.find((item) => item.name === 'compute') });
  assert.ok(incoming.some((item) => item.from?.path === 'src/main.ts'));
  const completionSource = "import { answer } from './value';\nconst total = ans\n";
  const completion = await manager.request(project, 'completion', { path: 'src/main.ts', content: completionSource, line: 2, column: 18 });
  const completionItems = Array.isArray(completion) ? completion : completion.items;
  assert.ok(completionItems.some((item) => item.label === 'answer'));
  const diagnostics = await manager.diagnostics(project, { path: 'src/main.ts', content: "const broken: string = 42;\n" });
  assert.ok(diagnostics.some((item) => item.severity === 1 && /number.*string|not assignable/i.test(item.message)));
  const missingImport = 'console.log(answer);\n';
  const missingDiagnostics = await manager.diagnostics(project, { path: 'src/main.ts', content: missingImport });
  const actions = await manager.codeActions(project, { path: 'src/main.ts', content: missingImport, line: 1, column: 13, endLine: 1, endColumn: 19, diagnostics: missingDiagnostics });
  assert.ok(actions.some((item) => /import/i.test(item.title) && item.edit.edits.some((edit) => edit.path === 'src/main.ts')));
});

test('Python project navigation and diagnostics are provided by Pyright', { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-pyright-')); fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/helpers.py'), 'def greet(name: str) -> str:\n    return f"Hello {name}"\n');
  const source = 'from helpers import greet\n\nprint(greet("Code Studio"))\n';
  fs.writeFileSync(path.join(root, 'src/main.py'), source);
  const manager = new LocalLspManager({ idleMs: 60_000 });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = { id: 'python-project', path: root };

  const definition = await manager.request(project, 'definition', { path: 'src/main.py', content: source, line: 3, column: 8 });
  assert.ok(definition.some((item) => item.path === 'src/helpers.py'));
  const references = await manager.request(project, 'references', { path: 'src/helpers.py', line: 1, column: 5 });
  assert.ok(references.some((item) => item.path === 'src/main.py'));
  const diagnostics = await manager.diagnostics(project, { path: 'src/main.py', content: 'value: str = 42\n' });
  assert.ok(diagnostics.some((item) => item.severity === 1));
});

test('Java project navigation and references are provided by JDT LS', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-jdtls-'));
  const librarySource = path.join(root, 'library-src/com/vendor');
  const libraryClasses = path.join(root, 'library-classes');
  fs.mkdirSync(librarySource, { recursive: true }); fs.mkdirSync(libraryClasses);
  fs.writeFileSync(path.join(librarySource, 'Dependency.java'), 'package com.vendor; public class Dependency { public static String value() { return "dependency-body"; } }');
  execFileSync('javac', ['-d', libraryClasses, path.join(librarySource, 'Dependency.java')]);
  const libraryJar = path.join(root, 'dependency.jar');
  execFileSync('jar', ['cf', libraryJar, '-C', libraryClasses, '.']);
  const sourceRoot = path.join(root, 'src/main/java/com/example'); fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'pom.xml'), '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>sample</artifactId><version>1.0</version><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies><dependency><groupId>com.vendor</groupId><artifactId>dependency</artifactId><version>1.0</version><scope>system</scope><systemPath>' + libraryJar + '</systemPath></dependency></dependencies></project>');
  fs.writeFileSync(path.join(sourceRoot, 'Greeting.java'), 'package com.example;\npublic class Greeting { public static String message() { return "Hello"; } }\n');
  const source = 'package com.example;\npublic class Main { public static void main(String[] args) { System.out.println(Greeting.message()); } }\n';
  fs.writeFileSync(path.join(sourceRoot, 'Main.java'), source);
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-jdtls-data-'));
  const manager = new LocalLspManager({ idleMs: 60_000, dataRoot });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); if (process.env.CODE_STUDIO_LSP_DEBUG !== '1') fs.rmSync(dataRoot, { recursive: true, force: true }); else console.error(`JDT data: ${dataRoot}`); });
  const project = { id: 'java-project', path: root };

  const prepared = await manager.prepareProject(project);
  assert.deepEqual(prepared.providers, [{ provider: 'java', ready: true }]);

  await manager.diagnostics(project, { path: 'src/main/java/com/example/Main.java', content: source });
  const symbols = await manager.request(project, 'documentSymbols', { path: 'src/main/java/com/example/Main.java', content: source });
  assert.ok(symbols.some((item) => item.name === 'Main'), JSON.stringify(symbols));
  const definition = await manager.request(project, 'definition', { path: 'src/main/java/com/example/Main.java', content: source, line: 2, column: 82 });
  assert.ok(definition.some((item) => item.path === 'src/main/java/com/example/Greeting.java'), JSON.stringify(definition));
  const references = await manager.request(project, 'references', { path: 'src/main/java/com/example/Greeting.java', line: 2, column: 14 });
  assert.ok(references.some((item) => item.path === 'src/main/java/com/example/Main.java'));
  const workspaceSymbols = await manager.workspaceSymbols(project, 'Greeting');
  assert.ok(workspaceSymbols.some((item) => item.path === 'src/main/java/com/example/Greeting.java'), JSON.stringify(workspaceSymbols));
  const jdkDefinition = await manager.request(project, 'definition', { path: 'src/main/java/com/example/Main.java', content: source, line: 2, column: source.split('\n')[1].indexOf('String') + 1 });
  const jdkSource = jdkDefinition.find((item) => item.path?.startsWith('@java-source/'));
  assert.ok(jdkSource, JSON.stringify(jdkDefinition));
  const openedSource = await manager.javaSource(project, jdkSource.path);
  assert.equal(openedSource.readOnly, true);
  assert.match(openedSource.content, /class String/);
  assert.ok(openedSource.content.length > 1000);
  const jarLine = 'package com.example; public class JarClient { public Object value() { return com.vendor.Dependency.value(); } }';
  fs.writeFileSync(path.join(sourceRoot, 'JarClient.java'), jarLine);
  await manager.diagnostics(project, { path: 'src/main/java/com/example/JarClient.java', content: jarLine });
  const jarDefinition = await manager.request(project, 'definition', { path: 'src/main/java/com/example/JarClient.java', content: jarLine, line: 1, column: jarLine.indexOf('Dependency') + 1 });
  const jarSource = jarDefinition.find((item) => item.path?.startsWith('@java-source/'));
  assert.ok(jarSource, JSON.stringify(jarDefinition));
  const jarContent = await manager.javaSource(project, jarSource.path);
  assert.equal(jarContent.readOnly, true); assert.match(jarContent.content, /class Dependency/); assert.match(jarContent.content, /dependency-body/);
  await assert.rejects(manager.javaSource({ id: 'different-project', path: root }, jdkSource.path), (error) => error.code === 'LOCAL_LSP_SOURCE_INVALID');
  await assert.rejects(manager.javaSource(project, 'file:///etc/passwd'), (error) => error.code === 'LOCAL_LSP_SOURCE_INVALID');
});

test('C++ project navigation and references are provided by clangd', { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-clangd-'));
  fs.writeFileSync(path.join(root, 'math.hpp'), '#pragma once\nint add(int left, int right);\n');
  fs.writeFileSync(path.join(root, 'math.cpp'), '#include "math.hpp"\nint add(int left, int right) { return left + right; }\n');
  const source = '#include "math.hpp"\nint main() { return add(20, 22); }\n';
  fs.writeFileSync(path.join(root, 'main.cpp'), source);
  const manager = new LocalLspManager({ idleMs: 60_000 });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = { id: 'cpp-project', path: root };

  const definition = await manager.request(project, 'definition', { path: 'main.cpp', content: source, line: 2, column: 21 });
  assert.ok(definition.some((item) => item.path === 'math.hpp' || item.path === 'math.cpp'), JSON.stringify(definition));
  const references = await manager.request(project, 'references', { path: 'math.hpp', line: 2, column: 5 });
  assert.ok(references.some((item) => item.path === 'main.cpp'), JSON.stringify(references));
});

test('Vue project navigation is provided by the bundled Vue Language Server', { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-vue-lsp-'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', moduleResolution: 'node', allowJs: true }, include: ['*.ts', '*.vue'] }));
  fs.writeFileSync(path.join(root, 'message.ts'), 'export function greeting(name: string) { return `Hello ${name}`; }\n');
  const source = `<script setup lang="ts">\nimport { greeting } from './message';\nconst text = greeting('Code Studio');\n</script>\n<template><p>{{ text }}</p></template>\n`;
  fs.writeFileSync(path.join(root, 'App.vue'), source);
  const manager = new LocalLspManager({ idleMs: 60_000 });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = { id: 'vue-project', path: root };

  const definition = await manager.request(project, 'definition', { path: 'App.vue', content: source, line: 3, column: 15 });
  assert.ok(definition.some((item) => item.path === 'message.ts'), JSON.stringify(definition));
  const symbols = await manager.request(project, 'documentSymbols', { path: 'App.vue', content: source });
  assert.ok(symbols.length > 0, JSON.stringify(symbols));
});

test('optional language servers fail fast with an actionable unavailable error', { timeout: 5_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-studio-missing-lsp-'));
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n');
  const manager = new LocalLspManager({ idleMs: 60_000, commands: { gopls: 'code-studio-command-that-does-not-exist' } });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(
    manager.request({ id: 'missing-lsp', path: root }, 'definition', { path: 'main.go', line: 2, column: 6 }),
    (error) => error?.code === 'LOCAL_LSP_UNAVAILABLE' && /gopls.*无法启动/.test(error.message),
  );
});
