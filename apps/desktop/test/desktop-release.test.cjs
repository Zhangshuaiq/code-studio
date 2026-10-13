const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyRelease } = require('../scripts/verify-release.cjs');
const { version, build } = require('../package.json');
for (const [platform, arch, suffixes] of [['macos', 'arm64', ['.dmg', '.zip']], ['windows', 'x64', ['-Setup.exe', '-Portable.exe']]]) {
  test(`release validation requires both ${platform} packages and records checksums`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-release-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const prefix = `Code Studio-${version}-${platform === 'macos' ? 'mac' : 'windows'}-${arch}`;
    await assert.rejects(verifyRelease(platform, arch, directory), /Missing\/empty/);
    for (const suffix of suffixes) fs.writeFileSync(path.join(directory, prefix + suffix), 'fixture-package');
    await verifyRelease(platform, arch, directory);
    const checksum = crypto.createHash('sha256').update('fixture-package').digest('hex');
    assert.equal(fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8'), suffixes.map(suffix => `${checksum}  ${prefix}${suffix}\n`).join(''));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'build-info.json'))).arch, arch);
    fs.writeFileSync(path.join(directory, prefix + suffixes[0]), '');
    await assert.rejects(verifyRelease(platform, arch, directory), /Missing\/empty/);
  });
}
test('push packaging covers native macOS architectures and Windows with distinct executable names', () => {
  const workflow = require('yaml').parse(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/desktop-build.yml'), 'utf8'));
  assert.ok(Object.hasOwn(workflow.on, 'push')); assert.equal(workflow.on.push, null);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.package.strategy.matrix.include.map(item => [item.platform, item.arch]), [['macos','x64'],['macos','arm64'],['windows','x64']]);
  for (const step of workflow.jobs.package.steps.filter(step => step.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  assert.notEqual(build.nsis.artifactName, build.portable.artifactName);
  assert.equal(build.mac.identity, '-');
  assert.ok(fs.readFileSync(path.resolve(__dirname, '../', build.mac.entitlements), 'utf8').includes('com.apple.security.cs.disable-library-validation'));
  assert.ok(workflow.jobs.package.steps.some(step => step.name === 'Verify macOS ZIP application signature' && step.run.includes('codesign --verify --deep --strict')));
  const command = workflow.jobs.package.steps.find(step => step.name === 'Build desktop packages').run;
  assert.ok(command.includes('--publish never')); assert.ok(command.includes('--${{ matrix.arch }}'));
});
