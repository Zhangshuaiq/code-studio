const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { describeFile } = require('@codegen/code-intelligence/file-preview.cjs');
const { fileLanguage, registry } = require('@codegen/code-intelligence/file-type.cjs');
const output = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../web/src/lib/workspace-file-type.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const exported = {}; new Function('exports', 'require', output)(exported, () => registry);
const resourceOutput = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../web/src/lib/markdown-resource.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const resources = {}; new Function('exports', resourceOutput)(resources);
test('Markdown resource resolution allows project-relative images and blocks external requests or escape', () => {
  const resolve = resources.markdownResourcePath;
  assert.equal(resolve('docs/README.md', '../assets/图%20片.png'), 'assets/图 片.png');
  assert.equal(resolve('docs/README.md', '/images/logo.png'), 'images/logo.png');
  for (const source of ['https://tracker.test/x.png', '//tracker.test/x.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '../../escape.png', '..%2f..%2fescape.png', '%2f%2ftracker.test/x', '..\\escape', '', '?token=x', '%00.png']) assert.equal(resolve('docs/README.md', source), null, source);
});
test('Markdown navigation resolves local files, line/column links and encoded chapter anchors', () => {
  const navigate = resources.markdownNavigation;
  assert.deepEqual(navigate('docs/README.md', '../src/Main.java#L10C4-L15'), { path: 'src/Main.java', line: 10, column: 4 });
  assert.deepEqual(navigate('docs/README.md', './guide.markdown#%E5%AE%89%E8%A3%85'), { path: 'docs/guide.markdown', anchor: '安装' });
  assert.deepEqual(navigate('docs/README.md', '#overview'), { path: 'docs/README.md', anchor: 'overview' });
  assert.deepEqual(navigate('docs/README.md', '/schema.sql#L2'), { path: 'schema.sql', line: 2, column: 1 });
  for (const href of ['https://foreign.test/guide', '//foreign.test/guide', 'javascript:alert(1)', '../../outside.md', '%2e%2e/%2e%2e/outside', 'Main.java#L0', 'Main.java#L1000001', 'Main.java#L2C1000001', '#bad%00', '#%', 'file:///etc/passwd']) assert.equal(navigate('docs/README.md', href), null, href);
});
test('heading anchors are stable for Unicode, inline code and duplicates without colliding with suffix headings', () => {
  const tree = { type: 'root', children: ['Hello *', 'Hello *', 'Hello-1', '安装', ''].map(value => ({ type: 'heading', children: [{ type: 'inlineCode', value }] })) };
  resources.remarkHeadingAnchors()(tree);
  assert.deepEqual(tree.children.map(node => node.data.hProperties.id), ['hello-', 'hello--1', 'hello-1', '安装', 'section']);
  const duplicate = { type: 'root', children: ['A', 'A-1', 'A'].map(value => ({ type: 'heading', children: [{ type: 'text', value }] })) };
  resources.remarkHeadingAnchors()(duplicate); assert.deepEqual(duplicate.children.map(node => node.data.hProperties.id), ['a', 'a-1', 'a-2']);
});
test('heading anchor processing handles deep inline nodes without recursive stack growth', () => {
  const heading = { type: 'heading' }; let node = heading;
  for (let i = 0; i < 20000; i++) { const child = { type: 'emphasis' }; node.children = [child]; node = child; }
  node.children = [{ type: 'text', value: 'Deep Heading' }];
  resources.remarkHeadingAnchors()({ type: 'root', children: [heading] }); assert.equal(heading.data.hProperties.id, 'deep-heading');
});
test('browser and backend use identical rules regardless of project language', () => {
  for (const [language, extensions] of Object.entries(registry.languages)) for (const extension of extensions) {
    assert.equal(fileLanguage(`java-project/config/Example.${extension}`), language);
    assert.equal(exported.workspaceFileLanguage(`java-project/config/Example.${extension}`), language);
  }
  for (const file of ['pom.xml', 'schema.SQL', '.env', '.env.local', 'Dockerfile', 'Dockerfile.dev', 'Makefile', 'Jenkinsfile', '.gitignore', 'unknown.format', 'no-extension', 'src.with.dots/README', 'src\\config.JSON', 'constructor', 'toString', '__proto__', 'mvnw', 'gradlew', '.zshrc', 'schema.svg.xml', 'Guide.MDWN']) assert.equal(exported.workspaceFileLanguage(file), fileLanguage(file), file);
});
test('shared classification keeps mixed source files editable and distinguishes unsupported binary input', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-file-types-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, language] of [['Main.java', 'java'], ['settings.json', 'json'], ['pom.xml', 'xml'], ['migration.sql', 'sql'], ['run.sh', 'shell'], ['README.markdown', 'markdown'], ['.env', 'ini'], ['Dockerfile', 'dockerfile'], ['custom.unknown', 'plaintext']]) {
    fs.writeFileSync(path.join(root, name), '测试文本\n');
    const descriptor = describeFile(path.join(root, name)); assert.equal(descriptor.kind, 'text'); assert.equal(descriptor.language, language);
    if (language === 'markdown') assert.equal(descriptor.preview, 'markdown');
  }
  fs.writeFileSync(path.join(root, 'launcher'), '#!/usr/bin/env bash\necho hello\n'); assert.equal(describeFile(path.join(root, 'launcher')).language, 'shell');
  fs.writeFileSync(path.join(root, 'damaged.json'), Buffer.from([0, 1, 2])); assert.equal(describeFile(path.join(root, 'damaged.json')).kind, 'unsupported');
  fs.writeFileSync(path.join(root, 'Example.class'), Buffer.from([0xca, 0xfe, 0xba, 0xbe])); assert.equal(describeFile(path.join(root, 'Example.class')).fileType, 'Java 字节码');
});
test('unknown extensions remain editable, while binary control bytes are not exposed as source', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-types-controls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content, language] of [['schema.svg.xml', '<schema/>', 'xml'], ['mvnw', 'echo build', 'shell'], ['Guide.MDWN', '# Guide', 'markdown'], ['empty.custom', '', 'plaintext'], ['notes.custom', '中文\ttext\r\n\f', 'plaintext']]) {
    fs.writeFileSync(path.join(root, name), content);
    const view = describeFile(path.join(root, name)); assert.equal(view.kind, 'text', name); assert.equal(view.language, language, name);
  }
  for (const byte of [1, 7, 11, 14, 27, 31, 127]) {
    const file = path.join(root, 'binary.custom'); fs.writeFileSync(file, Buffer.from([65, byte, 66]));
    assert.equal(describeFile(file).kind, 'unsupported', `control ${byte}`);
  }
});
