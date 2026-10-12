// UI-only fixture. Authorization/concurrency are tested separately through Nest
// HTTP and real PostgreSQL; this never connects to a user's control server.
const { app, BrowserWindow } = require('electron');
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../web/dist');
let window; let server; let role = 'owner'; let memberRole = 'member'; let memberReads = 0; let changed = false;
let auditReads = 0; let denyAudit = false; let lastAuditQuery;
let domainReads = 0; const domains = [];
let policy = { terminalEnabled: true, allowedModelEngines: ['codex-cli'], allowedConnectorTypes: ['postgres'], allowedGitHosts: ['local'], allowedNetworkHosts: [], minimumClientVersion: '0.1.0', offlineDays: 7, updatedAt: new Date().toISOString() }; let policyWrites = 0;
const invitations = [{ id: 'management', email: 'leader@example.test', role: 'admin', status: 'pending', expiresAt: new Date(Date.now() + 86400_000).toISOString() }];
const deadline = setTimeout(() => app.exit(1), 60000);
async function waitFor(expression) { for (let i = 0; i < 200; i++) { if (await window.webContents.executeJavaScript(`(() => { try { return (${expression}); } catch { return false; } })()`)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`UI condition not reached: ${expression}`); }
const panel = "document.querySelector('[data-organization-memberships]')";
const auditPanel = "document.querySelector('[data-organization-audit]')";
const domainPanel = "document.querySelector('[data-organization-domains]')";
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    server = http.createServer(async (request, response) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const json = (data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
      if (pathname === '/bootstrap') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<script>localStorage.setItem("token","ui-test");localStorage.setItem("username","Owner");location.replace("/settings/account");</script>'); return; }
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/auth/me') return json({ id: 'owner', username: 'Owner', email: 'owner@example.test', roles: [], permissions: [] });
        if (pathname === '/api/git/settings') return json({ identity: { authorName: 'Owner', authorEmail: 'owner@example.test' }, credentials: [] });
        if (pathname === '/api/control/enterprise/organizations') return json([{ userId: 'owner', role, organization: { id: 'org', name: 'UI Organization', slug: 'ui', seatLimit: 10 } }]);
        if (pathname === '/api/control/enterprise/organizations/org/policy') {
          if (request.method === 'GET') return json(policy);
          let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
          if (role !== 'owner') return json({ message: '仅组织所有者可以修改安全策略' }, 403);
          const { expectedUpdatedAt, ...fields } = body; assert.equal(expectedUpdatedAt, policy.updatedAt);
          policy = { ...fields, updatedAt: new Date(Date.parse(policy.updatedAt) + 1).toISOString() }; policyWrites++; return json(policy);
        }
        if (pathname === '/api/control/enterprise/organizations/org/domains') {
          if (request.method === 'GET') { domainReads++; return json(domains); }
          let raw = ''; for await (const chunk of request) raw += chunk;
          const { domain } = JSON.parse(raw); const item = { id: 'domain-1', domain, verifiedAt: null, expiresAt: new Date(Date.now() + 86400_000).toISOString(), recordName: `_code-studio-verification.${domain}`, recordValue: 'code-studio-verification=fixture-token' }; domains.push(item); return json(item, 201);
        }
        if (pathname === '/api/control/enterprise/organizations/org/domains/domain-1/verify' && request.method === 'POST') { domains[0].verifiedAt = new Date().toISOString(); return json(domains[0]); }
        if (pathname === '/api/control/enterprise/organizations/org/domains/domain-1' && request.method === 'DELETE') { domains.splice(0); return json({ success: true }); }
        if (pathname === '/api/control/enterprise/organizations/org/audit') {
          auditReads++; lastAuditQuery = new URL(request.url, 'http://localhost').searchParams;
          if (denyAudit) return json({ message: '没有该组织的管理权限' }, 403);
          const page = Number(lastAuditQuery.get('page')); const filtered = lastAuditQuery.get('q') === 'needle';
          const items = Array.from({ length: filtered ? 1 : page === 2 ? 1 : 20 }, (_, i) => ({ id: `audit-${page}-${i}`, createdAt: new Date().toISOString(), actorName: filtered ? 'FilteredOwner' : page === 2 ? 'SecondPageOwner' : `AuditOwner${i}`, action: 'organization.invitation.create', result: 'success', statusCode: 201, detail: { outcome: { invitationId: 'safe-target' } } }));
          return json({ items, total: filtered ? 1 : 21, page, pageSize: 20 });
        }
        if (pathname === '/api/control/enterprise/organizations/org/members') {
          memberReads++; return json([{ id: 'owner', userId: 'owner', role: 'owner', status: 'active', user: { id: 'owner', username: 'Owner' } }, { id: 'employee', userId: 'employee', role: memberRole, status: 'active', user: { id: 'employee', username: 'Employee' } }]);
        }
        if (pathname === '/api/control/enterprise/organizations/org/members/employee/role' && request.method === 'PUT') {
          let raw = ''; for await (const chunk of request) raw += chunk; memberRole = JSON.parse(raw).role; changed = true; return json({ role: memberRole });
        }
        if (pathname === '/api/control/enterprise/organizations/org/invitations') {
          if (request.method === 'GET') return json(invitations);
          let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
          const item = { id: 'staff', email: body.email, role: body.role, status: 'pending', expiresAt: new Date(Date.now() + 86400_000).toISOString() }; invitations.push(item); return json({ ...item, token: 'test-invitation-code' }, 201);
        }
        if (pathname === '/api/control/enterprise/organizations/org/invitations/staff' && request.method === 'DELETE') { invitations.find((item) => item.id === 'staff').status = 'revoked'; return json({ success: true }); }
        return json([]);
      }
      const file = pathname.startsWith('/assets/') ? path.resolve(root, `.${pathname}`) : path.join(root, 'index.html');
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); fs.createReadStream(file).pipe(response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
    window = new BrowserWindow({ show: false, width: 1200, height: 950, webPreferences: { partition: `organization-web-smoke-${require('node:crypto').randomUUID()}`, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    window.webContents.on('console-message', (event) => { if (event.level === 3) console.error(event.message); });
    await window.loadURL(`${origin}/bootstrap`);
    await waitFor(`${panel}?.textContent.includes('Employee')`);
    console.log('Organization fixture loaded.');
    await waitFor(`!!document.querySelector('[data-organization-policy] input[aria-label="最低客户端版本"]')`);
    await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('[data-organization-policy] input[aria-label="最低客户端版本"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.2.0'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-organization-policy] button')].find(node => node.textContent.trim() === '保存并用于下次策略签发').click()`);
    await waitFor(`document.body.textContent.includes('修改组织安全策略')`); assert.equal(policyWrites, 0);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '保存策略').click()`);
    await waitFor(`document.querySelector('[data-organization-policy]')?.textContent.includes('策略已保存')`); assert.equal(policyWrites, 1);
    await waitFor(`!!${domainPanel}?.querySelector('input[aria-label="企业域名"]')`);
    await window.webContents.executeJavaScript(`(() => { const input = ${domainPanel}.querySelector('input[aria-label="企业域名"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'managed.company.com'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await window.webContents.executeJavaScript(`[...${domainPanel}.querySelectorAll('button')].find(node => node.textContent.trim() === '生成验证记录').click()`);
    await waitFor(`${domainPanel}?.textContent.includes('待验证')`);
    assert.equal(await window.webContents.executeJavaScript(`[...${domainPanel}.querySelectorAll('input')].some(node => node.value === 'code-studio-verification=fixture-token')`), true);
    await window.webContents.executeJavaScript(`[...${domainPanel}.querySelectorAll('button')].find(node => node.textContent.trim() === '检查 DNS').click()`);
    await waitFor(`${domainPanel}?.textContent.includes('已验证')`);
    console.log('Domain UI passed: scoped creation, TXT instructions and verification.');
    await waitFor(`${auditPanel}?.textContent.includes('AuditOwner0')`);
    const auditorMemberReads = memberReads; const auditorDomainReads = domainReads; const auditorPolicyWrites = policyWrites;
    role = 'auditor'; await window.loadURL(`${origin}/settings/account`);
    await waitFor(`${panel}?.textContent.includes('当前角色：审计员（只读）') && ${auditPanel}?.textContent.includes('AuditOwner0')`);
    assert.equal(memberReads, auditorMemberReads); assert.equal(domainReads, auditorDomainReads); assert.equal(policyWrites, auditorPolicyWrites);
    assert.equal(await window.webContents.executeJavaScript(`!!document.querySelector('[data-organization-policy]') || !!document.querySelector('[data-organization-invitations]') || !!${domainPanel} || ${panel}.textContent.includes('Employee')`), false);
    denyAudit = true;
    await window.webContents.executeJavaScript(`[...${auditPanel}.querySelectorAll('button')].find(node => node.textContent.trim() === '刷新记录').click()`);
    await waitFor(`!!${auditPanel}?.querySelector('[role=alert]') && ${auditPanel}.querySelectorAll('tbody tr').length === 0`);
    assert.equal(await window.webContents.executeJavaScript(`${auditPanel}.textContent.includes('AuditOwner0')`), false);
    denyAudit = false;
    role = 'owner'; await window.loadURL(`${origin}/settings/account`);
    await waitFor(`${auditPanel}?.textContent.includes('AuditOwner0') && ${panel}?.textContent.includes('Employee')`);
    await window.webContents.executeJavaScript(`[...${auditPanel}.querySelectorAll('button')].find(node => node.textContent === '下一页').click()`);
    await waitFor(`${auditPanel}?.textContent.includes('SecondPageOwner')`);
    await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="组织审计关键词"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'needle'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await window.webContents.executeJavaScript(`[...${auditPanel}.querySelectorAll('button')].find(node => node.textContent === '查询').click()`);
    await waitFor(`${auditPanel}?.textContent.includes('FilteredOwner')`);
    assert.equal(lastAuditQuery.get('page'), '1'); assert.equal(lastAuditQuery.get('q'), 'needle');
    await window.webContents.executeJavaScript(`${auditPanel}.querySelector('summary').click()`);
    assert.equal(await window.webContents.executeJavaScript(`${auditPanel}.querySelector('details').open && ${auditPanel}.querySelector('pre').textContent.includes('safe-target')`), true);
    denyAudit = true;
    await window.webContents.executeJavaScript(`[...${auditPanel}.querySelectorAll('button')].find(node => node.textContent === '刷新记录').click()`);
    await waitFor(`!!${auditPanel}?.querySelector('[role="alert"]') && ${auditPanel}.querySelectorAll('tbody tr').length === 0`);
    denyAudit = false;
    console.log('Audit UI passed: paging, filtering, detail and removal of cached rows on permission failure.');
    await waitFor(`!!document.querySelector('input[aria-label="员工邮箱"]')`);
    await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="员工邮箱"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'staff@example.test'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-organization-invitations] button')].find(node => node.textContent.trim() === '生成邀请').click()`);
    await waitFor(`document.querySelector('input[aria-label="生成的邀请代码"]')?.value === 'test-invitation-code'`);
    await waitFor(`document.querySelector('[data-organization-invitations]')?.textContent.includes('staff@example.test')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-organization-invitations] span')].find(node => node.textContent.startsWith('staff@example.test')).parentElement.querySelector('button').click()`);
    await waitFor(`document.body.textContent.includes('撤销后该邀请代码将无法使用')`);
    assert.equal(invitations.find((item) => item.id === 'staff').status, 'pending');
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '撤销邀请').click()`);
    await waitFor(`!document.querySelector('input[aria-label="生成的邀请代码"]') && document.querySelector('[data-organization-invitations]')?.textContent.includes('已撤销')`);
    await window.webContents.executeJavaScript(`(() => { const item = [...${panel}.querySelectorAll('span')].find(node => node.textContent === 'Employee').parentElement.parentElement; item.querySelector('button[role="combobox"]').click(); })()`);
    await waitFor(`!!document.querySelector('[role="option"]')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim() === '管理员').click()`);
    await waitFor(`document.body.textContent.includes('修改组织角色')`);
    assert.equal(changed, false, 'role changes require explicit confirmation');
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === '修改角色').click()`);
    await waitFor(`${panel}?.textContent.includes('管理员')`); assert.equal(memberRole, 'admin');
    role = 'admin'; memberRole = 'member'; await window.loadURL(`${origin}/settings/account`);
    await waitFor(`${panel}?.textContent.includes('Employee')`);
    await waitFor(`document.querySelector('[data-organization-policy]')?.textContent.includes('仅组织所有者')`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-organization-policy] input').matches(':disabled')`), true);
    await waitFor(`${domainPanel}?.textContent.includes('已验证')`);
    await window.webContents.executeJavaScript(`[...${domainPanel}.querySelectorAll('button')].find(node => node.textContent.trim() === '移除').click()`);
    await waitFor(`document.body.textContent.includes('移除企业域名')`);
    assert.equal(domains.length, 1, 'domain removal requires confirmation');
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent.trim() === '确认').click()`);
    await waitFor(`!${domainPanel}?.textContent.includes('managed.company.com')`);
    assert.equal(domains.length, 0);
    assert.equal(await window.webContents.executeJavaScript(`${panel}.querySelectorAll('button[role="combobox"]').length`), 4, 'admins have organization/invitation/audit filters but no member role editors');
    await window.webContents.executeJavaScript(`document.querySelector('[data-organization-invitations] button[role="combobox"]').click()`);
    await waitFor(`!!document.querySelector('[role="option"]')`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('[role="option"]').length`), 1);
    assert.equal(await window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-organization-invitations] span')].find(node => node.textContent.startsWith('leader@example.test')).parentElement.querySelector('button') === null`), true, 'admin cannot revoke a manager invitation');
    await waitFor(`${auditPanel}?.textContent.includes('AuditOwner0')`);
    role = 'member'; const reads = memberReads; const auditCount = auditReads; const domainCount = domainReads; await window.loadURL(`${origin}/settings/account`);
    await waitFor(`${panel}?.textContent.includes('当前角色：成员')`);
    assert.equal(memberReads, reads, 'ordinary members must not request the manager list');
    assert.equal(await window.webContents.executeJavaScript(`${panel}.textContent.includes('Employee')`), false);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-organization-invitations]') === null`), true);
    assert.equal(auditReads, auditCount, 'ordinary members must not request audit records');
    assert.equal(await window.webContents.executeJavaScript(`${auditPanel} === null`), true);
    assert.equal(domainReads, domainCount, 'ordinary members must not request domain challenges');
    assert.equal(await window.webContents.executeJavaScript(`${domainPanel} === null`), true);
    console.log('Organization roles/invitations UI smoke passed: owner/admin management, auditor-only records without management requests, revoked-auditor cache removal and ordinary-member view.');
  } catch (error) { console.error(error); exitCode = 1; }
  finally { clearTimeout(deadline); window?.destroy(); if (server) await new Promise((resolve) => server.close(resolve)); app.exit(exitCode); }
});
