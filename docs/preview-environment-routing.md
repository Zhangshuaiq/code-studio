# 需求级预览路由与测试环境回落

## 目标与隔离边界

代码编辑页的“部署预览”把当前用户工作区中的单个服务部署到 Kubernetes，供同一需求的协作者联调。它不是测试、灰度或生产发布。

- 文件与 Git 状态按 `userId + projectId` 隔离；
- 联调流量按不可变的 `requirementNo` 隔离；
- 服务以需求关联项目中的稳定 `serviceKey` 标识；
- 同一需求未覆盖的服务回落到运行绑定指定的默认测试 Namespace；
- 不携带需求标识的请求只访问默认测试环境。

`Requirement` 是需求上下文和路由标识的唯一事实来源，不再维护独立的用户级预览环境实体。`PreviewInstance` 使用 `requirementId + serviceKey` 关联具体覆盖实例。数据库部分唯一索引保证同一需求、同一服务最多存在一个 `starting/ready` 实例；并发竞争失败的一方必须补偿清理由本次请求创建的 Kubernetes 资源。

## Kubernetes 契约

预览 Deployment、Pod、Service 和 Ingress 至少携带：

```text
codegen.io/requirement-no=req-20260904-a1b2c3
codegen.io/service-key=order-service
codegen.io/owner-id=<userId>
codegen.io/project-id=<projectId>
codegen.io/session-id=<sessionId>
codegen.io/environment=preview
```

容器注入：

```text
CODEGEN_REQUIREMENT_NO=REQ-20260904-A1B2C3
CODEGEN_SERVICE_KEY=order-service
CODEGEN_FALLBACK_ENVIRONMENT=test
```

测试 Namespace 必须在运行目标的 `businessNamespaces` 白名单中。平台读取所选测试 Service 的 Pod selector 和 `targetPort`，NetworkPolicy 只允许预览工作负载与这些后端 Pod 在指定端口通信，不能开放整个测试 Namespace 或集群。

## 路由规则

`X-Codegen-Requirement` 只属于需求预览联调协议，不是项目部署或业务访问凭证。只有进入预览联调入口且用户明确选择某个进行中需求时，可信入口才注入该 Header；外部调用方不能任意伪造。联调链路中的 HTTP/gRPC 服务间调用继续传播该标识，适配器按 `(requirementNo, serviceKey)` 选择端点：

1. 存在健康的需求预览实例时，路由到预览；
2. 没有覆盖、尚未就绪或已经停止时，路由到默认测试实例；
3. 已选中的预览实例返回业务 4xx/5xx 时不得回落，防止掩盖问题或重复写入。

没有 `X-Codegen-Requirement` 的请求完全绕过需求路由解析，继续使用所在环境原生的 Service、注册中心或网关路由。测试、灰度和生产环境的部署、健康检查及正常业务访问都不要求需求编号。生产入口应主动删除外部传入的 `X-Codegen-Requirement`，并且不接入需求预览解析器，避免伪造 Header 将生产流量导向个人预览；如需生产灰度，必须使用独立的发布/灰度治理机制。

平台核心只定义以上契约。实际可由 Service Mesh、Spring Cloud/Nacos、API Gateway 或语言 SDK 实现；内部直连未经过网关时，仍需要 Mesh 或 SDK 在联调链路传播标识。该适配器只部署在预览与测试联调边界，不部署到生产请求链路。

## 路由控制面接口

平台维护 `RequirementRouteEndpoint` 注册表。只有 Kubernetes Deployment 存在 Ready 副本时才写入端点；starting、failed、stopped 状态立即摘除。写入与续租不信任状态检查调用方携带的需求标识：平台会重新读取预览实例，核对其 Ready 状态、需求生命周期、项目、会话、服务、目标集群和项目组隔离 Namespace，任何不一致都会摘除端点。同一需求的最终复核、旧端点替换和新端点写入处于 PostgreSQL advisory lock 保护的同一事务，多个 Worker 不能并发覆盖同一需求服务。独立 Worker 每 20 秒重新读取 Kubernetes 状态并续租，租约默认 90 秒，可配置范围限制为 30–300 秒；Worker 或目标集群不可用时，端点租约自然过期，解析结果安全回落测试环境，不依赖 API Pod 内存。

网关、注册中心插件或 Mesh 控制器通过内部接口解析路由：

```http
GET /api/internal/preview-routing/resolve?requirementNo=REQ-20260904-A1B2C3&serviceKey=order-service
X-Codegen-Routing-Token: <至少 32 字符的随机密钥>
```

