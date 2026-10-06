const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ExcelJS = require('exceljs');
const { LocalStore } = require('./local-store.cjs');
const { LocalAgentRuntime } = require('./local-agent-runtime.cjs');
const { LocalPreviewRuntime } = require('./local-preview-runtime.cjs');
const { LocalJavaRuntime } = require('./local-java-runtime.cjs');
const { LocalTerminalRuntime } = require('./local-terminal-runtime.cjs');
const { LocalConnectorRuntime, validateConnector } = require('./local-connector-runtime.cjs');
const { LocalLspManager } = require('./local-lsp-manager.cjs');
const { evaluateLicense } = require('./license-verifier.cjs');
const { evaluatePolicy } = require('./policy-verifier.cjs');

const LOCAL_API_PREFIX = '/api/local';
const COMMUNITY_CAPABILITIES = Object.freeze({
  edition: 'community', accountRequired: false, licenseRequired: false, coreAccessExpiresAt: null, remoteApiRequired: false,
  capabilities: Object.freeze({ projects: true, files: true, git: true, terminal: true, preview: true, localAgent: true, search: true, codeNavigation: true, connectors: true, cloudSync: false, teamWorkspace: false, enterpriseGovernance: false }),
});
const LICENSE_SETTING = 'license.token';
const DEVICE_SETTING = 'device.id';
const POLICY_SETTING = 'enterprise.policyToken';
const CONTROL_TOKEN_SETTING = 'control.accessTokenCiphertext';
const CONTROL_USER_SETTING = 'control.user';
const OFFLINE_CHALLENGE_SETTING = 'license.offlineChallenge';
const SOURCE_INDEX_LIMITS = Object.freeze({ files: 500, totalBytes: 8 * 1024 * 1024, fileBytes: 256 * 1024 });
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function json(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function hasSessionToken(request, token) {
  if (request.headers.authorization === `Bearer ${token}`) return true;
  return (request.headers.cookie || '').split(';').some((part) => part.trim() === `code_studio_session=${token}`);
}

function createLocalApi(options = {}) {
  const token = options.token || crypto.randomBytes(32).toString('base64url');
  const staticDir = options.staticDir ? path.resolve(options.staticDir) : undefined;
  const store = options.storePath ? new LocalStore(options.storePath) : null;
  const deviceId = options.deviceId || store?.getSetting(DEVICE_SETTING) || crypto.randomBytes(24).toString('base64url');
  if (store && !store.getSetting(DEVICE_SETTING)) store.setSetting(DEVICE_SETTING, deviceId);
  const licenseStatus = () => evaluateLicense(store?.getSetting(LICENSE_SETTING), {
    publicKey: options.licensePublicKey,
    deviceId,
    now: typeof options.licenseNow === 'function' ? options.licenseNow() : options.licenseNow,
  });
  const policyStatus = () => evaluatePolicy(store?.getSetting(POLICY_SETTING), { publicKey: options.policyPublicKey, now: typeof options.policyNow === 'function' ? options.policyNow() : options.policyNow, appVersion: options.appVersion });
  const credentialCodec = options.credentialCodec;
  const lspManager = new LocalLspManager({ idleMs: options.lspIdleMs, dataRoot: options.lspDataRoot });
  const agentRuntime = store ? new LocalAgentRuntime({ store, credentialCodec, commands: options.agentCommands, timeoutMs: options.agentTimeoutMs, codeIntelligence: (project, name, input) => runCodeIntelligenceTool(lspManager, project, name, input) }) : null;
  const previewRuntime = new LocalPreviewRuntime({ command: options.previewCommand });
  const javaRuntime = new LocalJavaRuntime(lspManager);
  const terminalRuntime = new LocalTerminalRuntime();
  const connectorRuntime = new LocalConnectorRuntime();
  const executionRuntime = { shutdown: () => Promise.all([terminalRuntime.shutdown(), javaRuntime.shutdown()]) };
  const projects = new Map((store?.listProjects() ?? []).map((project) => [project.id, project]));
  const agentWriteApprovals = new Map();
  let origin;
  const server = http.createServer(async (request, response) => {
    try {
    const url = new URL(request.url || '/', origin);
    const isApi = url.pathname.startsWith(`${LOCAL_API_PREFIX}/`) || url.pathname === LOCAL_API_PREFIX;
    if (isApi) {
      const requestOrigin = request.headers.origin;
      if (requestOrigin && requestOrigin !== origin) {
        json(response, 403, { code: 'LOCAL_API_ORIGIN_REJECTED', message: '请求来源不受信任' });
        return;
      }
      if (!hasSessionToken(request, token)) {
        json(response, 401, { code: 'LOCAL_API_UNAUTHORIZED', message: '本地会话令牌无效' });
        return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/health`) {
        json(response, 200, { status: 'ready', runtime: 'desktop-local', edition: 'community', remoteApiRequired: false });
        return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/capabilities`) {
        json(response, 200, capabilitiesFor(licenseStatus())); return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/license`) {
        json(response, 200, { ...licenseStatus(), deviceId }); return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/account`) {
        json(response, 200, { serverUrl: resolveControlServerUrl(options.controlServerUrl), signedIn: Boolean(store?.getSetting(CONTROL_TOKEN_SETTING)), user: store?.getSetting(CONTROL_USER_SETTING) || null, license: licenseStatus(), policy: policyStatus(), deviceId }); return;
      }
      if (request.method === 'POST' && url.pathname === `${LOCAL_API_PREFIX}/account/login`) {
        if (!store) { json(response, 503, { code: 'LOCAL_STORE_UNAVAILABLE', message: '本地配置存储不可用' }); return; }
        const body = await readJsonBody(request, 32 * 1024); const username = typeof body.username === 'string' ? body.username.trim() : ''; const password = typeof body.password === 'string' ? body.password : '';
        if (!username || !password || username.length > 254 || password.length > 1024) { json(response, 400, { code: 'LOCAL_ACCOUNT_LOGIN_INVALID', message: '请输入有效的账号和密码' }); return; }
        try {
          const remote = await controlRequest(options.controlServerUrl, '/api/auth/login', { method: 'POST', body: { username, password } });
          if (typeof remote.accessToken !== 'string' || !remote.accessToken || !remote.user?.id) throw new Error('服务端登录响应无效');
          store.setSetting(CONTROL_TOKEN_SETTING, encryptCredential(remote.accessToken, credentialCodec)); store.setSetting(CONTROL_USER_SETTING, { id: remote.user.id, username: remote.user.username });
          json(response, 200, { signedIn: true, user: store.getSetting(CONTROL_USER_SETTING) });
        } catch (error) { json(response, 422, { code: 'LOCAL_ACCOUNT_LOGIN_FAILED', message: safeConnectorError(error, password) }); }
        return;
      }
      if (request.method === 'DELETE' && url.pathname === `${LOCAL_API_PREFIX}/account`) {
        store?.deleteSetting(CONTROL_TOKEN_SETTING); store?.deleteSetting(CONTROL_USER_SETTING); response.writeHead(204); response.end(); return;
      }
      if (request.method === 'POST' && url.pathname === `${LOCAL_API_PREFIX}/account/license/redeem`) {
        let code = '';
        try {
          const body = await readJsonBody(request, 8 * 1024); code = typeof body.code === 'string' ? body.code.trim() : '';
          if (code.length < 12 || code.length > 128) { json(response, 400, { code: 'LOCAL_REDEEM_INVALID', message: '请输入有效的兑换码' }); return; }
          const subscription = await authenticatedControlRequest(store, credentialCodec, options.controlServerUrl, '/api/control/license/redeem', { method: 'POST', body: { code } });
          json(response, 200, { subscription });
        } catch (error) { json(response, error?.code === 'LOCAL_ACCOUNT_REQUIRED' ? 401 : 422, { code: error?.code || 'LOCAL_REDEEM_FAILED', message: safeConnectorError(error, code) }); }
        return;
      }
      if (request.method === 'POST' && url.pathname === `${LOCAL_API_PREFIX}/account/license/activate`) {
        try {
          if (!options.licensePublicKey) throw new Error('当前客户端未配置许可证验证公钥');
          const remote = await authenticatedControlRequest(store, credentialCodec, options.controlServerUrl, '/api/control/license/activate', { method: 'POST', body: { deviceId, name: bodyDeviceName(), platform: process.platform, appVersion: options.appVersion || null } });
          const status = evaluateLicense(remote.token, { publicKey: options.licensePublicKey, deviceId });
          if (!['active', 'grace'].includes(status.state)) throw new Error(status.error || '服务端返回的许可证无效');
          if (status.edition === 'enterprise') await refreshEnterprisePolicy(store, credentialCodec, options, policyStatus, executionRuntime);
          store.setSetting(LICENSE_SETTING, remote.token); json(response, 200, { ...status, deviceId, policy: policyStatus() });
        } catch (error) { json(response, error?.code === 'LOCAL_ACCOUNT_REQUIRED' ? 401 : 422, { code: error?.code || 'LOCAL_LICENSE_ACTIVATION_FAILED', message: safeConnectorError(error, '') }); }
        return;
      }
      if (request.method === 'POST' && url.pathname === `${LOCAL_API_PREFIX}/account/enterprise/policy/refresh`) {
        try { json(response, 200, await refreshEnterprisePolicy(store, credentialCodec, options, policyStatus, executionRuntime)); }
        catch (error) { json(response, error?.code === 'LOCAL_ACCOUNT_REQUIRED' ? 401 : 422, { code: error?.code || 'LOCAL_POLICY_REFRESH_FAILED', message: safeConnectorError(error, '') }); } return;
      }
      if (request.method === 'POST' && url.pathname === `${LOCAL_API_PREFIX}/account/enterprise/invitations/accept`) {
        let invitationToken = '';
        try {
          const body = await readJsonBody(request, 8 * 1024); invitationToken = typeof body.token === 'string' ? body.token.trim() : '';
          if (!/^[A-Za-z0-9_-]{43}$/.test(invitationToken)) { json(response, 400, { code: 'LOCAL_INVITATION_INVALID', message: '请输入有效的邀请代码' }); return; }
          json(response, 200, await authenticatedControlRequest(store, credentialCodec, options.controlServerUrl, '/api/control/enterprise/invitations/accept', { method: 'POST', body: { token: invitationToken } }));
        } catch (error) { json(response, error?.code === 'LOCAL_ACCOUNT_REQUIRED' ? 401 : 422, { code: error?.code || 'LOCAL_INVITATION_FAILED', message: safeConnectorError(error, invitationToken) }); }
        return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/account/devices`) {
        try { json(response, 200, { items: await authenticatedControlRequest(store, credentialCodec, options.controlServerUrl, '/api/control/license/devices') }); }
        catch (error) { json(response, error?.code === 'LOCAL_ACCOUNT_REQUIRED' ? 401 : 422, { code: error?.code || 'LOCAL_ACCOUNT_REQUEST_FAILED', message: safeConnectorError(error, '') }); } return;
      }
      const accountDeviceMatch = url.pathname.match(/^\/api\/local\/account\/devices\/([0-9a-f-]{8,64})$/i);
      if (request.method === 'DELETE' && accountDeviceMatch) {
        try { await authenticatedControlRequest(store, credentialCodec, options.controlServerUrl, `/api/control/license/devices/${accountDeviceMatch[1]}`, { method: 'DELETE' }); json(response, 200, { success: true }); }
        catch (error) { json(response, error?.code === 'LOCAL_ACCOUNT_REQUIRED' ? 401 : 422, { code: error?.code || 'LOCAL_ACCOUNT_REQUEST_FAILED', message: safeConnectorError(error, '') }); } return;
      }
      if (request.method === 'POST' && url.pathname === `${LOCAL_API_PREFIX}/license`) {
        if (!store) { json(response, 503, { code: 'LOCAL_STORE_UNAVAILABLE', message: '配置服务暂时不可用' }); return; }
        if (!options.licensePublicKey) { json(response, 503, { code: 'LOCAL_LICENSE_UNAVAILABLE', message: '当前版本未配置许可证验证信息' }); return; }
        const body = await readJsonBody(request, 48 * 1024);
        const status = evaluateLicense(body.token, { publicKey: options.licensePublicKey, deviceId, now: typeof options.licenseNow === 'function' ? options.licenseNow() : options.licenseNow });
        if (!['active', 'grace'].includes(status.state)) { json(response, 400, { code: 'LOCAL_LICENSE_INVALID', message: status.error || '许可证已失效' }); return; }
        store.setSetting(LICENSE_SETTING, body.token); json(response, 200, { ...status, deviceId }); return;
      }
      if (request.method === 'DELETE' && url.pathname === `${LOCAL_API_PREFIX}/license`) {
        store?.deleteSetting(LICENSE_SETTING); response.writeHead(204); response.end(); return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/privacy`) {
        const license = licenseStatus();
        json(response, 200, privacySettings(store, license)); return;
      }
      if (request.method === 'PUT' && url.pathname === `${LOCAL_API_PREFIX}/privacy`) {
        if (!store) { json(response, 503, { code: 'LOCAL_STORE_UNAVAILABLE', message: '配置服务暂时不可用' }); return; }
        const body = await readJsonBody(request, 16 * 1024);
        if (typeof body.settingsSync !== 'boolean' || typeof body.conversationSync !== 'boolean') { json(response, 400, { code: 'LOCAL_PRIVACY_INVALID', message: '同步隐私设置无效' }); return; }
        const license = licenseStatus();
        const cloudSyncAvailable = ['active', 'grace'].includes(license.state) && license.entitlements.includes('cloud.sync');
        if ((body.settingsSync || body.conversationSync) && !cloudSyncAvailable) { json(response, 403, { code: 'LOCAL_SYNC_ENTITLEMENT_REQUIRED', message: '当前版本未启用云同步能力' }); return; }
        for (const [key, enabled] of Object.entries({ settingsSync: body.settingsSync, conversationSync: body.conversationSync })) {
          if (Boolean(store.getSetting(`privacy.${key}`)) !== enabled) store.setPrivacySetting(key, enabled);
        }
        json(response, 200, privacySettings(store, license)); return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/enterprise/policy`) {
        json(response, 200, policyStatus()); return;
      }
      if (request.method === 'POST' && url.pathname === `${LOCAL_API_PREFIX}/enterprise/policy`) {
        if (!store || !options.policyPublicKey) { json(response, 503, { code: 'LOCAL_POLICY_UNAVAILABLE', message: '当前版本未配置企业策略验证信息' }); return; }
        const body = await readJsonBody(request, 80 * 1024); const status = evaluatePolicy(body.token, { publicKey: options.policyPublicKey, now: typeof options.policyNow === 'function' ? options.policyNow() : options.policyNow, appVersion: options.appVersion });
        if (!['active', 'grace'].includes(status.state)) { json(response, 400, { code: 'LOCAL_POLICY_INVALID', message: status.error || '企业策略已过期' }); return; }
        store.setSetting(POLICY_SETTING, body.token);
        if (!status.policy.terminalEnabled) await executionRuntime.shutdown();
        json(response, 200, status); return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/projects`) {
        json(response, 200, { items: [...projects.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt)).map(withAvailability) });
        return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/models`) {
        json(response, 200, { items: (store?.listModelConfigs() || []).map(publicModelConfig) });
        return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/models/discover`) {
        json(response, 200, { items: await discoverLocalAgents(options.agentCommands) });
        return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/models/catalog`) {
        const engine = url.searchParams.get('engine');
        if (engine !== 'codex-cli') { json(response, 200, { engine, items: [] }); return; }
        try { json(response, 200, { engine, items: await discoverCodexModels(options.agentCommands) }); }
        catch (error) { json(response, 422, { code: 'LOCAL_MODEL_CATALOG_FAILED', message: safeConnectorError(error, '') }); }
        return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/models/usage`) {
        const items = store?.listAgentUsage() || [];
        json(response, 200, { items: items.map((item) => ({ ...item, totalTokens: Number(item.inputTokens) + Number(item.outputTokens) })) }); return;
      }
      if (request.method === 'GET' && url.pathname === `${LOCAL_API_PREFIX}/connectors`) {
        json(response, 200, { items: (store?.listConnectors() || []).map(publicConnector) }); return;
      }
      if (request.method === 'POST' && url.pathname === `${LOCAL_API_PREFIX}/connectors`) {
        if (!store) { json(response, 503, { code: 'LOCAL_STORE_UNAVAILABLE', message: '配置服务暂时不可用' }); return; }
        const body = await readJsonBody(request, 64 * 1024); const config = validateConnector(body, crypto.randomBytes(12).toString('hex'));
        const activePolicy = policyStatus();
        if (!policyAllows(activePolicy, 'connector', config.type)) { json(response, 403, policyDenied('当前企业策略不允许使用该连接器')); return; }
        const blockedHost = firstBlockedNetworkHost(activePolicy, connectorHosts(config)); if (blockedHost) { json(response, 403, policyDenied(`当前企业策略不允许访问网络主机 ${blockedHost}`)); return; }
        store.upsertConnector(config, encryptCredential(body.secret, credentialCodec)); json(response, 201, publicConnector(store.getConnector(config.id))); return;
      }
      const connectorMatch = url.pathname.match(/^\/api\/local\/connectors\/([a-f0-9]{24})(?:\/(test|explore))?$/);
      if (connectorMatch && request.method === 'POST' && connectorMatch[2] === 'test') {
        const row = store?.getConnector(connectorMatch[1]); if (!row) { json(response, 404, { code: 'LOCAL_CONNECTOR_NOT_FOUND', message: '连接配置不存在' }); return; }
        const activePolicy = policyStatus(); if (!policyAllows(activePolicy, 'connector', row.type)) { json(response, 403, policyDenied('当前企业策略不允许使用该连接器')); return; }
        const blockedHost = firstBlockedNetworkHost(activePolicy, connectorHosts(row)); if (blockedHost) { json(response, 403, policyDenied(`当前企业策略不允许访问网络主机 ${blockedHost}`)); return; }
        let secret = ''; try { if (row.credentialCiphertext) secret = credentialCodec?.decrypt(row.credentialCiphertext) || ''; const result = await connectorRuntime.test(row, secret); json(response, 200, result); }
        catch (error) { json(response, 422, { code: 'LOCAL_CONNECTOR_TEST_FAILED', message: safeConnectorError(error, secret) }); } return;
      }
      if (connectorMatch && request.method === 'POST' && connectorMatch[2] === 'explore') {
        const row = store?.getConnector(connectorMatch[1]); if (!row) { json(response, 404, { code: 'LOCAL_CONNECTOR_NOT_FOUND', message: '连接配置不存在' }); return; }
        const activePolicy = policyStatus(); if (!policyAllows(activePolicy, 'connector', row.type)) { json(response, 403, policyDenied('当前企业策略不允许使用该连接器')); return; }
        const blockedHost = firstBlockedNetworkHost(activePolicy, connectorHosts(row)); if (blockedHost) { json(response, 403, policyDenied(`当前企业策略不允许访问网络主机 ${blockedHost}`)); return; }
        const body = await readJsonBody(request, 128 * 1024); let secret = '';
        const personalDatabaseAccess = ['community', 'personal-pro'].includes(licenseStatus().edition) && !activePolicy.enforcementRequired;
        try { if (row.credentialCiphertext) secret = credentialCodec?.decrypt(row.credentialCiphertext) || ''; json(response, 200, await connectorRuntime.explore(row, secret, { ...body, readOnly: !personalDatabaseAccess })); }
        catch (error) { json(response, 422, { code: 'LOCAL_CONNECTOR_EXPLORE_FAILED', message: safeConnectorError(error, secret) }); } return;
      }
      if (connectorMatch && request.method === 'DELETE' && !connectorMatch[2]) {
        if (!store?.getConnector(connectorMatch[1])) { json(response, 404, { code: 'LOCAL_CONNECTOR_NOT_FOUND', message: '连接配置不存在' }); return; }
        store.deleteConnector(connectorMatch[1]); response.writeHead(204); response.end(); return;
      }
      if (request.method === 'POST' && url.pathname === `${LOCAL_API_PREFIX}/models`) {
        if (!store) { json(response, 503, { code: 'LOCAL_STORE_UNAVAILABLE', message: '本地配置存储不可用' }); return; }
        const body = await readJsonBody(request, 64 * 1024);
        const config = validateModelConfig(body, crypto.randomBytes(12).toString('hex'));
        const activePolicy = policyStatus();
        if (!policyAllows(activePolicy, 'model', config.engine)) { json(response, 403, policyDenied('当前企业策略不允许使用该模型平台')); return; }
        const blockedHost = firstBlockedNetworkHost(activePolicy, modelHosts(config)); if (blockedHost) { json(response, 403, policyDenied(`当前企业策略不允许访问模型主机 ${blockedHost}`)); return; }
        const encrypted = encryptCredential(body.apiKey, credentialCodec);
        store.upsertModelConfig(config, encrypted);
        json(response, 201, publicModelConfig(store.getModelConfig(config.id)));
        return;
      }
      const modelMatch = url.pathname.match(/^\/api\/local\/models\/([a-f0-9]{24})(?:\/(test))?$/);
      if (modelMatch && request.method === 'POST' && modelMatch[2] === 'test') {
        const row = store?.getModelConfig(modelMatch[1]);
        if (!row) { json(response, 404, { code: 'LOCAL_MODEL_NOT_FOUND', message: '本地模型配置不存在' }); return; }
        const activePolicy = policyStatus(); if (!policyAllows(activePolicy, 'model', row.engine)) { json(response, 403, policyDenied('当前企业策略不允许使用该模型平台')); return; }
        const blockedHost = firstBlockedNetworkHost(activePolicy, modelHosts(row)); if (blockedHost) { json(response, 403, policyDenied(`当前企业策略不允许访问模型主机 ${blockedHost}`)); return; }
        let config;
        try { config = resolvePrivateModelConfig(row, credentialCodec); json(response, 200, await testModelConnection(config, options.agentCommands)); }
        catch (error) { json(response, 422, { code: 'LOCAL_MODEL_TEST_FAILED', message: safeConnectorError(error, config?.apiKey || '') }); }
        return;
      }
      if (modelMatch && !modelMatch[2] && request.method === 'PUT') {
        if (!store) { json(response, 503, { code: 'LOCAL_STORE_UNAVAILABLE', message: '本地配置存储不可用' }); return; }
        const current = store.getModelConfig(modelMatch[1]);
        if (!current) { json(response, 404, { code: 'LOCAL_MODEL_NOT_FOUND', message: '本地模型配置不存在' }); return; }
        const body = await readJsonBody(request, 64 * 1024);
        const config = validateModelConfig({ ...current, ...body }, current.id);
        const activePolicy = policyStatus(); if (!policyAllows(activePolicy, 'model', config.engine)) { json(response, 403, policyDenied('当前企业策略不允许使用该模型平台')); return; }
        const blockedHost = firstBlockedNetworkHost(activePolicy, modelHosts(config)); if (blockedHost) { json(response, 403, policyDenied(`当前企业策略不允许访问模型主机 ${blockedHost}`)); return; }
        const encrypted = body.apiKey === undefined ? undefined : encryptCredential(body.apiKey, credentialCodec);
        store.upsertModelConfig(config, encrypted);
        json(response, 200, publicModelConfig(store.getModelConfig(config.id)));
        return;
      }
      if (modelMatch && !modelMatch[2] && request.method === 'DELETE') {
        if (!store?.getModelConfig(modelMatch[1])) { json(response, 404, { code: 'LOCAL_MODEL_NOT_FOUND', message: '本地模型配置不存在' }); return; }
        store.deleteModelConfig(modelMatch[1]); response.writeHead(204); response.end(); return;
      }
      const filesMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/files$/);
      const lspPrepareMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/language\/prepare$/);
      const javaSourceMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/language\/source$/);
      if (javaSourceMatch && request.method === 'GET') {
        const project = projects.get(javaSourceMatch[1]); if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '项目不存在或尚未打开' }); return; }
        json(response, 200, await lspManager.javaSource(project, url.searchParams.get('path'))); return;
      }
      if (lspPrepareMatch && request.method === 'POST') {
        const project = projects.get(lspPrepareMatch[1]); if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '项目不存在或尚未打开' }); return; }
        json(response, 200, await lspManager.prepareProject(project)); return;
      }
      const lspMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/language\/(definition|declaration|type-definition|implementation|references|hover|completion|diagnostics|rename|code-actions|call-hierarchy-prepare|call-hierarchy-incoming|call-hierarchy-outgoing|document-symbols|workspace-symbols)$/);
      if (lspMatch && (request.method === 'GET' || request.method === 'POST')) {
        const project = projects.get(lspMatch[1]); if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '项目不存在或尚未打开' }); return; }
        const operation = lspMatch[2];
        if (operation === 'workspace-symbols') {
          const query = String(url.searchParams.get('query') || '').trim(); if (query.length > 200) { json(response, 400, { code: 'LOCAL_LSP_REQUEST_INVALID', message: '搜索内容过长' }); return; }
          json(response, 200, { items: await lspManager.workspaceSymbols(project, query) }); return;
        }
        const body = request.method === 'POST' ? await readJsonBody(request, 2 * 1024 * 1024) : {};
        const input = { ...body, path: body.path || body.item?.path || url.searchParams.get('path'), content: body.content, line: Number(body.line || url.searchParams.get('line') || 0), column: Number(body.column || url.searchParams.get('column') || 0) };
        const positionRequired = !['document-symbols', 'diagnostics', 'call-hierarchy-incoming', 'call-hierarchy-outgoing'].includes(operation);
        if (!input.path || (positionRequired && (!Number.isInteger(input.line) || input.line < 1 || !Number.isInteger(input.column) || input.column < 1))) { json(response, 400, { code: 'LOCAL_LSP_REQUEST_INVALID', message: '代码位置无效' }); return; }
        if (operation === 'diagnostics') { json(response, 200, { result: await lspManager.diagnostics(project, input) }); return; }
        if (operation === 'rename') { json(response, 200, { result: await lspManager.rename(project, input) }); return; }
        if (operation === 'code-actions') { json(response, 200, { result: await lspManager.codeActions(project, input) }); return; }
        if (operation.startsWith('call-hierarchy-')) { json(response, 200, { result: await lspManager.callHierarchy(project, operation.slice('call-hierarchy-'.length), input) }); return; }
        const methods = { 'document-symbols': 'documentSymbols', 'type-definition': 'typeDefinition' };
        json(response, 200, { result: await lspManager.request(project, methods[operation] || operation, input) }); return;
      }
      const projectTerminalMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/terminal$/);
      const projectActivityMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/activity$/);
      if (projectActivityMatch && request.method === 'GET') {
        const project = projects.get(projectActivityMatch[1]); if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '项目不存在或尚未打开' }); return; }
        const terminal = terminalRuntime.getForProject(project.id);
        json(response, 200, {
          preview: previewRuntime.inspect(project),
          terminal: terminal ? { id: terminal.id, status: terminal.status, shell: terminal.shell, exitCode: terminal.exitCode } : null,
          agentTasks: (store?.listAgentTasks(project.id, 10) || []).map(({ prompt, ...task }) => ({ ...task, summary: prompt.slice(0, 160) })),
        }); return;
      }
      if (projectTerminalMatch && request.method === 'GET') {
        const project = projects.get(projectTerminalMatch[1]); if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '项目不存在或尚未打开' }); return; }
        const session = terminalRuntime.getForProject(project.id); json(response, 200, session ? terminalRuntime.output(session.id, Number(url.searchParams.get('after') || 0)) : { status: 'closed', chunks: [] }); return;
      }
      if (projectTerminalMatch && request.method === 'POST') {
        const project = projects.get(projectTerminalMatch[1]); if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '项目不存在或尚未打开' }); return; }
        if (!policyAllows(policyStatus(), 'terminal')) { json(response, 403, policyDenied('当前企业策略已关闭终端')); return; }
        const body = await readJsonBody(request, 16 * 1024); if (body.confirmed !== true) { json(response, 400, { code: 'LOCAL_TERMINAL_CONFIRMATION_REQUIRED', message: '启动终端前需要确认' }); return; }
        json(response, 201, terminalRuntime.create(project, body)); return;
      }
      const terminalMatch = url.pathname.match(/^\/api\/local\/terminal\/([a-f0-9]{24})(?:\/(input|resize))?$/);
      if (terminalMatch && request.method === 'GET' && !terminalMatch[2]) {
        const output = terminalRuntime.output(terminalMatch[1], Number(url.searchParams.get('after') || 0)); if (!output) { json(response, 404, { code: 'LOCAL_TERMINAL_NOT_FOUND', message: '终端会话已结束' }); return; }
        json(response, 200, output); return;
      }
      if (terminalMatch && request.method === 'POST' && terminalMatch[2] === 'input') {
        const body = await readJsonBody(request, 128 * 1024); if (typeof body.data !== 'string' || body.data.length > 65_536) { json(response, 400, { code: 'LOCAL_TERMINAL_INPUT_INVALID', message: '终端输入无效' }); return; }
        if (!terminalRuntime.write(terminalMatch[1], body.data)) { json(response, 409, { code: 'LOCAL_TERMINAL_NOT_RUNNING', message: '终端已结束' }); return; } response.writeHead(204); response.end(); return;
      }
      if (terminalMatch && request.method === 'POST' && terminalMatch[2] === 'resize') {
        const body = await readJsonBody(request, 16 * 1024); if (!terminalRuntime.resize(terminalMatch[1], body.cols, body.rows)) { json(response, 409, { code: 'LOCAL_TERMINAL_NOT_RUNNING', message: '终端已结束' }); return; } response.writeHead(204); response.end(); return;
      }
      if (terminalMatch && request.method === 'DELETE' && !terminalMatch[2]) { if (!terminalRuntime.close(terminalMatch[1])) { json(response, 404, { code: 'LOCAL_TERMINAL_NOT_FOUND', message: '终端会话已结束' }); return; } response.writeHead(204); response.end(); return; }
      const javaRunMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/java-run(?:\/(targets|start|stop|continue|next|stepIn|stepOut|pause|breakpoints|scopes|variables))?$/);
      if (javaRunMatch) {
        try {
        const project = projects.get(javaRunMatch[1]);
        if (!project) { json(response, 404, { message: '本地项目不存在' }); return; }
        if (!policyAllows(policyStatus(), 'terminal')) { json(response, 403, policyDenied('当前企业策略不允许运行程序')); return; }
        const action = javaRunMatch[2];
        if (request.method === 'GET' && !action) { json(response, 200, javaRuntime.inspect(project)); return; }
        if (request.method === 'GET' && action === 'targets') { json(response, 200, { targets: await javaRuntime.targets(project) }); return; }
        if (request.method === 'POST' && action && action !== 'targets') {
          const body = await readJsonBody(request, 80 * 1024);
          json(response, 200, action === 'start' ? await javaRuntime.start(project, body) : await javaRuntime.action(project, action, body)); return;
        }
        } catch (error) { json(response, 400, { code: error.code || 'LOCAL_JAVA_RUN_FAILED', message: error.message || 'Java 运行操作失败', issues: error.issues || [] }); return; }
      }
      const previewMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/preview$/);
      if (previewMatch && request.method === 'GET') {
        const project = projects.get(previewMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        json(response, 200, previewRuntime.inspect(project)); return;
      }
      if (previewMatch && request.method === 'POST') {
        const project = projects.get(previewMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const body = await readJsonBody(request, 16 * 1024);
        json(response, 202, await previewRuntime.start(project, body.targetId || body.script)); return;
      }
      if (previewMatch && request.method === 'DELETE') {
        const project = projects.get(previewMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        if (!previewRuntime.stop(project.id)) { json(response, 409, { code: 'LOCAL_PREVIEW_NOT_RUNNING', message: '本地预览当前未运行' }); return; }
        json(response, 202, previewRuntime.inspect(project)); return;
      }
      const projectTasksMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/agent\/tasks$/);
      if (projectTasksMatch && request.method === 'GET') {
        const project = projects.get(projectTasksMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        json(response, 200, { items: store?.listAgentTasks(project.id) || [] });
        return;
      }
      if (projectTasksMatch && request.method === 'POST') {
        const project = projects.get(projectTasksMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        if (!store || !agentRuntime) { json(response, 503, { code: 'LOCAL_AGENT_UNAVAILABLE', message: '智能助手暂不可用，请稍后重试' }); return; }
        if (agentRuntime.isProjectBusy(project.id)) { json(response, 409, { code: 'LOCAL_AGENT_BUSY', message: '该工作区已有 Agent 任务运行中' }); return; }
        const body = await readJsonBody(request, 1024 * 1024);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const permissionProfile = body.permissionProfile === 'workspace-write' ? 'workspace-write' : body.permissionProfile === 'read-only' ? 'read-only' : null;
        const configRow = typeof body.modelConfigId === 'string' ? store.getModelConfig(body.modelConfigId) : null;
        if (!prompt || prompt.length > 200_000) { json(response, 400, { code: 'LOCAL_AGENT_PROMPT_INVALID', message: '任务内容不能为空且不能超过 200000 个字符' }); return; }
        if (!permissionProfile) { json(response, 400, { code: 'LOCAL_AGENT_PERMISSION_INVALID', message: '请选择只读或允许修改工作区' }); return; }
        if (permissionProfile === 'workspace-write' && !consumeAgentWriteApproval(agentWriteApprovals, { projectId: project.id, modelConfigId: body.modelConfigId, prompt }, body.approvalToken)) { json(response, 403, { code: 'LOCAL_AGENT_APPROVAL_REQUIRED', message: '需要在桌面客户端确认本次文件修改权限' }); return; }
        if (!configRow) { json(response, 404, { code: 'LOCAL_MODEL_NOT_FOUND', message: '本地模型配置不存在' }); return; }
        const selectedModel = typeof body.model === 'string' ? body.model.trim() : configRow.model || '';
        const reasoningEffort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort : null;
        if (selectedModel.length > 200 || (reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort))) { json(response, 400, { code: 'LOCAL_AGENT_MODEL_INVALID', message: '模型或推理强度无效' }); return; }
        if (configRow.engine !== 'codex-cli' && (body.model !== undefined || body.reasoningEffort !== undefined)) { json(response, 400, { code: 'LOCAL_AGENT_MODEL_OVERRIDE_UNSUPPORTED', message: '当前模型平台不支持任务级模型切换' }); return; }
        const activePolicy = policyStatus(); if (!policyAllows(activePolicy, 'model', configRow.engine)) { json(response, 403, policyDenied('当前企业策略不允许运行该模型平台')); return; }
        const blockedHost = firstBlockedNetworkHost(activePolicy, modelHosts(configRow)); if (blockedHost) { json(response, 403, policyDenied(`当前企业策略不允许访问模型主机 ${blockedHost}`)); return; }
        const task = { id: crypto.randomBytes(12).toString('hex'), projectId: project.id, modelConfigId: configRow.id, prompt, permissionProfile, selectedModel: selectedModel || null, reasoningEffort, status: 'queued', createdAt: new Date().toISOString() };
        const config = { ...resolvePrivateModelConfig(configRow, credentialCodec), model: selectedModel, reasoningEffort };
        store.createAgentTask(task);
        agentRuntime.start(task, project, config);
        json(response, 202, store.getAgentTask(task.id));
        return;
      }
      const agentTaskMatch = url.pathname.match(/^\/api\/local\/agent\/tasks\/([a-f0-9]{24})$/);
      if (agentTaskMatch && request.method === 'GET') {
        const task = store?.getAgentTask(agentTaskMatch[1]);
        if (!task) { json(response, 404, { code: 'LOCAL_AGENT_TASK_NOT_FOUND', message: '本地 Agent 任务不存在' }); return; }
        json(response, 200, task);
        return;
      }
      const agentCancelMatch = url.pathname.match(/^\/api\/local\/agent\/tasks\/([a-f0-9]{24})\/cancel$/);
      if (agentCancelMatch && request.method === 'POST') {
        const task = store?.getAgentTask(agentCancelMatch[1]);
        if (!task) { json(response, 404, { code: 'LOCAL_AGENT_TASK_NOT_FOUND', message: '本地 Agent 任务不存在' }); return; }
        if (!agentRuntime?.cancel(task.id)) { json(response, 409, { code: 'LOCAL_AGENT_NOT_RUNNING', message: '任务当前未运行' }); return; }
        json(response, 202, store.getAgentTask(task.id));
        return;
      }
      if (request.method === 'GET' && filesMatch) {
        const project = projects.get(filesMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        json(response, 200, { items: listWorkspace(project.path) });
        return;
      }
      if (request.method === 'POST' && filesMatch) {
        const project = projects.get(filesMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const body = await readJsonBody(request, 16 * 1024);
        const target = resolveNewWorkspaceEntry(project.path, body.path);
        if (!['file', 'directory'].includes(body.type)) { json(response, 400, { code: 'LOCAL_FILE_TYPE_INVALID', message: '请选择新建文件或文件夹' }); return; }
        if (fs.existsSync(target.absolute)) { json(response, 409, { code: 'LOCAL_FILE_EXISTS', message: '同名文件或文件夹已存在' }); return; }
        if (body.type === 'directory') fs.mkdirSync(target.absolute);
        else fs.writeFileSync(target.absolute, '', { encoding: 'utf8', flag: 'wx' });
        json(response, 201, { path: target.relativePath, type: body.type }); return;
      }
      if (request.method === 'DELETE' && filesMatch) {
        const project = projects.get(filesMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const target = resolveExistingWorkspaceEntry(project.path, url.searchParams.get('path'));
        const stat = fs.lstatSync(target.absolute);
        if (stat.isSymbolicLink()) { json(response, 400, { code: 'LOCAL_FILE_SYMLINK_FORBIDDEN', message: '不允许通过工作区删除符号链接' }); return; }
        if (stat.isDirectory()) fs.rmSync(target.absolute, { recursive: true, force: false }); else fs.unlinkSync(target.absolute);
        response.writeHead(204); response.end(); return;
      }
      const indexMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/index$/);
      if (request.method === 'GET' && indexMatch) {
        const project = projects.get(indexMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        json(response, 200, buildSourceIndex(project.path));
        return;
      }
      const contentMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/content$/);
      const rawFileMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/file-preview$/);
      const spreadsheetMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/spreadsheet$/);
      const searchMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/search$/);
      const symbolsMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/symbols$/);
      const gitStatusMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/git\/status$/);
      const gitDiffMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/git\/diff$/);
      const gitCommitMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/git\/commit$/);
      const gitBranchesMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/git\/branches$/);
      const gitCheckoutMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/git\/checkout$/);
      const gitSyncMatch = url.pathname.match(/^\/api\/local\/projects\/([a-f0-9]{24})\/git\/sync$/);
      if (gitStatusMatch && request.method === 'GET') {
        const project = projects.get(gitStatusMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        json(response, 200, await gitStatus(project.path));
        return;
      }
      if (gitDiffMatch && request.method === 'GET') {
        const project = projects.get(gitDiffMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const relativePath = validateRelativePath(project.path, url.searchParams.get('path'));
        const [working, staged] = await Promise.all([
          runGit(project.path, ['diff', '--no-ext-diff', '--', relativePath]),
          runGit(project.path, ['diff', '--cached', '--no-ext-diff', '--', relativePath]),
        ]);
        json(response, 200, { path: relativePath, working: working.stdout, staged: staged.stdout });
        return;
      }
      if (gitCommitMatch && request.method === 'POST') {
        const project = projects.get(gitCommitMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const body = await readJsonBody(request, 64 * 1024);
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        const paths = Array.isArray(body.paths) ? [...new Set(body.paths.map((item) => validateRelativePath(project.path, item)))] : [];
        if (!message || message.length > 500) { json(response, 400, { code: 'LOCAL_GIT_MESSAGE_INVALID', message: '提交信息长度应为 1～500 个字符' }); return; }
        if (!paths.length || paths.length > 500) { json(response, 400, { code: 'LOCAL_GIT_PATHS_INVALID', message: '请选择需要提交的文件' }); return; }
        await runGit(project.path, ['add', '--all', '--', ...paths]);
        const committed = await runGit(project.path, ['commit', '-m', message], { allowFailure: true });
        if (committed.code !== 0) {
          json(response, 409, { code: 'LOCAL_GIT_COMMIT_FAILED', message: gitErrorMessage(committed.stderr || committed.stdout) }); return;
        }
        json(response, 200, { committed: true, output: committed.stdout.trim(), status: await gitStatus(project.path) });
        return;
      }
      if (gitBranchesMatch && request.method === 'GET') {
        const project = projects.get(gitBranchesMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const [branchesResult, remotesResult] = await Promise.all([
          runGit(project.path, ['branch', '--format=%(refname:short)']),
          runGit(project.path, ['remote']),
        ]);
        json(response, 200, {
          branches: branchesResult.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
          remotes: remotesResult.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        });
        return;
      }
      if (gitCheckoutMatch && request.method === 'POST') {
        const project = projects.get(gitCheckoutMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const body = await readJsonBody(request, 16 * 1024);
        const branch = await validateBranchName(project.path, body.branch);
        await runGit(project.path, body.create ? ['switch', '-c', branch] : ['switch', branch]);
        json(response, 200, { switched: true, status: await gitStatus(project.path) });
        return;
      }
      if (gitSyncMatch && request.method === 'POST') {
        const project = projects.get(gitSyncMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const body = await readJsonBody(request, 16 * 1024);
        const operation = body.operation;
        if (!['fetch', 'pull', 'push'].includes(operation)) { json(response, 400, { code: 'LOCAL_GIT_SYNC_INVALID', message: '不支持的 Git 同步操作' }); return; }
        const remote = body.remote == null || body.remote === '' ? null : validateGitRemote(body.remote);
        const gitPolicy = await checkGitRemotePolicy(project.path, policyStatus(), operation, remote);
        if (!gitPolicy.allowed) { json(response, 403, policyDenied(`当前企业策略不允许访问 Git 主机 ${gitPolicy.host}`)); return; }
        const currentStatus = await gitStatus(project.path);
        let args;
        if (operation === 'fetch') args = remote ? ['fetch', '--prune', remote] : ['fetch', '--all', '--prune'];
        else if (operation === 'pull') args = remote ? ['pull', '--ff-only', remote] : ['pull', '--ff-only'];
        else if (currentStatus.upstream) args = ['push'];
        else {
          if (!remote) { json(response, 400, { code: 'LOCAL_GIT_REMOTE_REQUIRED', message: '当前分支没有上游，请选择远程仓库' }); return; }
          args = ['push', '--set-upstream', remote, currentStatus.branch];
        }
        const syncResult = await runGit(project.path, args, { timeout: 120_000 });
        json(response, 200, { operation, output: `${syncResult.stdout}\n${syncResult.stderr}`.trim(), status: await gitStatus(project.path) });
        return;
      }
      if (searchMatch && request.method === 'GET') {
        const project = projects.get(searchMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const query = (url.searchParams.get('query') || '').trim();
        if (!query || query.length > 500) { json(response, 400, { code: 'LOCAL_SEARCH_INVALID', message: '搜索词长度应为 1～500 个字符' }); return; }
        const result = await searchWorkspace(project.path, {
          query,
          regex: url.searchParams.get('regex') === 'true',
          caseSensitive: url.searchParams.get('caseSensitive') === 'true',
          glob: (url.searchParams.get('glob') || '').trim(),
        });
        json(response, 200, result);
        return;
      }
      if (symbolsMatch && request.method === 'GET') {
        const project = projects.get(symbolsMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const query = (url.searchParams.get('query') || '').trim();
        if (!query || query.length > 200) { json(response, 400, { code: 'LOCAL_SYMBOL_QUERY_INVALID', message: '符号搜索词长度应为 1～200 个字符' }); return; }
        json(response, 200, searchWorkspaceSymbols(project.path, query));
        return;
      }
      if (rawFileMatch && request.method === 'GET') {
        const project = projects.get(rawFileMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const file = resolveWorkspaceFile(project.path, url.searchParams.get('path'));
        const stat = fs.statSync(file); const descriptor = describeFile(file);
        if (!['image', 'pdf'].includes(descriptor.kind)) { json(response, 415, { code: 'LOCAL_FILE_PREVIEW_UNSUPPORTED', message: '该文件不支持原始预览' }); return; }
        if (stat.size > 100 * 1024 * 1024) { json(response, 413, { code: 'LOCAL_FILE_TOO_LARGE', message: '暂不支持预览超过 100 MiB 的文件' }); return; }
        response.writeHead(200, { 'Content-Type': descriptor.mime, 'Content-Length': stat.size, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(file).pipe(response); return;
      }
      if (spreadsheetMatch && request.method === 'GET') {
        const project = projects.get(spreadsheetMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const file = resolveWorkspaceFile(project.path, url.searchParams.get('path')); const stat = fs.statSync(file);
        if (describeFile(file).kind !== 'spreadsheet') { json(response, 415, { code: 'LOCAL_SPREADSHEET_UNSUPPORTED', message: '当前仅支持 .xlsx 和 .csv 表格' }); return; }
        if (stat.size > 20 * 1024 * 1024) { json(response, 413, { code: 'LOCAL_FILE_TOO_LARGE', message: '暂不支持解析超过 20 MiB 的表格' }); return; }
        json(response, 200, await readSpreadsheet(file)); return;
      }
      if (contentMatch && request.method === 'GET') {
        const project = projects.get(contentMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const file = resolveWorkspaceFile(project.path, url.searchParams.get('path'));
        const stat = fs.statSync(file); const descriptor = describeFile(file);
        const content = fs.readFileSync(file);
        const metadata = { path: path.relative(project.path, file).split(path.sep).join('/'), version: fileVersion(content), size: content.length, ...descriptor };
        if (url.searchParams.get('metadata') === 'true' || descriptor.kind !== 'text') { json(response, 200, metadata); return; }
        if (stat.size > 2 * 1024 * 1024) { json(response, 413, { code: 'LOCAL_FILE_TOO_LARGE', message: '暂不支持编辑超过 2 MiB 的文本文件' }); return; }
        json(response, 200, { ...metadata, content: content.toString('utf8') });
        return;
      }
      if (contentMatch && request.method === 'PUT') {
        const project = projects.get(contentMatch[1]);
        if (!project) { json(response, 404, { code: 'LOCAL_PROJECT_NOT_FOUND', message: '本地项目不存在或尚未打开' }); return; }
        const body = await readJsonBody(request, 3 * 1024 * 1024);
        if (typeof body.path !== 'string' || typeof body.content !== 'string' || typeof body.expectedVersion !== 'string') {
          json(response, 400, { code: 'LOCAL_FILE_INVALID', message: '文件路径或内容无效' }); return;
        }
        const file = resolveWorkspaceFile(project.path, body.path);
        const current = fs.readFileSync(file);
        if (fileVersion(current) !== body.expectedVersion) {
          json(response, 409, { code: 'LOCAL_FILE_CONFLICT', message: '文件已被其他程序修改，请重新加载后再编辑' }); return;
        }
        const temporary = `${file}.code-studio-${crypto.randomBytes(6).toString('hex')}.tmp`;
        const mode = fs.statSync(file).mode;
        try { fs.writeFileSync(temporary, body.content, { encoding: 'utf8', mode }); fs.renameSync(temporary, file); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        await lspManager.saved(project, body.path);
        json(response, 200, { saved: true, path: body.path, version: fileVersion(Buffer.from(body.content)) });
        return;
      }
      json(response, 404, { code: 'LOCAL_API_NOT_FOUND', message: '本地接口不存在' });
      return;
    }
    serveStatic(request, response, url.pathname, staticDir, token);
    } catch (error) {
      const code = error?.code === 'PAYLOAD_TOO_LARGE' ? 413 : ['WORKSPACE_PATH_INVALID', 'LOCAL_PREVIEW_SCRIPT_INVALID', 'LOCAL_CONNECTOR_INVALID', 'LOCAL_LSP_REQUEST_INVALID'].includes(error?.code) ? 400 : ['LOCAL_AGENT_BUSY', 'LOCAL_PREVIEW_BUSY'].includes(error?.code) ? 409 : ['LOCAL_CREDENTIAL_STORE_UNAVAILABLE', 'LOCAL_LSP_UNAVAILABLE'].includes(error?.code) ? 503 : 500;
      const filesystemMessage = ['EACCES', 'EPERM'].includes(error?.code) ? '没有权限读取该文件或目录' : error?.code === 'ENOENT' ? '文件或目录已不存在' : null;
      if (code === 500) console.error('[Local API]', request.method, request.url, error);
      json(response, code, { code: error?.code || 'LOCAL_API_ERROR', message: filesystemMessage || (code === 500 ? '本地操作失败，请查看客户端日志' : error.message) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(); reject(new Error('无法获取 Local API 监听地址')); return;
      }
      origin = `http://127.0.0.1:${address.port}`;
      resolve({
        origin, token,
        registerWorkspace: (workspacePath) => {
          const resolved = path.resolve(workspacePath);
          let normalized = resolved;
          try { if (fs.statSync(resolved).isDirectory()) normalized = fs.realpathSync(resolved); } catch {}
          const project = {
            id: crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24),
            name: path.basename(normalized) || normalized, path: normalized, openedAt: new Date().toISOString(),
          };
          projects.delete(project.id); projects.set(project.id, project); store?.upsertProject(project); return withAvailability(project);
        },
        issueAgentWriteApproval: (request) => {
          if (!request || !projects.has(request.projectId) || typeof request.modelConfigId !== 'string' || typeof request.prompt !== 'string' || !request.prompt.trim()) return null;
          const approvalToken = crypto.randomBytes(32).toString('base64url');
          agentWriteApprovals.set(approvalToken, { fingerprint: agentApprovalFingerprint(request), expiresAt: Date.now() + 60_000 });
          return approvalToken;
        },
        createOfflineLicenseChallenge: () => {
          if (!store) throw new Error('本地配置存储不可用');
          const challenge = { format: 'code-studio-license-request-v1', deviceId, nonce: crypto.randomBytes(32).toString('base64url'), createdAt: new Date().toISOString(), platform: process.platform, appVersion: options.appVersion || null };
          store.setSetting(OFFLINE_CHALLENGE_SETTING, { nonce: challenge.nonce, createdAt: challenge.createdAt }); return challenge;
        },
        installOfflineLicenseFile: (contents) => {
          if (!store || !options.licensePublicKey) throw new Error('当前客户端未配置许可证验证公钥');
          if (typeof contents !== 'string' || Buffer.byteLength(contents) > 64 * 1024) throw new Error('离线许可证文件无效');
          let file; try { file = JSON.parse(contents); } catch { throw new Error('离线许可证文件不是有效 JSON'); }
          const pending = store.getSetting(OFFLINE_CHALLENGE_SETTING);
          if (file?.format !== 'code-studio-license-v1' || typeof file.token !== 'string' || !pending?.nonce || file.challengeNonce !== pending.nonce) throw new Error('离线许可证与当前设备申请不匹配');
          const createdAt = Date.parse(pending.createdAt); if (!Number.isFinite(createdAt) || createdAt < Date.now() - 30 * 86400_000) throw new Error('离线许可证申请已过期，请重新导出');
          const status = evaluateLicense(file.token, { publicKey: options.licensePublicKey, deviceId });
          if (!['active', 'grace'].includes(status.state) || status.challengeNonce !== pending.nonce) throw new Error(status.error || '离线许可证签名或设备信息无效');
          store.setSetting(LICENSE_SETTING, file.token); store.deleteSetting(OFFLINE_CHALLENGE_SETTING); return { ...status, deviceId };
        },
        close: async () => {
          await agentRuntime?.shutdown();
          await previewRuntime.shutdown();
          await javaRuntime.shutdown();
          await terminalRuntime.shutdown();
          await lspManager.shutdown();
          return new Promise((closeResolve, closeReject) => server.close((error) => {
            try { store?.close(); } catch {}
            error ? closeReject(error) : closeResolve();
          }));
        },
      });
    });
  });
}

function capabilitiesFor(license) {
  const entitlements = new Set(['active', 'grace'].includes(license.state) ? license.entitlements : []);
  return {
    ...COMMUNITY_CAPABILITIES,
    edition: license.edition,
    capabilities: {
      ...COMMUNITY_CAPABILITIES.capabilities,
      cloudSync: entitlements.has('cloud.sync'),
      teamWorkspace: entitlements.has('team.collaboration'),
      enterpriseGovernance: entitlements.has('enterprise.policies'),
    },
  };
}

function privacySettings(store, license) {
  const cloudSyncAvailable = ['active', 'grace'].includes(license.state) && license.entitlements.includes('cloud.sync');
  return {
    settingsSync: Boolean(store?.getSetting('privacy.settingsSync')),
    conversationSync: Boolean(store?.getSetting('privacy.conversationSync')),
    sourceCodeSync: false,
    cloudSyncAvailable,
    audit: store?.listPrivacyAudit(20) || [],
  };
}

function policyAllows(status, capability, value) {
  if (!status.enforcementRequired) return true;
  if (capability === 'terminal') return status.policy.terminalEnabled;
  const list = capability === 'model' ? status.policy.allowedModelEngines : status.policy.allowedConnectorTypes;
  return list.includes(value);
}
function policyDenied(message) { return { code: 'LOCAL_ENTERPRISE_POLICY_DENIED', message }; }
function firstBlockedNetworkHost(status, hosts) {
  if (!status.enforcementRequired) return null;
  return hosts.find((host) => !status.policy.allowedNetworkHosts.includes(host.toLowerCase())) || null;
}
function modelHosts(config) { if (!config.baseUrl) return []; try { return [new URL(config.baseUrl).hostname.toLowerCase()]; } catch { return []; } }
function connectorHosts(config) {
  if (config.type === 'postgres' || config.type === 'mysql') return [String(config.settings.host).toLowerCase()];
  if (config.type === 'kafka') return config.settings.brokers.map((broker) => broker.startsWith('[') ? broker.slice(1, broker.indexOf(']')).toLowerCase() : broker.split(':')[0].toLowerCase());
  if (config.type === 'kubernetes') { try { return [new URL(config.settings.server).hostname.toLowerCase()]; } catch { return []; } }
  return [];
}

async function checkGitRemotePolicy(root, status, operation, requestedRemote) {
  if (!status.enforcementRequired) return { allowed: true };
  let remotes = requestedRemote ? [requestedRemote] : [];
  if (!remotes.length && operation === 'fetch') {
    const result = await runGit(root, ['remote']); remotes = result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  if (!remotes.length) {
    const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true });
    if (upstream.code === 0) remotes = [upstream.stdout.trim().split('/')[0]].filter(Boolean);
  }
  for (const remote of remotes) {
    const result = await runGit(root, ['remote', 'get-url', '--all', remote], { allowFailure: true });
    if (result.code !== 0) continue;
    for (const value of result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const host = gitRemoteHost(value);
      if (!status.policy.allowedGitHosts.includes(host)) return { allowed: false, host };
    }
  }
  return { allowed: true };
}

function gitRemoteHost(value) {
  if (/^(?:\.{0,2}\/|\/|[A-Za-z]:[\\/])/.test(value) || value.startsWith('file://')) return 'local';
  try { const parsed = new URL(value); if (parsed.hostname) return parsed.hostname.toLowerCase(); } catch {}
  const scp = value.match(/^(?:[^@\s]+@)?([^:\s/]+):/); return scp ? scp[1].toLowerCase() : 'local';
}

const LOCAL_MODEL_ENGINES = new Set(['codex-cli', 'claude-code', 'aider', 'openai-compatible', 'ollama']);

function validateModelConfig(input, id) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const engine = typeof input.engine === 'string' ? input.engine : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!name || name.length > 100 || !LOCAL_MODEL_ENGINES.has(engine) || model.length > 200) {
    const error = new Error('模型名称、引擎或模型标识无效'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
  }
  let baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim().replace(/\/$/, '') : '';
  if (['openai-compatible', 'ollama', 'aider'].includes(engine)) {
    if (!baseUrl && engine === 'ollama') baseUrl = 'http://127.0.0.1:11434/v1';
    if (baseUrl) {
      let parsed;
      try { parsed = new URL(baseUrl); } catch {}
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        const error = new Error('模型服务地址必须是有效的 http:// 或 https:// 地址'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
      }
    }
  }
  return { id, name, engine, provider: typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : engine, baseUrl, model, executionLocation: 'local' };
}

function encryptCredential(value, codec) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 16_384) { const error = new Error('API Key 无效'); error.code = 'WORKSPACE_PATH_INVALID'; throw error; }
  if (!codec?.available?.()) { const error = new Error('系统凭据加密当前不可用，未保存 API Key'); error.code = 'LOCAL_CREDENTIAL_STORE_UNAVAILABLE'; throw error; }
  return codec.encrypt(value);
}

function publicModelConfig(row) {
  if (!row) return row;
  const { credentialCiphertext, ...config } = row;
  return { ...config, executionLocation: 'local', hasCredential: Boolean(credentialCiphertext) };
}

function publicConnector(row) { if (!row) return row; const { credentialCiphertext, ...config } = row; return { ...config, hasCredential: Boolean(credentialCiphertext) }; }
function safeConnectorError(error, secret) { const message = error instanceof Error ? error.message : String(error); return (secret ? message.split(secret).join('[REDACTED]') : message).slice(0, 1_000) || '连接失败'; }

function resolveControlServerUrl(source) {
  const value = typeof source === 'function' ? source() : source;
  if (!value) return null;
  let parsed; try { parsed = new URL(String(value)); } catch { return null; }
  return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.toString().replace(/\/$/, '') : null;
}

async function controlRequest(source, pathname, options = {}) {
  const origin = resolveControlServerUrl(source); if (!origin) throw new Error('请先配置团队或企业服务地址');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${origin}${pathname}`, { method: options.method || 'GET', signal: controller.signal, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(Array.isArray(body.message) ? body.message.join('；') : body.message || `服务端返回 HTTP ${response.status}`), { code: response.status === 401 ? 'CONTROL_UNAUTHORIZED' : 'CONTROL_REQUEST_FAILED' });
    return body;
  } finally { clearTimeout(timer); }
}

async function authenticatedControlRequest(store, codec, source, pathname, options = {}) {
  const ciphertext = store?.getSetting(CONTROL_TOKEN_SETTING);
  if (!ciphertext) throw Object.assign(new Error('请先登录账号'), { code: 'LOCAL_ACCOUNT_REQUIRED' });
  if (!codec?.available?.()) throw new Error('系统凭据解密当前不可用');
  let token; try { token = codec.decrypt(ciphertext); } catch { throw Object.assign(new Error('登录凭据已失效，请重新登录'), { code: 'LOCAL_ACCOUNT_REQUIRED' }); }
  try { return await controlRequest(source, pathname, { ...options, token }); }
  catch (error) {
    if (error?.code === 'CONTROL_UNAUTHORIZED') { store.deleteSetting(CONTROL_TOKEN_SETTING); store.deleteSetting(CONTROL_USER_SETTING); throw Object.assign(new Error('登录已过期，请重新登录'), { code: 'LOCAL_ACCOUNT_REQUIRED' }); }
    throw error;
  }
}

async function refreshEnterprisePolicy(store, codec, options, policyStatus, terminalRuntime) {
  if (!store || !options.policyPublicKey) throw new Error('当前客户端未配置企业策略验证公钥');
  const remote = await authenticatedControlRequest(store, codec, options.controlServerUrl, '/api/control/enterprise/policy');
  const status = evaluatePolicy(remote.token, { publicKey: options.policyPublicKey, now: typeof options.policyNow === 'function' ? options.policyNow() : options.policyNow, appVersion: options.appVersion });
  if (!['active', 'grace'].includes(status.state)) throw new Error(status.error || '服务端返回的企业策略无效');
  store.setSetting(POLICY_SETTING, remote.token); if (!status.policy.terminalEnabled) await terminalRuntime.shutdown(); return status;
}

function bodyDeviceName() {
  const hostname = os.hostname().trim(); return hostname ? hostname.slice(0, 100) : `${process.platform} 设备`;
}

function resolvePrivateModelConfig(row, codec) {
  let apiKey = '';
  if (row.credentialCiphertext) {
    if (!codec?.available?.()) { const error = new Error('系统凭据解密当前不可用'); error.code = 'LOCAL_CREDENTIAL_STORE_UNAVAILABLE'; throw error; }
    apiKey = codec.decrypt(row.credentialCiphertext);
  }
  return { ...publicModelConfig(row), apiKey };
}

async function discoverLocalAgents(commands = {}) {
  const definitions = [
    { engine: 'codex-cli', command: 'codex' },
    { engine: 'claude-code', command: 'claude' },
    { engine: 'aider', command: 'aider' },
    { engine: 'ollama', command: 'ollama' },
  ];
  return Promise.all(definitions.map(async (definition) => {
    const command = commands?.[definition.engine] || definition.command;
    const result = await runCommand(command, ['--version'], { timeout: 3_000, allowFailure: true });
    return { ...definition, available: result.started && result.code === 0, version: result.started ? (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null : null };
  }));
}

async function discoverCodexModels(commands = {}) {
  const command = commands?.['codex-cli'] || 'codex';
  const result = await runCommand(command, ['debug', 'models'], { timeout: 12_000 });
  if (!result.started || result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || '无法读取 Codex 模型目录');
  let body; try { body = JSON.parse(result.stdout); } catch { throw new Error('Codex CLI 返回了无效的模型目录'); }
  if (!Array.isArray(body.models)) throw new Error('Codex CLI 未返回模型目录');
  return body.models.filter((item) => item?.visibility === 'list' && typeof item.slug === 'string').slice(0, 100).map((item) => ({
    id: item.slug, name: typeof item.display_name === 'string' ? item.display_name : item.slug,
    description: typeof item.description === 'string' ? item.description : '',
    defaultReasoningEffort: item.default_reasoning_level || 'medium',
    reasoningEfforts: Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels.map((level) => ({ value: level.effort, description: level.description || '' })).filter((level) => typeof level.value === 'string') : [],
    contextWindow: Number.isSafeInteger(item.context_window) ? item.context_window : null,
    serviceTiers: Array.isArray(item.service_tiers) ? item.service_tiers.map((tier) => ({ id: tier.id, name: tier.name, description: tier.description })).filter((tier) => typeof tier.id === 'string') : [],
  }));
}

async function testModelConnection(config, commands = {}) {
  const startedAt = Date.now();
  if (config.engine === 'codex-cli' || config.engine === 'claude-code') {
    const command = commands?.[config.engine] || (config.engine === 'codex-cli' ? 'codex' : 'claude');
    const args = config.engine === 'codex-cli' ? ['login', 'status'] : ['auth', 'status'];
    const result = await runCommand(command, args, { timeout: 8_000 });
    if (!result.started) throw new Error(`${config.engine === 'codex-cli' ? 'Codex CLI' : 'Claude Code'} 尚未安装或不可执行`);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || '当前设备尚未登录');
    return { ok: true, kind: 'cli', authenticated: true, version: null, latencyMs: Date.now() - startedAt };
  }
  if (config.engine === 'aider') {
    const command = commands?.aider || 'aider';
    const result = await runCommand(command, ['--version'], { timeout: 5_000 });
    if (!result.started || result.code !== 0) throw new Error('Aider 尚未安装或不可执行');
  }
  if (!config.baseUrl) throw new Error('请先配置模型服务地址');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, { signal: controller.signal, headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {} });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `模型服务返回 HTTP ${response.status}`);
    const models = Array.isArray(body.data) ? body.data.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean).slice(0, 100) : Array.isArray(body.models) ? body.models.map((item) => item?.name || item?.model).filter(Boolean).slice(0, 100) : [];
    return { ok: true, kind: 'api', latencyMs: Date.now() - startedAt, models, configuredModelAvailable: config.model ? models.includes(config.model) : null };
  } finally { clearTimeout(timer); }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ started: true, code: -1, stdout, stderr: `${stderr}\n命令超时` }); }, options.timeout || 15_000);
    child.stdout.on('data', (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8'); });
    child.once('error', (error) => finish({ started: false, code: -1, stdout, stderr: error.message, error }));
    child.once('close', (code) => finish({ started: true, code: code ?? -1, stdout, stderr }));
  });
}

function withAvailability(project) {
  let available = false;
  try { available = fs.statSync(project.path).isDirectory(); } catch {}
  return { ...project, available };
}

function fileVersion(content) {
  return crypto.createHash('sha256').update(content).digest('base64url');
}

async function runCodeIntelligenceTool(manager, project, name, input = {}) {
  if (name === 'workspace_symbols') {
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 200) : '';
    if (!query) throw invalidCodeIntelligenceRequest('请提供要搜索的符号名称');
    return searchWorkspaceSymbols(project.path, query);
  }
  if (name === 'diagnostics') {
    if (typeof input.path !== 'string' || !input.path.trim()) throw invalidCodeIntelligenceRequest('请提供文件路径');
    return { items: (await manager.diagnostics(project, { path: input.path })).slice(0, 500) };
  }
  if (name === 'definition' || name === 'find_references') {
    const line = Number(input.line); const column = Number(input.column);
    if (typeof input.path !== 'string' || !input.path.trim() || !Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) throw invalidCodeIntelligenceRequest('请提供有效的文件位置');
    const operation = name === 'definition' ? 'definition' : 'references';
    return { items: (await manager.request(project, operation, { path: input.path, line, column })).slice(0, 500) };
  }
  throw invalidCodeIntelligenceRequest('不支持该代码分析操作');
}

function invalidCodeIntelligenceRequest(message) { const error = new Error(message); error.code = 'LOCAL_LSP_REQUEST_INVALID'; return error; }

function agentApprovalFingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify([request.projectId, request.modelConfigId, request.prompt.trim(), 'workspace-write'])).digest('base64url');
}

function consumeAgentWriteApproval(approvals, request, token) {
  const approval = typeof token === 'string' ? approvals.get(token) : null;
  if (typeof token === 'string') approvals.delete(token);
  for (const [key, value] of approvals) if (value.expiresAt <= Date.now()) approvals.delete(key);
  return Boolean(approval && approval.fingerprint === agentApprovalFingerprint(request) && approval.expiresAt > Date.now());
}

const IMAGE_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'], ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'],
]);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.jsonc', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.less', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.env', '.sh', '.bash', '.zsh', '.fish', '.py', '.java', '.kt', '.kts', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.properties', '.gradle', '.gitignore', '.dockerfile']);

function describeFile(file) {
  const extension = path.extname(file).toLowerCase();
  if (IMAGE_MIME.has(extension)) return { kind: 'image', mime: IMAGE_MIME.get(extension) };
  if (extension === '.pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (extension === '.xlsx' || extension === '.csv') return { kind: 'spreadsheet', mime: extension === '.csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  if (extension === '.xls') return { kind: 'unsupported', mime: 'application/vnd.ms-excel', reason: '旧版 .xls 暂不支持，请另存为 .xlsx 或 .csv' };
  if (TEXT_EXTENSIONS.has(extension) || !extension) return { kind: 'text', mime: 'text/plain; charset=utf-8' };
  const sample = Buffer.alloc(8_192); let bytes = 0; const descriptor = fs.openSync(file, 'r');
  try { bytes = fs.readSync(descriptor, sample, 0, sample.length, 0); } finally { fs.closeSync(descriptor); }
  return sample.subarray(0, bytes).includes(0) ? { kind: 'unsupported', mime: 'application/octet-stream', reason: '该二进制格式暂不支持预览' } : { kind: 'text', mime: 'text/plain; charset=utf-8' };
}

async function readSpreadsheet(file) {
  const workbook = new ExcelJS.Workbook();
  if (path.extname(file).toLowerCase() === '.csv') await workbook.csv.readFile(file);
  else await workbook.xlsx.readFile(file);
  let truncated = workbook.worksheets.length > 20;
  const sheets = workbook.worksheets.slice(0, 20).map((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber > 500) { truncated = true; return; }
      const values = [];
      for (let column = 1; column <= Math.min(row.cellCount, 100); column += 1) values.push(spreadsheetCell(row.getCell(column).value));
      if (row.cellCount > 100) truncated = true;
      rows.push(values);
    });
    return { name: sheet.name, rows };
  });
  return { sheets, truncated, limits: { sheets: 20, rows: 500, columns: 100 } };
}

function spreadsheetCell(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('result' in value) return spreadsheetCell(value.result);
    if ('text' in value) return String(value.text).slice(0, 10_000);
    if ('richText' in value) return value.richText.map((item) => item.text || '').join('').slice(0, 10_000);
    if ('hyperlink' in value) return String(value.text || value.hyperlink).slice(0, 10_000);
    return JSON.stringify(value).slice(0, 10_000);
  }
  return String(value).slice(0, 10_000);
}

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.idea', '.vscode', '.venv', 'venv', '__pycache__']);

function listWorkspace(root) {
  const items = [];
  const visit = (directory, depth) => {
    if (items.length >= 10_000 || depth > 30) return;
    let directoryEntries;
    try { directoryEntries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (isSkippableFilesystemError(error)) return;
      throw error;
    }
    const entries = directoryEntries
      .filter((entry) => !entry.name.startsWith('.') || entry.name === '.env.example')
      .filter((entry) => !IGNORED_DIRECTORIES.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (items.length >= 10_000) break;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      try {
        if (entry.isDirectory()) {
          items.push({ path: relative, name: entry.name, type: 'directory', depth }); visit(absolute, depth + 1);
        } else if (entry.isFile()) items.push({ path: relative, name: entry.name, type: 'file', depth });
      } catch (error) {
        if (!isSkippableFilesystemError(error)) throw error;
      }
    }
  };
  visit(root, 0);
  return items;
}

function buildSourceIndex(root) {
  const allowed = /\.(?:[cm]?[jt]sx?|json|py|java|c|h|cc|cpp|cxx|hh|hpp|hxx|go|rs|vue)$/i;
  const files = []; let totalBytes = 0; let truncated = false;
  for (const entry of listWorkspace(root)) {
    if (entry.type !== 'file' || !allowed.test(entry.path)) continue;
    const file = path.join(root, entry.path);
    try {
      const stat = fs.statSync(file);
      if (stat.size > SOURCE_INDEX_LIMITS.fileBytes) { truncated = true; continue; }
      if (files.length >= SOURCE_INDEX_LIMITS.files || totalBytes + stat.size > SOURCE_INDEX_LIMITS.totalBytes) { truncated = true; break; }
      const content = fs.readFileSync(file);
      if (content.includes(0)) continue;
      files.push({ path: entry.path, content: content.toString('utf8') });
      totalBytes += content.length;
    } catch (error) {
      if (!isSkippableFilesystemError(error)) throw error;
    }
  }
  return { files, totalBytes, truncated, limits: SOURCE_INDEX_LIMITS };
}

function searchWorkspaceSymbols(root, query) {
  const needle = query.toLowerCase();
  const items = [];
  const declaration = /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?(class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const file of buildSourceIndex(root).files) {
    const lines = file.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length && items.length < 200; lineIndex += 1) {
      declaration.lastIndex = 0;
      let match;
      while ((match = declaration.exec(lines[lineIndex])) && items.length < 200) {
        const name = match[2];
        if (name.toLowerCase().includes(needle)) items.push({ name, kind: match[1], path: file.path, line: lineIndex + 1, column: match.index + match[0].lastIndexOf(name) + 1 });
      }
    }
    if (items.length >= 200) break;
  }
  return { items, truncated: items.length >= 200 };
}

function isSkippableFilesystemError(error) {
  return ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code);
}

function validateRelativePath(root, value) {
  if (!value || typeof value !== 'string' || path.isAbsolute(value) || value.includes('\0')) {
    const error = new Error('文件路径无效'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
  }
  const normalized = path.normalize(value);
  const absolute = path.resolve(root, normalized);
  const resolvedRoot = path.resolve(root);
  if (absolute === resolvedRoot || !absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
    const error = new Error('文件不在本地项目中'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
  }
  return path.relative(resolvedRoot, absolute).split(path.sep).join('/');
}

async function gitStatus(root) {
  const result = await runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--branch'], { allowFailure: true });
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`;
    if (/not a git repository/i.test(detail)) return { repository: false, branch: null, ahead: 0, behind: 0, files: [] };
    const error = new Error(gitErrorMessage(detail)); error.code = 'LOCAL_GIT_ERROR'; throw error;
  }
  const records = result.stdout.split('\0').filter(Boolean);
  const branchLine = records.shift() || '';
  const branchMatch = branchLine.match(/^## (.+?)(?:\.\.\.(.+?))?(?: \[ahead (\d+)(?:, behind (\d+))?\]| \[behind (\d+)\])?$/);
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const indexStatus = record[0]; const worktreeStatus = record[1];
    let filePath = record.slice(3); let originalPath;
    if (indexStatus === 'R' || indexStatus === 'C') { originalPath = records[++index]; }
    files.push({ path: filePath, originalPath, indexStatus, worktreeStatus });
  }
  return {
    repository: true,
    branch: branchMatch?.[1] || branchLine.replace(/^## /, ''),
    upstream: branchMatch?.[2] || null,
    ahead: Number(branchMatch?.[3] || 0),
    behind: Number(branchMatch?.[4] || branchMatch?.[5] || 0),
    files,
  };
}

function runGit(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout || 15_000);
    child.stdout.on('data', (chunk) => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8'); });
    child.once('error', (error) => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.once('close', (code, signal) => {
      clearTimeout(timer); if (settled) return; settled = true;
      const result = { code: code ?? -1, signal, stdout, stderr };
      if (code === 0 || options.allowFailure) resolve(result);
      else { const error = new Error(gitErrorMessage(stderr || stdout)); error.code = 'LOCAL_GIT_ERROR'; reject(error); }
    });
  });
}

async function validateBranchName(root, value) {
  if (!value || typeof value !== 'string' || value.length > 200) {
    const error = new Error('分支名称无效'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
  }
  const branch = value.trim();
  const result = await runGit(root, ['check-ref-format', '--branch', branch], { allowFailure: true });
  if (result.code !== 0) { const error = new Error('分支名称无效'); error.code = 'WORKSPACE_PATH_INVALID'; throw error; }
  return branch;
}

function validateGitRemote(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(value)) {
    const error = new Error('远程仓库名称无效'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
  }
  return value;
}

function gitErrorMessage(output) {
  const detail = String(output || '').trim().split('\n').slice(-3).join(' ');
  if (/user\.email|user\.name|identity unknown|tell me who you are/i.test(detail)) return 'Git 尚未配置用户名或邮箱，请先在终端配置 user.name 和 user.email';
  return detail || 'Git 操作失败';
}

function resolveWorkspaceFile(root, relativePath) {
  const realRoot = fs.realpathSync(root);
  const safeRelativePath = validateRelativePath(realRoot, relativePath);
  const candidate = path.resolve(realRoot, safeRelativePath);
  let realFile;
  try { realFile = fs.realpathSync(candidate); }
  catch (cause) { const error = new Error('文件已不存在或无法读取'); error.code = 'WORKSPACE_PATH_INVALID'; error.cause = cause; throw error; }
  if (!realFile.startsWith(`${realRoot}${path.sep}`) || !fs.statSync(realFile).isFile()) {
    const error = new Error('文件不在本地项目中'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
  }
  return realFile;
}

function resolveNewWorkspaceEntry(root, relativePath) {
  const realRoot = fs.realpathSync(root);
  const safeRelativePath = validateRelativePath(realRoot, relativePath);
  const absolute = path.resolve(realRoot, safeRelativePath);
  const parent = fs.realpathSync(path.dirname(absolute));
  if (parent !== realRoot && !parent.startsWith(`${realRoot}${path.sep}`)) {
    const error = new Error('新建位置不在本地项目中'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
  }
  const name = path.basename(absolute);
  if (!name || name === '.' || name === '..' || name.length > 255) {
    const error = new Error('文件或文件夹名称无效'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
  }
  return { absolute, relativePath: safeRelativePath };
}

function resolveExistingWorkspaceEntry(root, relativePath) {
  const realRoot = fs.realpathSync(root);
  const safeRelativePath = validateRelativePath(realRoot, relativePath);
  const absolute = path.resolve(realRoot, safeRelativePath);
  if (fs.lstatSync(absolute).isSymbolicLink()) {
    const error = new Error('不允许通过工作区删除符号链接'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
  }
  const realEntry = fs.realpathSync(absolute);
  if (!realEntry.startsWith(`${realRoot}${path.sep}`)) {
    const error = new Error('删除目标不在本地项目中'); error.code = 'WORKSPACE_PATH_INVALID'; throw error;
  }
  return { absolute: realEntry, relativePath: safeRelativePath };
}

function readJsonBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) { const error = new Error('请求内容过大'); error.code = 'PAYLOAD_TOO_LARGE'; reject(error); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { const error = new Error('请求内容不是有效 JSON'); error.code = 'WORKSPACE_PATH_INVALID'; reject(error); }
    });
    request.on('error', reject);
  });
}

async function searchWorkspace(root, options) {
  let rgPath = 'rg';
  try { rgPath = require('@vscode/ripgrep').rgPath; } catch {}
  const args = ['--json', '--line-number', '--column', '--max-count', '200', '--max-columns', '1000', '--glob', '!.git/**'];
  for (const directory of IGNORED_DIRECTORIES) args.push('--glob', `!${directory}/**`);
  if (!options.regex) args.push('--fixed-strings');
  if (options.caseSensitive) args.push('--case-sensitive'); else args.push('--ignore-case');
  if (options.glob) args.push('--glob', options.glob);
  args.push('--', options.query, '.');
  try { return await runRipgrep(rgPath, args, root); }
  catch (error) {
    // Packaged Electron applications may resolve the optional ripgrep binary
    // inside app.asar where the operating system cannot execute it. The
    // bounded JavaScript implementation keeps search available in that case.
    return fallbackSearch(root, options);
  }
}

function runRipgrep(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const items = []; let buffer = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line || items.length >= 200) continue;
        try {
          const event = JSON.parse(line);
          if (event.type !== 'match') continue;
          const data = event.data;
          const submatch = data.submatches?.[0];
          items.push({
            path: data.path.text.split(path.sep).join('/').replace(/^\.\//, ''), line: data.line_number,
            column: (submatch?.start ?? 0) + 1, preview: data.lines.text.replace(/[\r\n]+$/, ''),
          });
        } catch {}
      }
      if (items.length >= 200) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8_192) stderr += chunk.toString('utf8'); });
    child.once('error', (error) => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.once('close', (code, signal) => {
      clearTimeout(timer); if (settled) return; settled = true;
      if (code === 0 || code === 1 || signal === 'SIGTERM') resolve({ items, truncated: items.length >= 200, engine: 'ripgrep' });
      else reject(new Error(stderr.trim() || `ripgrep 退出码 ${code}`));
    });
  });
}

