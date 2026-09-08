// 权限目录（RBAC）。权限是稳定字符串键；角色持有一组权限；用户持有一组角色。
// 新增受控能力 = 在此加一个键，并在需要的接口上 @RequirePermissions(...)。
export const PERMISSIONS = {
  // 开发者能力
  PROJECT_READ: "project:read",
  PROJECT_WRITE: "project:write",
  GENERATE: "generate:execute",
  REQUIREMENT_READ: "requirement:read",
  REQUIREMENT_MANAGE: "requirement:manage",
  REQUIREMENT_STAGE_UPDATE: "requirement:stage-update",
  DEPLOY_EXECUTE: "deploy:execute",
  DEPLOY_TARGET_MANAGE: "deploy-target:manage",
  REGISTRY_MANAGE: "registry:manage",
  MODEL_MANAGE: "model:manage",
  BUSINESS_LOG_READ: "business-log:read",
  BUSINESS_LOG_SOURCE_MANAGE: "business-log:source-manage",
  BUSINESS_LOG_EXPORT: "business-log:export",
  SYSTEM_SETTING_MANAGE: "system-setting:manage",
  MCP_APPROVAL_REVIEW: "mcp-approval:review",
  // 管理后台
  ADMIN_USERS: "admin:users",
  ADMIN_ROLES: "admin:roles",
  AUDIT_READ: "audit:read",
  TEAM_MANAGE: "team:manage",
  // 阶段 2 预留
  NAMESPACE_MANAGE: "namespace:manage",
  DATASOURCE_MANAGE: "datasource:manage",
  SCHEDULED_TASK_READ: "scheduled-task:read",
  SCHEDULED_TASK_MANAGE: "scheduled-task:manage",
  SCHEDULED_TASK_APPROVE: "scheduled-task:approve",
  KAFKA_READ: "kafka:read",
  KAFKA_PRODUCE: "kafka:produce",
  KAFKA_TOPIC_MANAGE: "kafka:topic-manage",
  KAFKA_GROUP_MANAGE: "kafka:group-manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// 权限的人类可读说明（管理后台角色页展示）
export const PERMISSION_LABELS: Record<string, string> = {
  "project:read": "查看项目",
  "project:write": "创建/修改/删除项目",
  "generate:execute": "运行代码生成",
  "requirement:read": "查看项目组需求与流水线",
  "requirement:manage": "创建和管理负责的需求",
  "requirement:stage-update": "更新负责的需求阶段",
  "deploy:execute": "执行部署",
  "deploy-target:manage": "管理部署目标",
  "registry:manage": "管理镜像仓库",
  "model:manage": "管理模型配置",
  "business-log:read": "查询业务日志",
  "business-log:source-manage": "管理业务日志接入源",
  "business-log:export": "导出业务日志",
  "system-setting:manage": "管理系统配置",
  "mcp-approval:review": "审核 MCP/Agent 工具调用",
  "admin:users": "管理用户账户",
  "admin:roles": "管理角色权限",
  "audit:read": "查看操作日志",
  "team:manage": "管理项目组",
  "namespace:manage": "管理 k8s namespace",
  "datasource:manage": "管理数据库/Redis",
  "scheduled-task:read": "查看定时任务",
  "scheduled-task:manage": "创建和管理定时任务",
  "scheduled-task:approve": "审批和执行定时任务",
  "kafka:read": "查看 Kafka Topic、消息样本和消费组",
  "kafka:produce": "向 Kafka Topic 发送消息",
  "kafka:topic-manage": "创建、扩容、截断和删除 Kafka Topic",
  "kafka:group-manage": "删除 Consumer Group 和修改消费位点",
};

const P = PERMISSIONS;

// 内置角色（bootstrap 时按名 upsert；权限每次启动同步为下面的定义）
export const BUILTIN_ROLES: {
  name: string;
  description: string;
  permissions: string[];
}[] = [
  {
    name: "admin",
    description: "平台管理员（全部权限）",
    permissions: [...ALL_PERMISSIONS],
  },
  {
    name: "developer",
    description: "开发者（代码生成、预览与业务日志）",
    permissions: [
      P.PROJECT_READ,
      P.PROJECT_WRITE,
      P.GENERATE,
      P.REQUIREMENT_READ,
      P.REQUIREMENT_MANAGE,
      P.REQUIREMENT_STAGE_UPDATE,
      P.MODEL_MANAGE,
      P.BUSINESS_LOG_READ,
      P.KAFKA_READ,
      P.BUSINESS_LOG_SOURCE_MANAGE,
      P.SCHEDULED_TASK_READ,
      P.SCHEDULED_TASK_MANAGE,
    ],
  },
  {
    name: "release-manager",
    description: "发布负责人（选择项目、分支和环境并执行部署）",
    permissions: [P.PROJECT_READ, P.DEPLOY_EXECUTE, P.BUSINESS_LOG_READ, P.REQUIREMENT_READ, P.REQUIREMENT_STAGE_UPDATE, P.MCP_APPROVAL_REVIEW],
  },
  {
    name: "ops-manager",
    description: "运维负责人（运行资源、镜像仓库与项目环境配置）",
    permissions: [
      P.PROJECT_READ,
      P.DEPLOY_EXECUTE,
      P.DEPLOY_TARGET_MANAGE,
      P.REGISTRY_MANAGE,
      P.NAMESPACE_MANAGE,
      P.BUSINESS_LOG_READ,
      P.KAFKA_READ,
      P.KAFKA_PRODUCE,
      P.KAFKA_TOPIC_MANAGE,
      P.KAFKA_GROUP_MANAGE,
      P.REQUIREMENT_READ,
      P.MCP_APPROVAL_REVIEW,
    ],
  },
  {
    name: "viewer",
    description: "只读（仅查看项目）",
    permissions: [P.PROJECT_READ, P.REQUIREMENT_READ],
  },
];
