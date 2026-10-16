const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function javaMajor(version) { const match = String(version || '').match(/^(?:1\.)?(\d+)/); return match ? Number(match[1]) : null; }
function inspectJdk(directory, platform = process.platform) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 4096 || /[\x00-\x1f]/.test(directory)) return null;
  for (const candidate of [directory, path.join(directory, 'Contents/Home')]) {
    try {
      const home = fs.realpathSync(candidate), suffix = platform === 'win32' ? '.exe' : '';
      const release = path.join(home, 'release');
      if (fs.statSync(release).size > 64 * 1024) continue;
      const metadata = Object.fromEntries([...fs.readFileSync(release, 'utf8').matchAll(/^([A-Z_]+)="([^"\r\n]*)"/gm)].map(match => [match[1], match[2]]));
      if (!javaMajor(metadata.JAVA_VERSION)) continue;
      for (const executable of ['java', 'javac']) { const file = path.join(home, 'bin', executable + suffix); if (!fs.statSync(file).isFile()) throw Error('Missing JDK executable'); if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK); }
      return { home, version: metadata.JAVA_VERSION, major: javaMajor(metadata.JAVA_VERSION), vendor: metadata.IMPLEMENTOR || 'Java', arch: metadata.OS_ARCH || '', javaExec: path.join(home, 'bin', 'java' + suffix) };
    } catch {}
  }
  return null;
}
function discoverJdks(options = {}) {
  const platform = options.platform || process.platform, env = options.env || process.env, home = options.home || os.homedir();
  const candidates = [env.JAVA_HOME, env.JDK_HOME, ...(options.candidates || [])];
  const roots = options.roots || [path.join(home, '.jdks'), path.join(home, '.sdkman/candidates/java'), path.join(home, '.asdf/installs/java'),
    ...(platform === 'darwin' ? ['/Library/Java/JavaVirtualMachines', path.join(home, 'Library/Java/JavaVirtualMachines'), '/opt/homebrew/opt', '/usr/local/opt'] : platform === 'win32' ? [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).flatMap(root => ['Java', 'Eclipse Adoptium', 'Amazon Corretto', 'Microsoft', 'BellSoft', 'Zulu'].map(vendor => path.join(root, vendor))) : ['/usr/lib/jvm', '/usr/java', '/opt/java'])];
  for (const root of roots.slice(0, 32)) {
    try { for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, 200)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = path.join(root, entry.name); candidates.push(candidate);
      if (entry.name.startsWith('openjdk')) candidates.push(path.join(candidate, 'libexec/openjdk.jdk/Contents/Home'));
    } } catch {}
  }
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter).slice(0, 100)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    try { candidates.push(path.dirname(path.dirname(fs.realpathSync(path.join(directory, platform === 'win32' ? 'java.exe' : 'java'))))); } catch {}
  }
  const found = new Map();
  for (const candidate of candidates.filter(Boolean)) { const jdk = inspectJdk(candidate, platform); if (jdk) found.set(jdk.home, jdk); }
  return [...found.values()].sort((a, b) => b.major - a.major || b.version.localeCompare(a.version, undefined, { numeric: true }) || a.home.localeCompare(b.home));
}
function selectJdk(jdks, required, selectedHome, projectHome) {
  if (selectedHome) {
    const real = inspectJdk(selectedHome);
    const selected = real && jdks.find(jdk => jdk.home === real.home);
    if (!selected) throw Error('已选择的 JDK 不再可用，请刷新并重新选择');
    if (required && selected.major < required) throw Error(`项目要求 Java ${required}，所选 JDK ${selected.major} 不兼容`);
    return selected;
  }
  const project = projectHome && inspectJdk(projectHome);
  const compatible = jdks.filter(jdk => !required || jdk.major >= required);
  const selected = compatible.find(jdk => jdk.major === required) || compatible.find(jdk => jdk.home === project?.home) || compatible.at(-1);
  if (!selected) throw Error(required ? `项目要求 Java ${required}，本机未发现兼容 JDK，请安装后刷新` : '本机未发现可用 JDK，请安装后刷新');
  return selected;
}
module.exports = { javaMajor, inspectJdk, discoverJdks, selectJdk };
