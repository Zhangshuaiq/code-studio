import { dependencyPolicyRequiresProxy, resolveDependencyAccessPolicy } from '../common/dependency-access-policy';

// 项目运行时抽象。
// 核心不再只是 build/test 命令，而是描述「这类项目怎么跑起来给人看/调」——即预览能力。
// 新增一种项目类型 = 加一个 ProjectRuntime 对象 + 对应 Dockerfile，SandboxModule/AgentModule 不动。

export type ProjectCategory = 'frontend' | 'backend' | 'mobile' | 'library';

export type PreviewKind =
  | 'web-dev-server' // 前端 dev server（iframe 预览 + HMR）
  | 'http-service' // 后端 HTTP 服务（暴露端口）
  | 'static' // 静态产物
  | 'emulator' // 移动端模拟器
  | 'none';

export interface PreviewSpec {
  kind: PreviewKind;
  startCommand?: string; // 长驻启动命令，如 'npm run dev -- --host 0.0.0.0 --port 5173'
  port?: number; // 容器内监听端口
  readyRegex?: RegExp; // 从日志判定「已就绪」
  needsWebsocket?: boolean; // HMR 等需要 WS 代理

  // ---- emulator 专属（kind==='emulator' 时使用）----
  // 移动端预览走「构建容器 + 模拟器容器」双容器模型，这些字段描述模拟器侧端口/设备。
  // PreviewService 按这些字段拉起独立模拟器容器，并向构建脚本注入 ADB 地址。
  grpcPort?: number; // 模拟器 gRPC 端口，默认 8554
  envoyPort?: number; // gRPC-web 对外端口（浏览器经此连接），默认 8080/8443
  adbPort?: number; // adb over TCP，默认 5555
  deviceProfile?: string; // 设备档案，如 'pixel_5'
  emulatorImage?: string; // 模拟器容器镜像（配置驱动，可被平台覆盖）
  launchCommand?: string; // 安装后启动 App 的命令（adb shell am start ...）
}

// 部署规格由 Docker、K8s 和产物直传驱动共用；产物直传使用 buildCommand 生成 JAR/WAR。
export interface DeploySpec {
  buildCommand: string;
  outputDir?: string; // 静态产物目录，如 'dist'
  strategy: 'static' | 'container-image';
}

export interface ProjectRuntime {
  id: string; // 'react-vite' | 'spring-boot'
  displayName: string;
  category: ProjectCategory;
  dockerImage: string;

  installCommand?: string;
  buildCommand?: string;
  testCommand?: string;

  preview: PreviewSpec; // 每种 runtime 都声明自己的预览方式
  deploy?: DeploySpec;

  envVars: Record<string, string>;

  // 生成约束：喂给「一把梭」LLM（simple-llm）的硬规则，确保产物能被本 runtime 直接跑起来。
  // 每种 runtime 自己声明脚手架契约（入口文件名/挂载点/依赖版本等），新增类型时一并补充。
  scaffoldRules?: string[];
}

// 兼容旧代码的类型别名（阶段 2 早期用 LanguageRuntime）
export type LanguageRuntime = ProjectRuntime;

export const reactViteRuntime: ProjectRuntime = {
  id: 'react-vite',
  displayName: 'React + Vite',
  category: 'frontend',
  dockerImage: 'sandbox-node:1.0',
  installCommand: 'npm install --ignore-scripts --no-audit --no-fund',
  buildCommand: 'npm run build',
  testCommand: 'npm test --silent',
  preview: {
    kind: 'web-dev-server',
    startCommand: 'npm run dev -- --host 0.0.0.0 --port 5173',
    port: 5173,
    readyRegex: /Local:\s+https?:\/\//,
    needsWebsocket: true,
  },
  deploy: {
    buildCommand: 'npm run build',
    outputDir: 'dist',
    strategy: 'static',
  },
  envVars: {},
  scaffoldRules: [
    'This is a Vite + React 18 project. It MUST run with `npm install && npm run dev`.',
    'Required files: package.json, vite.config.js, index.html, src/main.jsx, src/App.jsx.',
    'package.json: scripts.dev = "vite", scripts.build = "vite build". Dependencies: react ^18.2.0, react-dom ^18.2.0. devDependencies: vite ^5.0.0, @vitejs/plugin-react ^4.2.0.',
    'vite.config.js: import react from "@vitejs/plugin-react"; export default { plugins:[react()] } (use defineConfig).',
    'index.html MUST contain <div id="root"></div> and exactly <script type="module" src="/src/main.jsx"></script>. Do NOT reference /index.js or any non-module script.',
    'ALL files containing JSX MUST use the .jsx extension (never .js). Vite/esbuild will not parse JSX in .js files.',
    'src/main.jsx MUST use React 18 API: import { createRoot } from "react-dom/client"; createRoot(document.getElementById("root")).render(<App />). Do NOT use ReactDOM.render.',
    'Import the App component in main.jsx from "./App.jsx".',
  ],
};

