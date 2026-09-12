# AI 代码生成平台

统一可观测与分布式链路的架构、传播规范和实施进度见 [docs/observability-plan.md](docs/observability-plan.md)。

一个面向多用户的 AI 代码生成与交付平台：通过对话生成或修改项目，在浏览器中编辑、预览和调试代码，并用 Git 记录每次变更，生产环境通过 Kubernetes 完成预览、构建与部署。

> 文档状态：已按 2026-09-01 的源码更新。更完整的实现设计和缺陷分级见[《代码生成平台技术方案》](./代码生成平台-技术方案.md)。

API 错误响应及当前稳定业务错误码见 [`docs/api-errors.md`](./docs/api-errors.md)。
MCP 全域能力接入、内置 Agent 编排、工具权限与审批体系的独立设计见 [`docs/mcp-agent-design.md`](./docs/mcp-agent-design.md)。该文档目前仅为设计，不代表相关接口已经实现。
数据库 binlog/CDC 持续同步当前尚未实现；现有数据库迁移仅为一次性全量复制，能力边界和后续设计见 [`docs/database-cdc.md`](./docs/database-cdc.md)。
代码编辑页的预览联调采用需求驱动模型：唯一需求编号作为路由标识，需求统一管理 Markdown 文档与版本、总体排期、方案设计/开发/测试/灰度/上线流水线、阶段负责人、关联项目和开发分支。用户工作区仍独立，同一需求的多服务预览共享路由上下文，未覆盖服务约定回落默认测试环境。当前相关迁移尚未部署；实际网关、注册中心或 Service Mesh 路由适配器仍待部署阶段接入，因此回落契约尚未在真实流量中生效。详见 [`docs/requirements-pipeline.md`](./docs/requirements-pipeline.md) 和 [`docs/preview-environment-routing.md`](./docs/preview-environment-routing.md)。
Kafka 可视化工作台通过 `KAFKA_BROKERS`、`KAFKA_SSL` 和可选的 SASL/SCRAM 凭据连接单个受控集群，支持自签 CA 和 mTLS。工作台支持 Topic/分区与配置管理、Consumer Group 和 Offset 管理、按 Offset 截断记录、受限消息抽样及测试发送，并展示 Topic 最近 5 分钟、1 小时、24 小时的 Offset 增量以及 Consumer Group 当前总延迟和分区延迟。Group 卡片展示在线消费者数量、Client ID、来源地址和 Topic/分区分配，并根据 Group 状态及分区分配标识工作中、空闲或重平衡中。时间窗口消息量由时间戳起始 Offset 与最新 Offset 的差值即时估算，压缩 Topic 或事务记录场景可能与物理消息条数存在偏差，不提供长期趋势存储。权限拆分为 `kafka:read`、`kafka:produce`、`kafka:topic-manage` 和 `kafka:group-manage`；删除、截断和位点修改要求再次输入资源全名确认，并写入审计日志。抽样使用平台专用检查 Group、关闭自动提交，并限制为最多 100 条、5 秒和单条 64 KiB，不会推进业务消费组位点；“测试发送”会真实写入当前 Topic，页面明确提示风险并在成功后展示分区和 Offset，发送审计不保存消息正文、Key 或 Headers。Kubernetes NetworkPolicy 还需在服务出口规则中精确放行 Broker 地址。

Topic 配置区展示 Broker 返回的当前有效值、默认/覆盖来源、只读状态和中文用途说明。修改表单同时说明单位、特殊值与主要风险；配置修改采用服务端字段白名单，覆盖保留时间与大小、清理策略、Segment、最大消息、最小同步副本、压缩方式、Compaction 延迟和消息时间类型，不接受任意 Kafka 配置键透传。

保存配置前，服务端会读取 Topic 元数据和当前配置，拒绝 `min.insync.replicas` 超过实际副本数，以及最小 Compaction 延迟大于最大延迟的冲突组合；这类错误保留稳定的 `KAFKA_CONFIG_INCOMPATIBLE` 业务错误码，不会被误报为 Kafka 不可用。

创建 Topic 使用页面内表单，基础区设置名称、分区数、副本数和可选最小同步副本，高级区可设置清理策略、保留时间/容量、最大消息与压缩方式。前后端同时校验数值范围和最小同步副本关系；同名 Topic 返回 `KAFKA_TOPIC_ALREADY_EXISTS`，不会提示假成功。

## 已实现能力

| 领域       | 当前能力                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------- |
| AI 生成    | 用户自带 OpenAI 兼容 API Key（BYOK）；支持 `simple` 整文件生成和 `aider` 增量编辑；SSE 实时输出 |
| 项目运行时 | React + Vite、Spring Boot、Node.js + Express、Python + FastAPI                                  |
| 在线 IDE   | 文件树、文件/代码全局搜索、多标签 Monaco、TS/JS 跨文件跳转、格式化、保存、diff、项目 ZIP 下载       |
| 预览与调试 | Kubernetes 隔离预览；支持容量配额、空闲回收、前端预览与后端 API 调试             |
| Git        | 项目级可选仓库；按当前用户记录提交作者，个人 PAT 按 Git 主机加密隔离；分支、diff、回滚和推送    |
| 部署       | 独立部署中心；按项目组/项目/分支/环境发布到 Kubernetes，并保留发布记录             |
| 平台治理   | JWT、用户/角色/权限、团队与项目成员、审计日志、Kubernetes Namespace/Pod/Deployment/Service 管理 |
| 日志中心   | OpenSearch 业务日志、项目级隔离检索、接入源 Token、结构化日志、保留策略与每日索引清理           |
| 数据源     | MySQL、PostgreSQL、Redis、MongoDB 配置与成员授权；SQL/Redis/MongoDB 查询台                      |

## 技术栈

- 前端：React 18、Vite 5、Tailwind CSS、React Query、Zustand、Monaco、CodeMirror
- 后端：NestJS 11、Prisma 5、PostgreSQL 16
- 运行与部署：Docker Engine API（dockerode）、Kubernetes Client、Git CLI
- 日志：OpenSearch 3、自研日志查询/接入界面（不依赖 OpenSearch Dashboards）
- AI：OpenAI 兼容 Chat Completions API、Aider；保留 Claude Agent SDK provider
- 基础设施：Docker Compose 启动 PostgreSQL 16、Redis 7 和 OpenSearch 3.7

