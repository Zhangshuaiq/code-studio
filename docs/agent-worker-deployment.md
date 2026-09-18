# 独立编码 Worker

项目对话请求先进入 API 和 Redis 生成队列；真正的 Codex、Claude Agent SDK 编码进程只在编码 Worker 所在机器或 Pod 内启动。CLI 随平台依赖自动部署，浏览器所在机器无需安装 CLI。API 副本不决定任务执行节点。通用 Worker 在 `AGENT_WORKER_DEDICATED=true` 时不领取编码任务。

## 部署方式

- Kubernetes：Helm 默认创建 `agent-worker` Deployment。它使用平台 Worker 镜像，镜像构建时通过 npm 依赖自动带上 Codex SDK/CLI 和 Claude Agent SDK/CLI，不需要在节点手工安装。可用 `agentWorker.replicaCount` 独立扩容；工作区 PVC 必须支持且已验证 ReadWriteMany。
- 非 Kubernetes：在安装平台依赖并构建 API 后，给通用 Worker 和编码 Worker 都设置 `AGENT_WORKER_DEDICATED=true`，再单独运行 `npm run start:agent-worker --workspace apps/api`。Codex 和 Claude 的运行程序仍由平台依赖提供，不依赖机器预装的全局 CLI。普通 Worker 仍负责其他后台任务；本地单进程开发可继续使用 `npm run dev`。

## 多节点会话

每个用户的 Codex 状态位于 `AGENT_STATE_ROOT/<userId>/codex`，Claude 状态位于 `AGENT_STATE_ROOT/<userId>/claude`。Helm 将 `AGENT_STATE_ROOT` 设为共享 PVC 上的 `/data/agent-state`；项目工作区也在同一共享卷，所有编码 Worker 使用一致的绝对工作区路径。数据库保存会话 ID，下一轮由其他副本领取时可从共享状态恢复。分布式工作区锁确保同一用户项目不会被两个编码 Worker 同时修改。

这保证的是**会话和工作区不随 Pod 漂移丢失**，不是把项目永久绑定到某个物理节点。Pod 故障时队列可由另一副本接手。若要强制物理节点亲和，需要另行设计节点所有权与故障迁移，不能以 HTTP 请求碰巧落在哪个 API Pod 作为依据。

账号认证与 CLI 安装是两件事。用户在「设置 · AI 平台连接」分别保存自己的 OpenAI、Anthropic、DeepSeek 或智谱 API Key；具体模型在项目对话框选择，选择记录在用户自己的会话中。API Key 加密存于数据库，不写入项目工作区，不使用平台全局令牌或部署机器的登录态。API 和 Agent Worker 需要受控访问各模型服务的 HTTPS 出口。旧版 Codex 设备码登录记录不再用于生成；旧配置需更新为个人 API Key。

Codex SDK 使用个人 OpenAI API Key；Claude Agent SDK 使用个人 Anthropic API Key。DeepSeek、GLM 使用相同的本地智能体工具链与各自固定的官方 Anthropic 兼容端点，在项目工作区按需搜索、读写文件，不采用「一把梭」的固定文件上下文。四个平台均使用各自 API 账户计费，**不代表网页聊天、Codex/Claude 客户端或 GLM Coding Plan 订阅额度可在此平台使用**。模型列表从平台 API 获取；列表可见不保证实际调用权限，执行失败应向用户显示平台错误。任何新增国产 CLI 都应增加受控 Provider 适配器和镜像依赖，不接受用户提供任意可执行命令。
