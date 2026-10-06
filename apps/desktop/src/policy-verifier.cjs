const crypto = require('node:crypto');

const LOCKDOWN_POLICY = Object.freeze({ terminalEnabled: false, allowedModelEngines: [], allowedConnectorTypes: [], allowedGitHosts: [], allowedNetworkHosts: [], minimumClientVersion: null });

function evaluatePolicy(token, options = {}) {
  if (!token) return { state: 'unmanaged', organizationId: null, expiresAt: null, offlineUntil: null, policy: null, enforcementRequired: false };
  try {
    if (typeof token !== 'string' || token.length > 65_536) throw new Error('企业策略格式无效');
    const parts = token.split('.'); if (parts.length !== 3) throw new Error('企业策略格式无效');
    const header = parse(parts[0]); const payload = parse(parts[1]);
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT') throw new Error('企业策略签名算法无效');
    if (!options.publicKey || !crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), options.publicKey, Buffer.from(parts[2], 'base64url'))) throw new Error('企业策略签名无效');
    validate(payload);
    const now = Math.floor((options.now ?? Date.now()) / 1000);
    const state = now <= payload.expiresAt ? 'active' : now <= payload.offlineUntil ? 'grace' : 'expired';
    if (options.appVersion && compareVersions(options.appVersion, payload.policy.minimumClientVersion) < 0) return { state: 'upgrade-required', organizationId: payload.organizationId, expiresAt: iso(payload.expiresAt), offlineUntil: iso(payload.offlineUntil), policy: LOCKDOWN_POLICY, minimumClientVersion: payload.policy.minimumClientVersion, enforcementRequired: true, error: `企业要求 Code Studio ${payload.policy.minimumClientVersion} 或更高版本` };
    return { state, organizationId: payload.organizationId, expiresAt: iso(payload.expiresAt), offlineUntil: iso(payload.offlineUntil), policy: state === 'expired' ? LOCKDOWN_POLICY : payload.policy, minimumClientVersion: payload.policy.minimumClientVersion, enforcementRequired: true };
  } catch (error) {
    return { state: 'invalid', organizationId: null, expiresAt: null, offlineUntil: null, policy: LOCKDOWN_POLICY, enforcementRequired: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function validate(payload) {
  if (!payload || typeof payload.organizationId !== 'string' || !payload.organizationId || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) || !Number.isSafeInteger(payload.offlineUntil) || payload.expiresAt <= payload.issuedAt || payload.offlineUntil < payload.expiresAt) throw new Error('企业策略声明无效');
  const policy = payload.policy;
  if (!policy || typeof policy.terminalEnabled !== 'boolean') throw new Error('企业策略内容无效');
  for (const key of ['allowedModelEngines', 'allowedConnectorTypes']) if (!Array.isArray(policy[key]) || policy[key].length > 50 || policy[key].some((item) => typeof item !== 'string' || !/^[a-z][a-z0-9-]{0,49}$/.test(item))) throw new Error('企业策略白名单无效');
  if (!Array.isArray(policy.allowedGitHosts) || policy.allowedGitHosts.length > 100 || policy.allowedGitHosts.some((item) => typeof item !== 'string' || !/^(?:local|[a-z0-9.-]{1,253})$/i.test(item))) throw new Error('Git 主机白名单无效');
  if (!Array.isArray(policy.allowedNetworkHosts) || policy.allowedNetworkHosts.length > 200 || policy.allowedNetworkHosts.some((item) => typeof item !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(item))) throw new Error('网络主机白名单无效');
  if (typeof policy.minimumClientVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(policy.minimumClientVersion)) throw new Error('最低客户端版本无效');
  payload.policy = { terminalEnabled: policy.terminalEnabled, allowedModelEngines: [...new Set(policy.allowedModelEngines)], allowedConnectorTypes: [...new Set(policy.allowedConnectorTypes)], allowedGitHosts: [...new Set(policy.allowedGitHosts.map((item) => item.toLowerCase()))], allowedNetworkHosts: [...new Set(policy.allowedNetworkHosts.map((item) => item.toLowerCase()))], minimumClientVersion: policy.minimumClientVersion };
}
function compareVersions(left, right) { const a = String(left).split(/[.-]/).slice(0, 3).map((value) => Number(value) || 0); const b = String(right).split(/[.-]/).slice(0, 3).map((value) => Number(value) || 0); for (let index = 0; index < 3; index += 1) { if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1; } return 0; }
function parse(value) { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
function iso(value) { return new Date(value * 1000).toISOString(); }

module.exports = { evaluatePolicy, LOCKDOWN_POLICY };
