const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
// Private copies only; fail on any bundled core version/content change.
const home = path.resolve(__dirname, '../../../packages/code-intelligence/.cache/jdtls/1.61.0');
const plugins = path.join(home, 'plugins');
const core = path.join(plugins, 'org.eclipse.jdt.core_3.47.0.v20260828-1141.jar');
const originalSha = crypto.createHash('sha256').update(fs.readFileSync(core)).digest('hex');
if (originalSha !== '723e30be1e841516c388ebb32017cb8b36662808f46be5265b78cc06bd4fe71c') throw new Error('Unsupported JDT artifact; experiment refused');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdt-projection-core-'));
const classes = path.join(root, 'classes'), tests = path.join(root, 'tests'); fs.mkdirSync(classes); fs.mkdirSync(tests);
const source = path.join(__dirname, 'java-package-cache/core');
execFileSync('javac', ['--release', '21', '-cp', path.join(plugins, '*'), '-d', classes, path.join(source, 'PackageNameProjection.java'), path.join(source, 'PatchProjectionCore.java')], { stdio: 'inherit' });
const patched = path.join(root, path.basename(core));
execFileSync('java', ['-cp', [classes, path.join(plugins, '*')].join(path.delimiter), 'PatchProjectionCore', core, patched, path.join(classes, 'org/eclipse/jdt/internal/core/search/matching/PackageNameProjection.class')], { stdio: 'inherit' });
execFileSync('javac', ['--release', '21', '-cp', [patched, path.join(plugins, '*')].join(path.delimiter), '-d', tests, path.join(source, 'ProjectionCoreTest.java')], { stdio: 'inherit' });
execFileSync('java', ['-Xverify:all', '-cp', [tests, patched, path.join(plugins, '*')].join(path.delimiter), 'org.eclipse.jdt.internal.core.search.matching.ProjectionCoreTest'], { stdio: 'inherit' });
const result = { directory: root, originalSha, patchedSha: crypto.createHash('sha256').update(fs.readFileSync(patched)).digest('hex'), patchedJar: patched };
if (!process.argv.includes('--test-only')) {
  const filter = file => !path.relative(home, file).split(path.sep).some(part => ['org.eclipse.osgi', '.lock', '.metadata'].includes(part));
  for (const label of ['control', 'candidate']) {
    const destination = path.join(root, label);
    fs.cpSync(home, destination, { recursive: true, filter, mode: fs.constants.COPYFILE_FICLONE });
    if (label === 'candidate') fs.copyFileSync(patched, path.join(destination, 'plugins', path.basename(core)));
    result[`${label}Home`] = destination;
  }
}
if (crypto.createHash('sha256').update(fs.readFileSync(core)).digest('hex') !== originalSha) throw new Error('Original artifact unexpectedly changed');
console.log(JSON.stringify(result));
