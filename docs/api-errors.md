# API 错误契约

所有 API 错误统一返回 `statusCode`、`code`、`message`、`requestId`、`timestamp` 和
`path`。客户端应使用 `code` 判断业务分支，只把 `message` 用于用户展示；未知服务端
异常固定返回 `INTERNAL_ERROR`，内部异常细节不会进入响应。

未单独领域化的参数错误暂时使用 HTTP 状态对应的通用错误码：
`INVALID_REQUEST`、`AUTH_REQUIRED`、`ACCESS_DENIED`、`RESOURCE_NOT_FOUND`、
`RESOURCE_CONFLICT`、`PAYLOAD_TOO_LARGE`、`RATE_LIMITED`、
`UPSTREAM_UNAVAILABLE` 和 `SERVICE_UNAVAILABLE`。

## 当前领域错误码

| 领域 | 错误码 | 含义 |
| --- | --- | --- |
| 项目 | `PROJECT_NOT_FOUND` | 项目不存在 |
| 项目 | `PROJECT_NOT_FOUND_OR_INACCESSIBLE` | 项目不存在或调用方不可见 |
| 项目 | `PROJECT_DELETING` | 项目正在删除或等待资源回收 |
| 项目 | `PROJECT_CAPABILITY_DENIED` | 当前项目角色缺少所需能力 |
| 项目 | `PROJECT_REPOSITORY_REQUIRED` | Git 导入模式没有提供仓库地址 |
| 项目 | `PROJECT_IMPORT_IN_PROGRESS` | Git 导入进行中，工作区及项目操作暂不可用 |
| 项目 | `PROJECT_IMPORT_FAILED` | Git 导入失败，工作区操作被阻止，需修正配置后重试 |
| 项目 | `PROJECT_IMPORT_RETRY_NOT_ALLOWED` | 当前项目状态不允许重试 Git 导入 |
| 项目 | `PROJECT_SOURCE_CONFLICT` | 空白项目模式错误地提交了仓库地址 |
| Git | `GIT_DEFAULT_BRANCH_UNRESOLVED` | 远程 HEAD 不可识别，需要手动填写默认分支 |
| 会话 | `SESSION_NOT_FOUND_OR_INACCESSIBLE` | 会话不存在或不属于调用方 |
| 定时任务 | `JAVA_TASK_REGISTRATION_INVALID` | Java 应用注册凭据无效 |
| 定时任务 | `JAVA_TASK_HANDLER_UNAVAILABLE` | 方法不存在、停用或所属应用停用 |
| 定时任务 | `SCHEDULED_TASK_NOT_FOUND` | 定时任务不存在 |
| 定时任务 | `SCHEDULED_TASK_STATE_CONFLICT` | 审批状态已变化 |
| 定时任务 | `SCHEDULED_TASK_NOT_APPROVED` | 任务尚未审批 |
| 定时任务 | `SCHEDULED_TASK_NOT_RUNNABLE` | 任务当前不可执行 |
| 定时任务 | `SCHEDULED_TASK_ALREADY_RUNNING` | 并发策略禁止重复执行 |
| 定时任务 | `SCHEDULED_TASK_EXECUTION_NOT_FOUND` | 执行实例不存在 |
| 定时任务 | `SCHEDULED_TASK_EXECUTION_FINISHED` | 执行实例已经结束 |
| 代码生成 | `GENERATION_TASK_NOT_FOUND` | 生成任务不存在 |
| 代码生成 | `GENERATION_ALREADY_ACTIVE` | 当前会话已有生成任务运行、排队或取消中 |
| 代码生成 | `GENERATION_DAILY_QUOTA_EXCEEDED` | 项目最近 24 小时生成任务达到配额，附带 `limit`、`used` |
| 代码生成 | `GENERATION_JOB_MISSING` | 任务记录存在，但已不在执行队列中 |
| 代码生成 | `GENERATION_TASK_FINISHED` | 管理员尝试取消已经结束的任务，附带 `status` |
| 代码生成 | `GENERATION_RETRY_NOT_ALLOWED` | 当前任务状态不允许重试，附带 `status` |
| 代码生成 | `GENERATION_PRIORITY_INVALID` | 队列优先级不在 1–10 范围内 |
| 代码生成 | `GENERATION_REPRIORITIZE_NOT_ALLOWED` | 任务已不处于可调整优先级的队列状态 |
| 代码生成 | `GENERATION_DEAD_LETTER_STALE` | 死信任务不存在或队列状态已经变化 |
| 代码生成 | `GENERATION_DEAD_LETTER_REPLAY_NOT_ALLOWED` | 对应业务任务不再处于可重放状态 |
| 部署目标 | `DEPLOY_TARGET_NOT_FOUND_OR_INACCESSIBLE` | 部署目标不存在或当前用户不可见 |
| 部署目标 | `DEPLOY_TARGET_KIND_MISMATCH` | 接口所需目标类型与实际目标类型不一致 |
| 部署目标 | `DEPLOY_TARGET_KIND_INVALID` | 创建请求中的目标类型不受支持 |
| 部署目标 | `DEPLOY_TARGET_DISABLED` | 部署目标已被停用 |
| 部署目标 | `DEPLOY_TARGET_SCOPE_INVALID` | 目标可见范围不是 personal、team 或 platform |
| 部署目标 | `DEPLOY_TARGET_TEAM_REQUIRED` | 团队可见目标没有选择项目组 |
| 部署目标 | `DEPLOY_TARGET_TEAM_ACCESS_DENIED` | 创建者不属于所选项目组 |
| 部署目标 | `DEPLOY_TARGET_PURPOSE_INVALID` | 目标用途不是 preview 或 deploy |
| 部署目标 | `DEPLOY_TARGET_PURPOSE_UNSUPPORTED` | 目标类型不支持请求的用途 |
| 部署目标 | `DEPLOY_TARGET_DELETE_BLOCKED` | 目标仍有关联沙箱或项目环境绑定，附带 `blockers` |
| 部署目标 | `DEPLOY_TARGET_CONCURRENT_MODIFICATION` | 删除期间关联关系发生并发变化 |
| 部署目标 | `DEPLOY_TARGET_KUBECONFIG_REQUIRED` | Kubernetes 目标没有提供 kubeconfig |
| 部署目标 | `DEPLOY_TARGET_KUBECONFIG_UNSAFE` | kubeconfig 无法解析或包含命令认证、文件引用、不安全 TLS 等配置 |
| 部署目标 | `DEPLOY_TARGET_REGISTRY_INVALID` | Registry 不存在或不属于部署目标创建者 |
| 部署目标 | `DEPLOY_TARGET_REGISTRY_INSECURE` | Kubernetes 目标尝试绑定未启用 TLS 的 Registry |
| 镜像仓库 | `REGISTRY_CREDENTIALS_REQUIRED` | 缺少仓库地址、用户名或密码 |
| 镜像仓库 | `REGISTRY_TLS_CONFIGURATION_INVALID` | HTTP Registry 未显式标记 insecure |
| 镜像仓库 | `REGISTRY_NOT_FOUND_OR_INACCESSIBLE` | Registry 不存在或不属于当前用户 |
| 镜像仓库 | `REGISTRY_DELETE_BLOCKED` | Registry 仍被 Kubernetes 目标或项目运行环境引用，附带 `targets`、`bindingCount` |
| 镜像仓库 | `REGISTRY_REFERENCE_CHECK_FAILED` | 某个目标配置损坏，无法安全确认引用关系 |
| 镜像仓库 | `REGISTRY_CONCURRENT_MODIFICATION` | 删除期间 Registry 引用发生并发变化 |
| Kubernetes | `K8S_PREVIEW_NAMESPACE_INVALID` | 无法根据前缀和项目组生成合法 Namespace 名称 |
| Kubernetes | `K8S_TEAM_ACCESS_DENIED` | 当前用户不属于目标项目组 |
| Kubernetes | `K8S_PREVIEW_PURPOSE_DISABLED` | 目标未被授权用于预览工作负载 |
| Kubernetes | `K8S_TARGET_TEAM_MISMATCH` | 团队级部署目标与项目所属团队不一致 |
| 预览 | `PREVIEW_NOT_READY` | 预览尚未启动或未就绪 |
| 预览 | `PREVIEW_UPSTREAM_FAILED` | 预览服务请求失败或超时 |
| 预览 | `PREVIEW_SERVICE_KEY_CONFLICT` | 同一需求已有其他项目占用该服务标识 |
| 预览 | `PREVIEW_TEST_NAMESPACE_DENIED` | 测试 Namespace 未配置或不在运行目标授权范围内 |
| 预览 | `PREVIEW_TEST_SERVICE_REQUIRED` | Kubernetes 预览绑定缺少测试 Namespace、Service 或端口 |
| 预览 | `PREVIEW_TEST_SERVICE_NOT_FOUND` | 绑定的测试 Service 不存在 |
| 预览 | `PREVIEW_TEST_SERVICE_SELECTOR_REQUIRED` | 测试 Service 没有 Pod selector，无法生成最小权限网络策略 |
| 预览 | `PREVIEW_TEST_SERVICE_PORT_INVALID` | 测试 Service 未声明绑定中配置的端口 |
| 预览 | `PREVIEW_SOURCE_BASE_URL_REQUIRED` | 未配置目标集群可访问的平台 HTTPS 快照地址 |
| 预览 | `PREVIEW_SNAPSHOT_TOO_LARGE` | 当前用户工作区压缩快照超过构建限制 |
| 预览 | `PREVIEW_SNAPSHOT_TOKEN_REQUIRED` | 快照下载请求缺少 Bearer 凭证 |
| 预览 | `PREVIEW_SNAPSHOT_NOT_FOUND` | 快照不存在、过期或下载凭证无效 |
| 预览 | `PREVIEW_SNAPSHOT_FILE_MISSING` | 共享卷中的快照文件缺失或大小异常 |
| 预览路由 | `PREVIEW_ROUTING_NOT_CONFIGURED` | 内部路由控制面密钥未配置或强度不足 |
| 预览路由 | `PREVIEW_ROUTING_UNAUTHORIZED` | 路由适配器提供的控制面密钥无效 |
| 需求 | `REQUIREMENT_NOT_FOUND` | 需求不存在、不可访问或不能用于预览 |
| 需求 | `REQUIREMENT_TEAM_ACCESS_DENIED` | 用户不属于需求项目组 |
| 需求 | `REQUIREMENT_TITLE_REQUIRED` | 需求标题为空或仅包含空白字符 |
| 需求 | `REQUIREMENT_OWNER_REQUIRED` | 操作仅允许需求总负责人执行 |
| 需求 | `REQUIREMENT_IMMUTABLE` | 已结束需求的基础信息或文档已冻结 |
| 需求 | `REQUIREMENT_NUMBER_CONFLICT` | 唯一需求编号生成冲突 |
| 需求 | `REQUIREMENT_SCHEDULE_INVALID` | 排期开始时间晚于结束时间 |
| 需求 | `REQUIREMENT_DOCUMENT_VERSION_CONFLICT` | Markdown 基准版本已过期，需要刷新合并 |
| 需求 | `REQUIREMENT_VERSION_CONFLICT` | 需求基础信息或状态已被其他人修改，需要刷新 |
| 需求 | `REQUIREMENT_STATE_CHANGED` | 操作等待锁期间需求状态或负责人发生变化 |
| 需求 | `REQUIREMENT_STAGE_NOT_FOUND` | 需求阶段不存在 |
| 需求 | `REQUIREMENT_STAGE_ACCESS_DENIED` | 操作者不是需求或当前阶段负责人 |
| 需求 | `REQUIREMENT_BLOCKED_REASON_REQUIRED` | 阶段阻塞但没有填写原因 |
| 需求 | `REQUIREMENT_STAGE_PREDECESSOR_INCOMPLETE` | 前一阶段尚未完成或跳过 |
| 需求 | `REQUIREMENT_STAGE_IMMUTABLE` | 已结束需求不能继续更新阶段 |
| 需求 | `REQUIREMENT_PIPELINE_INCOMPLETE` | 流水线尚未结束，不能直接完成需求 |
| 需求 | `REQUIREMENT_ARCHIVE_STATE_INVALID` | 进行中的需求不能直接归档 |
| 需求 | `REQUIREMENT_STATUS_TRANSITION_INVALID` | 需求状态不符合单向迁移规则 |
| 需求 | `REQUIREMENT_ACTIVE_PREVIEWS_EXIST` | 需求仍有未停止的 starting、ready 或 failed 预览，不能结束需求或最后阶段 |
| 需求 | `REQUIREMENT_STAGE_ROLLBACK_REASON_REQUIRED` | 阶段回退没有填写原因 |
| 需求 | `REQUIREMENT_STAGE_SKIP_OWNER_REQUIRED` | 非需求负责人尝试跳过阶段 |
| 需求 | `REQUIREMENT_STAGE_SKIP_REASON_REQUIRED` | 跳过阶段没有填写原因 |
| 需求 | `REQUIREMENT_STAGE_PROGRESS_IMMUTABLE` | 已结束阶段在未回退时修改进度 |
| 需求 | `REQUIREMENT_STAGE_PROGRESS_INVALID` | 阶段状态与进度数值不一致 |
| 需求 | `REQUIREMENT_STAGE_VERSION_CONFLICT` | 阶段操作基于已经过期的需求或阶段状态 |
| 需求 | `REQUIREMENT_SERVICE_KEY_INVALID` | 需求服务标识格式非法 |
| 需求 | `REQUIREMENT_PROJECT_ACCESS_DENIED` | 项目不属于需求项目组或操作者无管理权限 |
| 需求 | `REQUIREMENT_DEVELOPER_PROJECT_ACCESS_REQUIRED` | 指派开发者没有项目编辑权限 |
| 需求 | `REQUIREMENT_PROJECT_CONFLICT` | 项目或服务标识已关联当前需求 |
| 需求 | `REQUIREMENT_PROJECT_NOT_FOUND` | 需求关联项目不存在 |
| 需求 | `REQUIREMENT_PROJECT_PREVIEW_RUNNING` | 关联项目仍有活动预览，不能解除关联 |
| 需求 | `REQUIREMENT_PROJECT_IMMUTABLE` | 当前需求状态不能修改关联项目 |
| 需求 | `REQUIREMENT_PROJECT_BRANCH_EXISTS` | 分支创建后不能调整负责人或改动范围 |
| 需求 | `REQUIREMENT_PROJECT_CHANGED` | 关联项目已被并发修改或删除，需要刷新 |
| 需求 | `REQUIREMENT_PROJECT_NO_CHANGE` | 无需改动的关联项目不能创建需求分支 |
| 需求 | `REQUIREMENT_BRANCH_IMMUTABLE` | 当前需求状态不允许创建分支 |
| 需求 | `REQUIREMENT_BRANCH_DEVELOPER_REQUIRED` | 操作者不是该项目的被指派开发负责人 |
| 需求 | `REQUIREMENT_BRANCH_CREATE_FAILED` | 同名分支或工作区冲突导致分支创建失败 |
| 需求 | `REQUIREMENT_BRANCH_STATE_CHANGED` | 创建分支期间需求或关联配置发生变化 |
| 需求 | `REQUIREMENT_BRANCH_OWNERSHIP_UNVERIFIED` | 工作区同名分支缺少需求归属记录，禁止自动认领 |
| 需求 | `REQUIREMENT_BRANCH_REQUIRED` | 当前工作区尚未建立对应需求分支 |
| 需求 | `REQUIREMENT_PROJECT_NOT_DEPLOYABLE` | 项目没有关联需求或无需部署预览 |
| 需求 | `REQUIREMENT_PREVIEW_ACCESS_DENIED` | 操作者不是需求负责人或项目开发负责人 |
| 需求 | `REQUIREMENT_PREVIEW_STATE_CHANGED` | 预览部署落库前需求或项目关联已发生变化 |
| 文件 | `FILE_PATH_INVALID` | 文件路径非法或越界 |
| 文件 | `FILE_NOT_FOUND` | 文件不存在 |
| 文件 | `FILE_NOT_REGULAR` | 目标不是普通文件 |
| 文件 | `FILE_VIEW_TOO_LARGE` | 文件超过在线查看限制 |
| 数据源 | `DATASOURCE_NOT_FOUND_OR_INACCESSIBLE` | 数据源不存在、未授权或与项目组不一致 |
| 数据源 | `DATASOURCE_TEAM_ACCESS_DENIED` | 当前用户不属于数据源目标项目组 |
| 数据源 | `DATASOURCE_MEMBER_INELIGIBLE` | 待授权用户不存在或不属于数据源项目组，附带 `userIds` |
| 数据源 | `DATASOURCE_SELF_REMOVAL_FORBIDDEN` | 管理操作不能移除操作者自己的数据源权限 |
| 数据源 | `DATASOURCE_APPROVER_MINIMUM_REQUIRED` | 关系型数据源必须保留至少一名审批人 |
| 数据源 | `DATASOURCE_APPROVER_INELIGIBLE` | 审批人未启用、不是项目组成员或没有数据源访问权 |
| 数据库审批 | `DB_APPROVAL_NOT_FOUND` | 审批单不存在或不可见 |
| 数据库审批 | `APPROVER_NOT_FOUND` | 审批人不存在 |
| 用户 | `USER_NOT_FOUND` | 用户不存在 |
| 用户管理 | `ADMIN_USER_CREDENTIALS_REQUIRED` | 管理员建号缺少用户名或密码 |
| 用户管理 | `ADMIN_USER_IDENTITY_CONFLICT` | 用户名或邮箱已被占用 |
| 用户管理 | `ADMIN_PASSWORD_TOO_SHORT` | 重置密码未达到最低长度 |
| 用户管理 | `ADMIN_SELF_DISABLE_FORBIDDEN` | 管理员不能停用当前登录账户 |
| 用户管理 | `ADMIN_SELF_DELETE_FORBIDDEN` | 管理员不能删除当前登录账户 |
| 用户管理 | `ACTIVE_ADMIN_REQUIRED` | 操作会导致系统没有启用中的管理员 |
| 用户管理 | `ADMIN_CONCURRENT_MODIFICATION` | 管理数据发生并发写入竞争，需要刷新后重试 |
| 角色管理 | `ROLE_NAME_REQUIRED` | 角色名为空 |
| 角色管理 | `ROLE_NAME_CONFLICT` | 角色名已存在 |
| 角色管理 | `ROLE_NOT_FOUND` | 角色不存在 |
| 角色管理 | `BUILTIN_ROLE_IMMUTABLE` | 内置角色不能通过管理接口修改或删除 |
| 角色管理 | `ROLE_ASSIGNMENT_INVALID` | 用户角色列表包含不存在的角色，附带 `roleIds` |
| 角色管理 | `ROLE_PERMISSION_INVALID` | 自定义角色包含平台不认识的权限，附带 `permissions` |
| 项目组 | `TEAM_NOT_FOUND` | 项目组不存在 |
| 项目组 | `TEAM_NAME_CONFLICT` | 项目组名称已存在 |
| 项目组 | `TEAM_MEMBER_INVALID` | 成员列表包含不存在的用户，附带 `userIds` |
| 项目组 | `TEAM_MEMBER_REMOVAL_BLOCKED` | 移除成员会导致关系型数据源没有审批人，附带 `datasources` |
| 项目组 | `TEAM_DELETE_BLOCKED` | 项目组仍有关联资源，附带项目、数据源和部署目标数量 `blockers` |
| 项目组 | `TEAM_CONCURRENT_MODIFICATION` | 项目组资源或成员发生并发修改，需要刷新后重试 |
| 数据库审批 | `APPROVAL_STATE_CONFLICT` | 审批单已被其他审批人处理或状态已变化 |
| 数据库审批 | `DATASOURCE_APPROVER_REQUIRED` | 调用方不在数据源审批人列表中 |
| 数据库传输 | `DB_TRANSFER_NOT_FOUND` | 迁移、备份或恢复任务不存在或不可见 |
| 数据库传输 | `DB_TRANSFER_STATE_CONFLICT` | 任务审批状态已变化 |
| 数据库传输 | `DB_TRANSFER_FINISHED` | 任务已经结束，不能取消 |
| 数据库传输 | `DB_TRANSFER_RETRY_NOT_ALLOWED` | 当前状态不允许重试 |
| 数据库传输 | `DB_TRANSFER_RETRY_REQUIRES_REPLACE` | 已写入部分数据，必须使用 replace 重试 |
| 数据库恢复 | `NATIVE_BACKUP_NOT_FOUND` | 没有可恢复的原生备份 |
| 数据库恢复 | `RESTORE_TARGET_NOT_EMPTY` | 恢复目标数据库不是空库 |
| 数据库备份 | `BACKUP_TASK_NOT_FOUND` | 备份任务不存在或不可见 |
| 数据库备份 | `BACKUP_FILE_NOT_READY` | 尚未生成可下载文件 |
| 数据库备份 | `BACKUP_FILE_MISSING` | 持久存储中的备份文件缺失 |
| 数据库备份 | `BACKUP_FILE_INVALID` | 备份目标不是普通文件 |
| 数据库备份 | `BACKUP_FILE_TOO_LARGE` | 备份超过恢复大小限制 |
| 数据库备份 | `BACKUP_PATH_INVALID` | 备份路径越过受控根目录 |
| 数据库备份 | `BACKUP_MANIFEST_MISSING` | 备份 manifest 缺失 |
| 数据库备份 | `BACKUP_MANIFEST_INVALID` | manifest 结构或内容非法 |
| 数据库备份 | `BACKUP_MANIFEST_PATH_INVALID` | manifest 路径越过受控目录 |
| 数据库备份 | `BACKUP_INTEGRITY_FAILED` | 文件大小、名称或 SHA-256 不匹配 |
| 数据库备份 | `BACKUP_DOWNLOAD_UNSUPPORTED` | 当前备份格式不能单文件下载 |
| Kafka | `KAFKA_NOT_CONFIGURED` | Kafka Broker 尚未配置 |
| Kafka | `KAFKA_TOPIC_INVALID` | Topic 名称非法 |
| Kafka | `KAFKA_TOPIC_ALREADY_EXISTS` | 创建的 Topic 已经存在 |
| Kafka | `KAFKA_UNAVAILABLE` | Kafka 连接或操作失败 |
| Kafka | `KAFKA_GROUP_INVALID` | Consumer Group 名称非法 |
| Kafka | `KAFKA_OFFSET_INVALID` | Offset 格式或数量非法 |
| Kafka | `KAFKA_CONFIG_EMPTY` | 未提供可修改的 Topic 配置 |
| Kafka | `KAFKA_CONFIG_INCOMPATIBLE` | Topic 配置组合与当前副本能力或其他配置冲突 |
| Kafka | `KAFKA_CONFIRMATION_MISMATCH` | 危险操作确认文本与资源名不匹配 |
| Kafka | `KAFKA_INTERNAL_GROUP_PROTECTED` | 试图修改平台内部消息检查 Group |
| Git | `GIT_REMOTE_NOT_CONFIGURED` | 项目尚未配置远程仓库 |
| Git | `GIT_FETCH_FAILED` | 无法读取远程分支状态，消息中包含已脱敏诊断信息 |
| Git | `GIT_SYNC_FAILED` | 远程分支无法合并且不是可在线解决的文件冲突 |
| Git | `GIT_PUSH_REJECTED` | 远程分支领先，普通推送被拒绝 |
| Git | `GIT_PUSH_FAILED` | 推送失败，消息中包含已脱敏诊断信息 |
| Git | `GIT_BRANCH_INVALID` | 分支名非法 |
| Git | `GIT_BRANCH_CHECKOUT_FAILED` | 分支不存在、存在冲突或无法切换 |
| Git | `GIT_BRANCH_DELETE_FAILED` | 当前分支或被工作区占用的分支不能删除 |
| Git | `GIT_MERGE_NOT_IN_PROGRESS` | 当前没有待继续的合并 |
| Git | `GIT_CONFLICTS_REMAIN` | 仍有未解决冲突，附带 `conflicts` |
| Git | `GIT_CONFLICT_NOT_FOUND` | 文件不是当前未解决冲突 |
| Git | `GIT_CONFLICT_BINARY` | 二进制文件不能在线编辑合并 |
| Git | `GIT_CONFLICT_TOO_LARGE` | 冲突文件超过在线处理限制 |
| Git | `GIT_CONFLICT_CONTENT_REQUIRED` | 自定义合并结果缺失 |
| Git | `GIT_CONFLICT_RESULT_TOO_LARGE` | 合并结果超过在线保存限制 |
| Git | `GIT_CONFLICT_NOT_RESOLVED` | 保存后 Git 仍报告冲突 |
| Git | `GIT_CONFLICT_SAVE_FAILED` | 冲突解决结果无法写入或加入暂存区 |
| Git | `GIT_CONFLICT_PATH_REQUIRED` | 缺少冲突文件路径 |
| Git | `GIT_CONFLICT_PATH_INVALID` | 冲突路径非法或越界 |
| Git | `GIT_IMPORT_WORKSPACE_NOT_EMPTY` | 非空工作区不能执行首次导入 |
| Git | `GIT_IMPORT_OWNER_REQUIRED` | 只有项目所有者可首次导入 |
| Git | `GIT_REPOSITORY_URL_INVALID` | 远程仓库 URL 非法 |
| Git | `GIT_REPOSITORY_HTTPS_REQUIRED` | 远程仓库必须使用 HTTPS |
| Git | `GIT_REPOSITORY_CREDENTIALS_FORBIDDEN` | URL 中不允许嵌入凭据 |
| Git | `GIT_HOST_REQUIRED` | 缺少 Git 服务主机 |
| Git | `GIT_HOST_INVALID` | Git 服务主机格式非法 |
| Git | `GIT_CREDENTIAL_TOKEN_REQUIRED` | 首次配置凭据必须提供 Token |
| Git | `GIT_CREDENTIAL_REQUIRED` | 当前用户没有目标 Git 主机的凭据 |
| Git | `GIT_CREDENTIAL_NOT_FOUND` | Git 凭据不存在 |
| Git | `GIT_IDENTITY_INVALID` | Git 提交身份为空或包含非法控制字符 |

部分错误会带额外结构化字段，例如 `PROJECT_CAPABILITY_DENIED.capability`、
`PROJECT_DELETE_BLOCKED.blockers` 和配额错误的 `limit`/`used`。客户端应忽略不认识的
附加字段，以保持前后兼容。