生成请求通过 BullMQ 持久队列交给独立 Worker 执行，API 通过 SSE 转发任务进度；支持取消、
超时、重试、死信重放以及 Redis 单机/Cluster 两种部署模式。

## 项目结构

```text
.
├── apps/
│   ├── api/                    # NestJS API、Prisma schema 与 migrations
│   │   └── src/
│   │       ├── agent/          # 生成编排与 providers
│   │       ├── sandbox/        # 项目运行时和 Docker 沙箱
│   │       ├── preview/        # 预览与 API 调试代理
│   │       ├── files/          # 文件读写和下载
│   │       ├── git/            # 版本历史、分支、远程推送
│   │       ├── deploy/         # Docker/K8s 部署和镜像仓库
│   │       ├── auth/           # JWT、角色与权限
│   │       └── ...             # 项目、会话、团队、审计、数据源、K8s 管理
│   └── web/                    # React 管理界面和工作区
├── sandbox-images/
│   ├── node/Dockerfile         # React/Node 沙箱
│   └── java/Dockerfile         # Spring Boot 沙箱
├── docker-compose.yml          # PostgreSQL + Redis + OpenSearch
├── .env.example
└── 代码生成平台-技术方案.md
```

## 快速开始

机器资源有限或只验证核心流程时，请优先使用[本地最小启动指南](./docs/minimal-local-startup.md)，仅启动 PostgreSQL、Redis、API、Worker 和 Web；无需启动可观测性、Kafka、MySQL 或 Kubernetes 组件。

### 1. 环境要求

- Node.js 22.19+
- npm
- Docker Engine 或 Docker Desktop，并支持 Docker Compose
- Git CLI
- 可用的 OpenAI 兼容模型 API Key
- 可选：Aider（仅选择 `aider` 引擎时需要）

### 2. 创建本地配置

```bash
cp .env.example .env
```

至少替换以下两个值：

```bash
# JWT 签名密钥，可用 openssl rand -base64 32 生成
JWT_SECRET="替换为随机字符串"
JWT_KEY_ID="primary"

# AES-256-GCM 密钥，必须为 64 位 hex，可用 openssl rand -hex 32 生成
CRED_ENCRYPTION_KEY="替换为64位hex"
CRED_ENCRYPTION_KEY_ID="primary"
```

`CRED_ENCRYPTION_KEY` 用于加密模型 Key、Git PAT、部署目标、数据源、通知和镜像仓库凭证。需要换钥时不要直接覆盖旧密钥，请按下文的在线轮换流程操作。

所有环境默认使用 `DEPENDENCY_ACCESS_POLICY=proxy-upstream`：生成、预览和部署通过 `DEPENDENCY_NPM_REGISTRY`、`DEPENDENCY_PIP_INDEX_URL`、`DEPENDENCY_MAVEN_MIRROR_URL` 指向企业 Nexus、Artifactory 等内部代理，代理可按自身配置获取并缓存尚未收录的上游依赖。可显式改为 `proxy-cache-only`（需同时在代理端关闭上游）或 `direct`（不注入代理配置，使用包管理器默认源）。平台不内置第三方镜像地址。

沙箱 Dockerfile 的基础镜像均提供 `*_BASE_IMAGE` Build Arg。生产构建应传入企业仓库中的完整 digest 引用，例如 `harbor.example.com/base/node@sha256:...`，不要依赖可变 tag。

基础镜像、Android 工具版本及校验策略统一记录在 [`docs/supply-chain.md`](./docs/supply-chain.md) 和机器可读的 [`docs/supply-chain-versions.json`](./docs/supply-chain-versions.json)。

React Native 沙箱固定 Android Command-line Tools 版本及官方 SHA-256，Docker 构建会在解压前执行校验。升级工具版本时必须同时从 Android 官方下载页更新版本号和校验值。

### 3. 安装依赖并启动基础设施

```bash
npm install
npm run infra:up
npm run prisma:generate
npm run prisma:migrate
```

默认会启动：

- PostgreSQL：`localhost:5432`
- Redis：`localhost:6379`（BullMQ 队列、Worker 协调和分布式限流）
- OpenSearch：`localhost:9200`（仅由 API 访问；本地关闭安全插件）

### 4. 构建沙箱镜像

```bash
docker build -t sandbox-node:1.0 sandbox-images/node
docker build -t sandbox-java:1.0 sandbox-images/java
docker build -t sandbox-python:1.0 sandbox-images/python
# 仅使用 React Native 时需要；Apple Silicon 上按项目约束构建 amd64 镜像
docker build --platform linux/amd64 -t sandbox-react-native:1.0 sandbox-images/react-native
```

`react-vite` 和 `node` 共用 Node 镜像，`java` 使用 Maven + JDK 17 镜像，`python` 使用 Python 3.12 镜像。React 的部署模板也以 `sandbox-python:1.0` 中的 `http.server` 托管静态产物，因此即使不创建 Python 项目也需要构建该镜像。React Native 还需单独准备 Android 模拟器镜像。

### 5. 启动前后端

```bash
npm run dev
```

- Web：<http://localhost:5173>
- API：<http://localhost:3000/api>

首次使用流程：

1. 在服务端生成至少 32 位随机值并配置为 `INITIAL_ADMIN_TOKEN`。
2. 首次注册时填写该初始化令牌；首个通过校验的账户会原子地获得 `admin`。初始化完成后应从 Secret 中移除该令牌，系统不会再自动提升用户。
3. 打开“设置 → 模型”，添加 OpenAI 兼容端点、模型名和 API Key。第一套配置会自动成为默认模型。
4. 创建项目，选择运行时，然后在工作区中开始对话生成。

## 项目运行时

