export type ProductEdition = 'community' | 'personal-pro' | 'team' | 'enterprise';
export type ExecutionLocation = 'local' | 'remote';
export type WorkspaceLocation = 'local' | 'remote';

export interface Entitlements {
  localProjects: boolean;
  localAgent: boolean;
  localPreview: boolean;
  localConnectors: boolean;
  cloudSync: boolean;
  remoteExecution: boolean;
  teamCollaboration: boolean;
  enterpriseRbac: boolean;
  enterpriseAudit: boolean;
  enterprisePolicies: boolean;
}

const BASE_LOCAL: Entitlements = {
  localProjects: true,
  localAgent: true,
  localPreview: true,
  localConnectors: true,
  cloudSync: false,
  remoteExecution: false,
  teamCollaboration: false,
  enterpriseRbac: false,
  enterpriseAudit: false,
  enterprisePolicies: false,
};

export const EDITION_ENTITLEMENTS: Readonly<Record<ProductEdition, Readonly<Entitlements>>> = {
  community: Object.freeze({ ...BASE_LOCAL }),
  'personal-pro': Object.freeze({ ...BASE_LOCAL, cloudSync: true }),
  team: Object.freeze({
    ...BASE_LOCAL,
    cloudSync: true,
    remoteExecution: true,
    teamCollaboration: true,
  }),
  enterprise: Object.freeze({
    ...BASE_LOCAL,
    cloudSync: true,
    remoteExecution: true,
    teamCollaboration: true,
    enterpriseRbac: true,
    enterpriseAudit: true,
    enterprisePolicies: true,
  }),
};

export function entitlementsFor(edition: ProductEdition): Entitlements {
  return { ...EDITION_ENTITLEMENTS[edition] };
}

export const API_NAMESPACES = Object.freeze({
  local: '/api/local',
  control: '/api/control',
  compatibility: '/api',
});

export type AgentEventKind = 'text' | 'tool_use' | 'result' | 'system' | 'reasoning';

export interface AgentEvent {
  kind: AgentEventKind;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  sequence?: number;
}

export interface AgentRunInput {
  workspaceId: string;
  prompt: string;
  modelConfigId: string;
  executionLocation: ExecutionLocation;
  permissionProfile: AgentPermissionProfile;
}

export type AgentPermissionProfile = 'read-only' | 'workspace-write';

export type AgentTaskStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted';

export interface WorkspaceDescriptor {
  id: string;
  name: string;
  location: WorkspaceLocation;
  /** 只允许存在于 Local API 的响应中，不得同步到 Control API。 */
  localPath?: string;
  remoteProjectId?: string;
}

export interface ModelConfigContract {
  id: string;
  name: string;
  provider: string;
  baseUrl?: string;
  model: string;
  engine: 'codex-cli' | 'claude-code' | 'aider' | 'openai-compatible' | 'ollama';
  executionLocation: ExecutionLocation;
  /** 指向实际执行位置的安全凭据存储，绝不包含明文密钥。 */
  credentialRef?: string;
}
