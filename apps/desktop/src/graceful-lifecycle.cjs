const { performance } = require('node:perf_hooks');

function installGracefulQuit(app, close, { canQuit = async () => true, onEvent = () => {}, timeoutMs = 45_000 } = {}) {
  let completed = false;
  let pending;
  const report = (event) => { try { onEvent(event); } catch {} };
  app.on('before-quit', (event) => {
    if (completed) return;
    event.preventDefault();
    if (pending) return;
    pending = (async () => {
      if (!await canQuit()) { report({ event: 'quit-cancelled' }); return; }
      const started = performance.now();
      report({ event: 'quit-start' });
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(close),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('关闭运行时超时')), timeoutMs); }),
        ]);
        report({ event: 'quit-ready', durationMs: Math.round(performance.now() - started) });
      } catch (error) {
        report({ event: 'quit-cleanup-error', durationMs: Math.round(performance.now() - started), reason: error.message });
      } finally { clearTimeout(timer); }
      completed = true;
      app.quit();
    })().catch((error) => report({ event: 'quit-check-error', reason: error.message })).finally(() => { pending = undefined; });
  });
}

module.exports = { installGracefulQuit };