| 运行时 ID    | 技术                            | 沙箱镜像             | 预览               | 部署模板     | 状态                                         |
| ------------ | ------------------------------- | -------------------- | ------------------ | ------------ | -------------------------------------------- |
| `react-vite` | React 18 + Vite                 | `sandbox-node:1.0`   | iframe + HMR，5173 | 静态产物容器 | 生成/预览可用；部署依赖 `sandbox-python:1.0` |
| `java`       | Spring Boot 3 + Maven + Java 17 | `sandbox-java:1.0`   | HTTP，8080         | JAR 容器     | 可用                                         |
| `node`       | Node.js + Express               | `sandbox-node:1.0`   | HTTP，3000         | Node 容器    | 可用                                         |
| `python`     | FastAPI + Uvicorn               | `sandbox-python:1.0` | HTTP，8000         | Python 容器  | 可用                                         |
| `react-native` | React Native + Expo           | `sandbox-react-native:1.0` | Android 云手机 | Android 容器 | 编排已接入；需准备构建与模拟器镜像           |

项目文件默认写入 `.data/projects/<project-id>`，并绑定挂载到会话沙箱的 `/workspace`。AI provider 在宿主机项目目录中写文件；安装依赖、构建和预览命令在沙箱容器内执行。

移动端预览采用构建容器与模拟器容器分离的方式。模拟器镜像须开放 ADB `5555` 和浏览器投屏网关 `8080`，默认名为 `sandbox-android-emulator:30`，可通过 `ANDROID_EMULATOR_IMAGE` 覆盖。构建镜像还需包含 Node.js、JDK、Android SDK、ADB 和 Gradle 所需工具。

React Native 构建沙箱可在项目根目录构建：

```bash
docker build --platform linux/amd64 -t sandbox-react-native:1.0 sandbox-images/react-native
```

Python 沙箱镜像可通过以下命令构建：

```bash
docker build -t sandbox-python:1.0 sandbox-images/python
```

生产运行时镜像应推送至 Harbor 等受控仓库，并分别通过 `SANDBOX_NODE_IMAGE`、`SANDBOX_JAVA_IMAGE`、`SANDBOX_PYTHON_IMAGE`、`SANDBOX_REACT_NATIVE_IMAGE` 配置。Kubernetes 生产模式要求全部使用 `name@sha256:digest`；Helm 对应配置为 `runtime.images.*`，目标集群通过 `runtime.kubernetes.imagePullSecrets` 拉取。

## 模型与生成引擎

模型配置保存在数据库中，API Key 使用 AES-256-GCM 加密，列表接口只返回尾码。

- `simple`：调用 OpenAI 兼容的 `/chat/completions` 流式接口，要求模型按文件标记返回完整文件。适合快速生成和较弱模型。
- `aider`：通过本机 Aider 子进程做仓库感知的增量编辑。可通过 `AIDER_BIN` 指定可执行文件路径。
- `claude-agent`：provider 代码仍保留，供后续平台凭证模式扩展；当前 UI/API 的模型配置只接受 OpenAI 兼容配置，正常生成流程要求先配置 BYOK 模型。

成功生成后，系统会补齐必要脚手架、创建 Git 提交，并在 `AUTO_PREVIEW=true` 时异步启动预览。

## Git 仓库与用户身份

新建项目支持空白创建或从 HTTPS Git 仓库异步导入，也可在项目卡片或工作区“历史”面板中后续配置仓库。仓库地址属于项目，项目记录中不保存用户名或 PAT。

每位用户在“设置 → 账户与 Git”中管理自己的 Git 姓名、邮箱，以及按主机隔离的个人 PAT（例如 `github.com`、`git.company.com`）。生成、在线编辑、回滚等产生提交时，API 通过 `git -c user.name=... -c user.email=...` 显式写入当前操作者身份；推送时再按仓库主机读取当前用户的加密凭据。因此共享项目中的不同用户不会被记录成同一个平台账户。未显式设置身份时，会使用平台用户名和该用户独立的占位邮箱。

旧版保存在 `ProjectRemote` 中的项目级 PAT 会在迁移时转移给项目创建者。已有历史提交不会被重写，新的提交才使用个人身份。

共享项目采用用户级开发工作区：项目创建者使用主工作区，其余成员自动获得独立的 Git worktree、`users/<username>-<id>` 分支、Session、沙箱与预览容器。容器在首次生成/预览时按需创建，默认空闲 30 分钟后回收；手动停止预览也会立即释放实例。项目可把预览绑定到平台本机、Docker TCP 或 Docker over SSH 资源，并按用户、项目、项目组、目标实例数、CPU 和内存限制并发。

正式部署不复用任何个人工作区。部署中心会为所选项目、环境和分支准备独立 detached worktree，再构建到团队共享目标，因此发布时切换分支不会改变任何开发者代码页。内置 `developer` 只负责开发和预览；`release-manager` 负责发版；`ops-manager` 负责运行资源、镜像仓库和项目环境绑定。

项目内角色分为 Maintainer、Developer、Viewer：维护者可管理仓库和部署，开发者可生成、编辑、同步和推送个人分支，只读成员只能查看。平台 RBAC 与项目角色会同时校验。历史页支持获取并合并项目默认远程分支、展示 ahead/behind、保留冲突现场、完成或放弃合并；发生冲突时可在 Monaco 三方合并器中切换 Base/当前/远端对比，编辑最终结果，并对删除、二进制和超大文件选择完整版本。空白项目可直接导入远程代码。强制推送使用 `force-with-lease`，不会无条件覆盖未知远端提交。

创建项目时可选择“创建新项目”或“从 Git 导入”。Git 模式先持久化项目和创建者会话并立即返回 `import_queued`，独立 Worker 再拉取 HTTPS 仓库，因此大仓库不会占用 API/Ingress 长请求。项目卡片每 3 秒刷新 `import_queued/importing` 状态；成功后变为 `active`，失败则保留脱敏错误并允许所有者安全重试。未填写默认分支时，Worker 根据远程 `HEAD` 自动识别并持久化实际分支。公开仓库支持匿名拉取，私有仓库使用项目创建者按 Git 主机加密保存的 Token。Worker 通过数据库条件更新 claim 任务，多副本不会领取同一项目；进程异常后租约到期会重新排队。导入期间禁止打开项目、修改仓库配置或删除项目，失败清理工作区但保留项目记录供诊断和重试。