function fallbackSearch(root, options) {
  const items = [];
  let matcher;
  try { matcher = options.regex ? new RegExp(options.query, options.caseSensitive ? 'g' : 'gi') : null; }
  catch { const error = new Error('正则表达式无效'); error.code = 'WORKSPACE_PATH_INVALID'; throw error; }
  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  for (const entry of listWorkspace(root)) {
    if (items.length >= 200 || entry.type !== 'file') continue;
    if (options.glob && !simpleGlobMatch(entry.path, options.glob)) continue;
    const file = path.join(root, entry.path);
    if (fs.statSync(file).size > 1024 * 1024) continue;
    const content = fs.readFileSync(file);
    if (content.includes(0)) continue;
    const lines = content.toString('utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (items.length >= 200) return;
      const match = matcher ? (matcher.lastIndex = 0, matcher.exec(line)) : null;
      const column = matcher ? match?.index : (options.caseSensitive ? line : line.toLowerCase()).indexOf(needle);
      if (column !== undefined && column >= 0) items.push({ path: entry.path, line: index + 1, column: column + 1, preview: line });
    });
  }
  return { items, truncated: items.length >= 200, engine: 'javascript-fallback' };
}

function simpleGlobMatch(file, glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(file);
}

function serveStatic(request, response, pathname, staticDir, token) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    json(response, 405, { code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持' }); return;
  }
  if (!staticDir) {
    json(response, 404, { code: 'DESKTOP_RENDERER_MISSING', message: '桌面页面尚未构建' }); return;
  }
  let relative;
  try { relative = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { relative = ''; }
  const requested = path.resolve(staticDir, relative || 'index.html');
  const inside = requested === staticDir || requested.startsWith(`${staticDir}${path.sep}`);
  const file = inside && fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested : path.join(staticDir, 'index.html');
  if (!file.startsWith(`${staticDir}${path.sep}`) || !fs.existsSync(file)) {
    json(response, 404, { code: 'DESKTOP_RENDERER_MISSING', message: '桌面页面尚未构建' }); return;
  }
  const content = fs.readFileSync(file);
  const headers = {
    'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': content.length, 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws:; worker-src 'self' blob:; frame-src http: https:;",
  };
  if (path.basename(file) === 'index.html') {
    headers['Cache-Control'] = 'no-store';
    headers['Set-Cookie'] = `code_studio_session=${token}; HttpOnly; SameSite=Strict; Path=/`;
  } else headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  response.writeHead(200, headers);
  if (request.method === 'HEAD') response.end(); else response.end(content);
}

module.exports = { createLocalApi, LOCAL_API_PREFIX };
