import type { ConfigModuleOptions } from '@nestjs/config';
import { parsePreviousJwtSecrets } from '../auth/jwt-keys';
import {
  DEPENDENCY_ACCESS_POLICIES,
  dependencyPolicyRequiresProxy,
  resolveDependencyAccessPolicy,
} from '../common/dependency-access-policy';

const integerRules: Record<string, { min: number; max: number }> = {
  API_PORT: { min: 1, max: 65535 },
  WORKER_HEALTH_PORT: { min: 1, max: 65535 },
  REDIS_PORT: { min: 1, max: 65535 },
  REDIS_DB: { min: 0, max: 15 },
  AGENT_WORKER_CONCURRENCY: { min: 1, max: 100 },
  AGENT_JOB_ATTEMPTS: { min: 1, max: 20 },
  AGENT_JOB_TIMEOUT_MS: { min: 1_000, max: 86_400_000 },
  AGENT_EXECUTION_TIMEOUT_MS: { min: 1_000, max: 86_400_000 },
  AGENT_JOB_LOCK_MS: { min: 10_000, max: 86_400_000 },
  PROJECT_DAILY_GENERATION_LIMIT: { min: 1, max: 1_000_000 },
  WORKSPACE_MAX_SOURCE_FILES: { min: 1, max: 1_000_000 },
  WORKSPACE_MAX_FILE_BYTES: { min: 1_024, max: 104_857_600 },
  WORKSPACE_MAX_SOURCE_BYTES: { min: 1_024, max: 10_737_418_240 },
  GENERATION_MAX_PER_TEAM: { min: 1, max: 1_000 },
  GENERATION_MAX_PER_USER: { min: 1, max: 100 },
  GENERATION_RESOURCE_RETRY_MS: { min: 1_000, max: 300_000 },
  SANDBOX_MEMORY_MB: { min: 128, max: 262_144 },
  SANDBOX_PIDS_LIMIT: { min: 16, max: 65_536 },
  SANDBOX_TMPFS_BYTES: { min: 1_048_576, max: 17_179_869_184 },
  SANDBOX_EXEC_MAX_OUTPUT_BYTES: { min: 1_024, max: 104_857_600 },
  SANDBOX_IDLE_MINUTES: { min: 1, max: 10_080 },
  PREVIEW_MAX_PER_USER: { min: 1, max: 1_000 },
  PREVIEW_MAX_PER_PROJECT: { min: 1, max: 10_000 },
  PREVIEW_MAX_PER_TEAM: { min: 1, max: 100_000 },
  PREVIEW_NAMESPACE_MAX_PODS: { min: 1, max: 10_000 },
  PREVIEW_NAMESPACE_MAX_PVCS: { min: 0, max: 10_000 },
  K8S_PREVIEW_TTL_MINUTES: { min: 1, max: 10_080 },
  K8S_GENERATION_JOB_TIMEOUT_SECONDS: { min: 30, max: 86_400 },
  K8S_GENERATION_JOB_TTL_SECONDS: { min: 0, max: 86_400 },
  K8S_GENERATION_LOG_MAX_BYTES: { min: 1_024, max: 104_857_600 },
  PREVIEW_BUILD_MAX_PER_TEAM: { min: 1, max: 1_000 },
  PREVIEW_BUILD_MAX_PER_USER: { min: 1, max: 100 },
  PREVIEW_BUILD_QUEUE_TIMEOUT_MINUTES: { min: 1, max: 10_080 },
  PREVIEW_BUILD_STUCK_GRACE_SECONDS: { min: 30, max: 3_600 },
  OPENSEARCH_TIMEOUT_MS: { min: 1_000, max: 300_000 },
  OPENSEARCH_MAX_RESPONSE_BYTES: { min: 1_024, max: 104_857_600 },
  PROMETHEUS_MAX_RESPONSE_BYTES: { min: 1_024, max: 104_857_600 },
  RATE_LIMIT_MAX: { min: 1, max: 1_000_000 },
  RATE_LIMIT_WINDOW_MS: { min: 1_000, max: 86_400_000 },
  RATE_LIMIT_AUTH_MAX: { min: 1, max: 10_000 },
  RATE_LIMIT_AUTH_WINDOW_MS: { min: 1_000, max: 86_400_000 },
  OTEL_METRIC_EXPORT_INTERVAL_MS: { min: 1_000, max: 3_600_000 },
  DB_QUERY_TIMEOUT_MS: { min: 1_000, max: 300_000 },
  DB_QUERY_MAX_ROWS: { min: 1, max: 100_000 },
  DB_QUERY_MAX_RESULT_BYTES: { min: 1_024, max: 104_857_600 },
  DB_EXPORT_MAX_BYTES: { min: 1_024, max: 536_870_912 },
  DB_BACKUP_MAX_BYTES: { min: 1_048_576, max: 1_099_511_627_776 },
  PROJECT_CLEANUP_MAX_ATTEMPTS: { min: 1, max: 100 },
  PROJECT_IMPORT_LEASE_MS: { min: 60_000, max: 7_200_000 },
  MCP_RESULT_MAX_BYTES: { min: 1_024, max: 10_485_760 },
  LSP_TICKET_TTL_SECONDS: { min: 10, max: 300 },
  LSP_SESSION_TTL_SECONDS: { min: 60, max: 86_400 },
};