## 运行资源与部署

运维负责人先在左侧“运行资源”维护目标的可见范围、用途、标签、实例上限和总容量，再在“部署中心 → 项目环境配置”把项目的个人预览或统一部署环境绑定到目标。发布负责人只需选择项目、分支和环境执行部署。

当前驱动状态：

- `local-docker`：已接入。使用平台 API 节点 Docker，可配置浏览器访问主机名。
- `docker-tcp`：已接入。连接目标 Docker Engine API；生产环境不要暴露无 TLS 的 2375 端口。
- `docker-ssh`：已接入。远端需要 SSH、Docker CLI 18.09+，且登录用户能访问 Docker daemon。
- `k8s`：已接入。API 使用 kubeconfig 下发 Deployment 和 NodePort Service；远程集群通常还要配置可拉取的镜像仓库。
- `server-artifact`：已接入 Java Maven JAR/WAR 直传。平台在项目沙箱中构建，通过 SSH/SFTP 上传到普通服务器，并可选执行重启命令。

产物服务器目标需要填写 SSH 主机、端口、用户、私钥和远端绝对目录（例如 `/opt/apps/demo`）。部署用户必须能写入该目录；平台会先上传隐藏临时文件，完成后再原子替换正式 JAR/WAR，避免中断时产生半包。可选配置：

- `SSH 主机指纹`：推荐填写 `SHA256:...` 指纹，防止连接到伪造服务器。
- `重启命令`：上传成功后执行，例如 `sudo -n systemctl restart demo`。命令可用 `{artifact}` 引用远端产物完整路径、用 `{directory}` 引用目标目录；需要 sudo 时应配置仅针对所需命令的免交互权限。

“停止”不适用于产物直传：平台只负责上传和执行配置的重启命令，不会猜测或终止服务器上的业务进程。

Kubernetes 部署在 API 所在 Docker daemon 构建镜像；配置镜像仓库后会重新打 tag、推送镜像、创建 `imagePullSecret`，再由集群拉取。未配置仓库只适用于与本地 Docker 共享镜像库的集群等特殊环境。

## API 模块

所有业务 API 都使用 `/api` 前缀。除注册和登录外，接口需要 `Authorization: Bearer <token>`。

| 路径前缀                                     | 用途                                     |
| -------------------------------------------- | ---------------------------------------- |
| `/api/auth`                                  | 注册、登录、当前用户                     |
| `/api/projects`、`/api/sessions`             | 项目、成员、项目仓库和会话               |
| `/api/model-configs`                         | BYOK 模型配置                            |
| `/api/agent`                                 | 同步/SSE 生成、构建、最近改动            |
| `/api/sessions/:id/files`                    | 文件树、读写、ZIP 下载                   |
| `/api/preview/sessions/:id`                  | 预览生命周期、端点解析和请求代理         |
| `/api/sessions/:id/git`                      | 分支、提交、diff、回滚、远程推送         |
| `/api/git`                                   | 当前用户 Git 身份和按主机隔离的推送凭据  |
| `/api/deploy-targets`、`/api/registries`     | 运行目标、容量与镜像仓库                 |
| `/api/deployment-center`                     | 项目环境绑定、分支部署和部署记录         |
| `/api/sessions/:id/deploy`                   | 兼容用当前部署状态与停止接口             |
| `/api/admin`、`/api/admin/audit`             | 用户、角色、权限和审计                   |
| `/api/admin/teams`、`/api/admin/datasources` | 团队、数据源和成员授权                   |
| `/api/db-query`                              | 数据源查询                               |

项目、用户、角色、团队、数据源、生成任务、部署记录、预览构建记录和数据库审批/传输列表接受 `page`、`pageSize`，统一返回 `{ items, page, pageSize, total, hasNext, pages }`。通用页大小上限为 500，预览构建记录因日志字段较大限制为 100；管理端预览队列已提供翻页控件。

API 错误统一包含 `statusCode`、`code`、`message`、`requestId`、`timestamp` 和 `path`。客户端报障时应携带 `requestId`；未知异常和 5xx 底层细节只写服务端日志。

资源回收达到最大重试次数后进入 `deletion_failed`，管理员可在 `/admin/project-cleanups` 查看错误、填写确认备注并重新入队。确认会记录操作者和时间，并消除“未确认失败”健康告警；历史失败记录仍保留。平台不会提供静默忽略，避免残留资源失去追踪。
| `/api/k8s`                                   | Namespace、Pod、Deployment、Service 管理 |
| `/api/business-logs`                         | 业务日志接入源、检索、集群状态和保留策略 |

### 业务日志接入

在左侧“业务日志 → 接入管理”中为项目服务创建接入源。Token 只展示一次，平台只保存 SHA-256 哈希。采集端可一次提交最多 200 条日志：

```bash
curl http://localhost:3000/api/business-logs/ingest \
  -H 'Authorization: Bearer <source-token>' \
  -H 'Content-Type: application/json' \
  -d '{"logs":[{"timestamp":"2026-08-18T10:00:00Z","level":"INFO","message":"service started"}]}'
```

生产环境建议由 OpenTelemetry Collector 批量调用该接口。`log4j` 接入源会解析常见 PatternLayout 的时间、线程、级别、Logger 和多行异常；自定义 PatternLayout 无法识别时仍会按原文保存。

“应用监控”会从结构化 HTTP 请求日志聚合成功率、请求量、状态码和 P50/P95/P99 延迟。采集端至少上报 `http.method`、`http.route`、`http.status_code` 和 `duration_ms`；可通过 `success` 覆盖默认的 HTTP 2xx/3xx 成功判定：

```json
{
  "logs": [{
    "level": "INFO",
    "message": "POST /api/orders completed",
    "traceId": "trace-123",
    "attributes": {
      "http.method": "POST",
      "http.route": "/api/orders/:id",
      "http.status_code": 200,
      "duration_ms": 83,
      "business.code": "0",
      "success": true,
      "service.version": "2026.08.23"
    }
  }]
}
```

