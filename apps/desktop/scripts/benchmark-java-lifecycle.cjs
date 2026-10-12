const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LocalLspManager } = require('../src/local-lsp-manager.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-lifecycle-'));
  try {
    const root = path.join(directory, 'project');
    fs.mkdirSync(path.join(root, 'src/main/java/demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>lifecycle</artifactId><version>1</version><properties><maven.compiler.release>17</maven.compiler.release></properties></project>');
    fs.writeFileSync(path.join(root, 'src/main/java/demo/Main.java'), 'package demo; public class Main { public static void main(String[] args) { System.out.println("hello"); } }');
    for (const mode of ['fresh-index', 'persisted-index']) {
      const events = [];
      const manager = new LocalLspManager({ dataRoot: path.join(directory, 'data'), onLifecycle: event => events.push(event) });
      const started = performance.now();
      let reuseMs;
      try {
        const prepared = await manager.prepareProject({ id: 'benchmark', path: root });
        if (!prepared.providers[0]?.ready) throw new Error(JSON.stringify(prepared));
        const reuseStarted = performance.now();
        await manager.prepareProject({ id: 'benchmark', path: root });
        reuseMs = Math.round((performance.now() - reuseStarted) * 100) / 100;
      } finally { await manager.shutdown(); }
      console.log(JSON.stringify({ mode, reuseMs, totalMs: Math.round(performance.now() - started), events }));
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
