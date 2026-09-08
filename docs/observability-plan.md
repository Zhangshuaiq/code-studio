# 统一可观测与分布式链路实施计划

## 目标

平台以 OpenTelemetry 作为语言无关的采集与传播标准，统一接入 Browser、Node.js、Java、Go、Python 等运行时。语言仅作为检索标签，不形成彼此割裂的监控模块。

最终提供：

- 服务 CPU、内存、请求量、错误率和延迟监控；
- 按项目、环境、服务、语言、状态和耗时搜索 Trace；
- Trace 瀑布图、Span 总耗时、自身耗时和关键路径；
- Trace、日志、指标之间的关联跳转；
- HTTP、RPC、数据库、缓存、消息队列和后台任务统一追踪；
- 跨线程、异步回调、进程、服务和消息队列的 Context 传播；
- 错误、慢链路、资源异常告警及 Webhook 通知。

## 总体架构

```text
Browser / Node.js / Java / Go / Python
                    │ OTLP HTTP/gRPC
                    ▼
          OpenTelemetry Collector
             │       │       │
             ▼       ▼       ▼
           Tempo  Prometheus OpenSearch
           Trace   Metrics     Logs
             └───────┼─────────┘
                     ▼
             Code Studio 统一界面
```

本地开发使用单体 Tempo 与 Collector；Kubernetes 生产环境通过 Helm 配置外部或集群内可观测组件。生产数据存储必须使用持久卷或对象存储。

## 统一资源标签

所有 SDK 必须设置：

| 属性 | 说明 |
|---|---|
| `service.name` | 稳定服务名称 |
| `service.namespace` | 业务域或团队 |
| `service.version` | 构建版本 |
| `service.instance.id` | Pod/容器/进程实例 |
| `deployment.environment.name` | dev/test/staging/prod |
| `telemetry.sdk.language` | java/go/python/nodejs/webjs |
| `code-studio.project.id` | 平台项目 ID |
| `code-studio.team.id` | 平台团队 ID |

Kubernetes 环境额外补充 namespace、pod、node、container；标签禁止包含密码、Token、完整 SQL、请求正文和个人敏感信息。

## Trace Context 规范

- 跨网络统一采用 W3C `traceparent`、`tracestate`，可控场景使用 `baggage`；
- HTTP/gRPC 使用 SDK 自动注入和提取；
- BullMQ、Kafka、RabbitMQ 等将 Trace Context 写入消息元数据；
- 消费端提取 Context 后创建 `CONSUMER` Span；
- 长时间延迟的定时任务创建新 Trace，并通过 Span Link 关联创建 Trace；
- 不允许仅传递 Trace ID，也不允许序列化 SDK 内部 Context 对象；
- 外部不可信入口校验或重建 Trace Context，Baggage 不得包含敏感信息。

## 跨线程与异步传播

- Java：Java Agent 自动覆盖常用 Executor、CompletableFuture、Reactor；自定义线程池使用 `Context.current().wrap(...)` 或 `makeCurrent()`；
- Go：显式传递 `context.Context`，goroutine 创建时捕获并传入；
- Python：asyncio 使用 contextvars，线程池使用 `copy_context()`，跨进程按消息传播；
- Node.js：使用 AsyncLocalStorage Context Manager，worker_threads、child process、BullMQ 手动注入/提取；
- Browser：Fetch/XHR 注入 W3C Header，限定可信域名并配置 CORS。

## 查询与展示

链路搜索支持：时间范围、Trace ID、项目、环境、服务、语言、状态、最小/最大耗时、HTTP 路由、Span 类型、数据库系统和业务标签。

链路详情展示：

- Trace 总耗时、服务数量、Span 数量和错误数；
- 按父子关系组织的瀑布图；
- Span 开始时间、总耗时、自身耗时、状态、Attributes、Events；
- 异常类型、消息和堆栈；
- Trace ID/Span ID 关联日志；
- 同期 CPU、内存和请求指标。

自身耗时按“父 Span 区间减去所有直接子 Span 时间区间的并集”计算，避免并行子调用被重复扣除。

## 采样与保留

- 开发/测试默认 100%；
- 生产普通请求采用 ParentBased TraceIdRatio 采样；
- Collector 使用 Tail Sampling 保留错误、慢请求和关键任务；
- 本地 Trace 默认保留 72 小时；生产按容量配置 7～30 天；
- 日志、指标和 Trace 使用相同项目/环境/服务标签和租户边界。

## 实施阶段

