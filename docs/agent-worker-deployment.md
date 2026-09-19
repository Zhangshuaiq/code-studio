# 独立编码 Worker

项目对话请求先进入 API 和 Redis 生成队列；真正的 Codex、Claude Agent SDK 编码进程只在编码 Worker 所在机器或 Pod 内启动。CLI 随平台依赖自动部署，浏览器所在机器无需安装 CLI。API 副本不决定任务执行节点。通用 Worker 在 `AGENT_WORKER_DEDICATED=true` 时不领取编码任务。

## 对话实时状态与恢复

浏览器先调用 `POST /api/agent/run/start` 获取任务 ID，再订阅 `GET /api/agent/tasks/:id/stream`。Worker 用 BullMQ progress 推送可公开的模型文本、Codex 推理摘要和工具事件；页面同时每 1.5 秒查询 `GET /api/agent/tasks/:id/live`，用于 SSE 断线或反向代理缓冲时的兜底。进度事件带序号，避免 SSE 与轮询重复显示。刷新页面后从会话任务历史识别运行中任务，恢复 `Working (Xm Ys)` 计时并按原任务 ID 重连，不会再次提交任务。最终结果由任务持久化日志覆盖临时流内容；原始内部推理不会展示。

成功对话只刷新代码树与 Git 历史，不自动打开运行日志或部署预览。已有仓库不自动补齐根目录 `package.json` 等模板文件；智能体应先读取真实多子项目结构，再按需求修改。

## 远程分支与失败项目清理

Git 分支菜单直接查询远程 heads，公开仓库可匿名读取，私有仓库使用当前用户 Git 凭据。选择远程分支时先 fetch 再 checkout 到当前用户工作区；后续同步针对当前分支的同名远程分支，不更改项目级默认分支。

管理员「项目后台任务」对目录缺失且资源回收失败的项目提供「清除关联记录」。API 必须再次确认当前共享卷上的项目目录、用户工作区、部署工作区均不存在；仍有运行中预览时拒绝，仍有运行中部署时先尝试停止真实资源，停止失败则保留数据库记录。确认后删除项目记录，数据库外键级联清理会话、任务及其他关联记录。旧路径若位于其他主机，平台无法保证删除那台机器上的文件，因此界面会明确提示这是不可恢复的记录清理操作。

## 部署方式

- Kubernetes：Helm 默认创建 `agent-worker` Deployment。它使用平台 Worker 镜像，镜像构建时通过 npm 依赖自动带上 Codex SDK/CLI 和 Claude Agent SDK/CLI，不需要在节点手工安装。可用 `agentWorker.replicaCount` 独立扩容；工作区 PVC 必须支持且已验证 ReadWriteMany。
- 非 Kubernetes：在安装平台依赖并构建 API 后，给通用 Worker 和编码 Worker 都设置 `AGENT_WORKER_DEDICATED=true`，再单独运行 `npm run start:agent-worker --workspace apps/api`。Codex 和 Claude 的运行程序仍由平台依赖提供，不依赖机器预装的全局 CLI。普通 Worker 仍负责其他后台任务；本地单进程开发可继续使用 `npm run dev`。

## 多节点会话

每个用户的 Codex CLI 登录态位于 `AGENT_STATE_ROOT/<userId>/codex`，Codex API 执行状态位于独立的 `AGENT_STATE_ROOT/<userId>/codex-api`，Claude 状态位于 `AGENT_STATE_ROOT/<userId>/claude`。Helm 将 `AGENT_STATE_ROOT` 设为共享 PVC 上的 `/data/agent-state`；项目工作区也在同一共享卷，所有编码 Worker 使用一致的绝对工作区路径。数据库保存会话 ID，下一轮由其他副本领取时可从共享状态恢复。分布式工作区锁确保同一用户项目不会被两个编码 Worker 同时修改。

这保证的是**会话和工作区不随 Pod 漂移丢失**，不是把项目永久绑定到某个物理节点。Pod 故障时队列可由另一副本接手。若要强制物理节点亲和，需要另行设计节点所有权与故障迁移，不能以 HTTP 请求碰巧落在哪个 API Pod 作为依据。

项目数据库现以 `storageKey=primary`、`storagePath=<projectId>` 保存逻辑位置；运行时在当前节点的 `SANDBOX_PROJECTS_ROOT` 下解析绝对路径。协作者工作区以项目 ID 和用户 ID 在 `SANDBOX_WORKSPACES_ROOT` 下解析。旧 `volumePath`、`workspacePath` 字段仅供迁移核对，新建项目和新会话不再写入部署机器的绝对路径。数据库迁移不会搬运源码：切换存储卷时必须先将项目及 Git worktree 文件复制到新卷，并让所有 API/Worker 挂载到相同的容器内路径；缺少原文件时服务会拒绝新建空仓库。数据库不能单独代替供 Git、编码 Agent 和构建工具访问的工作区文件系统。

账号认证与 CLI 安装是两件事。用户在「设置 · AI 平台连接」可选择 Codex CLI（个人 ChatGPT/Codex 登录）或 Codex API Key（个人 OpenAI Platform 凭证）。平台首先检查当前用户的隔离登录态；若未连接，还可检测**API 服务所在机器**的文件型 Codex CLI 登录。当前用户确认后，平台将机器上的凭证安全复制到该用户的共享状态目录，并在数据库中限制同一部署环境的机器登录态只能绑定给一位平台用户；其他用户仍须使用自己的账号。也可以直接通过设备码登录。浏览器所在机器的登录态不会自动传入服务器；若 API 在容器/Pod 中，检测的是容器内的登录态，除非明确、安全地提供凭证文件，否则通常不会检测到宿主机登录。系统凭证库中仅有登录态、没有可读取的 `auth.json` 时，也应使用设备码登录。编码 Worker 以用户自己的 `CODEX_HOME` 调用 SDK，不会在运行任务时直接复用机器的全局账号。CLI 模式可使用 CLI 默认模型，也可在项目对话框手动指定模型 ID。API Key 模式及其他平台的个人密钥加密存于数据库，不写入项目工作区；具体模型在项目对话框选择。API 和 Agent Worker 均需要受控 HTTPS 出口，且共享状态卷必须可靠、仅授权平台进程访问。

Codex CLI 个人登录使用该用户 ChatGPT/Codex 账号可用的订阅访问；Codex API Key 使用 OpenAI Platform 按 API 用量计费，两者不会自动互相切换或共用额度。Claude Agent SDK 使用个人 Anthropic API Key；DeepSeek、GLM 使用相同的本地智能体工具链与各自固定的官方 Anthropic 兼容端点，在项目工作区按需搜索、读写文件，不采用「一把梭」的固定文件上下文。API 模式的模型列表从各平台 API 获取；CLI 模式默认使用 CLI 模型配置，手动指定模型需确保账号有权限。任何新增国产 CLI 都应增加受控 Provider 适配器和镜像依赖，不接受用户提供任意可执行命令。
