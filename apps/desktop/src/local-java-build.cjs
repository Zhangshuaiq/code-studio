const fs = require('node:fs'); const path = require('node:path');
const { spawnGuarded } = require('@codegen/code-intelligence/guarded-process.cjs');
const { utf8ProcessEnvironment, pipeUtf8Output } = require('@codegen/code-intelligence/process-text.cjs');

function mavenInvocation(root, env = process.env, platform = process.platform, profiles = '') {
  const wrapper = path.join(root, platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
  let command;
  if (fs.existsSync(wrapper)) command = wrapper;
  else {
    const directories = [...(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':'), ...[env.MAVEN_HOME, env.M2_HOME].filter(Boolean).map(home => path.join(home, 'bin')), ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])];
    for (const directory of directories) {
      if (!path.isAbsolute(directory)) continue;
      const file = path.join(directory, platform === 'win32' ? 'mvn.cmd' : 'mvn');
      try { fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); command = file; break; } catch {}
    }
  }
  if (!command) throw Error('项目使用 Maven，但本机未找到 Maven 或 mvnw，请安装 Maven 后重试');
  const args = ['-B', '-Dstyle.color=never', '-Dmaven.test.skip=true', 'compile'];
  if (profiles) { if (typeof profiles !== 'string' || profiles.length > 2000 || !/^[!a-zA-Z0-9_.,-]+$/.test(profiles)) throw Error('项目 Maven profile 无效，请检查项目配置'); args.splice(args.length - 1, 0, '-P' + profiles); }
  if (platform === 'win32') {
    if (/["&|<>^%\r\n]/.test(command)) throw Error('Maven 路径包含无法安全执行的字符');
    return { command: path.join(env.SystemRoot || 'C:\\Windows', 'System32/cmd.exe'), args: ['/d', '/s', '/c', `""${command}" ${args.join(' ')}"`] };
  }
  return fs.existsSync(wrapper) ? { command: '/bin/sh', args: [wrapper, ...args] } : { command, args };
}
async function buildMaven(project, jdk, session, spawn = spawnGuarded, profiles = '') {
  const root = fs.realpathSync(project.path), invocation = mavenInvocation(root, process.env, process.platform, profiles);
  const env = utf8ProcessEnvironment(Object.fromEntries(['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','SYSTEMROOT','ComSpec','COMSPEC','PATHEXT','TMP','TEMP','TMPDIR','LANG','LC_ALL','LC_CTYPE','LC_MESSAGES','MAVEN_USER_HOME','MAVEN_HOME','M2_HOME','MAVEN_OPTS'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])));
  env.JAVA_HOME = jdk.home; env.PATH = path.join(jdk.home, 'bin') + path.delimiter + (process.env.PATH || process.env.Path || '');
  session.logs.push(`使用 JDK ${jdk.version} 编译：${jdk.home}\nMaven 项目编译（保留项目 source/target/release/toolchain）…\n`);
  session.buildDone = new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    session.buildChild = child;
    const timer = setTimeout(() => { session.buildTimedOut = true; child.kill('SIGTERM'); }, 10 * 60 * 1000); timer.unref();
    let output = '';
    let logBytes = 0;
    const log = chunk => { const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, ''); output = (output + text).slice(-4 * 1024 * 1024); session.logs.push(text); logBytes += Buffer.byteLength(text); while (session.logs.length > 2000 || (logBytes > 2 * 1024 * 1024 && session.logs.length > 1)) logBytes -= Buffer.byteLength(session.logs.shift()); };
    pipeUtf8Output(child.stdout, log); pipeUtf8Output(child.stderr, log);
    const finish = () => { clearTimeout(timer); if (session.buildChild === child) session.buildChild = null; };
    child.on('error', error => { finish(); reject(error); });
    child.on('close', code => { finish(); if (session.cancelled) reject(Error('项目编译已取消')); else if (session.buildTimedOut) reject(Error('Maven 编译超时，请查看编译输出')); else if (code !== 0) reject(Object.assign(Error('Maven 项目编译失败，请查看控制台输出'), { code: 'LOCAL_JAVA_BUILD_FAILED', issues: parseMavenIssues(root, output) })); else resolve(); });
  });
  return session.buildDone;
}
function parseMavenIssues(root, output) {
  const found = new Map();
  for (const match of output.matchAll(/^(?:\[ERROR\]\s*)?(.+?\.java):\[(\d+),(\d+)\]\s*(.*)$/gm)) {
    try {
      const file = fs.realpathSync(path.resolve(root, match[1].trim())); if (!file.startsWith(root + path.sep)) continue;
      const details = [];
      for (const line of output.slice(match.index + match[0].length).split('\n').slice(1, 5)) {
        if (/\.java:\[\d+,\d+\]|^\[(?:INFO|WARNING)\]|^\[ERROR\]\s*(?:Failed|->|$)/.test(line)) break;
        const detail = line.replace(/^\[ERROR\]\s*/, '').trim(); if (detail) details.push(detail);
      }
      const message = [match[4], ...details].join(' '), relative = path.relative(root, file).split(path.sep).join('/');
      const key = `${relative}:${match[2]}:${match[3]}:${message}`; found.set(key, { path: relative, line: Number(match[2]), column: Number(match[3]), message }); if (found.size >= 200) break;
    } catch {}
  }
  return [...found.values()];
}
module.exports = { mavenInvocation, buildMaven, parseMavenIssues };
