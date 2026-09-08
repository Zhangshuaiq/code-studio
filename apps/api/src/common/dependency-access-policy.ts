export const DEPENDENCY_ACCESS_POLICIES = [
  'proxy-upstream',
  'proxy-cache-only',
  'direct',
] as const;

export type DependencyAccessPolicy = (typeof DEPENDENCY_ACCESS_POLICIES)[number];

/**
 * 默认通过企业代理解析依赖，并允许代理按自身配置回源。
 * 旧布尔开关仅用于兼容已有部署；显式的新策略始终优先。
 */
export function resolveDependencyAccessPolicy(
  policy?: string,
  legacyRequireProxy?: string,
): DependencyAccessPolicy {
  if (policy) return policy as DependencyAccessPolicy;
  return legacyRequireProxy === 'false' ? 'direct' : 'proxy-upstream';
}

export function dependencyPolicyRequiresProxy(policy: DependencyAccessPolicy) {
  return policy !== 'direct';
}