预览覆盖返回 `route=preview`、目标集群、Namespace、Service、端口、集群内地址和租约截止时间；未覆盖返回 `route=test` 及项目预览绑定中的 `testNamespace/testServiceName/testServicePort`。每次解析都会复核当前运行目标仍启用、类型为 Kubernetes、用途包含 preview，并解密当前目标配置确认 `testNamespace` 仍在 `businessNamespaces` 白名单中。预览端点还必须同时匹配当前绑定目标、预览实例的需求与服务归属，以及根据当前项目组重新推导出的隔离 Namespace；Service 与端口必须符合 Kubernetes 规则，集群内 URL 由已校验字段实时生成，不直接信任数据库中的冗余 URL。任一检查失败都会忽略旧端点并安全回落测试环境。绑定失效、目标配置不可解析、测试回落未配置、Service 名称非法或 Namespace 已被移出白名单时明确返回 `route=unavailable` 及对应 reason，不能把旧地址或空地址当成默认服务；无法识别的需求服务返回 `route=not_found`。所有结果都包含 `retryToFallback=false`：适配器只能在选路阶段因“没有覆盖”回落，不能在预览服务返回业务错误后重试测试实例。适配器应按 `cacheTtlSeconds` 做短缓存，避免每个业务请求都查询控制面。

预览结果的缓存时间取端点剩余租期和 `PREVIEW_ROUTING_CACHE_TTL_SECONDS` 中的较小值，默认 10 秒且配置上限为 30 秒。这样即使 Worker 在刚续租后失联，网关也不会继续缓存预览地址到整个 90 秒租期结束；测试回落结果仍短缓存 15 秒。

`unavailable.reason` 当前包括：

- `preview_binding_not_available`：预览绑定不存在、已禁用、目标类型或用途不匹配；
- `preview_target_config_invalid`：目标加密配置无法解密或不是合法 JSON；
- `test_fallback_not_configured`：没有配置测试 Namespace；
- `test_fallback_namespace_denied`：测试 Namespace 已不在目标当前业务白名单；
- `test_fallback_service_invalid`：测试 Service 名称不符合 Kubernetes DNS 标签规则。

启动需求预览前，平台会读取测试 Service，确认其存在、端口已声明且具有非空 Pod selector。生成的 NetworkPolicy 同时使用测试 Namespace、Service selector 和实际 `targetPort` 限制互访，不再允许预览 Pod 访问测试 Namespace 内的任意工作负载；路由结果仍返回 Service 的对外 `port`。配置关闭或用途变化时也会删除旧的测试、公网及构建出口策略，防止历史放行残留。旧绑定若未配置 `testServiceName`，路由和部署校验暂以需求关联的 `serviceKey` 兼容；新建或重新保存绑定时 API 与界面都要求显式填写 Service 名称。

部署中心支持选择已有绑定重新编辑，并回填目标、分支规则、测试路由、镜像、Registry、快照地址、公网策略和数据源。保存时会保留界面暂未暴露的高级 JSON 参数，避免常规编辑意外清除 `env`、`dockerfile`、构建超时等配置；绑定用途与环境构成唯一标识，编辑期间不可修改这两个字段。

项目运行环境绑定属于项目级管理操作：除全局 `deploy-target:manage` 权限外，用户还必须是该项目的所有者或维护者。开发者和只读成员即使能够查看部署中心，也不能新增、修改或删除绑定；前端入口与后端鉴权使用相同规则。

该接口使用独立的 `PREVIEW_ROUTING_CONTROL_TOKEN`，不接受用户 JWT 替代。生产 Ingress 应限制 `/api/internal/*` 的来源网络；密钥通过 Kubernetes Secret 或 External Secrets 注入并定期轮换。

## 当前完成度

当前代码已经完成需求关联、服务唯一性、多 Pod 数据库约束、Kubernetes 标签/环境变量、测试 Namespace 白名单和网络策略，并在代码编辑页按需求选择部署。预览镜像不再从远程仓库默认分支构建：API 在用户工作区锁内生成不可变 `tar.gz`，保存到 API/Worker 共享卷；目标集群使用短期 256 bit Bearer 凭证下载，校验 SHA-256 后才交给 BuildKit。快照不包含 `.git`、点文件、依赖目录和构建产物，构建结束、取消或过期后回收。

部署时还必须满足：

- `PREVIEW_SNAPSHOT_ROOT` 位于 API 与 Worker 共同挂载的 RWX 卷；
- 每个预览绑定的 `sourceBaseUrl`（或全局 `PREVIEW_SOURCE_BASE_URL`）是目标集群可访问的 HTTPS 平台地址；
- NetworkPolicy 的构建出口允许访问该地址和镜像/依赖仓库；
- 快照 TTL 大于最大排队时间与构建超时之和。

尚未完成的关键链路是：

- 将实际网关、Nacos/Spring Cloud 或 Service Mesh 插件接到统一解析接口；
- 更细粒度的构建日志、资源指标和自动回收视图（需求服务拓扑、文档修订与基础路由活动时间线已具备）。

因此目前只能称为“需求级隔离部署基础”，不能宣称测试环境回落已经在真实流量链路生效。
