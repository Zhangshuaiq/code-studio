const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClusterNodes } = require('../dist/redis/redis-connection.js');

test('redis cluster discovery nodes are parsed deterministically', () => {
  assert.deepEqual(parseClusterNodes('redis-0:6379, redis-1:6380'), [
    { host: 'redis-0', port: 6379 },
    { host: 'redis-1', port: 6380 },
  ]);
});

test('redis cluster discovery rejects malformed nodes', () => {
  assert.throws(() => parseClusterNodes('redis-without-port'), /非法 Redis Cluster 节点/);
});