1. 部署 OpenTelemetry Collector 与 Tempo，打通 OTLP 接收和 Trace 查询；
2. 统一 API、Worker 的资源标签与采样配置；
3. 贯通 HTTP、BullMQ、Java 定时任务的 W3C Context 与 Span Link；
4. 实现平台 Trace 搜索 API、Trace 详情转换、自身耗时与关键路径计算；
5. 在应用监控增加“服务概览 / 链路追踪 / 异常中心”；
6. 提供 Java、Go、Python、Node.js、Browser 接入模板；
7. 接入 Prometheus、容器与 Kubernetes 指标，完成 CPU/内存告警；
8. 完成端到端测试、数据保留、采样、脱敏和生产 Helm 配置。

## 当前实施状态（2026-08-27）

| 阶段 | 状态 | 已落地内容 |
|---|---|---|
| 1～2 | 已完成 | Docker Compose 已部署 Tempo 2.10.5 与 Collector 0.153.0；API、Worker 统一通过 OTLP/HTTP 上报 |
| 3 | 已完成 | HTTP 自动埋点；生成任务与 Java 定时任务在 BullMQ 中注入、提取 W3C Trace Context，并创建 Consumer Span |
| 4 | 已完成 | 提供 TraceQL 安全查询、Trace 详情转换、并行子 Span 去重后的自身耗时计算 |
| 5 | 进行中 | 已完成服务概览与链路追踪；异常中心、日志联动放在下一阶段 |
| 6 | 已完成 | 已提供 Java、Go、Python、Node.js、Browser 接入与跨线程传播示例 |
| 7 | 进行中 | Collector 已接收运行时指标并暴露 Prometheus 格式；Prometheus 存储、容器指标与告警规则待接入 |
| 8 | 进行中 | 本地构建、测试与真实链路查询已通过；生产采样、脱敏策略和 Helm 可观测组件依赖待完善 |

当前验证结果：API 与 Web 生产构建通过，API 34 项测试通过；测试账户发起真实请求后，Tempo 可按 `service.name=codegen-api` 搜索，选中 Trace 能返回 26 个 Span 及 22.7ms 总耗时。健康检查入口已从采样中排除，避免每 15 秒产生无业务价值的 Trace。

## 第二阶段执行计划

1. 部署 Prometheus，持久化 Collector 暴露的运行时指标，并通过 cAdvisor 采集本地容器 CPU、内存、网络、文件系统和重启状态；
2. 增加平台只读指标查询层，只开放预定义查询，不允许浏览器提交任意 PromQL；
3. 按服务、语言、环境和实例聚合 CPU、内存、事件循环/JVM/Go/Python 运行时指标，并提供时间序列；
4. 在应用监控增加资源总览、实例列表和 CPU/内存趋势，区分“无数据”和“组件不可用”；
5. 建立 CPU、内存、实例消失、错误率和慢请求的默认告警规则，复用已有 Webhook 通知能力；
6. 增加异常中心，汇总错误 Trace，并支持从异常跳转 Trace、从 Span 按 `traceId` 查询业务日志；
7. 补充 Kubernetes/Helm 的外部 Prometheus 地址、鉴权 Secret、NetworkPolicy 和生产部署说明；
8. 完成构建、测试、容器部署与真实 CPU/内存/Trace/日志联动验收。

第二阶段验收要求：指标查询接口不得成为 PromQL 代理；平台页面能看到 API/Worker 资源趋势和容器实时用量；停止一个实例能产生可识别的状态；错误 Trace 能进入异常中心；Trace 与日志之间使用 Trace ID 关联且不实时重复分析历史数据。

### 第二阶段进度（2026-08-27）

- 已部署 Prometheus 3.13.2 与 cAdvisor 0.60.5，指标保留 15 天，Collector 和容器指标每 15 秒采集；
- 已加入 CPU、内存和核心实例消失的默认 Prometheus 告警规则；
- 已提供受权限保护的固定资源查询 API，浏览器不能传入 PromQL；
- 应用监控已展示 API/Worker 实例数、CPU、内存、网络速率和时间趋势；
- 平台健康已纳入 Tempo 与 Prometheus，并修正生成执行器依赖名称；
- 已增加异常中心，错误 Trace 可跳转完整瀑布图或按 Trace ID 查询业务日志；
- Helm 已支持外部 Prometheus URL，以及 Bearer Token 或 Basic Auth Secret/ExternalSecret；
- 最终实测：API、Worker 均识别为 1 个活跃实例；CPU、工作集内存查询正常；平台数据库、Redis、生成执行器、OpenSearch、Tempo、Prometheus 六项依赖全部健康；错误 TraceQL 查询正常且当前时段无异常；
- 日志保留和告警评估调度已迁移至独立 Worker，API 副本不再执行周期轮询；PostgreSQL advisory lock 负责多 Worker 防重。
- 待完成项：将 Prometheus 规则事件接入统一通知分发、补充 Kubernetes ServiceMonitor/PrometheusRule 示例及错误样本自动化验收。

