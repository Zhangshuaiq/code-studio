# MCP 与 Agent 平台总体设计

> 状态：设计完成，Phase 0 基础骨架实施中  
> 日期：2026-09-07  
> 适用范围：Code Generator 平台全部现有业务域  
> 目标协议：MCP `2026-07-28`；为尚未升级的企业客户端保留 `2025-11-25` 兼容适配层

## 1. 背景与目标

当前平台已经具备项目、用户工作区、Git、代码生成 Agent、需求流水线、个人预览、Kubernetes 部署、数据库治理、Kafka 管理、业务日志、定时任务、审计和平台监控等能力，但这些能力主要通过页面和 REST Controller 独立使用。现有 `AgentModule` 能调用模型并在用户工作区读写文件，不过 Claude Agent 明确配置了 `strictMcpConfig=true`，工具范围仅为 `Read/Edit/Write/Glob/Grep`，还不能理解或操作平台其他业务对象。

本设计希望实现：

- 将平台能力以统一、可发现、强类型的 MCP tools/resources/prompts 对外提供；
- 让平台内置 Agent 在同一权限边界内组合项目、需求、代码、数据、Kafka、预览和部署能力；
- 允许 IDE、桌面客户端和企业内部 Agent 平台安全接入；
- 保持现有 REST API 和页面可继续使用，MCP 不是替换层；
- 全程复用现有领域 Service、RBAC、项目角色、审批、审计和多 Pod 锁，不复制业务规则；
- 长任务可恢复、可取消、可追踪，API Pod 不保存会话状态；
- 任何 Agent 都不能绕过用户权限、项目隔离、需求负责人规则或生产审批。

不在本阶段目标内：

- 让模型获得任意 Shell、任意 SQL、任意 Kubernetes API 或服务器 SSH；
- 自动批准生产部署、数据库写操作、Kafka 删除等高风险动作；
- 保存模型的隐藏推理过程；
- 用需求预览标签控制生产部署或生产访问；
- 直接将 Prisma Client、kubeconfig、数据库密码、Registry 密码或模型密钥暴露给 MCP Client。

## 2. 设计原则

1. **MCP 是能力协议，不是权限系统**：每次调用都必须重新经过平台 JWT/OAuth、RBAC、项目角色和资源归属校验。
2. **Service 层唯一规则源**：MCP handler 调用现有领域 Service，禁止直接调用 Prisma、Kafka Admin、Kubernetes Client 或文件系统。
3. **默认只读，逐级授权**：工具按读取、可逆写入、执行、高危破坏四级管理。
4. **显式上下文**：`projectId/sessionId/requirementId/targetId/datasourceId` 必须作为参数传递，不依赖隐藏的“当前项目”。
5. **无协议级粘性状态**：多轮状态通过 `agentRunId/taskId/sessionId/approvalId` 等显式句柄传递，任一 Pod 可处理下一次请求。
6. **最小数据披露**：列表默认分页，日志默认截尾，代码按文件读取，密钥只返回掩码和配置状态。
7. **计划与执行分离**：Agent 可以自动生成计划；有副作用的步骤逐项通过策略引擎和审批门。
8. **失败不隐式降级**：预览调用失败不得重试测试实例，生产操作失败不得切换目标，写操作必须具备幂等键。
9. **生产与预览隔离**：需求编号只参与预览/测试联调；生产部署和访问不需要需求标签。

## 3. 总体架构

```text
IDE / Desktop / Enterprise Agent        Web 内置 Agent
                │ OAuth 2.1                  │ 用户 JWT + 内部委托
                └─────────────┬──────────────┘
                              ▼
                    MCP Gateway（API Pods）
             协议适配 / 鉴权 / schema / 限流 / 审计
                              │
                    Tool Policy & Approval
                              │
       ┌───────────────领域能力提供器───────────────┐
       │ project workspace git requirement preview │
       │ deploy k8s database kafka logs tasks admin │
       └───────────────────┬───────────────────────┘
                           ▼
                    现有 NestJS Services
                           │
       PostgreSQL / Redis-BullMQ / RWX / K8s / Kafka / OpenSearch
```

新增代码建议：

```text
apps/api/src/mcp/
  mcp.module.ts
  transport/                 # 2026-07-28 与兼容协议适配
  auth/                      # OAuth resource server、内部委托身份
  catalog/                   # tool/resource/prompt 注册表
  policy/                    # 风险分级、授权、审批、限流
  invocation/                # 幂等、审计、结果裁剪
  providers/                 # 各领域 handler，仅调用 Service
apps/api/src/agent-v2/
  orchestrator.service.ts
  planner.service.ts
  run-worker.service.ts
  context-builder.service.ts
  profiles/
```

MCP Gateway 作为无状态 API 能水平扩容；Agent Run、审批、任务状态写 PostgreSQL，耗时执行进入 BullMQ Worker。不要为 MCP 开启 sticky session。

## 4. 协议与传输

### 4.1 远程接入

- 统一端点：`POST /api/mcp`（受 Nest 全局 `/api` 前缀约束），仅 HTTPS；
- 首选 MCP `2026-07-28` 的无状态 HTTP 核心；
- 校验 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 与 JSON-RPC body 一致；
- `tools/list`、resources 和 prompts 返回明确 `ttlMs/cacheScope`，涉及用户权限的目录只能使用 private/user scope；
- W3C `traceparent/tracestate/baggage` 进入现有 OpenTelemetry 链路；
- 请求体、schema 深度、单次 tool result、分页大小和执行时间均设硬上限；
- 不支持 JSON-RPC batch，避免批量调用绕开逐项授权与限流。

### 4.2 本地开发接入

可选提供独立 stdio bridge。bridge 本身不包含业务凭证，通过浏览器完成平台登录后在系统密钥链保存短期令牌；它仍调用远程 MCP Gateway，不直接读取服务器工作区。生产部署不内置 stdio server。

