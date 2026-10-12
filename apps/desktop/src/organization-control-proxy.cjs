// Deliberately not a general-purpose remote URL proxy.
function invalid() { throw Object.assign(new Error('组织请求参数无效'), { code: 'LOCAL_ORGANIZATION_REQUEST_INVALID', status: 400 }); }
function organizationRequest(method, url, body = {}) {
  const suffix = url.pathname.replace(/^\/api\/local\/account\/enterprise/, '');
  const id = '[A-Za-z0-9_-]{1,100}';
  const routes = [
    ['GET', /^\/organizations$/],
    ['GET', new RegExp(`^/organizations/${id}/(?:members|invitations|domains|audit|policy)$`)],
    ['PUT', new RegExp(`^/organizations/${id}/policy$`), ['terminalEnabled', 'allowedModelEngines', 'allowedConnectorTypes', 'allowedGitHosts', 'allowedNetworkHosts', 'minimumClientVersion', 'offlineDays', 'expectedUpdatedAt']],
    ['PUT', new RegExp(`^/organizations/${id}/members/${id}/role$`), ['role']],
    ['DELETE', new RegExp(`^/organizations/${id}/(?:members|invitations|domains)/${id}$`)],
    ['POST', new RegExp(`^/organizations/${id}/invitations$`), ['email', 'role', 'expiresInDays']],
    ['POST', new RegExp(`^/organizations/${id}/domains$`), ['domain']],
    ['POST', new RegExp(`^/organizations/${id}/domains/${id}/verify$`)],
  ];
  const route = routes.find(([verb, pattern]) => verb === method && pattern.test(suffix));
  if (!route) throw Object.assign(new Error('组织接口不存在'), { code: 'LOCAL_ORGANIZATION_ROUTE_NOT_FOUND', status: 404 });
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !(route[2] || []).includes(key))) invalid();
  if (method === 'PUT' && suffix.endsWith('/role') && !['owner', 'admin', 'auditor', 'member'].includes(body.role)) invalid();
  if (method === 'PUT' && suffix.endsWith('/policy')) {
    if (typeof body.terminalEnabled !== 'boolean' || !Number.isInteger(body.offlineDays) || body.offlineDays < 0 || body.offlineDays > 90 || typeof body.expectedUpdatedAt !== 'string' || body.expectedUpdatedAt.length > 40 || !Number.isFinite(new Date(body.expectedUpdatedAt).getTime()) || typeof body.minimumClientVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(body.minimumClientVersion)) invalid();
    for (const [key, max] of [['allowedModelEngines', 50], ['allowedConnectorTypes', 50], ['allowedGitHosts', 100], ['allowedNetworkHosts', 200]]) if (!Array.isArray(body[key]) || body[key].length > max || body[key].some((item) => typeof item !== 'string' || item.length > 253)) invalid();
  }
  if (route[2]?.includes('email') && (typeof body.email !== 'string' || body.email.length > 320 || !body.email.includes('@'))) invalid();
  if (route[2]?.includes('email') && body.role !== undefined && !['admin', 'auditor', 'member'].includes(body.role)) invalid();
  if (body.expiresInDays !== undefined && (!Number.isInteger(body.expiresInDays) || body.expiresInDays < 1 || body.expiresInDays > 30)) invalid();
  if (route[2]?.includes('domain') && (typeof body.domain !== 'string' || !body.domain.trim() || body.domain.length > 253)) invalid();
  const query = new URLSearchParams(); const auditKeys = ['q', 'actor', 'action', 'result', 'from', 'to', 'page', 'pageSize'];
  for (const [key, value] of url.searchParams) {
    if (!suffix.endsWith('/audit') || !auditKeys.includes(key) || query.has(key) || value.length > 200) invalid();
    query.set(key, value);
  }
  return { pathname: `/api/control/enterprise${suffix}${query.size ? `?${query}` : ''}`, ...(route[2] ? { body } : {}) };
}
module.exports = { organizationRequest };
