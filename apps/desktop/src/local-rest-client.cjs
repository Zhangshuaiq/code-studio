function validateRequest(input) {
  if (!input || typeof input.url !== 'string' || input.url.length > 4096) throw Error('请求地址无效');
  const url = new URL(input.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('仅支持不含用户名密码的 HTTP/HTTPS 地址');
  const method = input.method || 'GET';
  if (!['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(method)) throw Error('请求方法无效');
  if (input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 256 * 1024)) throw Error('请求体最多 256 KiB');
  if (['GET','HEAD'].includes(method) && input.body) throw Error('GET/HEAD 请求不能发送请求体');
  const headers = {};
  if (input.headers && (typeof input.headers !== 'object' || Array.isArray(input.headers))) throw Error('请求头无效');
  if (Object.keys(input.headers || {}).length > 100) throw Error('请求头最多 100 项');
  for (const [name, value] of Object.entries(input.headers || {})) {
    if (!/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(name) || typeof value !== 'string' || value.length > 8000 || /[\r\n\0]/.test(value) || /^(?:host|connection|content-length|transfer-encoding|upgrade|proxy-|sec-)/i.test(name)) throw Error('请求头名称或值不安全');
    headers[name] = value;
  }
  return { url: url.toString(), method, headers, ...(!['GET','HEAD'].includes(method) ? { body: input.body || '' } : {}) };
}
async function sendRequest(input, signal) {
  const request = validateRequest(input), start = performance.now();
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
  const chunks = []; let size = 0, truncated = false;
  if (response.body) { const reader = response.body.getReader(); try { for (;;) { const { done, value } = await reader.read(); if (done) break; const remaining = 2 * 1024 * 1024 - size; chunks.push(value.subarray(0, Math.max(0, remaining))); size += Math.min(remaining, value.length); if (value.length > remaining) { truncated = true; await reader.cancel(); break; } } } finally { reader.releaseLock(); } }
  const bytes = Buffer.concat(chunks), type = response.headers.get('content-type') || '';
  const binary = type && !/text|json|xml|javascript|x-www-form-urlencoded/i.test(type);
  return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body: binary ? '' : bytes.toString('utf8'), binary: !!binary, bytes: size, truncated, elapsedMs: Math.round(performance.now() - start), redirected: response.status >= 300 && response.status < 400 };
}
module.exports = { validateRequest, sendRequest };