### 4.3 版本兼容

Gateway 内部先归一化为平台自己的 `McpInvocation`。旧版 `initialize/Mcp-Session-Id/Streamable HTTP` 只存在于边缘 adapter，领域工具完全不感知协议版本。新能力优先按 `2026-07-28` 实现；兼容层到期时间需在客户端覆盖率达到要求后单独决策。

## 5. 身份、权限与审批

### 5.1 外部 MCP Client

- MCP Gateway 是 OAuth Resource Server；
- 使用 OAuth 2.1 Authorization Code + PKCE；
- 发布 Protected Resource Metadata，并验证 token issuer、audience/resource、scope、过期时间和撤销状态；
- access token 必须明确绑定 MCP Gateway audience，禁止 token passthrough；
- Gateway 调用下游平台 Service 时使用已经解析的用户身份，不转发 MCP token 给 Kafka、Kubernetes、数据库或模型服务；
- 第三方凭证授权采用独立 URL 流程，禁止通过 elicitation 表单索取 API Key、密码或 token。

### 5.2 内置 Agent

内置 Agent 使用短期、单用途的内部委托令牌：

```json
{
  "sub": "user-id",
  "actor": "agent-run-id",
  "aud": "codegen-mcp",
  "permissions": ["project:read", "requirement:read"],
  "resourceBounds": { "projectIds": ["..."], "teamIds": ["..."] },
  "exp": 1780000000
}
```

令牌权限是用户当前权限、Agent Profile 允许权限和本次授权范围的交集。权限或项目成员关系变更后，每次 tool call 仍实时复核，不依赖 token 中的旧角色。

### 5.3 风险等级

| 等级 | 含义 | 默认策略 | 示例 |
|---|---|---|---|
| R0 | 只读、低敏感 | 权限通过后自动执行 | 项目列表、文件树、需求详情、Kafka 指标 |
| W1 | 当前用户范围内可逆写入 | 首次展示计划，可按 Agent Run 授权 | 修改工作区文件、保存需求草稿 |
| X2 | 启动任务或改变共享运行状态 | 每次明确确认 | Git push、启动预览、执行部署、发送 Kafka 测试消息 |
| D3 | 破坏性、生产或敏感数据 | 平台审批对象 + 最终确认 | 删除 Topic、改消费位点、生产数据库写入、删除 Namespace |

审批不能只靠模型在文本中说“用户同意”。MCP 返回 `input_required` 或平台 `approvalId`，客户端展示目标、影响范围、参数摘要、差异、过期时间；用户确认后用审批句柄继续原调用。审批绑定 `userId + toolName + normalizedArgumentsHash + resourceVersion`，任何参数变化都必须重新审批。

### 5.4 现有权限映射

MCP 不新增“超级 Agent”权限。工具分别映射现有权限，例如：

- 项目/文件/Git：`project:read`、`project:write` 加项目 `read/edit/manage`；
- 需求：`requirement:read/manage/stage-update` 加负责人、阶段负责人、开发负责人规则；
- 生成与个人预览：`generate:execute` 加 Session 所有权；
- 共享部署：`deploy:execute`；运行目标和绑定：`deploy-target:manage` 加项目 owner/maintainer；
- 数据库：`datasource:manage` 加数据源 owner/member 和现有 DatabaseApproval；
- Kafka：`kafka:read/produce/topic-manage/group-manage`；
- 运维：`namespace:manage`；后台：`admin:*`、`audit:read`、`system-setting:manage`。

## 6. MCP 能力目录

工具使用稳定的 `domain.action` 名称。所有 list/search 工具必须分页；所有写工具接受 `idempotencyKey` 和已知资源版本（存在 `updatedAt/version` 时）。以下目录覆盖当前项目全部业务域。

### 6.1 项目、成员与仓库

| 类型 | 能力 |
|---|---|
| resources | `codegen://projects/{projectId}`、`codegen://projects/{projectId}/repository`、`codegen://projects/{projectId}/members` |
| R0 tools | `project.list/get`、`project.repository_get`、`project.member_list` |
| W1 tools | `project.create_empty`、`project.import_git`、`project.update`、`project.repository_set`、`project.member_add/update/remove` |
| D3 tools | `project.delete_request`，只发起现有异步回收流程，不同步硬删除 |

Git 导入凭证只引用 `gitCredentialId`，工具入参和结果不得出现密码/token。仓库 URL 必须通过现有 SSRF 与协议校验。

### 6.2 Session、用户工作区与文件

| 类型 | 能力 |
|---|---|
| resources | `codegen://sessions/{sessionId}`、`codegen://sessions/{sessionId}/tree/{path}`、`codegen://sessions/{sessionId}/files/{path}` |
| R0 tools | `session.list/get`、`workspace.tree`、`workspace.file_read`、`workspace.search`、`workspace.changes` |
| W1 tools | `session.update`、`workspace.file_write`、`workspace.patch_apply`、`workspace.format_file` |

所有路径先经过 workspace 根目录归一化、符号链接检查、文件类型/大小/总量配额。MCP 不提供任意绝对路径、Shell、宿主文件或其他用户 Session。写入沿用 `workspace:${projectId}:${userId}` 分布式锁；返回 before/after hash 和 diff 摘要。

### 6.3 Git

| R0 | `git.status`、`git.branch_current/list`、`git.commit_list/diff`、`git.remote_get`、`git.conflict_detail` |
| W1 | `git.branch_create/checkout/delete`、`git.rollback`、`git.remote_set`、`git.fetch`、`git.sync`、`git.conflict_resolve/continue/abort` |
| X2 | `git.push` |

Agent 不得自行切换另一用户的工作区。push 必须展示 remote、branch、ahead commits 和是否 force；首版不提供 force push。Git 身份始终来自当前平台用户配置。

### 6.4 代码生成 Agent 与任务中心

