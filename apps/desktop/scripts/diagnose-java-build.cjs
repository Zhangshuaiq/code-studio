// Diagnose a read-only source snapshot: never build into the user's project.
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { LocalLspManager } = require('../src/local-lsp-manager.cjs');
const source = fs.realpathSync(process.argv[2]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'java-build-diagnosis-'));
const snapshot = path.join(temporary, path.basename(source));
const manager = new LocalLspManager({ dataRoot: path.join(temporary, 'language') });
(async () => {
  fs.cpSync(source, snapshot, { recursive: true, filter: (file) => {
    const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) return false;
    if (stat.isDirectory()) return !['.git', 'target', 'node_modules', '.idea', '.settings'].includes(path.basename(file));
    return file.endsWith('.java') || path.basename(file) === 'pom.xml' || path.basename(file) === 'lombok.config';
  } });
  const project = { id: 'java-build-diagnosis', path: snapshot };
  const targets = await manager.javaCommand(project, 'vscode.java.resolveMainClass');
  console.log('Java entries:', (targets || []).map((target) => `${target.mainClass} (${target.projectName})`));
  const result = await manager.javaBuild(project, targets?.[0] || {}, true);
  console.log('Build status:', result.status, 'Errors:', result.issues.length);
  for (const issue of result.issues.slice(0, 30)) console.log(`${issue.path}:${issue.line}:${issue.column}: ${issue.message}`);
  for (const message of result.messages) console.log(message);
  if (result.status !== 1) process.exitCode = 1;
})().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await manager.shutdown(); fs.rmSync(temporary, { recursive: true, force: true }); });
