// 每个 runtime 的部署 Dockerfile + 容器端口。
// 刻意用平台已有的本地镜像作 base（sandbox-node/java/python），避免拉 Docker Hub（国内易失败）。

export interface DeployTemplate {
  dockerfile: string;
  port: number;
}

const TEMPLATES: Record<string, DeployTemplate> = {
  // 前端：node 构建 dist，再用 python 内置 http.server 托管静态产物（零额外依赖）
  'react-vite': {
    port: 8080,
    dockerfile: `FROM sandbox-node:1.0 AS build
WORKDIR /app
COPY . .
ARG NPM_REGISTRY
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm install && npm run build
FROM sandbox-python:1.0
WORKDIR /site
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["python","-m","http.server","8080","--directory","dist"]
`,
  },
  // Node/Express
  node: {
    port: 3000,
    dockerfile: `FROM sandbox-node:1.0
WORKDIR /app
COPY . .
ARG NPM_REGISTRY
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm install --omit=dev
EXPOSE 3000
ENV PORT=3000
CMD ["node","server.js"]
`,
  },
  // Python/FastAPI
  python: {
    port: 8000,
    dockerfile: `FROM sandbox-python:1.0
WORKDIR /app
COPY . .
ARG PIP_INDEX_URL
RUN if [ -n "$PIP_INDEX_URL" ]; then pip install -q -r requirements.txt --index-url "$PIP_INDEX_URL"; else pip install -q -r requirements.txt; fi
EXPOSE 8000
CMD ["uvicorn","main:app","--host","0.0.0.0","--port","8000"]
`,
  },
  // Java/Spring Boot：maven 打 jar，再用同镜像跑 jar
  java: {
    port: 8080,
    dockerfile: `FROM sandbox-java:1.0 AS build
WORKDIR /app
COPY . .
RUN mvn -q clean package -DskipTests
FROM sandbox-java:1.0
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
CMD ["java","-jar","app.jar"]
`,
  },
};

// 构建时排除的目录/文件（写进 .dockerignore）
export const DOCKERIGNORE = [
  'node_modules',
  'target',
  'dist',
  'build',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.aider*',
  'Dockerfile',
  '.dockerignore',
  '',
].join('\n');

export function deployTemplate(runtimeId: string): DeployTemplate | null {
  return TEMPLATES[runtimeId] ?? null;
}