| R0 | `generation.task_get/list`、`generation.changes`、`generation.queue_health` |
| X2 | `generation.run`、`generation.retry`、`generation.cancel` |
| 管理 | `generation.admin_list/cancel/reprioritize`、`generation.dlq_list/replay/remove` |

现有 `Task + BullMQ + Worker` 继续作为执行底座。MCP Tasks extension 可映射平台 Task，但数据库 Task 才是事实源。结果只保存用户可见事件、tool call 摘要、diff 和日志，不保存隐藏 chain-of-thought。

### 6.5 需求管理与流水线

| resources | `codegen://requirements/{requirementId}`、`.../document`、`.../revisions/{version}`、`.../topology`、`.../activity` |
| R0 | `requirement.list/get/metadata/revision_list`、`requirement.route_topology` |
| W1 | `requirement.create/update`、`requirement.document_save`、`requirement.stage_update`、`requirement.project_add/update/remove` |
| X2 | `requirement.branch_create`、`requirement.status_transition` |

所有操作复用负责人/阶段负责人规则、乐观锁和需求 advisory lock。Agent 可以根据 Markdown 生成方案、拆阶段和总结活动，但不能替负责人跳过阶段。需求编号仅用于预览联调，不进入生产部署工具。

### 6.6 个人预览与需求路由

| R0 | `preview.status/logs/build_list/build_metrics`、`preview.route_resolve`（仅受信任内部 Agent） |
| X2 | `preview.start/stop`、`preview.build_cancel` |
| 管理 | `preview.admin_build_list/cancel` |

需求预览必须携带 `requirementId`，并继续校验开发负责人、需求分支、ServiceKey 唯一性、测试 Service 与 NetworkPolicy。生产 Agent Profile 不注册 `preview.route_resolve`，生产访问不要求 `X-Codegen-Requirement`。

### 6.7 部署中心、运行目标与 Registry

| resources | `codegen://deployments/{projectId}`、`codegen://deployments/{projectId}/records/{id}`、`codegen://targets/{id}` |
| R0 | `deployment.project_list/binding_list/status/record_list`、`target.list/get`、`registry.list` |
| W1 | `deployment.binding_save/remove`、`target.create/update`、`registry.create` |
| X2 | `deployment.execute/stop` |
| D3 | `target.delete`、`registry.delete` |

部署必须明确 `projectId + bindingId + branch + expectedGitSha`。生产部署工具永远是 X2/D3 策略，不因 Agent 是需求负责人而自动授权。模型只能引用 `registryId/targetId`，不能读取其加密配置。

### 6.8 Kubernetes

| R0 | `k8s.namespace_list`、`k8s.pod_list/get/logs`、`k8s.deployment_list`、`k8s.service_list` |
| X2 | `k8s.deployment_scale/restart`、`k8s.preview_namespace_provision` |
| D3 | `k8s.pod_delete`、`k8s.namespace_create/delete` |

首版不提供 `kubectl apply`、exec、port-forward、Secret read 或任意 Kubernetes object CRUD。Namespace 必须属于目标 `businessNamespaces` 或平台生成的团队预览 Namespace；日志执行脱敏、截断和时间范围限制。

### 6.9 数据源、SQL 与数据迁移

| resources | `codegen://datasources/{id}`、`.../databases/{db}`、`.../tables/{table}/schema`、`.../approvals/{id}` |
| R0 | `datasource.list/get/member_list`、`database.list/table_list/table_describe`、`database.query_explain`、`database.approval_list/get`、`database.transfer_list/preflight` |
| W1 | `datasource.create/update/member_manage/approver_set`、`database.query_read`、`database.export_request`、`database.transfer_create` |
| D3 | `database.query_write_request`、`database.import_request`、`database.restore_request`、`database.approval_approve/reject`、`datasource.delete` |

禁止暴露通用 `sql.execute`。读查询和写查询使用不同工具；服务端 AST/语句类型检查、超时、行数和结果字节限制继续生效。生产写入、导入和恢复必须走现有 `DatabaseApproval/DatabaseTransfer`，Agent 只能提出申请，审批者 Agent 也不能替用户自动确认。结果默认掩码，禁止模型批量读取敏感列。

CDC/binlog 当前只有设计文档，因此仅提供 `database.cdc_plan_read` resource，不声明可执行工具，直到实现完成。

### 6.10 Kafka

| resources | `codegen://kafka/topics/{topic}`、`.../config`、`codegen://kafka/groups/{groupId}` |
| R0 | `kafka.topic_list/get_config/metrics/message_sample`、`kafka.group_list/offsets/lag` |
| X2 | `kafka.message_produce`（必须标记 testMessage、限制大小并确认环境） |
| D3 | `kafka.topic_create/partition_increase/config_update/delete_records/delete`、`kafka.group_offset_set/delete` |

消息样本限制时间窗、条数和总字节，对 header/key/value 脱敏。删除、截断和位点修改继续要求 confirmation，同时增加 approvalId、当前 offset 快照和目标环境确认。Agent 不得自动遍历全部 Topic 内容。

### 6.11 定时任务

| R0 | `schedule.application_list/task_list/execution_list/queue_health` |
| W1 | `schedule.application_create/task_create/status_update` |
| X2 | `schedule.run_now/execution_cancel` |
| D3 | `schedule.approve/reject` |

注册回调接口不作为 MCP tool 暴露。Agent 创建任务后仍需沿用发布审批，不能通过 `run_now` 绕开任务审批状态。

### 6.12 业务日志、指标、链路与告警

| resources | `codegen://logs/projects/{projectId}`、`codegen://metrics/platform`、`codegen://traces/{traceId}` |
| R0 | `logs.search/metrics`、`metrics.platform/resource`、`trace.search/get`、`alert.rule_list/event_list`、`platform.health` |
| W1 | `alert.rule_create/update/delete`、`log_source.create/update/delete/rotate_token` |
| X2 | `alert.notification_test` |