## 常用命令

```bash
npm run dev                # 同时启动 API、独立 Worker 和 Web
npm run dev:api            # 仅启动 API
npm run dev:web            # 仅启动 Web
npm run build              # 构建前后端
npm run infra:up           # 启动 PostgreSQL、Redis 和 OpenSearch
npm run infra:down         # 停止基础设施
npm run prisma:generate    # 生成 Prisma Client
npm run prisma:migrate     # 本地开发迁移
npm run seed:runtime-demo --workspace=apps/api # 可选：写入运行资源/部署中心演示数据
```

## 当前限制

- API 已有自动化测试；提交前应运行 `npm test --workspace apps/api` 和 `npm run build`。
- 生成任务已使用 BullMQ 持久化和独立 Worker；数据库迁移任务使用数据库租约与心跳协调。预览维护、日志保留和告警评估也只在 Worker 运行，API 副本不再启动后台轮询器。
- 代码生成 SSE 每 15 秒发送心跳；客户端连接中断不会取消或重复提交任务，并会使用持久化 `taskId` 最多三次恢复订阅。恢复失败时任务继续由 Worker 执行，最终结果可从任务中心或会话历史读取；API 会立即释放断开连接对应的 QueueEvents 监听器。
- Python 沙箱镜像已提供；React 静态部署模板也复用该镜像，通过 Python `http.server` 托管静态产物。
- 产物直传当前仅支持 Java Maven 的主 JAR/WAR；Node、Python 和前端静态目录仍需选择 Docker/Kubernetes 目标。
- 数据库迁移当前只执行一次性全量复制，不消费 MySQL binlog，也不提供持续增量同步；平台不会自动修改数据库全局配置或重启数据库。
- 团队项目已采用用户级 Session、worktree 和分支隔离；接口需同时通过平台 RBAC 与项目角色校验。
- 敏感控制器统一采用 JWT + RBAC 双重守卫；镜像仓库、模型配置、数据查询、Kubernetes、平台指标和健康视图均有明确权限边界，关键写操作进入审计日志。
- Kubernetes 应用部署仍有部分旧流程使用 NodePort；平台自身 Helm 部署已包含 Ingress、TLS、HPA、PDB 和 NetworkPolicy，资源配额与自动部署回滚仍需继续完善。
- Redis 已用于平台任务队列；支持单机和 Cluster 两种部署模式，默认单机。
- 生产默认关闭自助注册；如确需开放，显式设置 `SELF_REGISTRATION_ENABLED=true`。

## 安全提醒

- 不要把 `.env`、API Key、Git PAT、SSH 私钥、kubeconfig 或 Registry 密码提交到仓库。
- `CRED_ENCRYPTION_KEY` 应由密钥管理系统持久化和备份，并使用平台的事务轮换接口换钥。
- Docker socket 等价于宿主机高权限入口；生产部署应隔离 API、构建节点和业务节点。
- kubeconfig 应使用最小权限 ServiceAccount，不要直接提供长期有效的 `cluster-admin` 凭证。
- 数据源查询接口允许执行用户提交的 SQL/命令，只应授权给可信用户，并使用低权限数据库账号。数据源密码只在服务端解密，详情接口不会回传；编辑时密码留空表示保留原值。
- Git、数据库原生工具、SSH/SFTP、部署及 AI Provider 的外部诊断统一去除 ANSI，并对私钥、Authorization、Cookie、URL 凭证、JWT 和已知密钥脱敏；持久化任务日志同样只保存脱敏后的受限长度内容。
- 手动保存和 Simple LLM 批量生成在落盘前执行源码工作区配额检查，默认限制 2,000 个源码文件、单文件 2 MiB、源码总量 100 MiB；依赖目录、构建产物和 Git 数据不计入源码配额，且文件 API 禁止通过符号链接或内部目录读写卷外内容。可通过 `WORKSPACE_MAX_SOURCE_FILES`、`WORKSPACE_MAX_FILE_BYTES`、`WORKSPACE_MAX_SOURCE_BYTES` 调整。
- Aider 执行期间每秒审计工作区配额，Claude Agent 在每轮工具结果后审计，并在构建和提交前统一复核。外部 AI 子进程只继承网络代理、证书等必要环境，不会继承数据库、JWT、Registry 等平台密钥；保留的 Claude Provider 仅允许仓库读写工具，禁止 Shell 和网络工具。
- Docker 沙箱限制进程数和 `/tmp` 容量，命令输出只保留受限尾部。Kubernetes 构建门禁把 PVC 源码以只读方式挂载，复制到带 `sizeLimit` 的独立 `emptyDir` 后构建，同时设置 ephemeral-storage request/limit；依赖和构建产物不再写回共享源码 PVC。
- Kubernetes 生成 Job 使用独立的 `networkPolicy.generationEgressCidrs`/`generationExtraEgress`，不会继承 API/Worker 的宽出口；默认仅允许 DNS。生产应指向内部 npm/PyPI/Maven 镜像或受控 egress gateway，Chart 默认拒绝生成 Job 使用 `0.0.0.0/0`、`::/0`。Job 关闭 Service Links，并可通过 `runtime.kubernetes.nodeSelector`、`tolerations` 调度到专用执行节点。
- 默认依赖策略 `proxy-upstream` 在所有环境强制配置 npm、PyPI、Maven 内部代理，允许代理获取并缓存上游缺失依赖；`proxy-cache-only` 仍强制走代理，但上游开关由代理平台管理；`direct` 是显式可选的直连策略。生产 Kubernetes 的代理地址必须为 HTTPS。Maven settings 仅生成在本次 Job 的临时卷中，代理 URL 不允许内嵌凭证，NetworkPolicy 还需放行代理或受控出口的精确目标。
# 企业运维

## 配置与密钥