### Pod 指标与交互图表补充（2026-08-28）

- 应用监控新增 Pod 监控页面，支持 Namespace、Pod 和时间范围筛选；
- Pod 总览展示数量、Ready 数、CPU、内存与重启次数，详情展示 CPU、工作集内存、网络接收和网络发送趋势；
- 所有请求趋势、服务 CPU/内存趋势和 Pod 趋势统一使用按需加载的 ECharts 折线图，支持鼠标十字指示线、时间点 Tooltip、序列图例和容器尺寸自适应；
- Pod 查询仅允许固定 PromQL 模板，Namespace/Pod 标签经过格式校验；未接入 Kubernetes 指标时页面明确提示缺少数据源，不伪造零值图表；
- CPU、内存和网络依赖 kubelet/cAdvisor 指标；Ready、Phase、重启次数依赖 kube-state-metrics。集群内抓取参考 [`prometheus-kubernetes.example.yaml`](../deploy/observability/prometheus-kubernetes.example.yaml)。
- 本地验收结果：Namespace 与 Pod API 均返回 200；当前 Docker Compose 环境没有 Kubernetes 时返回 `sourceAvailable=false` 和空 Pod 列表；非法 Namespace 标签返回 400，避免标签注入 PromQL。

### 多部署目标集群监控（2026-08-28）

- Pod 监控的数据源归属于 `DeployTarget`，不是平台全局 Prometheus；每个 Kubernetes 部署目标独立保存 Prometheus URL 与 Bearer/Basic 凭证；
- 查询必须携带 `targetId`，服务端先校验目标可见权限、类型和启用状态，再解密该目标的数据源配置；禁止缺省回落到平台本机集群；
- 页面先选择“部署目标”，再选择该目标 Prometheus 返回的 Namespace，确保展示的是业务发布实际落点；
- kubeconfig 负责发布和 Kubernetes API 操作，Prometheus 负责历史资源指标，两者共同属于同一个部署目标；
- 目标集群只需一次性部署 kubelet/cAdvisor、kube-state-metrics 和 Prometheus 自动发现规则。之后发布到任何 Namespace 的新 Pod 都不需要修改平台或逐 Pod 配置。

### Docker Desktop Kubernetes 本机接入（仅开发验证）

- 已确认本机 `docker-desktop` context 和单节点集群正常运行；
- `codegen-observability` Namespace 内部署 kube-state-metrics 2.19.1 与 cAdvisor 0.60.5，通过本机 NodePort 30080/30081 仅供本地 Prometheus 抓取；
- Prometheus 将 Docker Desktop 的 `container_label_io_kubernetes_pod_namespace/pod_name/container_name` 重标记为标准 `namespace/pod/container`，因此平台查询逻辑可同时兼容 Docker Desktop 与标准 Kubernetes 指标；
- 实测 Prometheus 两个抓取目标均为 `up=1`，发现 5 个 Namespace；`kube-system` 返回 9 个 Pod，并能查询真实 CPU、工作集内存、Ready 状态和重启次数；
- 本机采集器声明位于 [`local-kubernetes-exporters.yaml`](../deploy/observability/local-kubernetes-exporters.yaml)，可重复执行 `kubectl apply`，不会依赖手工创建的临时资源。

#### 目标集群自动发现机制

无需为新 Pod 修改平台配置：部署目标集群内的 cAdvisor 以 DaemonSet 方式常驻每个节点并自动发现节点上的新容器；kube-state-metrics 使用 Kubernetes Watch 自动接收 Pod、Deployment、Job 和 Namespace 状态变化；该目标的 Prometheus 抓取这些稳定采集端点。前端 Namespace 与 Pod 列表每 30 秒刷新，实际出现时间还取决于目标 Prometheus 的采集周期。Pod 删除后历史时间序列继续保留，当前实例列表会在数据过期后自动消失。

本机 `docker-desktop` 是单节点，NodePort 指向唯一 cAdvisor。生产多节点集群应使用 `kubernetes_sd_configs`、ServiceMonitor 或 PodMonitor 发现每个 DaemonSet Endpoint，不能通过单个负载均衡 Service 抽样某一个节点。

## 验收标准

- Browser → API → BullMQ Worker → Java 服务能够保持关联或通过 Span Link 明确关联；
- 链路搜索可以按语言筛选并在详情中显示每个 Span 的准确耗时；
- Worker/API 重启不会破坏已进入队列任务的 Trace 元数据；
- 错误 Span 能跳转到同 Trace/Span 的日志；
- 未接入某种语言专属 Agent 时，不影响其他语言按统一协议接入；
- 生产入口不会接收或传播未过滤的敏感 Baggage。

多语言接入操作见 [`integrations/observability/README.md`](../integrations/observability/README.md)。