日志与 Trace 必须按项目可见性过滤，查询时间窗、聚合桶数、返回字节均有限制；日志接入 token 只在创建/轮换时一次性返回给明确的人类调用，不进入 Agent 上下文或任务日志。

### 6.13 用户、团队、角色、审计和系统设置

| R0 | `team.list/get`、`audit.list/facets`、`admin.user_list/role_list`、`crypto.rotation_status` |
| W1 | `team.create/update/member_add/remove`、`admin.user_update/role_assign`、`admin.role_create/update` |
| D3 | `team.delete`、`admin.user_disable/delete`、`crypto.rotate`、`system.setting_update` |

后台类工具默认不进入通用 Agent，只注册给独立 Admin Agent Profile。审计日志只读、不可由 MCP 删除。密钥轮换工具只接受新 key reference，不返回任何密钥材料。

### 6.14 模型与 Agent 配置

| R0 | `model.list`、`agent.profile_list/get` |
| W1 | `model.create/update/delete/set_default`、`agent.profile_create/update` |
| X2 | `agent.run/cancel/resume` |

模型 API Key 使用 URL/页面安全录入，不允许 Agent、prompt 或普通 elicitation 收集。MCP 结果仅返回 `keyMasked`。

## 7. Resources 与 Prompts

Resources 适合稳定上下文，不承担副作用。URI 必须使用不可猜测 ID 后再做授权，不能因为知道 URI 就获得访问权。推荐 prompts：

- `project.code_review`：项目/Session/变更范围 → 静态审查；
- `project.implement_requirement`：需求文档 + 指定关联项目 → 生成修改计划；
- `requirement.design`：业务描述 → Markdown 方案草稿与阶段责任建议；
- `requirement.progress_summary`：阶段、提交、预览、活动 → 周报；
- `preview.diagnose`：构建日志、Pod 状态、事件 → 故障定位；
- `deployment.release_checklist`：分支、Git SHA、需求交付状态、目标环境 → 发布清单；
- `database.query_assistant`：schema + 用户目的 → 只读 SQL 草稿；
- `kafka.lag_diagnose`：Topic 指标、消费者状态、lag → 原因建议；
- `incident.analyze`：日志、指标、Trace、部署记录 → 事件时间线。

Prompt 返回的是可编辑模板，不自动调用写工具。

## 8. Agent 体系

### 8.1 Agent Profiles

| Profile | 默认能力 | 明确禁止 |
|---|---|---|
| Coding Agent | 工作区、文件、Git 只读/写、生成、个人预览 | 共享部署、数据库写、K8s 管理 |
| Requirement Agent | 需求文档、阶段、项目拓扑、进度汇总 | 代替负责人跳过阶段、生产发布 |
| Data Agent | schema、只读查询、导出/变更申请 | 明文凭证、无审批写 SQL |
| Kafka Agent | 指标、消息样本、lag 诊断、测试发送申请 | 自动删 Topic、自动改位点 |
| Release Agent | Git SHA、构建记录、部署计划、执行确认 | 需求标签控制生产、自动批准生产 |
| Ops Agent | K8s 只读诊断、日志、指标、受控重启扩缩容 | exec、Secret、任意 apply |
| Incident Agent | 日志/指标/Trace/部署关联分析 | 默认不具备任何写工具 |
| Admin Agent | 用户、角色、团队、审计辅助 | 默认关闭，必须单独启用并逐次审批 |

### 8.2 编排流程

```text
用户目标
  → Context Builder 解析显式资源范围
  → Planner 生成步骤与风险等级
  → Policy Engine 裁剪可用工具
  → R0 自动执行 / W1 按 Run 授权 / X2-D3 请求审批
  → Worker 执行耗时任务
  → Verifier 读取结果、版本和副作用
  → 汇总用户可见结果与审计引用
```

高风险场景采用“计划 Agent”和“执行器”分离：模型产出结构化参数，确定性代码负责 schema 校验、权限检查、幂等和 Service 调用。模型永远不能直接连接基础设施。

### 8.3 上下文与记忆

- 短期上下文绑定 `AgentRun`，包含用户消息、公开 tool result、资源句柄和摘要；
- 项目长期知识以版本化 Markdown/resource 保存，不能藏在模型厂商会话里；
- `session.agentContextId` 可继续兼容现有 provider，但不作为授权依据；
- 跨项目记忆默认禁止；团队知识必须创建显式文档并经过项目权限；
- secret、完整 Kafka 消息、数据库结果集和日志原文不进入长期记忆。

## 9. 建议数据模型

新增表建议：

- `McpClient`：clientId、名称、redirectUris、状态、允许 scope；
- `McpGrant`：userId、clientId、scope、资源边界、过期/撤销时间；
- `McpInvocation`：requestId、协议版本、client/user/agentRun、tool、参数 hash、风险、状态、耗时、traceId、结果摘要；
- `ToolApproval`：tool、参数 hash、资源版本、申请人、审批人、状态、过期时间、一次性 nonce；
- `AgentProfile`：系统 profile 或团队 profile、模型策略、允许工具、最大步骤/成本；
- `AgentRun`：用户、profile、项目/需求/Session、目标、状态、预算、取消时间；
- `AgentStep`：runId、序号、tool、approvalId、输入摘要、输出摘要、状态、重试次数；
- `AgentArtifact`：计划、patch、报告等对象的 URI、hash、大小和保留期。

参数原文只在确有审计必要时加密保存；常规审计保存规范化 hash 和脱敏摘要。ToolApproval、AgentRun 和长任务均使用不可猜 UUID，终态不可回退。

## 10. 安全设计