export const springBootRuntime: ProjectRuntime = {
  id: 'java',
  displayName: 'Spring Boot (Maven)',
  category: 'backend',
  dockerImage: 'sandbox-java:1.0',
  buildCommand: 'mvn -q clean package -DskipTests',
  testCommand: 'mvn test',
  preview: {
    kind: 'http-service',
    // spring-boot:run 会自行拉依赖、编译并启动，无需单独 install
    startCommand: 'mvn -q -DskipTests spring-boot:run',
    port: 8080,
    readyRegex: /Started .* in .* seconds|Tomcat started on port/,
    needsWebsocket: false,
  },
  deploy: {
    buildCommand: 'mvn -q clean package -DskipTests',
    strategy: 'container-image',
  },
  envVars: { MAVEN_OPTS: '-Xmx1024m' },
  scaffoldRules: [
    'This is a Maven Spring Boot 3 project (Java 17). It MUST build with `mvn -q -DskipTests package` and run with `mvn spring-boot:run`.',
    'Required files: pom.xml, src/main/java/com/example/demo/DemoApplication.java (with @SpringBootApplication and a main method), and src/main/resources/application.properties.',
    'pom.xml MUST use parent spring-boot-starter-parent version 3.2.x, java.version 17, and depend on spring-boot-starter-web. Group com.example, artifact demo.',
    'Put a REST controller under src/main/java/com/example/demo/ annotated with @RestController exposing the endpoints the user asks for; return JSON via POJOs or Map.',
    'Use package com.example.demo for all classes. The app listens on port 8080 (default).',
    'application.properties can be minimal (e.g. server.port=8080).',
    'Do NOT include a frontend; this is a backend HTTP API.',
  ],
};

export const nodeExpressRuntime: ProjectRuntime = {
  id: 'node',
  displayName: 'Node.js (Express)',
  category: 'backend',
  dockerImage: 'sandbox-node:1.0',
  installCommand: 'npm install --ignore-scripts --no-audit --no-fund',
  preview: {
    kind: 'http-service',
    startCommand: 'node server.js',
    port: 3000,
    readyRegex: /listening on|Server (?:running|started|listening)/i,
  },
  deploy: { buildCommand: 'true', strategy: 'container-image' },
  envVars: {},
  scaffoldRules: [
    'This is a Node.js + Express backend API. It MUST run with `npm install && node server.js`.',
    'Required files: package.json (with express dependency and "start": "node server.js"), server.js.',
    'server.js: use CommonJS (require). const express=require("express"); const app=express(); app.use(express.json());',
    'Listen with: const PORT=process.env.PORT||3000; app.listen(PORT, ()=>console.log(`Server listening on port ${PORT}`)); — the ready log line is REQUIRED.',
    'Define the routes the user asks for with app.get/app.post/etc, returning JSON via res.json(...). Use in-memory mock data if needed.',
    'Do NOT include a frontend; this is a backend HTTP API.',
  ],
};

export const fastapiRuntime: ProjectRuntime = {
  id: 'python',
  displayName: 'Python (FastAPI)',
  category: 'backend',
  dockerImage: 'sandbox-python:1.0',
  installCommand: 'pip install -q --no-input --disable-pip-version-check -r requirements.txt',
  preview: {
    kind: 'http-service',
    startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000',
    port: 8000,
    readyRegex: /Uvicorn running|Application startup complete/i,
  },
  deploy: { buildCommand: 'true', strategy: 'container-image' },
  envVars: {},
  scaffoldRules: [
    'This is a Python FastAPI backend API. It MUST run with `pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000`.',
    'Required files: requirements.txt (must include fastapi and uvicorn[standard]), main.py.',
    'main.py: from fastapi import FastAPI; app = FastAPI(); then define routes with @app.get("/path") / @app.post(...) returning dicts/lists (auto JSON). Use in-memory mock data if needed.',
    'The ASGI app variable MUST be named `app` in main.py so `uvicorn main:app` works.',
    'Do NOT include a frontend; this is a backend HTTP API.',
  ],
};