复制 `.env.example` 为 `.env`，并至少配置 PostgreSQL、`JWT_SECRET` 和
`CRED_ENCRYPTION_KEY`。生产环境启动时会拒绝弱 JWT、非法连接地址以及越界的
资源参数。`CRED_ENCRYPTION_KEY` 必须是 64 位十六进制字符串，可通过
`openssl rand -hex 32` 生成；密文包含版本和 key ID，并兼容已有旧格式。

安全轮换分四步：先用新的 `CRED_ENCRYPTION_KEY` 和新 `CRED_ENCRYPTION_KEY_ID` 部署，
同时把旧密钥以 `旧ID:64位hex` 写入 `CRED_ENCRYPTION_PREVIOUS_KEYS`；然后使用具备
`system-setting:manage` 权限的管理员调用 `POST /admin/encryption/rotate`；通过
`GET /admin/encryption/status` 确认 `needingRotation` 为 0；最后在下一次部署移除历史密钥。
轮换在一个数据库事务内完成，任何密文损坏或缺少历史密钥都会整体回滚，接口不会返回明文。

JWT 签名密钥也支持无停机轮换。首次启用时先保持原 `JWT_SECRET` 不变，只设置
`JWT_KEY_ID="v1"`；无 `kid` 的存量令牌仍按当前密钥验证。至少等待一个 `JWT_EXPIRES_IN`
周期后，再部署新密钥和 `JWT_KEY_ID="v2"`，同时设置
`JWT_PREVIOUS_SECRETS="v1:旧密钥"`。新令牌由 v2 签发，带 v1 `kid` 的令牌继续验证。
再次等待全部 v1 令牌过期后，方可移除历史密钥。这个两阶段流程可避免强制用户重新登录。

## PostgreSQL 备份与恢复

创建自带 SHA-256 清单、并经过 `pg_restore --list` 校验的备份：

```bash
npm run backup:db
```

默认保存到 `.data/backups/postgres`。生产环境应通过 `BACKUP_DIR` 指向加密的持久卷，
并由外部备份系统复制到对象存储。恢复是破坏性操作，因此必须显式确认目标数据库：

```bash
RESTORE_CONFIRM=codegen npm run restore:db -- .data/backups/postgres/codegen-<timestamp>.dump
```

恢复前会验证相邻 `.manifest` 文件中的 SHA-256，不匹配时拒绝执行。建议定期在隔离数据库
执行恢复演练；未经恢复验证的备份不能视为有效备份。

## 业务数据备份与跨库迁移

“数据库管理”页面支持选择来源库表进行异步备份，也支持 MySQL 与 PostgreSQL 之间的
双向表数据迁移。迁移属于写操作，提交后进入四眼审批，申请人不能审批自己的任务。
执行前会预检数据源、目标表和字段兼容性，任务保留表级检查点、行数进度、心跳和错误信息，
并支持取消与失败重试。

目标表冲突策略：

- `fail`（默认）：目标表已存在时拒绝执行，最安全。
- `append`：保留目标表并追加数据；调用方负责唯一键冲突与重复数据风险。
- `replace`：先删除目标表再重建，只应在确认可覆盖目标数据时使用。

这里的“业务数据备份”是平台自定义的逻辑备份，不是 `mysqldump`、`pg_dump` custom format
或数据库物理文件的二进制备份。备份产物由 manifest 和逐表 JSONL 组成，生产默认目录为
`/data/backups/databases`，必须挂载持久卷并交由对象存储、加密和保留策略接管。
当前迁移范围是表结构的基础字段映射与表数据，不包含索引、外键、触发器、存储过程、
数据库用户和权限；正式切换前仍需校验行数、抽样数据、字符集、时区和业务一致性。

数据库工作台还支持 CSV、XLSX 文件导入，以及 CSV、XLSX 文件导出。导入文件首行
必须与目标表字段对应，单次最多 10MB、5000 行，并作为 `INSERT` 写操作进入四眼审批。
导出可以选择当前表的全部数据，或当前只读 SQL 的查询结果；为保护 API 内存，单次最多
100000 行，更大的数据集应使用带条件的 SQL 分批导出或交由专用数据交换任务处理。

平台 PostgreSQL 自身的灾备使用下一节的 `pg_dump` custom-format 备份，和工作台中的
JSONL 业务数据备份用途不同：前者用于平台故障恢复，后者用于选表归档和跨类型迁移。

工作台现在也可显式选择“原生格式”备份：PostgreSQL 使用 `pg_dump --format=custom` 生成
可由 `pg_restore` 读取的压缩归档；MySQL 使用 `mariadb-dump --single-transaction` 生成包含
结构与数据的 SQL dump（MySQL 常规原生恢复介质是 SQL 文本，不是二进制物理备份）。每次
原生备份都会生成带格式、大小和 SHA-256 的 manifest，并支持流式下载。

原生恢复只接受平台已登记且 SHA-256 校验通过的原生备份，数据库类型必须一致，目标数据库
必须为空，并进入四眼审批。审批通过后执行前还会再次检查目标库是否为空；PostgreSQL 使用
`pg_restore --exit-on-error`，MySQL 使用 `mariadb` 客户端恢复。API 运行镜像因此安装了
PostgreSQL 16 client 和 MariaDB client。当前这属于逻辑灾备；需要时间点恢复时仍需结合
PostgreSQL WAL 归档或 MySQL binlog，以及数据库服务自身的快照/物理备份能力。

## Redis 部署模式

默认使用单机模式，适合本地开发和规模较小的单实例环境：

```env
REDIS_MODE=standalone
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_DB=0
```

生产环境可切换为 Redis Cluster。API Producer 与独立 Worker 会使用相同的节点发现配置，
每个进程分别维护 BullMQ 所需的普通连接和阻塞连接：

```env
REDIS_MODE=cluster
REDIS_CLUSTER_NODES=redis-0:6379,redis-1:6379,redis-2:6379
REDIS_CLUSTER_SCALE_READS=master
REDIS_DB=0
REDIS_TLS=true
REDIS_USERNAME=codegen
REDIS_PASSWORD=<secret>
```