- 对 tool description、resource、项目文件、日志、数据库内容和 Kafka 消息一律视为不可信数据；其中出现的“忽略规则/调用工具”不能改变系统策略；
- 工具目录由服务端策略裁剪，不能仅依赖模型“不要调用”；
- tool output 与用户指令分通道标记，禁止把资源文本拼进 system prompt；
- 写文件后继续执行现有 workspace quota、symlink 和 Git diff 门禁；
- URL、Git remote、模型 baseUrl、日志源和 webhook 统一走 SSRF allowlist/DNS 重绑定防护；
- 所有凭证使用现有 CryptoService/External Secrets，MCP 日志统一调用脱敏器；
- 对相同 `idempotencyKey + user + tool` 返回原结果；参数不同则冲突；
- 高危工具限制并发、速率、时间窗和环境，生产 D3 可要求双人审批；
- MCP Apps 若以后启用，只运行在 sandboxed iframe，UI 发起的动作仍通过同一 tool policy 和审计；首期不启用远程 HTML UI；
- 不使用 MCP sampling 作为核心编排依赖，平台直接调用已配置模型 provider，保留对不同模型供应商的控制；
- 不向外部 MCP Client 暴露内部预览路由 token、快照下载 token 或下游 OAuth token。

## 11. 多 Pod、任务与一致性

- MCP HTTP 层无状态，所有审批和运行句柄写 PostgreSQL；
- 代码写入、Git 和需求继续使用现有 workspace lock/advisory lock；
- 生成、部署、预览构建、导入导出等耗时工具返回 task handle，由 BullMQ Worker 执行；
- task 状态以数据库为准，Redis 只做队列；Worker 重启执行现有状态校准；
- AgentStep 使用唯一约束 `(runId, stepNo)`，McpInvocation 使用 requestId/idempotencyKey 唯一约束；
- Worker 领取副作用步骤前再次校验审批、权限、资源版本和目标环境；
- 取消是状态机操作，不承诺已经提交给外部系统的不可撤销动作能回滚；结果必须明确 `cancelled` 与 `completed_after_cancel_request`。

## 12. 错误与结果契约

tool result 同时返回简短文本与 `structuredContent`。业务错误沿用 `docs/api-errors.md` 的稳定 code，并增加：

- `MCP_AUTH_REQUIRED`、`MCP_TOKEN_AUDIENCE_INVALID`；
- `MCP_TOOL_NOT_ALLOWED`、`MCP_RESOURCE_SCOPE_DENIED`；
- `MCP_APPROVAL_REQUIRED/EXPIRED/MISMATCH`；
- `MCP_IDEMPOTENCY_CONFLICT`；
- `MCP_RESULT_TOO_LARGE`；
- `AGENT_STEP_LIMIT_EXCEEDED`、`AGENT_COST_LIMIT_EXCEEDED`；
- `AGENT_RESOURCE_VERSION_CONFLICT`；
- `AGENT_HUMAN_INPUT_REQUIRED`。

错误不得返回堆栈、SQL、kubeconfig、下游响应头或凭证明文。列表和大文件通过 resource link/分页返回，禁止把数十 MB 内容直接塞入模型上下文。

## 13. 审计与可观测性

每次调用记录：requestId、traceId、clientId、真实用户、AgentRun、tool、风险等级、资源类型/ID、参数 hash、审批 ID、结果状态、耗时、输出大小。写操作继续生成现有 AuditLog；Agent 调用不是“系统用户”，审计同时保留 `actorUserId` 和 `agentRunId`。

建议指标：

- MCP 请求量、错误率、P50/P95/P99、schema/权限拒绝数；
- 各 tool 调用量、审批通过/拒绝/过期率；
- Agent 成功率、平均步骤数、取消率、模型 token/费用；
- 每团队并发、队列等待、Worker 饱和度；
- prompt injection 命中、敏感数据脱敏、越权尝试；
- 生产操作按用户、Agent、目标和审批人统计。

## 14. 分阶段实施

### Phase 0：协议和安全底座

实现无状态 MCP Gateway、OAuth resource metadata、内部委托令牌、catalog、统一 schema/错误/审计、R0/W1/X2/D3 策略和 ToolApproval；先不接模型。

当前已落地的最小安全骨架：MCP TypeScript SDK v2、默认关闭的无状态 Gateway、精确 Host/Origin 校验、平台 JWT 鉴权、按权限裁剪的统一工具目录、结果字节上限和调用审计。已接入的 R0 工具覆盖平台、项目、需求、工作区、Git、预览、部署、Kubernetes、Kafka、定时任务非敏感状态、业务日志聚合指标、带项目归属校验的精确 Trace，以及数据源摘要、数据库/表列表和关系型表结构。数据库工具额外要求 `datasource:manage` 和数据源成员授权；摘要路径不解密连接配置，实时 Schema 路径才在服务端临时使用凭证。MongoDB 首版只列数据库/集合，不通过 describe 读取真实示例文档。数据源 REST 与 MCP 响应均明确排除 `encryptedConfig`，密文不得离开 API 服务。Kafka 工具不返回消息正文或敏感配置值，Kubernetes 不开放日志、Secret、ConfigMap 内容和变更操作；定时任务不返回参数、结果及错误正文，业务日志目前只开放项目级聚合指标。Trace 只有在所有 Span Resource 都携带唯一且匹配的 `codegen.project.id` 时才可通过 MCP 精确读取，并剔除 attributes、事件和状态消息；全局 Trace 搜索仍不开放。平台生成的 Kubernetes 正式部署和个人预览会覆盖注入该 Resource Attribute，并使用集群可访问的 `OTEL_EXPORTER_OTLP_ENDPOINT`，不再写死 Docker Desktop 的 `host.docker.internal`。该属性只能由受信任 Collector 或平台管理工作负载注入；Collector 的 OTLP 接收端必须受 NetworkPolicy/认证保护，不能暴露给不可信网络。业务工具受默认关闭的 `MCP_READ_TOOLS_ENABLED` 独立控制。当前只允许内部平台身份；OAuth resource metadata、委托令牌和审批尚未完成前，不开放外部客户端及写工具。

