# 本地最小启动指南

本文用于在开发机上启动 Code Studio 的管理界面和核心 API，同时避免启动当前阶段不需要的中间件。本文只描述操作，不要求日常开发启用完整可观测性、Kafka、MySQL 或 Kubernetes。

## 1. 最小组件

推荐的“核心流程模式”包含：

| 组件 | 是否必需 | 用途 |
| --- | --- | --- |
| PostgreSQL 16 | 必需 | 用户、项目、权限、任务及配置持久化 |
| Redis 7 | 必需 | BullMQ、Worker 协调、分布式锁和限流 |
| API | 必需 | REST、认证和业务控制面，默认端口 `3000` |
| Worker | 推荐 | Git 异步导入、AI 任务和后台维护；不启动时相关任务只会排队 |
| Web | 必需 | Vite 开发界面，默认端口 `5173` |

以下组件不影响登录、权限、项目列表和普通配置页面，可暂不启动：MySQL、OpenSearch、Tempo、OpenTelemetry Collector、Prometheus、cAdvisor、Kafka、LSP Worker，以及 Kubernetes 生成和预览资源。

## 2. 前置条件

- Node.js `22.19` 或更高版本；
- npm；
- Git；
- Docker Engine 或 Docker Desktop，仅用于启动 PostgreSQL 和 Redis；
- 首次安装依赖时可以访问项目配置的 npm 源。

## 3. 初始化配置

在仓库根目录执行：

```bash
cp .env.example .env
```

至少修改下列安全配置，不要继续使用示例值：

```dotenv
DATABASE_URL="postgresql://codegen:codegen@localhost:5432/codegen?schema=public"
REDIS_MODE="standalone"
REDIS_HOST="localhost"
REDIS_PORT="6379"

# 分别使用 `openssl rand -base64 32` 和 `openssl rand -hex 32` 生成。
JWT_SECRET="替换为随机字符串"
CRED_ENCRYPTION_KEY="替换为64位十六进制字符串"

# 首个管理员注册时使用，至少 32 位；完成初始化后删除该值并重启 API。
INITIAL_ADMIN_TOKEN="替换为至少32位随机字符串"

API_PORT=3000
WEB_ORIGIN="http://localhost:5173"
OTEL_ENABLED="false"
MCP_ENABLED="false"
LSP_ENABLED="false"
LOCAL_PREVIEW_ENABLED="false"
KAFKA_BROKERS=""
OPENSEARCH_URL=""
```

`.env` 位于仓库根目录即可；API 的配置加载器同时查找当前目录和仓库根目录。不要提交 `.env`。

## 4. 只启动必要基础设施

不要使用 `npm run infra:up`，该命令会启动 Compose 文件中的全部默认服务。最小模式只启动两个明确命名的服务：

```bash
docker compose up -d postgres redis
docker compose ps postgres redis
```

这不会启动 MySQL、OpenSearch、Tempo、OpenTelemetry Collector、Prometheus 或 cAdvisor。如果本机已经有兼容的 PostgreSQL 和 Redis，可跳过 Docker Compose，并在 `.env` 中填写实际地址。

## 5. 首次安装与数据库初始化

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
```

`prisma:migrate` 会修改本地 PostgreSQL，只应指向本地开发数据库。已有数据库在拉取新迁移后也需要再次执行。它不会启动 API 或 Web。

## 6. 启动项目

建议打开三个终端，便于分别停止和查看日志：

```bash
# 终端 1
npm run dev:api
```

```bash
# 终端 2
npm run dev:worker
```

```bash
# 终端 3
npm run dev:web
```

访问地址：

- Web：<http://localhost:5173>
- API：<http://localhost:3000/api>
- Worker 健康端口：<http://localhost:3001/health/ready>

也可以用 `npm run dev` 同时启动三个进程，但独立终端更容易定位问题。

### 仅查看界面的更小模式

如果只验证登录、菜单、角色和普通管理页面，可以暂时不启动 Worker：

```bash
npm run dev:api
npm run dev:web
```

此时不要提交 Git 导入、代码生成、数据库传输或其他后台任务；任务可能进入队列但不会被消费。

## 7. 首次登录

1. 使用 `.env` 中的 `INITIAL_ADMIN_TOKEN` 完成首个账号注册；
2. 首个校验成功的账号会获得内置 `admin` 角色；
3. 初始化完成后从 `.env` 删除 `INITIAL_ADMIN_TOKEN`，再单独重启 API；
4. 需要 AI 生成时，在“设置 → 模型”添加 OpenAI 兼容端点、模型名和个人 API Key。

## 8. 当前最小模式不可用的能力

- 不启动 OpenSearch：业务日志检索和异常日志联动不可用；
- 不启动 Prometheus/Tempo：指标趋势和链路追踪不可用；
- 不配置 Kafka：Kafka 工作台不可用；
- 不接 Kubernetes：代码生成执行器、预览环境和部署不能实际创建 Pod/Job；
- 不准备语言服务器：LSP 智能跳转保持关闭；
- 不启动 Worker：异步 Git 导入、生成及后台维护任务不会执行。

这些能力缺失不应影响基础登录、权限管理和项目配置页面。调用对应能力时出现“未配置”或“服务不可用”属于预期结果。

## 9. 停止与清理

前台运行的 API、Worker 和 Web 使用 `Ctrl+C` 分别停止。保留数据并停止基础设施：

```bash
docker compose stop postgres redis
```

再次启动时仍可使用原数据：

```bash
docker compose start postgres redis
```

只有确认不再需要本地数据时，才考虑删除 Compose volume；常规停止不要执行 `docker compose down -v`。

## 10. 推荐启动顺序

```text
PostgreSQL + Redis
        ↓
Prisma migration（首次或存在新迁移时）
        ↓
API → Worker → Web
```

出现问题时按相反方向排查：浏览器代理到 API、API 到 PostgreSQL/Redis、Worker 到 Redis/PostgreSQL。未启用的可选组件不应作为最小启动的排查前提。
