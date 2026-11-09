'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSseRegistry } = require('../services/sseRegistry');
const { hashIp } = require('../services/privacy');

test('privacy hash is deterministic, keyed, and hides the raw address', () => {
  const a = hashIp('203.0.113.9');
  const b = hashIp('203.0.113.9');

  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.equal(a.includes('203.0.113.9'), false);
  assert.notEqual(a, hashIp('203.0.113.10'));
});

test('SSE registry enforces the per-IP cap', () => {
  const sse = createSseRegistry({ maxPerIp: 2, maxTotal: 50 });
  const a = {};
  const b = {};
  const c = {};

  assert.equal(sse.tryAdd('ip-1', a), true);
  assert.equal(sse.tryAdd('ip-1', b), true);
  assert.equal(sse.tryAdd('ip-1', c), false);
  assert.deepEqual(sse.stats(), { total: 2, keys: 1 });

  assert.equal(sse.remove(a), true);
  assert.equal(sse.tryAdd('ip-1', c), true);
  assert.deepEqual(sse.stats(), { total: 2, keys: 1 });
});

test('SSE registry enforces the global cap and closeAll cleans up', () => {
  const sse = createSseRegistry({ maxPerIp: 2, maxTotal: 3 });
  const clients = [{}, {}, {}, {}];

  assert.equal(sse.tryAdd('ip-1', clients[0]), true);
  assert.equal(sse.tryAdd('ip-2', clients[1]), true);
  assert.equal(sse.tryAdd('ip-3', clients[2]), true);
  assert.equal(sse.tryAdd('ip-4', clients[3]), false);

  sse.closeAll();
  assert.deepEqual(sse.stats(), { total: 0, keys: 0 });
  assert.equal(sse.tryAdd('ip-5', clients[3]), true);
});

test('removing an unknown response is a no-op', () => {
  const sse = createSseRegistry({ maxPerIp: 2, maxTotal: 50 });
  assert.equal(sse.remove({}), false);
  assert.deepEqual(sse.stats(), { total: 0, keys: 0 });
});
