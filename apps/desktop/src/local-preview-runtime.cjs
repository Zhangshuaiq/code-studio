const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnGuarded } = require('./guarded-process.cjs');

class LocalPreviewRuntime {
  constructor({ command, pythonCommand, dockerCommand } = {}) {
    this.npmCommand = command || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    this.pythonCommand = pythonCommand || (process.platform === 'win32' ? 'python' : 'python3');
    this.dockerCommand = dockerCommand || (process.platform === 'win32' ? 'docker.exe' : 'docker');
    this.runs = new Map();
  }

  inspect(project) {
    const targets = detectPreviewTargets(project.path);
    const scripts = targets.filter((item) => item.kind === 'node').map((item) => item.script);
    const run = this.runs.get(project.id);
    return { targets: targets.map(publicTarget), scripts, ...(run ? publicRun(run) : { status: 'stopped', url: null, port: null, targetId: null, targetLabel: null, script: null, logs: [] }) };
  }

  async start(project, targetId) {
    if (this.runs.has(project.id)) { const error = new Error('该项目的本地预览已在运行'); error.code = 'LOCAL_PREVIEW_BUSY'; throw error; }
    const targets = detectPreviewTargets(project.path);
    const target = targets.find((item) => item.id === targetId || (item.kind === 'node' && item.script === targetId));
    if (!target) { const error = new Error('请选择项目中检测到的预览配置'); error.code = 'LOCAL_PREVIEW_SCRIPT_INVALID'; throw error; }
    const port = await freePort();
    const run = { projectId: project.id, targetId: target.id, targetLabel: target.label, script: target.script || null, port, url: `http://127.0.0.1:${port}`, status: target.kind === 'docker' ? 'building' : 'starting', logs: [], child: null, kind: target.kind };
    this.runs.set(project.id, run);
    if (target.kind === 'docker') {
      run.imageName = `code-studio-preview-${project.id}`; run.containerName = `${run.imageName}-${port}`;
      void this.startDocker(project, target, run); return publicRun(run);
    }
    const invocation = previewInvocation(target, port, { npmCommand: this.npmCommand, pythonCommand: this.pythonCommand });
    const child = spawnGuarded(invocation.command, invocation.args, {
      cwd: project.path,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    run.child = child;
    const append = (chunk) => appendLog(run, chunk, true);
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', (error) => { run.status = 'failed'; append(error.message); run.child = null; });
    child.once('close', (code, signal) => {
      run.child = null;
      if (run.status !== 'stopping') run.status = code === 0 ? 'stopped' : 'failed';
      run.logs.push(`预览进程已退出（${signal || (code ?? 'unknown')}）`);
      if (run.status === 'stopping') run.status = 'stopped';
    });
    return publicRun(run);
  }

  async startDocker(project, target, run) {
    try {
      appendLog(run, `正在构建 ${path.basename(target.file)}…`);
      const build = spawnGuarded(this.dockerCommand, ['build', '--file', target.file, '--tag', run.imageName, '.'], { cwd: project.path, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      run.child = build; pipeLogs(build, run); const buildResult = await waitForProcess(build);
      if (run.status === 'stopping') { run.status = 'stopped'; return; }
      if (buildResult.code !== 0) throw new Error(`镜像构建失败（退出码 ${buildResult.code ?? 'unknown'}）`);
      appendLog(run, '镜像构建完成，正在启动容器…'); run.status = 'starting';
      const child = spawnGuarded(this.dockerCommand, ['run', '--rm', '--name', run.containerName, '--publish', `127.0.0.1:${run.port}:${target.containerPort}`, run.imageName], { cwd: project.path, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      run.child = child; pipeLogs(child, run, true); run.status = 'running';
      child.once('error', (error) => { run.status = 'failed'; appendLog(run, error.message); run.child = null; });
      child.once('close', (code, signal) => { run.child = null; run.status = run.status === 'stopping' ? 'stopped' : code === 0 ? 'stopped' : 'failed'; appendLog(run, `容器已退出（${signal || (code ?? 'unknown')}）`); });
    } catch (error) { run.child = null; run.status = 'failed'; appendLog(run, error instanceof Error ? error.message : String(error)); }
  }

  stop(projectId) {
    const run = this.runs.get(projectId);
    if (!run?.child) return false;
    run.status = 'stopping'; killProcessTree(run.child);
    if (run.kind === 'docker') void cleanupDocker(this.dockerCommand, run);
    return true;
  }

  async shutdown() {
    const children = [...this.runs.values()].map((run) => run.child).filter(Boolean);
    for (const child of children) killProcessTree(child);
    await Promise.all([...this.runs.values()].filter((run) => run.kind === 'docker').map((run) => cleanupDocker(this.dockerCommand, run)));
    await Promise.all(children.map((child) => new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000); child.once('close', () => { clearTimeout(timer); resolve(); });
    })));
    this.runs.clear();
  }
}

function readPreviewScripts(root) {
  return detectPreviewTargets(root).filter((item) => item.kind === 'node').map((item) => item.script);
}

function detectPreviewTargets(root) {
  const targets = [];
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
  for (const script of ['dev', 'start', 'preview', 'serve']) {
    if (typeof pkg?.scripts?.[script] === 'string') targets.push({ id: `node:${script}`, kind: 'node', label: `Node · npm run ${script}`, script });
  }
  if (fs.existsSync(path.join(root, 'manage.py'))) targets.push({ id: 'python:django', kind: 'python-django', label: 'Python · Django runserver' });
  else if (fs.existsSync(path.join(root, 'app.py'))) targets.push({ id: 'python:app', kind: 'python-app', label: 'Python · app.py' });
  const pom = readSmallFile(path.join(root, 'pom.xml'));
  if (pom?.includes('spring-boot')) targets.push({ id: 'java:maven-spring', kind: 'java-maven', label: 'Java · Maven Spring Boot', command: fs.existsSync(path.join(root, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw')) ? (process.platform === 'win32' ? 'mvnw.cmd' : './mvnw') : 'mvn' });
  const gradle = readSmallFile(path.join(root, 'build.gradle')) || readSmallFile(path.join(root, 'build.gradle.kts'));
  if (gradle?.includes('org.springframework.boot')) targets.push({ id: 'java:gradle-spring', kind: 'java-gradle', label: 'Java · Gradle Spring Boot', command: fs.existsSync(path.join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')) ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew') : 'gradle' });
  for (const file of ['Dockerfile', 'dockerfile']) {
    const content = readSmallFile(path.join(root, file)); if (!content) continue;
    const exposed = content.match(/^\s*EXPOSE\s+(\d{1,5})(?:\/tcp)?\b/im); const containerPort = Number(exposed?.[1] || 3000);
    if (containerPort > 0 && containerPort <= 65535) targets.push({ id: `docker:${file}`, kind: 'docker', label: `Docker · ${file} (${containerPort})`, file, containerPort });
    break;
  }
  return targets;
}

function previewInvocation(target, port, commands = {}) {
  if (target.kind === 'node') return { command: commands.npmCommand || (process.platform === 'win32' ? 'npm.cmd' : 'npm'), args: ['run', target.script] };
  if (target.kind === 'python-django') return { command: commands.pythonCommand || (process.platform === 'win32' ? 'python' : 'python3'), args: ['manage.py', 'runserver', `127.0.0.1:${port}`, '--noreload'] };
  if (target.kind === 'python-app') return { command: commands.pythonCommand || (process.platform === 'win32' ? 'python' : 'python3'), args: ['app.py'] };
  if (target.kind === 'java-maven') {
    return { command: target.command || 'mvn', args: ['spring-boot:run', `-Dspring-boot.run.arguments=--server.address=127.0.0.1 --server.port=${port}`] };
  }
  if (target.kind === 'java-gradle') {
    return { command: target.command || 'gradle', args: ['bootRun', '--args', `--server.address=127.0.0.1 --server.port=${port}`] };
  }
  throw new Error('不支持的预览配置');
}

function readSmallFile(file) {
  try { const stat = fs.statSync(file); return stat.size <= 1024 * 1024 ? fs.readFileSync(file, 'utf8') : null; } catch { return null; }
}

function publicRun(run) {
  return { targetId: run.targetId, targetLabel: run.targetLabel, script: run.script, port: run.port, url: run.url, status: run.status, logs: [...run.logs] };
}

function appendLog(run, value, markRunning = false) { run.logs.push(...String(value).split(/\r?\n/).filter(Boolean)); if (run.logs.length > 500) run.logs.splice(0, run.logs.length - 500); if (markRunning && run.status === 'starting') run.status = 'running'; }
function pipeLogs(child, run, markRunning = false) { child.stdout.on('data', (chunk) => appendLog(run, chunk.toString('utf8'), markRunning)); child.stderr.on('data', (chunk) => appendLog(run, chunk.toString('utf8'), markRunning)); }
function waitForProcess(child) { return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
async function cleanupDocker(command, run) { await Promise.all([run.containerName ? quietProcess(command, ['rm', '--force', run.containerName]) : null, run.imageName ? quietProcess(command, ['image', 'rm', '--force', run.imageName]) : null]); }
function quietProcess(command, args) { return new Promise((resolve) => { const child = spawn(command, args, { stdio: 'ignore', windowsHide: true }); child.once('error', resolve); child.once('close', resolve); }); }

function publicTarget(target) { return { id: target.id, kind: target.kind, label: target.label }; }

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const address = probe.address(); const port = typeof address === 'object' && address ? address.port : 0; probe.close((error) => error ? reject(error) : resolve(port)); });
  });
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { try { child.kill('SIGTERM'); } catch {} }
}

module.exports = { LocalPreviewRuntime, readPreviewScripts, detectPreviewTargets, previewInvocation };