生产环境 Cluster 至少要求三个发现节点。队列读取默认固定到 master，以免只读副本延迟影响
任务状态一致性。两种模式均支持 ACL 用户名、密码和 TLS；切换模式无需修改业务代码。

API 默认启用基于 Redis 的分布式固定窗口限流。普通接口按客户端 IP 计数；登录与注册接口
同时按 IP 和账号标识计数，账号仅以 SHA-256 哈希形式进入 Redis。健康探针不计入限流。
普通接口在 Redis 短暂异常时默认放行，认证接口始终失败关闭；可通过
`RATE_LIMIT_FAIL_OPEN=false` 让所有接口在限流服务故障时失败关闭。

## OpenTelemetry

API 与 Worker 支持在业务模块加载前启用 OpenTelemetry 自动埋点，覆盖 HTTP/Express、
PostgreSQL、Redis 等调用，并通过 OTLP HTTP/protobuf 导出 traces 和 metrics。默认关闭：

```env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.namespace=codegen
OTEL_METRIC_EXPORT_INTERVAL_MS=60000
```

Compose 会分别将服务名设置为 `codegen-api` 和 `codegen-worker`。鉴权型 Collector 可通过
`OTEL_EXPORTER_OTLP_HEADERS` 传递请求头。进程收到 SIGTERM/SIGINT 时会主动 flush 并关闭 SDK。

## Helm 生产部署

Chart 位于 `deploy/helm/codegen`，部署 API、独立 Worker、Web、数据库迁移 Job、Ingress、
HPA、PDB、NetworkPolicy、ServiceAccount、ConfigMap、Secret 和 RWX 工作区 PVC。生产环境建议预先创建
Secret 与 Harbor 拉取凭证：

```bash
kubectl -n codegen create secret docker-registry harbor-pull \
  --docker-server=harbor.example.com \
  --docker-username='<username>' \
  --docker-password='<password>'

kubectl -n codegen create secret generic codegen-production-secrets \
  --from-literal=DATABASE_URL='<postgresql-url>' \
  --from-literal=JWT_SECRET='<random-secret>' \
  --from-literal=JWT_KEY_ID='primary' \
  --from-literal=JWT_PREVIOUS_SECRETS='' \
  --from-literal=CRED_ENCRYPTION_KEY='<64-hex>' \
  --from-literal=CRED_ENCRYPTION_KEY_ID='primary' \
  --from-literal=CRED_ENCRYPTION_PREVIOUS_KEYS='' \
  --from-literal=REDIS_USERNAME='' \
  --from-literal=REDIS_PASSWORD='<redis-password>' \
  --from-literal=OPENSEARCH_USERNAME='<username>' \
  --from-literal=OPENSEARCH_PASSWORD='<password>' \
  --from-literal=OTEL_EXPORTER_OTLP_HEADERS=''

helm upgrade --install codegen deploy/helm/codegen \
  --namespace codegen --create-namespace \
  -f deploy/helm/codegen/values-production.example.yaml \
  --atomic --timeout 15m
```

首次安装时迁移 Job 在基础资源创建后运行；升级时在工作负载滚动更新前运行。建议生产环境
提供支持 `ReadWriteMany` 的存储（如 CephFS、EFS、NFS）。代码生成构建门禁默认使用
`runtime.generationExecutor=kubernetes`。Worker 在共享 PVC 中写入代码，随后只把当前工作区的 `subPath` 挂载给一次性
Job；Job 使用无 API Token 的独立 ServiceAccount，受 CPU/内存、超时、TTL 和 NetworkPolicy
限制，任务成功、失败或取消后都会清理。多副本部署必须先验证存储的跨节点锁、原子 rename 和
Git worktree 语义，再设置 `persistence.rwxVerified=true`；详细要求见
[`docs/kubernetes-multi-replica.md`](docs/kubernetes-multi-replica.md)。

生成队列还会在领取任务时通过 PostgreSQL advisory lock 原子执行团队与用户并发配额检查。
资源不足的任务会返回 BullMQ 延迟队列而不占用 Worker 槽位，稍后重新参与优先级调度。配额由
`worker.scheduling.maxPerTeam/maxPerUser` 配置；管理员可在“生成队列”页面调整排队任务的
P1-P10 优先级，或强制终止排队和运行中的任务，相关操作自动进入审计日志。

使用 Kubernetes 模式时，`runtime.kubernetes.workspaceClaim` 必须是 Worker 挂载的同一 RWX
PVC；若留空会复用 Chart 的工作区 PVC。沙箱运行时镜像应推送到 Harbor，并在
`runtime.kubernetes.imagePullSecrets` 配置拉取 Secret。生产示例同时关闭
`runtime.dockerSocket.enabled`；此时项目预览/部署也必须绑定 Kubernetes 目标，旧的本地 Docker
预览与 Docker 部署路径将不可用。

NetworkPolicy 默认启用：先对本 Chart 的 Pod 执行入站和出站默认拒绝，再只允许指定
Ingress Controller 访问 API/Web，并为 API、Worker、迁移任务放行 DNS、同 Namespace 服务和
配置的出口 CIDR。默认 `externalEgressCidrs` 为全网以兼容模型 API、Git 和外部数据库；生产环境
必须改成 NAT/Egress Gateway 或实际依赖服务网段，同时根据集群修改 Ingress Controller 标签。
关闭 `runtime.dockerSocket.enabled` 后 API/Worker 会自动以 UID 1000 非 root 运行；迁移任务和
Web 始终以非 root 运行。

独占 Namespace 可启用 `namespaceGovernance.enabled`，由 Chart 创建 ResourceQuota 和
LimitRange，限制 Pod、CPU、内存、PVC 数量及存储总量；共享 Namespace 不应启用，以免影响
其他业务。三个 Deployment 均限制 ReplicaSet 历史数量并配置发布超时，配合安装命令中的
`--atomic`，迁移 Hook 或滚动发布失败时 Helm 会自动回滚到上一版本。