// 移动端：React Native (Expo)。预览走 Android 模拟器 + WebRTC 投屏（kind='emulator'）。
// 双容器模型：本 dockerImage 是「构建/Metro 容器」（复用 ensureSandbox 长驻），
// 负责 npm install + expo export；模拟器容器由 preview 层单独拉起（阶段 B）。
// startCommand 在 emulator 语义下 = 打包并安装到模拟器的编排脚本入口，
// 由 preview.service 的 emulator 分支解释，不走「install && startCommand 长驻」老路径。
export const reactNativeRuntime: ProjectRuntime = {
  id: 'react-native',
  displayName: 'React Native (Expo)',
  category: 'mobile',
  dockerImage: 'sandbox-react-native:1.0',
  installCommand: 'npm install --ignore-scripts --no-audit --no-fund',
  buildCommand: 'npx expo export --platform android',
  testCommand: 'npm test --silent',
  preview: {
    kind: 'emulator',
    // 构建容器内打包+安装脚本入口（脚手架写入项目根 .rn-preview/ 下，满足路径约束）
    startCommand: 'bash .rn-preview/build-and-install.sh',
    readyRegex: /BUILD_AND_INSTALL_OK|Launched .* on emulator/i,
    needsWebsocket: false, // WebRTC 走 envoy，不经 vite ws
    grpcPort: 8554,
    envoyPort: 8080,
    adbPort: 5555,
    deviceProfile: 'pixel_5',
    emulatorImage: 'sandbox-android-emulator:30',
    launchCommand: 'adb shell monkey -p com.generated.app 1',
  },
  deploy: {
    buildCommand: 'npx expo export --platform android',
    outputDir: 'dist',
    strategy: 'container-image',
  },
  envVars: {
    EXPO_NO_TELEMETRY: '1',
  },
  scaffoldRules: [
    'This is an Expo (React Native) app. It MUST install with `npm install` and bundle via `npx expo export --platform android`.',
    'Required files: package.json, app.json, App.js (default-exporting a React component), babel.config.js.',
    'package.json: "main" = "node_modules/expo/AppEntry.js"; dependencies MUST include expo (~51.0.0), react (18.2.0), react-native (0.74.5); scripts.start = "expo start". Do NOT add a "web" build or Vite.',
    'app.json: { "expo": { "name": "...", "slug": "...", "sdkVersion": "51.0.0", "android": { "package": "com.generated.app" } } }.',
    'babel.config.js: module.exports = function(api){ api.cache(true); return { presets: ["babel-preset-expo"] }; };',
    'Use ONLY React Native core components (View, Text, ScrollView, Pressable, Image, TextInput, FlatList) and Expo-managed APIs. NEVER use browser/DOM APIs (window, document, localStorage) or web-only libraries.',
    'All screens are plain RN components; navigation optional via @react-navigation/native if included in dependencies. Style with StyleSheet.create, not CSS.',
  ],
};

const RUNTIMES: Record<string, ProjectRuntime> = {
  'react-vite': reactViteRuntime,
  java: springBootRuntime,
  node: nodeExpressRuntime,
  python: fastapiRuntime,
  'react-native': reactNativeRuntime,
};

export function getRuntime(runtimeId: string): ProjectRuntime {
  const runtime = RUNTIMES[runtimeId];
  if (!runtime) {
    throw new Error(`不支持的项目运行时: ${runtimeId}`);
  }
  return runtime;
}

export function listRuntimes(): ProjectRuntime[] {
  return Object.values(RUNTIMES);
}

const RUNTIME_IMAGE_KEYS: Record<string, string> = {
  'react-vite': 'SANDBOX_NODE_IMAGE',
  node: 'SANDBOX_NODE_IMAGE',
  java: 'SANDBOX_JAVA_IMAGE',
  python: 'SANDBOX_PYTHON_IMAGE',
  'react-native': 'SANDBOX_REACT_NATIVE_IMAGE',
};

export function configuredRuntime(
  runtime: ProjectRuntime,
  get: (key: string) => string | undefined,
): ProjectRuntime {
  const key = RUNTIME_IMAGE_KEYS[runtime.id];
  const image = key ? get(key)?.trim() : undefined;
  return image ? { ...runtime, dockerImage: image } : runtime;
}

export function isImmutableImageReference(image: string): boolean {
  return /@sha256:[a-f0-9]{64}$/i.test(image.trim());
}

/** 根据统一访问策略注入依赖源；默认强制通过允许回源的内部代理。 */
export function runtimeDependencyEnv(
  runtime: ProjectRuntime,
  npmRegistry?: string,
  pipIndexUrl?: string,
  mavenMirrorUrl?: string,
  accessPolicy?: string,
  legacyRequireProxy?: string,
) {
  const useProxy = dependencyPolicyRequiresProxy(
    resolveDependencyAccessPolicy(accessPolicy, legacyRequireProxy),
  );
  return {
    ...runtime.envVars,
    ...(useProxy && npmRegistry?.trim() ? { NPM_CONFIG_REGISTRY: npmRegistry.trim() } : {}),
    ...(useProxy && pipIndexUrl?.trim() ? { PIP_INDEX_URL: pipIndexUrl.trim() } : {}),
    ...(useProxy && mavenMirrorUrl?.trim()
      ? { CODEGEN_MAVEN_MIRROR_URL: mavenMirrorUrl.trim() }
      : {}),
  };
}
