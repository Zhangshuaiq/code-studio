const { CancellationTokenSource } = require('vscode-jsonrpc/node');
const interrupted = () => Object.assign(new Error('代码智能正在关闭，可以稍后重试'), { code: 'LOCAL_LSP_UNAVAILABLE' });

function languageRequest(session, method, params, timeoutMs = session.requestTimeoutMs ?? 15_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid language request timeout');
  if (session.stopping) return Promise.reject(interrupted());
  const cancellation = new CancellationTokenSource();
  let timer, rejectInterrupted;
  session.pendingLanguageRequests ||= new Set();
  const request = { cancel() { rejectInterrupted(interrupted()); try { cancellation.cancel(); } catch {} } };
  const stopping = new Promise((_, reject) => { rejectInterrupted = reject; });
  session.pendingLanguageRequests.add(request);
  return Promise.race([
    Promise.resolve().then(() => {
      if (session.stopping) throw interrupted();
      return session.connection.sendRequest(method, params, cancellation.token);
    }),
    stopping,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        // Reject with the stable client timeout first, then propagate cancellation
        // to the server so abandoned navigation/formatting work can stop.
        reject(Object.assign(new Error(`${session.provider} 语言服务响应超时`), { code: 'LOCAL_LSP_TIMEOUT' }));
        try { cancellation.cancel(); } catch { /* A disconnected transport is already being disposed. */ }
      }, timeoutMs);
    }),
  ]).finally(() => { clearTimeout(timer); cancellation.dispose(); session.pendingLanguageRequests.delete(request); });
}
function cancelLanguageRequests(session) { for (const request of session.pendingLanguageRequests || []) request.cancel(); }
module.exports = { languageRequest, cancelLanguageRequests };