平台还提供团队预览 Namespace 的幂等初始化接口：
`POST /api/k8s/:targetId/preview-namespaces/:teamId/provision`。接口仅允许项目组成员操作对其
可见且启用了 `preview` 用途的 Kubernetes 目标，并创建 `codegen-preview-{teamId}`、非自动
挂载 Token 的 ServiceAccount、ResourceQuota、LimitRange、Pod Security Admission restricted
标签、默认拒绝 NetworkPolicy 和 DNS 白名单。重复调用会校准配置，不会重复创建资源；额度可通过
`.env.example` 中的 `PREVIEW_NAMESPACE_*` 配置。

项目的 `preview/preview` 运行绑定现在允许选择 Kubernetes 目标。绑定配置示例：

```json
{
  "imageRepository": "harbor.example.com/team/project",
  "sourceBaseUrl": "https://codegen.example.com",
  "registryId": "平台镜像仓库配置ID",
  "baseDomain": "preview.example.com",
  "testNamespace": "team-test",
  "ingressClassName": "nginx",
  "ingressNamespace": "ingress-nginx",
  "tlsSecretName": "preview-wildcard-tls",
  "allowInternet": false,
  "buildAllowInternet": true,
  "buildEgressCidrs": ["10.20.0.0/16"],
  "env": { "NODE_ENV": "preview" }
}
```

点击启动后，平台会在团队预览 Namespace 中幂等创建 Deployment、ClusterIP Service、Ingress
和实例级 NetworkPolicy，并根据 Deployment Ready 状态更新预览状态；停止时清理所有实例资源。
超过 `K8S_PREVIEW_TTL_MINUTES` 未访问的实例会自动回收。配置 `imageRepository` 后，平台会创建
一次性 BuildKit rootless Job，从当前用户工作区的不可变短期快照构建唯一镜像、使用 Registry 缓存并推送 Harbor。
快照在用户工作区锁内生成到 API/Worker 共享卷，目标 Job 通过短期随机 Bearer 凭证下载并校验
SHA-256；下载凭证只以哈希写入数据库，令牌通过临时 Kubernetes Secret 注入，构建结束、取消或
过期后归档和 Secret 都会回收。平台会从 `registryId` 对应的加密 Registry 配置生成实例级
`.dockerconfigjson` Secret。Registry Secret 保留到预览停止，以便节点迁移时重新拉取镜像。也可以使用 `image` 直接
指定已有的非 root 项目镜像而跳过构建。集群应启用 Kubernetes Secret 静态加密，敏感应用变量不得
写入绑定 `env`。

`sourceBaseUrl` 必须是目标集群可访问的平台 HTTPS 地址，也可用全局 `PREVIEW_SOURCE_BASE_URL`
提供。`PREVIEW_SNAPSHOT_ROOT` 必须位于 API/Worker 共同挂载的 RWX 卷；构建 NetworkPolicy 必须
允许访问平台地址、镜像仓库和依赖代理。快照不包含 `.git`、点文件、依赖目录或构建产物。

需求预览 Ready 后会登记带租约的路由端点，Worker 每 20 秒根据 Kubernetes 实际状态续租或摘除。
网关/Nacos/Mesh 适配器使用 `PREVIEW_ROUTING_CONTROL_TOKEN` 调用
`GET /api/internal/preview-routing/resolve`，按 `requirementNo + serviceKey` 获取 preview/test 决策。
端点租约过期自动回落测试环境；preview 决策缓存由 `PREVIEW_ROUTING_CACHE_TTL_SECONDS` 控制，
默认 10 秒、强制不超过 30 秒且不超过端点剩余租期。解析结果明确禁止在预览业务 4xx/5xx 后重试测试实例。平台提供的是
厂商无关控制面，具体流量组件仍需在部署阶段选择并接入。

需求路由只用于预览与测试联调。未携带 `X-Codegen-Requirement` 的请求沿用环境默认路由；生产部署、
健康检查和业务访问不需要需求编号，生产网关应移除外部传入的同名 Header，且不调用预览路由解析接口。

BuildKit 并发由 `PREVIEW_BUILD_MAX_PER_TEAM` 和 `PREVIEW_BUILD_MAX_PER_USER` 控制。超过并发上限的
任务仍会创建 Kubernetes Suspended Job，但不会创建 Pod 或占用 CPU/内存；平台调度器使用
PostgreSQL 事务锁按入队时间恢复任务，因此多 API 副本也不会超卖。绑定可通过 `buildRetries`
（0-3，默认 1）和 `buildTimeoutSeconds`（60-3600，默认 1200）控制 Kubernetes Job 的失败重试
与执行上限。预览状态会展示队列前方任务数。

用户可调用 `POST /api/preview/sessions/:id/builds/:buildId/cancel` 主动取消自己的排队或运行任务。
管理员可在“管理后台 → 预览构建”查看全局队列、按状态筛选并强制取消；对应接口为
`GET /api/admin/preview-builds` 和 `POST /api/admin/preview-builds/:id/cancel`，取消操作进入审计日志。
排队超过 `PREVIEW_BUILD_QUEUE_TIMEOUT_MINUTES` 的任务会自动取消；后台每 10 秒校准 Job 状态，
Job 丢失超过 `PREVIEW_BUILD_STUCK_GRACE_SECONDS` 后自动标记失败并释放并发槽位。

每次 BuildKit 执行都会写入不可变 `PreviewBuildRecord`，记录项目、会话、目标、Job、镜像、状态、
耗时和脱敏日志尾部。`GET /api/preview/sessions/:id/builds` 按统一协议分页返回构建记录，
`GET /api/preview/sessions/:id/builds/metrics?days=7` 返回成功率和平均耗时；预览工具栏会展示最近
7 天构建成功率。升级时需执行 `npm run prisma:deploy --workspace apps/api` 应用对应迁移。

若集群已经安装 External Secrets Operator，可启用 `externalSecrets.enabled`，配置
`secretStoreRef` 和 `remoteKey`，由 Vault、AWS Secrets Manager、Azure Key Vault 等后端
持续同步应用 Secret；此时 Chart 不会生成内置 Secret。字段映射可通过
`externalSecrets.dataMappings` 调整，示例见 `values-production.example.yaml`。
