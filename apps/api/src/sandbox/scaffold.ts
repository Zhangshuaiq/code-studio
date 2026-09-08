// 生成后确定性兜底：弱模型常漏关键脚手架文件（如 node 项目漏 package.json），
// scaffoldRules 只是「软约束」喂给 LLM，这里再做一层「硬保证」——缺了就按依赖推断补齐，
// 让产物无论哪个模型生成都能被对应 runtime 直接跑起来/构建。
// 返回被修复/补齐的文件相对路径列表（供日志展示）。
import { mkdir, readdir, readFile, stat, writeFile, rm } from 'fs/promises';
import { join, resolve, sep } from 'path';
import type { ProjectRuntime } from './language-runtime';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.venv',
  '__pycache__',
  '.vite',
]);

// Node 内置模块（require/import 到这些不算依赖）
const NODE_BUILTINS = new Set([
  'assert','async_hooks','buffer','child_process','cluster','console','constants',
  'crypto','dgram','diagnostics_channel','dns','domain','events','fs','http','http2',
  'https','inspector','module','net','os','path','perf_hooks','process','punycode',
  'querystring','readline','repl','stream','string_decoder','sys','timers','tls','tty',
  'url','util','v8','vm','wasi','worker_threads','zlib',
]);

// 常见包的稳定版本（推断到的依赖优先用这里的版本，未知则 "latest"）
const KNOWN_VERSIONS: Record<string, string> = {
  express: '^4.19.2',
  cors: '^2.8.5',
  'body-parser': '^1.20.2',
  dotenv: '^16.4.5',
  axios: '^1.7.2',
  morgan: '^1.10.0',
  helmet: '^7.1.0',
  uuid: '^9.0.1',
  jsonwebtoken: '^9.0.2',
  bcryptjs: '^2.4.3',
  mongoose: '^8.4.0',
  pg: '^8.11.5',
  mysql2: '^3.9.7',
  sqlite3: '^5.1.7',
  ws: '^8.17.0',
  'node-fetch': '^3.3.2',
  nanoid: '^5.0.7',
};

export async function ensureScaffold(
  runtime: ProjectRuntime,
  cwd: string,
): Promise<string[]> {
  switch (runtime.id) {
    case 'node':
      return ensureNode(cwd);
    case 'python':
      return ensurePython(cwd);
    case 'react-vite':
      return ensureReactVite(cwd);
    case 'react-native':
      return ensureReactNative(cwd);
    default:
      return [];
  }
}

/** node/express：缺 package.json 时按源码里的 require/import 推断依赖补齐 */
async function ensureNode(cwd: string): Promise<string[]> {
  if (await exists(join(cwd, 'package.json'))) return [];

  const sources = await collectFiles(cwd, /\.(js|cjs|mjs)$/);
  const deps = new Set<string>();
  for (const file of sources) {
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const pkg of extractJsImports(text)) deps.add(pkg);
  }
  // server.js 用了 express 却没扫到（例如动态 require）也兜一个底
  if (deps.size === 0) deps.add('express');

  const dependencies: Record<string, string> = {};
  for (const d of [...deps].sort())
    dependencies[d] = KNOWN_VERSIONS[d] ?? 'latest';

  const hasServer = await exists(join(cwd, 'server.js'));
  const pkg = {
    name: 'generated-app',
    version: '1.0.0',
    private: true,
    main: hasServer ? 'server.js' : 'index.js',
    scripts: { start: `node ${hasServer ? 'server.js' : 'index.js'}` },
    dependencies,
  };
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
    'utf8',
  );
  const repaired = ['package.json'];

  // 残留的空/桩 package-lock.json 会与新 package.json 不一致，删掉让 npm 重新生成
  if (await exists(join(cwd, 'package-lock.json'))) {
    await rm(join(cwd, 'package-lock.json')).catch(() => undefined);
    repaired.push('package-lock.json (removed stale)');
  }
  return repaired;
}

/** python/fastapi：缺 requirements.txt 时补最小依赖 */
async function ensurePython(cwd: string): Promise<string[]> {
  if (await exists(join(cwd, 'requirements.txt'))) return [];
  await writeFile(
    join(cwd, 'requirements.txt'),
    'fastapi\nuvicorn[standard]\n',
    'utf8',
  );
  return ['requirements.txt'];
}

/** react-vite：缺 package.json 时补最小可 dev/build 的清单 */
async function ensureReactVite(cwd: string): Promise<string[]> {
  if (await exists(join(cwd, 'package.json'))) return [];
  const pkg = {
    name: 'generated-app',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
    devDependencies: {
      vite: '^5.0.0',
      '@vitejs/plugin-react': '^4.2.0',
    },
  };
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
    'utf8',
  );
  return ['package.json'];
}

/**
 * react-native (Expo)：逐个补齐缺失的关键文件，让产物是一个 `npm install` 即可
 * `expo export` 的最小 Expo 工程。弱模型常漏 app.json / babel.config.js。
 */