现有 Web/REST Trace 接口也已收口到相同规则：搜索和详情必须显式提供 `projectId`，先校验项目成员关系；搜索在 TraceQL 项目条件之外逐条复核完整 Trace，任何 Span 缺少项目标识或出现混合项目标识时均过滤，详情返回统一的“不存在或不可访问”。Trace Explorer、异常中心及其日志跳转保持同一项目上下文。历史无项目标识的数据不迁移、不推断归属，也不兼容放行。

ToolApproval 持久化基础已经落地：审批单绑定申请用户、MCP Client、tool、风险等级、目标业务权限、环境、资源与版本、规范化参数 SHA-256 和有效期，但不保存原始工具参数；供人审阅的结构化摘要会限制深度、字段数和字符串长度，并按敏感字段名强制脱敏。REST 与 MCP 提供“我的审批单”只读查询，人工 REST 入口提供按 ID 审阅、批准、拒绝和申请人取消；服务端申请与原子消费方法供后续具体写工具调用。现阶段仍没有 MCP 副作用工具。

审批状态机已进一步实现，但依然没有接入具体副作用工具：`mcp-approval:review` 仅分配给管理员、发布负责人和运维负责人；审批人除该权限外还必须具备审批单快照中的全部目标业务权限。人工 REST 接口支持按 ID 安全查看、批准和拒绝，申请人可取消自己的未消费审批。D3 禁止申请人自审。执行器内部通过包含申请人、Client、tool、参数哈希和资源版本的单条条件更新，将 `approved` 原子领取为 `consuming`，随后只能落为 `consumed` 或 `execution_failed`。审批仍不会触发执行，MCP 也不开放批准/拒绝工具，避免 Agent 代替真人完成授权。

待审批分配采用显式 `reviewerIds` 快照，而不是把持有审批角色的所有人视为审批人。创建申请时领域策略必须给出至少一名有效审批人；待审批列表只返回 `reviewerIds` 包含当前用户、状态仍为 `requested` 且未过期的记录，并再次校验当前用户仍拥有审批单要求的全部业务权限。按 ID 查看、批准和拒绝同样执行这两层检查。前端“Agent 审批”菜单仅对 `mcp-approval:review` 可见，页面只展示上述属于当前用户的待办。

### Phase 1：只读全域

开放项目、需求、工作区、Git、部署状态、K8s 状态、数据库 schema、Kafka 指标、日志/Trace、任务和健康信息。用只读 Agent 验证权限裁剪和多租户隔离。

### Phase 2：Coding 与 Requirement Agent

把现有 Claude Agent 文件工具迁移到平台 MCP workspace 工具，接入需求文档、分支、patch、生成任务和个人预览。保留确定性构建/Git 门禁，默认不开放共享部署。

### Phase 3：Data、Kafka 与 Observability Agent

接只读查询和诊断，再接审批申请、测试消息、告警规则等受控写操作。数据库/Kafka 的 D3 操作必须完成审批模型后才上线。

### Phase 4：Release 与 Ops Agent

接部署计划、明确确认后的部署/停止、K8s 重启扩缩容。生产环境采用独立 Agent Profile、独立 scope 和更严格审批。

### Phase 5：外部生态

开放经过登记的 IDE/桌面/企业 Agent Client，提供 SDK 示例、兼容性矩阵、scope 管理、客户端撤销和安全运营页面。

## 15. 验收标准

- 能通过一个 MCP endpoint 发现并使用全部已授权业务域，未授权工具不会出现在目录中；
- 同一用户在 MCP、Web 和 REST 下得到一致的项目/资源权限结果；
- Agent 无法访问其他用户工作区、未授权项目、Secret 或任意基础设施接口；
- 所有 X2/D3 调用在没有有效审批时均无法执行，参数变更使审批失效；
- 多 API/Worker Pod 下无粘性会话要求，重复请求不会重复部署、发送消息或执行数据变更；
- 生产部署和访问不依赖需求标签；
- 每个副作用步骤都能关联真实用户、AgentRun、审批和 trace；
- 模型不可用时 MCP 只读/确定性工具仍可独立工作；
- 任一 MCP Client 可被立即撤销，已有短期 token 到期后不能继续访问；
- 协议升级只修改 transport adapter，不修改领域工具实现。

## 16. 关键决策

1. 采用一个逻辑 MCP Gateway，按领域拆 provider，不为每个模块部署独立公网 MCP Server；降低 OAuth、审计和授权复杂度。
2. MCP handler 只调用领域 Service，不包装现有 HTTP Controller，也不直连存储或基础设施。
3. 平台 Agent 与外部 MCP 使用相同工具目录和策略引擎，但使用不同认证入口。
4. 先覆盖只读，再逐步开放写入；“工具全面”不等于“默认全部授权”。
5. 生产能力永远与个人预览/需求路由隔离。
6. 当前 Agent 的本地文件工具在迁移完成前保留；迁移后以 MCP workspace 工具为唯一写入口，避免两套策略漂移。

## 17. 规范依据

设计基于 MCP 官方 `2026-07-28` 版本方向：无状态协议、显式方法头、目录缓存、W3C Trace Context、扩展化 Tasks，以及 OAuth/OIDC 授权强化。落地前应使用所选官方 SDK 的 conformance suite 固定具体兼容版本。官方资料：

