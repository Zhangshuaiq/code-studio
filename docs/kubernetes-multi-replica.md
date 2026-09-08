# Kubernetes 多副本部署约束

平台生产环境仅支持 Kubernetes 执行路径。API、Worker 和 Web 默认至少两个副本，生成与预览通过 Kubernetes Job 执行，不向平台 Pod 挂载 Docker Socket。

## 共享工作区

API 与 Worker 必须挂载同一个 RWX PVC 到 `/data`。上线前需由存储管理员验证：

- Pod 分布在不同节点时可以同时读写同一文件；
- rename、fsync、文件锁和权限变更符合 POSIX 预期；
- Git index lock、引用更新和 worktree 元数据在该存储上可靠；
- 单节点、单可用区和存储控制面故障不会静默返回陈旧数据。

确认完成后设置 `persistence.rwxVerified=true`。多副本使用 `emptyDir`、未确认 RWX，或由 Chart 创建但未声明 `ReadWriteMany` 时，Helm 模板会拒绝部署。

## 并发一致性

共享卷写操作按职责使用 Redis 分布式锁：用户文件保存、生成和 Git 写入使用 `workspace:<projectId>:<userId>`；worktree 元数据和项目清理使用 `repository:<projectId>`；部署使用 `deployment:<projectId>:<bindingId>`。因此同项目的不同用户可以并行编辑，各自工作区内仍保持串行。Redis 必须高可用且禁止驱逐锁键；租约由 `WORKSPACE_LOCK_LEASE_MS` 控制并自动续租，竞争等待由 `WORKSPACE_LOCK_WAIT_MS` 控制。

锁顺序固定为先确认仓库/worktree，再进入用户工作区操作。项目清理先获取仓库锁，然后按用户 ID 排序依次获取该项目的全部工作区锁，确认没有正在保存、生成或执行 Git 写入后才删除目录；禁止在持有用户工作区锁时反向创建 worktree，以避免跨 Pod 循环等待。

长耗时生成、构建、部署和清理由 Worker 执行。在线文件保存、冲突解决和分支操作为保持同步交互仍由 API 执行，但必须经过相同的分布式锁。部署当前记录 ID 保存在 PostgreSQL，不依赖 Pod 内存。

## 调度与可观测性

API、Worker 和 Web 默认使用同组件 Pod 反亲和，并按 `kubernetes.io/hostname` 以 `maxSkew: 1` 尽量分散。PDB 和 HPA 配置继续生效；生产集群应至少提供两个满足 nodeSelector、taint/toleration 和存储挂载条件的节点。

API 请求指标由 OpenTelemetry 导出并在外部指标后端聚合。平台不再展示单个 API Pod 的内存滚动指标；业务监控使用 OpenSearch 中的全局访问日志，基础设施指标使用 Prometheus。

## 上线前必填

- `runtime.generationExecutor=kubernetes`
- `runtime.dockerSocket.enabled=false`
- `runtime.localPreviewEnabled=false`
- `persistence.enabled=true`
- `persistence.rwxVerified=true`
- `K8S_GENERATION_WORKSPACE_CLAIM` 指向同 Namespace 的 RWX PVC
- 沙箱镜像固定为经过扫描和签名的 `name@sha256:digest`
- Redis、PostgreSQL、OpenSearch、Prometheus 与 OTLP 地址使用集群内高可用服务
