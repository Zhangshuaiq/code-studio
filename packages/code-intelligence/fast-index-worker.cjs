const { parentPort, workerData } = require('node:worker_threads');
const { JavaFastIndex } = require('./java-fast-index.cjs');
let index;
try {
  index = new JavaFastIndex({ ...workerData, onProgress: status => parentPort.postMessage({ event: 'status', status }) });
  parentPort.on('message', async ({ id, operation, input }) => {
    try {
      let result;
      if (operation === 'search') result = await index.search(input.query, input.limit, input.documents);
      else if (operation === 'outline') result = await index.outline(input.path, input.documents);
      else if (operation === 'status') result = index.status();
      else if (operation === 'refresh') result = await index.refresh();
      else if (operation === 'close') { await index.close(); parentPort.postMessage({ id, result: { closed: true } }); parentPort.close(); return; }
      else throw new Error('Unsupported fast-index operation');
      parentPort.postMessage({ id, result });
    } catch (error) { parentPort.postMessage({ id, error: { code: error.code || 'FAST_INDEX_ERROR', message: error.message } }); }
  });
  parentPort.postMessage({ event: 'ready', status: index.status() });
} catch (error) { parentPort.postMessage({ event: 'failed', error: { code: error.code || 'FAST_INDEX_ERROR', message: error.message } }); parentPort.close(); }
