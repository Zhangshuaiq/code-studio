const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// Diagnostic artifact only; never overwrite shipped components or user indexes.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdt-index-thread-guard-'));
const source = path.resolve(__dirname, '../../..', 'packages/code-intelligence/java-compat');
const classes = path.join(root, 'classes'); fs.mkdirSync(classes);
const plugins = path.resolve(__dirname, '../.cache/jdtls/1.61.0/plugins');
const asm = path.join(plugins, fs.readdirSync(plugins).find(name => /^org\.objectweb\.asm_.*\.jar$/.test(name)) || 'missing-asm.jar');
execFileSync('javac', ['--release', '8', '-Xlint:-options', '-cp', asm, '-d', classes, path.join(source, 'IndexThreadGuardAgent.java')], { stdio: 'inherit' });
const tests = path.join(root, 'tests'); fs.mkdirSync(tests);
execFileSync('javac', ['--release', '8', '-Xlint:-options', '-cp', [classes, asm].join(path.delimiter), '-d', tests, path.join(source, 'IndexThreadGuardTest.java'), path.join(source, 'test-fixtures/Bundle.java'), path.join(source, 'test-fixtures/Platform.java')], { stdio: 'inherit' });
execFileSync('java', ['-cp', [tests, classes, asm].join(path.delimiter), 'codestudio.compat.IndexThreadGuardTest'], { stdio: 'inherit' });
// Preserve ASM's original archive and license metadata; do not repackage it.
fs.copyFileSync(asm, path.join(root, 'asm.jar'));
const jar = path.join(root, 'index-thread-guard.jar');
execFileSync('jar', ['cfm', jar, path.join(source, 'MANIFEST.MF'), '-C', classes, '.'], { stdio: 'inherit' });
console.log(JSON.stringify({ jar }));