async function ensureReactNative(cwd: string): Promise<string[]> {
  const repaired: string[] = [];

  if (!(await exists(join(cwd, 'package.json')))) {
    const pkg = {
      name: 'generated-app',
      version: '1.0.0',
      private: true,
      main: 'node_modules/expo/AppEntry.js',
      scripts: { start: 'expo start' },
      dependencies: {
        expo: '~51.0.0',
        react: '18.2.0',
        'react-native': '0.74.5',
      },
    };
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify(pkg, null, 2) + '\n',
      'utf8',
    );
    repaired.push('package.json');
    // 残留的桩 lock 会与新 package.json 冲突，删掉让 npm 重新生成
    if (await exists(join(cwd, 'package-lock.json'))) {
      await rm(join(cwd, 'package-lock.json')).catch(() => undefined);
      repaired.push('package-lock.json (removed stale)');
    }
  }

  if (!(await exists(join(cwd, 'app.json')))) {
    const app = {
      expo: {
        name: 'generated-app',
        slug: 'generated-app',
        sdkVersion: '51.0.0',
        android: { package: 'com.generated.app' },
      },
    };
    await writeFile(
      join(cwd, 'app.json'),
      JSON.stringify(app, null, 2) + '\n',
      'utf8',
    );
    repaired.push('app.json');
  }

  if (!(await exists(join(cwd, 'babel.config.js')))) {
    await writeFile(
      join(cwd, 'babel.config.js'),
      'module.exports = function (api) {\n' +
        '  api.cache(true);\n' +
        "  return { presets: ['babel-preset-expo'] };\n" +
        '};\n',
      'utf8',
    );
    repaired.push('babel.config.js');
  }

  // 入口组件：App.js 或 App.tsx 任一存在即可，都缺则补最小 App.js
  const hasEntry =
    (await exists(join(cwd, 'App.js'))) ||
    (await exists(join(cwd, 'App.tsx'))) ||
    (await exists(join(cwd, 'App.jsx')));
  if (!hasEntry) {
    await writeFile(
      join(cwd, 'App.js'),
      "import { StyleSheet, Text, View } from 'react-native';\n\n" +
        'export default function App() {\n' +
        '  return (\n' +
        '    <View style={styles.container}>\n' +
        '      <Text>Open App.js to start working on your app!</Text>\n' +
        '    </View>\n' +
        '  );\n' +
        '}\n\n' +
        'const styles = StyleSheet.create({\n' +
        "  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },\n" +
        '});\n',
      'utf8',
    );
    repaired.push('App.js');
  }

  const previewDir = join(cwd, '.rn-preview');
  const previewScript = join(previewDir, 'build-and-install.sh');
  if (!(await exists(previewScript))) {
    await mkdir(previewDir, { recursive: true });
    await writeFile(
      previewScript,
      '#!/bin/sh\n' +
        'set -eu\n' +
        ': "${EMULATOR_ADB_HOST:?missing EMULATOR_ADB_HOST}"\n' +
        ': "${EMULATOR_ADB_PORT:?missing EMULATOR_ADB_PORT}"\n' +
        'npx expo prebuild --platform android --no-install\n' +
        '(cd android && ./gradlew assembleRelease)\n' +
        'device="${EMULATOR_ADB_HOST}:${EMULATOR_ADB_PORT}"\n' +
        'attempt=0\n' +
        'until adb connect "$device" 2>/dev/null | grep -Eq "connected|already connected"; do\n' +
        '  attempt=$((attempt + 1))\n' +
        '  [ "$attempt" -lt 60 ] || { echo "emulator ADB not ready" >&2; exit 1; }\n' +
        '  sleep 3\n' +
        'done\n' +
        'adb -s "$device" wait-for-device\n' +
        'export ANDROID_SERIAL="$device"\n' +
        'attempt=0\n' +
        'until [ "$(adb -s "$device" shell getprop sys.boot_completed 2>/dev/null | tr -d "\\r")" = "1" ]; do\n' +
        '  attempt=$((attempt + 1))\n' +
        '  [ "$attempt" -lt 60 ] || { echo "emulator boot timed out" >&2; exit 1; }\n' +
        '  sleep 3\n' +
        'done\n' +
        'adb -s "$device" install -r android/app/build/outputs/apk/release/app-release.apk\n' +
        'if [ -n "${EMULATOR_LAUNCH_COMMAND:-}" ]; then sh -c "$EMULATOR_LAUNCH_COMMAND"; fi\n' +
        'echo BUILD_AND_INSTALL_OK\n',
      { encoding: 'utf8', mode: 0o755 },
    );
    repaired.push('.rn-preview/build-and-install.sh');
  }

  return repaired;
}

/** 从 JS 源码里抽出裸模块名（排除相对路径与 node 内置），归一到包名 */
function extractJsImports(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const spec = m[1];
      if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
      const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
      // 归一到包名：@scope/name/sub -> @scope/name；express/lib -> express
      const parts = bare.split('/');
      const pkg = bare.startsWith('@')
        ? parts.slice(0, 2).join('/')
        : parts[0];
      if (NODE_BUILTINS.has(pkg)) continue;
      out.add(pkg);
    }
  }
  return [...out];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 递归收集匹配后缀的源文件（跳过依赖/构建产物目录），防越界 */
async function collectFiles(cwd: string, match: RegExp): Promise<string[]> {
  const root = resolve(cwd);
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (full !== root && !full.startsWith(root + sep)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (match.test(e.name)) {
        out.push(full);
      }
    }
  };
  await walk(root);
  return out;
}
