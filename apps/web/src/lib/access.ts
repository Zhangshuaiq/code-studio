export const ACCESS = {
  projectRead: 'project:read',
  generate: 'generate:execute',
  requirements: 'requirement:read',
  requirementManage: 'requirement:manage',
  requirementStageUpdate: 'requirement:stage-update',
  deploy: 'deploy:execute',
  deployTargets: 'deploy-target:manage',
  registries: 'registry:manage',
  models: 'model:manage',
  observability: 'business-log:read',
  systemSettings: 'system-setting:manage',
  adminUsers: 'admin:users',
  adminRoles: 'admin:roles',
  audit: 'audit:read',
  teams: 'team:manage',
  namespaces: 'namespace:manage',
  datasources: 'datasource:manage',
  scheduledTasks: 'scheduled-task:read',
  kafka: 'kafka:read',
  mcpApprovalReview: 'mcp-approval:review',
} as const;

export const GOVERNANCE_ACCESS = [
  ACCESS.adminUsers,
  ACCESS.adminRoles,
  ACCESS.audit,
  ACCESS.systemSettings,
  ACCESS.teams,
  ACCESS.datasources,
  ACCESS.deployTargets,
  ACCESS.mcpApprovalReview,
] as const;

export function hasAnyAccess(granted: readonly string[], required: readonly string[]): boolean {
  return required.length === 0 || required.some((permission) => granted.includes(permission));
}