const booleanKeys = ['AUTO_PREVIEW', 'GENERATION_VERIFY', 'AGENT_USE_HOST_LOGIN', 'RATE_LIMIT_ENABLED', 'RATE_LIMIT_FAIL_OPEN', 'OTEL_ENABLED', 'SELF_REGISTRATION_ENABLED', 'PROJECT_CLEANUP_WORKER_ENABLED', 'K8S_GENERATION_REQUIRE_IMAGE_DIGEST', 'K8S_GENERATION_REQUIRE_DEPENDENCY_PROXY', 'MCP_ENABLED', 'MCP_READ_TOOLS_ENABLED', 'LSP_ENABLED'];

export function validateEnvironment(input: Record<string, unknown>) {
  const env = { ...input } as Record<string, string>;
  const errors: string[] = [];
  const nodeEnv = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    errors.push('NODE_ENV 仅支持 development、test 或 production');
  }

  if (!env.DATABASE_URL?.startsWith('postgresql://') && !env.DATABASE_URL?.startsWith('postgres://')) {
    errors.push('DATABASE_URL 必须是 PostgreSQL 连接地址');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(env.CRED_ENCRYPTION_KEY || '')) {
    errors.push('CRED_ENCRYPTION_KEY 必须是 64 位十六进制字符串');
  }
  const encryptionKeyId = env.CRED_ENCRYPTION_KEY_ID || 'primary';
  const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
  if (!keyIdPattern.test(encryptionKeyId)) {
    errors.push('CRED_ENCRYPTION_KEY_ID 仅支持 1-32 位字母、数字、下划线或连字符');
  }
  const previousKeyIds = new Set<string>();
  for (const entry of (env.CRED_ENCRYPTION_PREVIOUS_KEYS || '').split(',').map((value) => value.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const id = separator > 0 ? entry.slice(0, separator).trim() : '';
    const key = separator > 0 ? entry.slice(separator + 1).trim() : '';
    if (!keyIdPattern.test(id) || !/^[0-9a-fA-F]{64}$/.test(key)) {
      errors.push('CRED_ENCRYPTION_PREVIOUS_KEYS 必须是 id:64位十六进制密钥的逗号分隔列表');
      continue;
    }
    if (id === encryptionKeyId || previousKeyIds.has(id)) {
      errors.push(`加密密钥 ID 重复: ${id}`);
    }
    previousKeyIds.add(id);
  }
  const redisMode = env.REDIS_MODE || 'standalone';
  if (!['standalone', 'cluster'].includes(redisMode)) {
    errors.push('REDIS_MODE 仅支持 standalone 或 cluster');
  }
  const generationExecutor = env.GENERATION_EXECUTOR || 'kubernetes';
  if (!['docker', 'kubernetes'].includes(generationExecutor)) {
    errors.push('GENERATION_EXECUTOR 仅支持 docker 或 kubernetes');
  }
  if (env.PROCESS_ROLE && !['api', 'worker'].includes(env.PROCESS_ROLE)) {
    errors.push('PROCESS_ROLE 仅支持 api 或 worker');
  }
  if (env.BUILD_GIT_SHA && !/^[a-f0-9]{7,64}$/i.test(env.BUILD_GIT_SHA)) errors.push('BUILD_GIT_SHA 必须是 7-64 位十六进制 Git SHA');
  if (env.BUILD_TIME && !Number.isFinite(Date.parse(env.BUILD_TIME))) errors.push('BUILD_TIME 必须是合法的 ISO 时间');
  if (env.KAFKA_SSL != null && !['true', 'false'].includes(env.KAFKA_SSL)) errors.push('KAFKA_SSL 仅支持 true 或 false');
  if (env.KAFKA_SASL_MECHANISM && !['plain', 'scram-sha-256', 'scram-sha-512'].includes(env.KAFKA_SASL_MECHANISM)) errors.push('KAFKA_SASL_MECHANISM 仅支持 plain、scram-sha-256 或 scram-sha-512');
  if (env.KAFKA_BROKERS) {
    const brokers = env.KAFKA_BROKERS.split(',').map((value) => value.trim()).filter(Boolean);
    if (!brokers.length || brokers.some((value) => !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(value))) errors.push('KAFKA_BROKERS 必须是逗号分隔的 host:port');
  }
  if (env.KAFKA_INSPECTOR_GROUP_ID && (env.KAFKA_INSPECTOR_GROUP_ID.length > 255 || /[\u0000-\u001f]/.test(env.KAFKA_INSPECTOR_GROUP_ID))) errors.push('KAFKA_INSPECTOR_GROUP_ID 必须是不超过 255 字符的合法名称');
  if (Boolean(env.KAFKA_SASL_USERNAME) !== Boolean(env.KAFKA_SASL_PASSWORD)) errors.push('KAFKA_SASL_USERNAME 与 KAFKA_SASL_PASSWORD 必须同时配置');
  if (Boolean(env.KAFKA_SSL_CERT) !== Boolean(env.KAFKA_SSL_KEY)) errors.push('KAFKA_SSL_CERT 与 KAFKA_SSL_KEY 必须同时配置');
  if (env.KAFKA_SSL === 'false' && (env.KAFKA_SSL_CA || env.KAFKA_SSL_CERT || env.KAFKA_SSL_KEY)) errors.push('KAFKA_SSL=false 时不能配置 TLS CA、证书或私钥');
  if (generationExecutor === 'kubernetes' && !env.K8S_GENERATION_WORKSPACE_CLAIM) {
    errors.push('Kubernetes 生成执行器必须配置 K8S_GENERATION_WORKSPACE_CLAIM');
  }
  const dependencyAccessPolicy = resolveDependencyAccessPolicy(
    env.DEPENDENCY_ACCESS_POLICY,
    env.K8S_GENERATION_REQUIRE_DEPENDENCY_PROXY,
  );
  if (!DEPENDENCY_ACCESS_POLICIES.includes(dependencyAccessPolicy)) {
    errors.push(`DEPENDENCY_ACCESS_POLICY 仅支持 ${DEPENDENCY_ACCESS_POLICIES.join('、')}`);
  }
  if (dependencyPolicyRequiresProxy(dependencyAccessPolicy)) {
    for (const key of ['DEPENDENCY_NPM_REGISTRY', 'DEPENDENCY_PIP_INDEX_URL', 'DEPENDENCY_MAVEN_MIRROR_URL']) {
      if (!env[key]) errors.push(`${key} 在 ${dependencyAccessPolicy} 策略下必须配置`);
    }
  }
  if (redisMode === 'cluster') {
    const nodes = (env.REDIS_CLUSTER_NODES || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (!nodes.length || nodes.some((node) => !/^.+:\d+$/.test(node))) {
      errors.push('REDIS_CLUSTER_NODES 必须是逗号分隔的 host:port 列表');
    } else if (nodeEnv === 'production' && nodes.length < 3) {
      errors.push('生产环境 Redis Cluster 至少配置 3 个发现节点');
    }
    if (env.REDIS_DB && env.REDIS_DB !== '0') errors.push('Redis Cluster 仅支持 REDIS_DB=0');
  }
  if (env.REDIS_TLS != null && !['true', 'false'].includes(env.REDIS_TLS)) {
    errors.push('REDIS_TLS 仅支持 true 或 false');
  }
  if (env.REDIS_CLUSTER_SCALE_READS && !['master', 'slave', 'all'].includes(env.REDIS_CLUSTER_SCALE_READS)) {
    errors.push('REDIS_CLUSTER_SCALE_READS 仅支持 master、slave 或 all');
  }
  if (nodeEnv === 'production') {
    if (env.LOCAL_PREVIEW_ENABLED === 'true') {
      errors.push('生产环境禁止启用 LOCAL_PREVIEW_ENABLED，必须使用 Kubernetes Preview');
    }
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || /dev-secret|change-me|smoke-test/i.test(env.JWT_SECRET)) {
      errors.push('生产环境 JWT_SECRET 必须是至少 32 位的非默认随机字符串');
    }
    if (env.WEB_ORIGIN === '*') errors.push('生产环境 WEB_ORIGIN 不允许使用通配符');
    if (env.AGENT_USE_HOST_LOGIN === 'true') {
      errors.push('生产环境禁止 AGENT_USE_HOST_LOGIN，必须显式注入受管 AI 凭证');
    }
    if (generationExecutor === 'kubernetes') {
      if (env.K8S_GENERATION_REQUIRE_IMAGE_DIGEST === 'false') {
        errors.push('生产 Kubernetes 生成执行器禁止关闭运行时镜像 digest 校验');
      }
      for (const key of ['SANDBOX_NODE_IMAGE', 'SANDBOX_JAVA_IMAGE', 'SANDBOX_PYTHON_IMAGE', 'SANDBOX_REACT_NATIVE_IMAGE']) {
        if (!/@sha256:[a-f0-9]{64}$/i.test(env[key] || '')) {
          errors.push(`${key} 必须配置为 name@sha256:digest`);
        }
      }
      if (dependencyPolicyRequiresProxy(dependencyAccessPolicy)) {
        for (const key of ['DEPENDENCY_NPM_REGISTRY', 'DEPENDENCY_PIP_INDEX_URL', 'DEPENDENCY_MAVEN_MIRROR_URL']) {
          if (env[key] && !env[key].startsWith('https://')) errors.push(`${key} 生产环境必须使用 HTTPS`);
        }
      }
    }
  }
  const jwtKeyId = env.JWT_KEY_ID || 'primary';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(jwtKeyId)) {
    errors.push('JWT_KEY_ID 仅支持 1-32 位字母、数字、下划线或连字符');
  }
  try {
    const previousJwtKeys = parsePreviousJwtSecrets(env.JWT_PREVIOUS_SECRETS || '');
    const ids = new Set<string>();
    for (const item of previousJwtKeys) {
      if (item.id === jwtKeyId || ids.has(item.id)) errors.push(`JWT 密钥 ID 重复: ${item.id}`);
      ids.add(item.id);
      if (nodeEnv === 'production' && /dev-secret|change-me|smoke-test/i.test(item.secret)) {
        errors.push(`JWT 历史密钥 ${item.id} 不允许使用默认值`);
      }
    }
  } catch (error) {
    errors.push((error as Error).message);
  }

  for (const [key, rule] of Object.entries(integerRules)) {
    if (env[key] == null || env[key] === '') continue;
    const value = Number(env[key]);
    if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      errors.push(`${key} 必须是 ${rule.min} 到 ${rule.max} 之间的整数`);
    }
  }
  if (env.SANDBOX_CPUS != null && env.SANDBOX_CPUS !== '') {
    const value = Number(env.SANDBOX_CPUS);
    if (!Number.isFinite(value) || value <= 0 || value > 128) {
      errors.push('SANDBOX_CPUS 必须是大于 0 且不超过 128 的数字');
    }
  }
  for (const key of booleanKeys) {
    if (env[key] != null && !['true', 'false'].includes(env[key])) {
      errors.push(`${key} 仅支持 true 或 false`);
    }
  }
  for (const key of [
    'K8S_GENERATION_BUILD_SIZE_LIMIT',
    'K8S_GENERATION_TMP_SIZE_LIMIT',
    'K8S_GENERATION_EPHEMERAL_REQUEST',
    'K8S_GENERATION_EPHEMERAL_LIMIT',
  ]) {
    if (env[key] && !/^[1-9]\d*(?:Ki|Mi|Gi|Ti)$/.test(env[key])) {
      errors.push(`${key} 必须是正整数 Kubernetes 容量，例如 512Mi 或 2Gi`);
    }
  }
  for (const key of ['OPENSEARCH_URL', 'MONITORING_ALERT_WEBHOOK_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'DEPENDENCY_NPM_REGISTRY', 'DEPENDENCY_PIP_INDEX_URL', 'DEPENDENCY_MAVEN_MIRROR_URL']) {
    if (!env[key]) continue;
    try {
      const url = new URL(env[key]);
      if (key.startsWith('DEPENDENCY_') && (url.username || url.password)) {
        errors.push(`${key} 不得在 URL 中包含凭证，请由受控网络或后续 Secret 认证机制提供`);
      }
    } catch {
      errors.push(`${key} 必须是合法 URL`);
    }
  }
  if (env.WEB_ORIGIN) {
    for (const origin of env.WEB_ORIGIN.split(',').map((value) => value.trim())) {
      try {
        new URL(origin);
      } catch {
        errors.push(`WEB_ORIGIN 包含非法 URL: ${origin}`);
      }
    }
  }
  if (env.TRUST_PROXY != null && !['true', 'false'].includes(env.TRUST_PROXY) && !/^\d+$/.test(env.TRUST_PROXY)) {
    errors.push('TRUST_PROXY 仅支持 true、false 或代理层数');
  }
  if (env.SELF_REGISTRATION_ROLE && !['viewer', 'developer'].includes(env.SELF_REGISTRATION_ROLE)) {
    errors.push('SELF_REGISTRATION_ROLE 仅支持 viewer 或 developer');
  }
  if (env.INITIAL_ADMIN_TOKEN && env.INITIAL_ADMIN_TOKEN.length < 32) {
    errors.push('INITIAL_ADMIN_TOKEN 配置后必须至少 32 位');
  }
  if (env.MCP_ENABLED === 'true') {
    const allowedHosts = (env.MCP_ALLOWED_HOSTS || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (!allowedHosts.length) errors.push('启用 MCP 时必须配置 MCP_ALLOWED_HOSTS');
    if (allowedHosts.some((host) => host.includes('://') || host.includes('/') || host.includes('*'))) {
      errors.push('MCP_ALLOWED_HOSTS 只能填写逗号分隔的精确主机名，不含协议、路径或通配符');
    }
  }

  if (errors.length) {
    throw new Error(`环境变量校验失败：\n- ${errors.join('\n- ')}`);
  }
  return env;
}

export const environmentConfigOptions: ConfigModuleOptions = {
  isGlobal: true,
  cache: true,
  expandVariables: true,
  envFilePath: ['.env', '../../.env'],
  validate: validateEnvironment,
};
