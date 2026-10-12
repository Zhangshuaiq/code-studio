// Real desktop renderer + production Local API; control server is isolated fixture.
const { app, BrowserWindow } = require('electron');
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const assert = require('node:assert/strict');
const { createLocalApi } = require('../src/local-api.cjs');
let window; let api; let server; let directory; let reads = 0; let roleChanged = false; let expired = false; let joined = false;
const invitations = []; const domains = [];
const controlRequests = []; let auditorRevoked = false;
let policy = { terminalEnabled: true, allowedModelEngines: ['codex-cli'], allowedConnectorTypes: ['postgres'], allowedGitHosts: ['local'], allowedNetworkHosts: [], minimumClientVersion: '0.1.0', offlineDays: 7, updatedAt: new Date().toISOString() }; let policyWrites = 0;
const deadline = setTimeout(() => { console.error('Desktop organization UI timed out'); app.exit(1); }, 90000);
const panel = "document.querySelector('[data-organization-memberships]')";
const domainPanel = "document.querySelector('[data-organization-domains]')";
async function run(source) { return window.webContents.executeJavaScript(source); }
async function waitFor(source) { for (let i = 0; i < 200; i++) { if (await run(`(() => { try { return (${source}); } catch { return false; } })()`)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`UI condition not reached: ${source}`); }
async function input(selector, value) { await run(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', { bubbles: true })); })()`); }
async function button(text, scope = 'document') { await run(`[...${scope}.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)}).click()`); }
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-organizations-ui-'));
    server = http.createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk; const body = raw ? JSON.parse(raw) : {};
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const json = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
      if (pathname === '/api/auth/login') return json({ accessToken: `private-control-${body.username}`, user: { id: body.username, username: body.username } });
      const actor = request.headers.authorization?.replace('Bearer private-control-', '');
      if (!['Owner', 'Admin', 'Auditor', 'Member'].includes(actor)) return json({ message: 'unauthorized' }, 401);
      if (pathname === '/api/control/license/devices') return json([]);
      if (pathname === '/api/control/enterprise/invitations/accept') { joined = true; return json({ organization: { id: 'joined', name: 'Joined Organization' } }); }
      if (!pathname.startsWith('/api/control/enterprise/organizations')) return json({}, 404);
      reads++;
      controlRequests.push({ actor, pathname, method: request.method });
      if (auditorRevoked && actor === 'Auditor' && pathname.endsWith('/audit')) return json({ message: '审计权限已撤销' }, 403);
      if (expired && pathname.endsWith('/audit')) return json({ message: 'expired' }, 401);
      if (pathname === '/api/control/enterprise/organizations') return json([{ userId: actor, role: actor === 'Owner' ? 'owner' : actor === 'Admin' ? 'admin' : actor === 'Auditor' ? 'auditor' : 'member', organization: { id: 'org', name: 'Desktop Organization', slug: 'desktop', seatLimit: 10 } }, ...(joined ? [{ userId: actor, role: 'member', organization: { id: 'joined', name: 'Joined Organization', slug: 'joined', seatLimit: 10 } }] : [])]);
      if (actor === 'Member') return json({ message: 'forbidden' }, 403);
      if (actor === 'Auditor' && !pathname.endsWith('/audit')) return json({ message: 'forbidden' }, 403);
      if (pathname.endsWith('/policy')) {
        if (request.method === 'GET') return json(policy);
        if (actor !== 'Owner') return json({ code: 'ORGANIZATION_POLICY_FORBIDDEN' }, 403);
        if (body.expectedUpdatedAt !== policy.updatedAt) return json({ code: 'ORGANIZATION_POLICY_CONFLICT', message: 'private-control-Owner' }, 409);
        const { expectedUpdatedAt, ...fields } = body; policy = { ...fields, updatedAt: new Date(Date.parse(policy.updatedAt) + 1).toISOString() }; policyWrites++; return json(policy);
      }
      if (pathname.endsWith('/members')) return json([{ id: 'employee', userId: 'employee', role: roleChanged ? 'admin' : 'member', status: 'active', user: { id: 'employee', username: 'Employee' } }]);
      if (pathname.endsWith('/members/employee/role') && request.method === 'PUT') { roleChanged = body.role === 'admin'; return json({ role: body.role }); }
      if (pathname.endsWith('/invitations')) {
        if (request.method === 'GET') return json(invitations);
        const item = { id: 'invite', email: body.email, role: body.role, status: 'pending', expiresAt: new Date(Date.now() + 86400_000).toISOString() }; invitations.push(item); return json({ ...item, token: 'fixture-invitation-code' }, 201);
      }
      if (pathname.endsWith('/domains')) {
        if (request.method === 'GET') return json(domains);
        const item = { id: 'domain', domain: body.domain, verifiedAt: null, expiresAt: new Date(Date.now() + 86400_000).toISOString(), recordName: '_code-studio-verification.company.com', recordValue: 'code-studio-verification=fixture' }; domains.push(item); return json(item, 201);
      }
      if (pathname.endsWith('/domains/domain/verify')) { domains[0].verifiedAt = new Date().toISOString(); return json(domains[0], 201); }
      if (pathname.endsWith('/domains/domain') && request.method === 'DELETE') { domains.splice(0); return json({ success: true }); }
      if (pathname.endsWith('/audit')) return json({ items: [{ id: 'audit', createdAt: new Date().toISOString(), actorName: 'DesktopAuditOwner', action: 'organization.domain.create', result: 'success', detail: { outcome: { domainId: 'domain' } } }], total: 1, page: 1, pageSize: 20 });
      return json({}, 404);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const codec = { available: () => true, encrypt: (value) => Buffer.from(value).toString('base64'), decrypt: (value) => Buffer.from(value, 'base64').toString() };
    api = await createLocalApi({ staticDir: path.resolve(__dirname, '../renderer'), storePath: path.join(directory, 'local.sqlite3'), credentialCodec: codec, controlServerUrl: `http://127.0.0.1:${server.address().port}` });
    window = new BrowserWindow({ show: false, width: 1200, height: 950, webPreferences: { partition: `organization-smoke-${require('node:crypto').randomUUID()}`, preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadURL(api.origin);
    await waitFor(`!![...document.querySelectorAll('button')].find(node => node.textContent.trim() === '账户与许可证')`);
    await button('账户与许可证'); await waitFor(`!!document.querySelector('input[autocomplete="username"]')`);
    assert.equal(reads, 0, 'unsigned personal mode must not contact enterprise server');
    assert.equal(await run(`${panel} === null`), true);
    async function login(name) { await input('input[autocomplete="username"]', name); await input('input[autocomplete="current-password"]', 'password'); await button('登录账号'); await waitFor(`${panel}?.textContent.includes('Desktop Organization')`); }
    await login('Owner'); await waitFor(`${panel}?.textContent.includes('Employee') && document.body.textContent.includes('DesktopAuditOwner')`);
    const policyPanel = "document.querySelector('[data-organization-policy]')";
    await waitFor(`!!${policyPanel}?.querySelector('input[aria-label="最低客户端版本"]')`);
    await input('input[aria-label="允许的模型引擎（逗号分隔）"]', 'codex-cli,');
    assert.equal(await run(`document.querySelector('input[aria-label="允许的模型引擎（逗号分隔）"]').value.endsWith(',')`), true, 'list editing must preserve a separator while typing');
    await input('input[aria-label="允许的模型引擎（逗号分隔）"]', 'codex-cli, ollama');
    await input('input[aria-label="最低客户端版本"]', '0.2.0'); await button('保存并用于下次策略签发', policyPanel);
    await waitFor(`document.body.textContent.includes('修改组织安全策略')`); assert.equal(policyWrites, 0);
    await button('保存策略'); await waitFor(`${policyPanel}?.textContent.includes('策略已保存')`); assert.equal(policyWrites, 1);
    assert.deepEqual(policy.allowedModelEngines, ['codex-cli', 'ollama']);
    policy = { ...policy, minimumClientVersion: '0.3.0', updatedAt: new Date(Date.parse(policy.updatedAt) + 1).toISOString() };
    await input('input[aria-label="最低客户端版本"]', '0.4.0'); await button('保存并用于下次策略签发', policyPanel); await waitFor(`document.body.textContent.includes('修改组织安全策略')`); await button('保存策略');
    await waitFor(`${policyPanel}?.textContent.includes('策略已被更新')`); assert.equal(policyWrites, 1); assert.equal(await run(`${policyPanel}.querySelector('input[aria-label="最低客户端版本"]').value`), '0.4.0');
    await button('重新读取策略', policyPanel); await waitFor(`document.body.textContent.includes('重新读取会放弃')`); await button('确认', "document.querySelector('[role=dialog]')");
    await waitFor(`${policyPanel}?.querySelector('input[aria-label="最低客户端版本"]')?.value === '0.3.0'`);
    await input('input[aria-label="员工邮箱"]', 'staff@example.com'); await button('生成邀请', "document.querySelector('[data-organization-invitations]')");
    await waitFor(`document.querySelector('input[aria-label="生成的邀请代码"]')?.value === 'fixture-invitation-code'`);
    await input('input[aria-label="企业域名"]', 'company.com'); await button('生成验证记录', domainPanel); await waitFor(`${domainPanel}?.textContent.includes('待验证')`);
    await button('检查 DNS', domainPanel); await waitFor(`${domainPanel}?.textContent.includes('已验证')`);
    await button('移除', domainPanel); await waitFor(`document.body.textContent.includes('移除企业域名')`); assert.equal(domains.length, 1);
    await button('确认', "document.querySelector('[role=dialog]')"); await waitFor(`!${domainPanel}?.textContent.includes('company.com')`); assert.equal(domains.length, 0);
    await run(`(() => { const item = [...${panel}.querySelectorAll('span')].find(node => node.textContent === 'Employee').parentElement.parentElement; item.querySelector('button[role=combobox]').click(); })()`);
    await waitFor(`!!document.querySelector('[role=option]')`); await run(`[...document.querySelectorAll('[role=option]')].find(node => node.textContent.trim() === '管理员').click()`);
    await waitFor(`document.body.textContent.includes('修改组织角色')`); assert.equal(roleChanged, false);
    await button('修改角色'); await waitFor(`${panel}?.textContent.includes('管理员')`); assert.equal(roleChanged, true);
    const privateState = await run(`JSON.stringify({ storage: { ...localStorage }, text: document.body.textContent, values: [...document.querySelectorAll('input')].map(node => node.value) })`); assert.ok(!privateState.includes('private-control-'));
    await input('input[aria-label="企业邀请代码"]', 'a'.repeat(43)); await button('接受邀请'); await waitFor(`document.body.textContent.includes('已加入 Joined Organization')`);
    await run(`${panel}.querySelector('button[role=combobox]').click()`);
    await waitFor(`!![...document.querySelectorAll('[role=option]')].find(node => node.textContent.includes('Joined Organization'))`);
    await run(`[...document.querySelectorAll('[role=option]')].find(node => node.textContent.includes('Joined Organization')).click()`);
    await waitFor(`${panel}?.textContent.includes('当前角色：成员')`);
    assert.equal(await run(`document.querySelector('[data-organization-invitations]') === null`), true);
    await button('退出登录'); await waitFor(`!!document.querySelector('input[autocomplete="username"]') && ${panel} === null`);
    await login('Admin'); await waitFor(`${policyPanel}?.textContent.includes('仅组织所有者')`);
    assert.equal(await run(`${policyPanel}.querySelector('input').matches(':disabled') && ![...${policyPanel}.querySelectorAll('button')].some(node => node.textContent.includes('保存并'))`), true);
    await button('退出登录'); await waitFor(`!!document.querySelector('input[autocomplete="username"]') && ${panel} === null`);
    await login('Member'); await waitFor(`${panel}?.textContent.includes('当前角色：成员')`);
    assert.equal(await run(`${panel}.textContent.includes('Employee') || document.body.textContent.includes('DesktopAuditOwner') || !!document.querySelector('[data-organization-invitations]') || !!${domainPanel}`), false, 'new account sees no previous manager data');
    await button('退出登录'); await waitFor(`!!document.querySelector('input[autocomplete="username"]') && ${panel} === null`);
    await login('Auditor'); await waitFor(`${panel}?.textContent.includes('当前角色：审计员（只读）') && document.body.textContent.includes('DesktopAuditOwner')`);
    assert.equal(await run(`!!document.querySelector('[data-organization-policy]') || !!document.querySelector('[data-organization-invitations]') || !!${domainPanel} || ${panel}.textContent.includes('Employee')`), false);
    assert.ok(controlRequests.filter(row => row.actor === 'Auditor').every(row => row.method === 'GET' && (row.pathname.endsWith('/organizations') || row.pathname.endsWith('/audit'))), 'auditor UI must not request management endpoints');
    auditorRevoked = true; await button('刷新记录', "document.querySelector('[data-organization-audit]')");
    await waitFor(`document.querySelector('[data-organization-audit] [role=alert]') && !document.body.textContent.includes('DesktopAuditOwner')`);
    await button('退出登录'); await waitFor(`!!document.querySelector('input[autocomplete="username"]') && ${panel} === null`);
    await login('Owner'); await waitFor(`document.body.textContent.includes('DesktopAuditOwner')`);
    expired = true; await button('刷新记录', "document.querySelector('[data-organization-audit]')");
    await waitFor(`!!document.querySelector('input[autocomplete="username"]') && ${panel} === null`);
    assert.equal(await run(`document.body.textContent.includes('DesktopAuditOwner')`), false);
    assert.equal(await run(`fetch('/api/local/capabilities').then(response => response.json()).then(body => body.capabilities.projects && body.remoteApiRequired === false)`), true);
    console.log('Desktop organization UI passed: real Local API, unsigned mode, policy confirmation/conflict/draft/reload/admin read-only, members, invitations, domains, audit and account/session isolation.');
  } catch (error) { console.error(error); if (window && !window.isDestroyed()) console.error('UI state:', (await run('document.body.textContent')).slice(0, 3000).replace(/private-control-[A-Za-z]+/g, '[redacted]')); exitCode = 1; }
  finally { clearTimeout(deadline); window?.destroy(); await api?.close(); if (server) await new Promise((resolve) => server.close(resolve)); if (directory) fs.rmSync(directory, { recursive: true, force: true }); app.exit(exitCode); }
});
