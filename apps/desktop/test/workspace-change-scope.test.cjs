const test = require('node:test');
const assert = require('node:assert/strict');
const { validChange, javaRelevant, indexChangeScope } = require('@codegen/code-intelligence/workspace-change-scope.cjs');
const { LocalLspManager } = require('@codegen/code-intelligence');
const change = file => ({ path: file, type: 1 });
test('Java source, dependencies and build configuration remain watched; assets do not', () => {
  for (const file of ['module/src/Main.java', 'module/pom.xml', 'lib/api.jar', 'lib/Main.class', '.classpath', '.project', '.settings/org.eclipse.jdt.core.prefs', 'build.gradle.kts', 'settings.gradle', 'gradle.properties']) assert.equal(javaRelevant(change(file)), true, file);
  for (const file of ['logo.png', 'README.md', 'Mapper.xml', 'schema.sql', 'deploy.sh', '.idea/workspace.xml', 'application.yml']) assert.equal(javaRelevant(change(file)), false, file);
  for (const file of ['../Outside.java', '/Outside.java', 'C:/Outside.java', 'a/../Outside.java', 'a\\Outside.java', 'a\0.java']) assert.equal(validChange(change(file)), false, file);
  assert.equal(validChange({ path: 'A.java', type: 100 }), false);
});
test('syntax and mapper indexes invalidate only for their inputs, with conservative directory fallback', () => {
  assert.deepEqual(indexChangeScope([change('README.md'), change('logo.png'), change('run.sh')]), { java: false, relations: false });
  assert.deepEqual(indexChangeScope([change('Mapper.xml')]), { java: false, relations: true });
  assert.deepEqual(indexChangeScope([change('Main.java')]), { java: true, relations: true });
  assert.deepEqual(indexChangeScope(undefined), { java: true, relations: true });
});
test('irrelevant events do not wait for initializing Java or send Java watcher notifications', async () => {
  const manager = new LocalLspManager();
  manager.sessions.set('test:java', { projectId: 'test', provider: 'java', ready: new Promise(() => {}) });
  let timer;
  try {
    await Promise.race([manager.workspaceChanged({ id: 'test', path: __dirname }, [change('README.md'), change('Mapper.xml')]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('irrelevant event waited for Java initialization')), 100); })]);
  } finally { clearTimeout(timer); manager.sessions.clear(); await manager.shutdown(); }
});
test('shared watcher routing preserves source/build events and non-Java notifications', async () => {
  const manager = new LocalLspManager(), notifications = { java: [], typescript: [] };
  for (const provider of Object.keys(notifications)) {
    const session = { projectId: 'test', provider, documents: new Map(), connection: { sendNotification: async (method, body) => notifications[provider].push({ method, body }) } };
    session.ready = Promise.resolve(session); manager.sessions.set(`test:${provider}`, session);
  }
  try {
    await manager.workspaceChanged({ id: 'test', path: __dirname }, [change('Main.java'), change('pom.xml'), change('logo.png'), change('../Outside.java')]);
    assert.equal(notifications.java[0].body.changes.length, 2);
    assert.equal(notifications.typescript[0].body.changes.length, 3);
    assert.ok(notifications.java[0].body.changes.some(item => item.uri.endsWith('/pom.xml')));
  } finally { manager.sessions.clear(); await manager.shutdown(); }
});
