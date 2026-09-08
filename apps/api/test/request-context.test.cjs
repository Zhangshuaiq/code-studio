const test = require('node:test');
const assert = require('node:assert/strict');
const { requestContextMiddleware, getRequestContext } = require('../dist/observability/request-context.js');

function invoke(headers = {}) {
  const responseHeaders = {};
  const request = { header: (name) => headers[name] };
  const response = { setHeader: (name, value) => { responseHeaders[name] = value; } };
  let context;
  requestContextMiddleware(request, response, () => { context = getRequestContext(); });
  return { responseHeaders, context };
}

test('request context preserves safe request id and W3C trace id', () => {
  const traceId = 'a'.repeat(32);
  const result = invoke({
    'x-request-id': 'gateway-request-42',
    traceparent: `00-${traceId}-${'b'.repeat(16)}-01`,
  });
  assert.equal(result.context.requestId, 'gateway-request-42');
  assert.equal(result.context.traceId, traceId);
  assert.match(result.responseHeaders.traceparent, new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
});

test('request context replaces unsafe inbound identifiers', () => {
  const result = invoke({ 'x-request-id': '<script>'.repeat(30), traceparent: 'invalid' });
  assert.match(result.context.requestId, /^[0-9a-f-]{36}$/);
  assert.match(result.context.traceId, /^[0-9a-f]{32}$/);
});
