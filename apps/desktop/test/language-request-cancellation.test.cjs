const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const { languageRequest, cancelLanguageRequests } = require('@codegen/code-intelligence/language-request.cjs');
function peers(t) {
  const up = new PassThrough(), down = new PassThrough();
  const client = createMessageConnection(new StreamMessageReader(down), new StreamMessageWriter(up));
  const server = createMessageConnection(new StreamMessageReader(up), new StreamMessageWriter(down));
  t.after(() => { client.dispose(); server.dispose(); up.destroy(); down.destroy(); });
  client.listen(); server.listen();
  return { client, server, session: { provider: 'java', connection: client } };
}
test('timed-out requests send JSON-RPC cancellation and later requests remain usable', async t => {
  const { server, session } = peers(t);
  let wasCancelled = false;
  server.onRequest('slow', (_params, token) => new Promise(resolve => {
    token.onCancellationRequested(() => { wasCancelled = true; resolve('late response'); });
  }));
  server.onRequest('quick', () => 'ready');
  await assert.rejects(languageRequest(session, 'slow', {}, 30), { code: 'LOCAL_LSP_TIMEOUT' });
  const deadline = Date.now() + 1000;
  while (!wasCancelled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(wasCancelled, true);
  assert.equal(await languageRequest(session, 'quick', {}, 1000), 'ready');
  assert.equal(session.pendingLanguageRequests.size, 0);
});
test('session shutdown cancels active work and refuses late requests', async t => {
  const { server, session } = peers(t);
  let start, cancelled = false;
  const started = new Promise(resolve => { start = resolve; });
  server.onRequest('slow', (_params, token) => new Promise(resolve => {
    token.onCancellationRequested(() => { cancelled = true; resolve(null); }); start();
  }));
  const pending = languageRequest(session, 'slow', {}, 1000);
  const rejected = assert.rejects(pending, { code: 'LOCAL_LSP_UNAVAILABLE' });
  await started; session.stopping = true; cancelLanguageRequests(session);
  await rejected;
  const deadline = Date.now() + 1000;
  while (!cancelled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cancelled, true);
  assert.equal(session.pendingLanguageRequests.size, 0);
  await assert.rejects(languageRequest(session, 'late', {}, 1000), { code: 'LOCAL_LSP_UNAVAILABLE' });
});
test('successful responses and protocol errors do not trigger timeout cancellation', async t => {
  const { server, session } = peers(t);
  let cancellations = 0;
  server.onRequest('quick', (_params, token) => { token.onCancellationRequested(() => cancellations++); return 42; });
  assert.equal(await languageRequest(session, 'quick', {}, 40), 42);
  await assert.rejects(languageRequest(session, 'missing', {}, 1000), { code: -32601 });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(cancellations, 0);
  assert.throws(() => languageRequest(session, 'quick', {}, 0), /timeout/);
});
test('synchronous transport failures preserve the original error', async () => {
  const error = new Error('transport closed');
  await assert.rejects(languageRequest({ provider: 'java', connection: { sendRequest() { throw error; } } }, 'quick', {}, 10), reason => reason === error);
});
test('trusted diagnostic session budget is honored and explicit budget takes precedence', async t => {
  const { server, session } = peers(t);
  session.requestTimeoutMs = 10;
  server.onRequest('delayed', () => new Promise(resolve => setTimeout(() => resolve('ok'), 40)));
  await assert.rejects(languageRequest(session, 'delayed', {}), { code: 'LOCAL_LSP_TIMEOUT' });
  assert.equal(await languageRequest(session, 'delayed', {}, 1000), 'ok');
});