- [MCP 2026-07-28 正式发布说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [MCP 2025-11-25 Schema Reference](https://modelcontextprotocol.io/specification/2025-11-25/schema)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

## 18. 现有模块复用矩阵

MCP Module 不应把所有现有 Service 直接导出后自由组合。每个业务 Module 增加窄接口 `*McpFacade`，Facade 负责把 MCP 身份转换为现有 Service 所需的 `AuthUser/userId`，并隐藏凭证解析、底层 client 和内部专用方法。

| MCP Provider | 现有模块/Service | 当前可直接复用 | 实施前调整 |
|---|---|---|---|
| ProjectProvider | `ProjectModule/ProjectService` | 模块已导出 Service | 增加只暴露授权方法的 ProjectMcpFacade |
| SessionProvider | `SessionModule/SessionService` | 已导出 | 增加显式项目角色复核 |
| WorkspaceProvider | `FilesModule/FilesService`、`WorkspaceService` | FilesService 已导出 | 统一 patch、hash、版本冲突和路径 schema |
| GitProvider | `GitModule/GitService/GitSettingsService` | 已导出 | 通过 Session Facade 固定工作区，禁止 MCP 传物理路径 |
| RequirementProvider | `RequirementModule/RequirementService` | 已导出 | 保留完整 AuthUser，不能退化成 userId |
| PreviewProvider | `PreviewModule` | 目前只导出 PreviewService | 新增 PreviewMcpFacade；不要直接导出 Routing token/快照 Service |
| DeploymentProvider | `DeployModule` | 目前只导出 DeployTargetService | 新增 DeploymentMcpFacade，内部组合 DeploymentCenter/Deploy/Registry |
| KubernetesProvider | `K8sModule/K8sService` | 已导出底层 Service | 新增 K8sMcpFacade，只允许白名单动作，MCP 不接触 client 对象 |
| DatasourceProvider | `DatasourceModule/DatasourceService` | 已导出 | 返回安全视图，禁止 resolveConfig 结果流出 |
| DatabaseProvider | `DbQueryModule/DbQueryService` | 已导出 | 复用审批和传输状态机，拆分 read/request-write tools |
| KafkaProvider | `KafkaModule/KafkaService` | 模块未导出 | 新增 KafkaMcpFacade 并只导出 Facade |
| ScheduleProvider | `ScheduledTaskModule/ScheduledTaskService` | 已导出 | 注册回调和 dispatcher/worker 不进入 MCP |
| LogProvider | `BusinessLogModule/BusinessLogService` | 已导出 | 固定项目过滤、时间窗和脱敏结果 |
| TraceProvider | `TracingModule/TracingService` | 已导出 | 增加资源大小上限 |
| MetricsProvider | `ResourceMetricsModule/ResourceMetricsService` | 已导出 | 返回结构化指标，不返回下游认证信息 |
| HealthProvider | `PlatformHealthModule/PlatformHealthService` | 模块未导出 | 增加只读 HealthMcpFacade |
| TeamProvider | `TeamModule/TeamService` | 已导出 | 管理动作接 ToolApproval |
| AdminProvider | `AdminModule/AdminService` | 模块未导出 | 独立 AdminMcpFacade，默认不被 McpModule import |
| AuditProvider | `AuditModule/AuditService` | 已导出 | 只读，强制分页和时间范围 |
| ModelProvider | `ModelConfigModule/ModelConfigService` | 已导出 | create/update 不接受模型生成的 apiKey 参数 |
| CryptoProvider | `CryptoModule` | 仅导出 CryptoService | 只提供轮换状态/申请 Facade，绝不导出 encrypt/decrypt tool |

Facade 返回 MCP 专用 DTO，不能原样返回 Prisma 实体。`encryptedConfig/encryptedKey/webrtcTokenEnc/kubeconfig/password/token` 等字段即使调用者是管理员也不在 DTO 中出现。

## 19. 统一工具定义与调用包络

### 19.1 ToolDescriptor

平台目录中的每个工具除 MCP 标准字段外，还维护服务端私有元数据：

```ts
interface PlatformToolDescriptor {
  name: `${string}.${string}`;
  title: string;
  description: string;
  inputSchema: JsonSchema202012;
  outputSchema: JsonSchema202012;
  requiredPermissions: string[];
  projectCapability?: 'read' | 'edit' | 'manage';
  risk: 'R0' | 'W1' | 'X2' | 'D3';
  environments?: Array<'preview' | 'test' | 'gray' | 'production'>;
  idempotent: boolean;
  supportsTask: boolean;
  resultLimitBytes: number;
  timeoutMs: number;
}
```

`requiredPermissions` 只用于目录预裁剪，handler 内仍必须调用领域 Service 复核资源权限。目录按 `name` 确定性排序，同一用户权限未变化时返回稳定 ETag/ttl。

### 19.2 通用输入

写入或执行工具使用统一字段：

```json
{
  "projectId": "uuid",
  "expectedVersion": "2026-09-07T10:00:00.000Z",
  "idempotencyKey": "client-generated-uuid",
  "approvalId": "optional-uuid",
  "reason": "用户可见的操作原因"
}
```

- `expectedVersion` 只在资源支持版本时要求；
- `idempotencyKey` 对 W1/X2/D3 必填，有效期默认 24 小时；
- `approvalId` 只在策略要求时填写；
- `reason` 进入审计，不能作为授权证据；
- schema 设置 `additionalProperties: false`，防止模型夹带未审计字段。

### 19.3 通用输出

```json
{
  "ok": true,
  "requestId": "uuid",
  "resource": { "uri": "codegen://...", "version": "..." },
  "summary": "已更新 2 个文件",
  "data": {},
  "warnings": [],
  "nextActions": []
}
```

异步操作返回：

```json
{
  "ok": true,
  "task": {
    "taskId": "uuid",
    "kind": "deployment.execute",
    "status": "queued",
    "pollAfterMs": 2000,
    "expiresAt": "2026-09-08T10:00:00.000Z"
  }
}
```

不得用自然语言文本替代状态、版本、taskId 或审批信息；文本只用于人类摘要。

## 20. 审批状态机

```text
requested ──→ approved ──→ consuming ──→ consumed
      │           │              └──→ execution_failed
     │           └──→ expired/revoked
     └──→ rejected/cancelled/expired
```

规则：

- `requested` 保存 tool、风险、环境、规范化参数 hash、目标资源版本和影响摘要；
- 审批人不能仅凭 Agent 身份审批，必须有真实登录用户和相应业务权限；
- 数据库现有审批继续由数据源审批人处理，ToolApproval 只是 MCP 调用门，不能替代 DatabaseApproval；
- D3 默认禁止申请人与最终审批人为同一人；是否允许单人审批由环境策略显式配置；
- 执行 Worker 使用行锁把 approved 原子更新为 consuming；只有一个 Worker 可以消费；
- 下游调用前再次检查资源版本。版本变化将审批置为 revoked/mismatch，而不是使用旧批准执行新状态；
- execution_failed 不允许直接换参数重试；相同参数且确定未产生副作用时可由用户发起恢复；
- approvalId 不进入模型长期记忆，过期或消费后不能复用。

## 21. Agent Run 状态机

```text
draft → planning → ready → running ─┬→ input_required → running
                                    ├→ approval_required → running
                                    ├→ cancelling → cancelled
                                    ├→ succeeded
                                    └→ failed / timed_out
```

- `planning` 只读，不执行副作用工具；
- `ready` 保存用户可审阅的结构化计划和预计风险/成本；
- `running` 每次只推进一个已持久化 AgentStep；
- `input_required` 只询问非敏感业务信息；凭证录入返回安全页面 URL；
- `approval_required` 不占用模型或 Worker 计算资源；
- `cancelling` 阻止领取新步骤，并向当前可取消任务传递取消信号；
- 终态不可恢复为 running，重试创建新 AgentRun 并引用原 runId；
- 最大步骤、最大运行时间、最大模型 token/费用分别设置硬限制。

Agent Worker 不能把一次模型回复中的多个 tool calls 并发执行，除非它们全部为 R0、资源互不相关且目录元数据明确 `parallelSafe=true`。

## 22. 首批精确工具契约

Phase 1 首批工具用于验证端到端协议和权限，不追求副作用覆盖：

### `project.list`

```json
{
  "input": { "teamId": "uuid?", "search": "string?", "page": 1, "limit": 20 },
  "output": { "items": [{ "id": "uuid", "name": "string", "language": "string", "teamId": "uuid|null", "accessRole": "owner|maintainer|developer|viewer" }], "total": 1 }
}
```

### `workspace.file_read`

输入：`sessionId`、相对 `path`、可选 `startLine/endLine`。输出：UTF-8 文本、sha256、截断标记和当前 Git 状态。二进制文件只返回 resource link；单次默认不超过 256 KiB。

### `workspace.patch_apply`

输入：`sessionId`、unified diff、`baseFileHashes`、`idempotencyKey`。服务端先校验所有路径和 hash，再在 workspace lock 中整体应用；任一文件冲突则全部不写。输出 changedFiles、before/after hashes 和 diffStat。

### `requirement.get`

输入：`requirementId`。输出安全详情、阶段、关联项目、有效预览端点和最近活动；Markdown 正文使用 resource link，避免详情结果过大。

### `kafka.topic_metrics`

输入：topic 和有上限的时间窗口。输出过去窗口消息总数、当前 offset/lag、分区、消费者数、消费者状态和数据新鲜度；无 `kafka:read` 时工具不出现在目录。

### `deployment.plan`

只读工具。输入 `projectId/bindingId/branch`，输出解析后的 target、environment、Git SHA、镜像、数据源引用、风险和缺失条件，不执行构建或部署。后续 `deployment.execute` 必须引用未过期 `planId + expectedGitSha`。

## 23. 实施依赖与顺序清单

1. 固定 TypeScript MCP SDK v2 的精确版本和 conformance 基线；
2. 新增数据库模型与迁移：Client、Grant、Invocation、Approval、AgentRun/Step/Artifact；
3. 实现 MCP transport adapter 和 request context，不接任何领域工具；
4. 接 OAuth metadata、PKCE、audience/resource 校验和内部委托 token；
5. 实现 ToolCatalog、JSON Schema 2020-12 编译缓存和权限裁剪；
6. 实现 Invocation 幂等、结果上限、统一错误、审计和 OTel；
7. 实现 PolicyEngine 和 ToolApproval 状态机；
8. 为现有模块补窄 Facade，先接六个 Phase 1 工具；
9. 完成跨用户、跨团队、路径逃逸、token audience、审批复用等安全验证后再扩只读目录；
10. 实现 AgentRun/Step Worker，先使用只读 Incident/Requirement Agent；
11. 将 Coding Agent 文件访问迁移到 WorkspaceProvider；
12. 最后才开放 X2/D3，并按 Database → Kafka → Preview → Deployment → Ops 顺序逐域验收。

任何阶段都不能为了快速覆盖而直接把现有 Controller 批量转换为 tools。Controller 的权限装饰器、DTO 和审计可以作为核对依据，但不是 MCP handler 的安全边界。

## 24. 上线开关与回滚

建议配置：

```text
MCP_ENABLED=false
MCP_READ_TOOLS_ENABLED=false
MCP_RESULT_MAX_BYTES=1048576
MCP_EXTERNAL_ACCESS_ENABLED=false
MCP_PROTOCOL_VERSIONS=2026-07-28,2025-11-25
MCP_WRITE_TOOLS_ENABLED=false
AGENT_V2_ENABLED=false
AGENT_V2_ALLOWED_PROFILES=requirement-readonly,incident-readonly
```

开关按能力递进，不能只有一个总开关。回滚顺序为先关闭 Agent 新 Run，再关闭写工具，再关闭外部接入；已有异步任务继续由原 Worker 按数据库状态完成或取消。关闭 MCP 不删除 Grant、Invocation、Approval 和 AgentRun 审计数据。旧 Agent 在 Coding Agent 完成迁移并稳定运行前保持可用，但同一 Session 同时只能由一个 Agent 执行写操作。
