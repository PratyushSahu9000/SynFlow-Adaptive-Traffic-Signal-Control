'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { EventEmitter } = require('events');

const { loadConfig } = require('../config');
const { createExperimentsRouter } = require('../routes/experiments');

const EXP_ID = '64b7f0c2a1b2c3d4e5f60718';
const RESET_AT = '2026-05-02T00:00:00.000Z';

function makeConfig(overrides = {}) {
  const cfg = loadConfig({});
  return { ...cfg, ...overrides };
}

function makeRunner({ slot = Symbol('slot'), started = true, launchError = null } = {}) {
  const events = new EventEmitter();
  const calls = { acquire: 0, release: 0, launch: 0, rollback: 0 };

  return {
    events,
    calls,
    tryAcquireSlot() {
      calls.acquire += 1;
      return slot;
    },
    releaseSlot() {
      calls.release += 1;
    },
    async launch(_exp, options) {
      calls.launch += 1;
      if (launchError) throw launchError;
      if (!started) {
        calls.rollback += 1;
        if (options && options.onSpawnFailure) await options.onSpawnFailure();
      }
      return { started };
    },
  };
}

function makeLimiter(decision) {
  const calls = { evaluate: 0, record: 0 };
  return {
    calls,
    evaluate() {
      calls.evaluate += 1;
      return decision;
    },
    record() {
      calls.record += 1;
    },
  };
}

function makeQuota({ reservation, error = null } = {}) {
  const calls = { reserve: 0, release: 0 };
  return {
    calls,
    async reserve() {
      calls.reserve += 1;
      if (error) throw error;
      return reservation;
    },
    async release() {
      calls.release += 1;
    },
  };
}

function makeModel({ exp = null, createError = null } = {}) {
  const calls = { create: 0 };
  return {
    calls,
    async create() {
      calls.create += 1;
      if (createError) throw createError;
      return { _id: EXP_ID, status: 'running', seed: undefined };
    },
    findById() {
      return {
        select: async () => exp,
        then: (resolve, reject) => Promise.resolve(exp).then(resolve, reject),
        catch: (reject) => Promise.resolve(exp).catch(reject),
      };
    },
    async findByIdAndUpdate() {
      return exp;
    },
  };
}

function makeSse({ allow = true } = {}) {
  const calls = { add: 0, remove: 0 };
  return {
    calls,
    tryAdd() {
      calls.add += 1;
      return allow;
    },
    remove() {
      calls.remove += 1;
    },
    closeAll() {},
  };
}

function buildApp(overrides) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/api/experiments', createExperimentsRouter(overrides));
  return app;
}

const allowed = { allowed: true, reason: null, retryAfterSeconds: 0 };
const reservation = {
  allowed: true,
  dayKey: '2026-05-01',
  limit: 25,
  resetAt: RESET_AT,
  count: 1,
  remaining: 24,
};

test('a successful start acquires one slot and returns 201', async () => {
  const runner = makeRunner();
  const limiter = makeLimiter(allowed);
  const quota = makeQuota({ reservation });
  const model = makeModel();

  const app = buildApp({ runner, limiter, quota, ExperimentModel: model });
  const res = await request(app).post('/api/experiments').send({}).expect(201);

  assert.equal(res.body.id, EXP_ID);
  assert.equal(runner.calls.acquire, 1);
  assert.equal(runner.calls.launch, 1);
  assert.equal(limiter.calls.record, 1);
  assert.equal(model.calls.create, 1);
  assert.equal(quota.calls.release, 0);
});

test('unexpected request fields are rejected before acquiring a slot', async () => {
  const runner = makeRunner();
  const limiter = makeLimiter(allowed);
  const quota = makeQuota({ reservation });

  const app = buildApp({ runner, limiter, quota, ExperimentModel: makeModel() });
  const res = await request(app).post('/api/experiments').send({ seed: 7 }).expect(400);

  assert.equal(res.body.error, 'Unexpected request fields');
  assert.equal(runner.calls.acquire, 0);
  assert.equal(quota.calls.reserve, 0);
});

test('a non-JSON start body is rejected before acquiring a slot', async () => {
  const runner = makeRunner();
  const limiter = makeLimiter(allowed);
  const quota = makeQuota({ reservation });

  const app = buildApp({ runner, limiter, quota, ExperimentModel: makeModel() });
  const res = await request(app)
    .post('/api/experiments')
    .set('Content-Type', 'text/plain')
    .send('{"seed":7}')
    .expect(400);

  assert.equal(res.body.error, 'Content-Type must be application/json');
  assert.equal(runner.calls.acquire, 0);
  assert.equal(quota.calls.reserve, 0);
});

test('a running experiment returns 409 without consuming quota', async () => {
  const runner = makeRunner({ slot: null });
  const limiter = makeLimiter(allowed);
  const quota = makeQuota({ reservation });

  const app = buildApp({ runner, limiter, quota, ExperimentModel: makeModel() });
  const res = await request(app).post('/api/experiments').send({}).expect(409);

  assert.match(res.body.error, /currently running/i);
  assert.equal(quota.calls.reserve, 0);
  assert.equal(limiter.calls.evaluate, 0);
});

test('a per-IP cooldown returns 429 with Retry-After and no quota use', async () => {
  const runner = makeRunner();
  const limiter = makeLimiter({ allowed: false, reason: 'cooldown', retryAfterSeconds: 120 });
  const quota = makeQuota({ reservation });

  const app = buildApp({ runner, limiter, quota, ExperimentModel: makeModel() });
  const res = await request(app).post('/api/experiments').send({}).expect(429);

  assert.equal(res.body.error, 'Too many experiment requests. Please try again later.');
  assert.equal(res.body.retryAfterSeconds, 120);
  assert.equal(res.headers['retry-after'], '120');
  assert.equal(runner.calls.release, 1);
  assert.equal(quota.calls.reserve, 0);
  assert.equal(quota.calls.release, 0);
});

test('global daily exhaustion returns 429 with limit and dynamic resetAt', async () => {
  const runner = makeRunner();
  const limiter = makeLimiter(allowed);
  const quota = makeQuota({ reservation: { allowed: false, limit: 25, resetAt: RESET_AT } });

  const app = buildApp({ runner, limiter, quota, ExperimentModel: makeModel() });
  const res = await request(app).post('/api/experiments').send({}).expect(429);

  assert.match(res.body.error, /capacity has been reached/i);
  assert.equal(res.body.limit, 25);
  assert.equal(res.body.resetAt, RESET_AT);
  assert.ok(Number(res.headers['retry-after']) > 0);
  assert.equal(runner.calls.release, 1);
  assert.equal(runner.calls.launch, 0);
});

test('MongoDB quota failure returns a sanitized 503 and does not start Python', async () => {
  const runner = makeRunner();
  const limiter = makeLimiter(allowed);
  const quota = makeQuota({ error: new Error('mongodb://secret-host/db is down') });

  const app = buildApp({ runner, limiter, quota, ExperimentModel: makeModel() });
  const res = await request(app).post('/api/experiments').send({}).expect(503);

  assert.equal(res.body.error, 'Experiments are temporarily unavailable. Please try again later.');
  assert.equal(JSON.stringify(res.body).includes('mongodb'), false);
  assert.equal(runner.calls.release, 1);
  assert.equal(runner.calls.launch, 0);
});

test('a document creation failure rolls the reservation back', async () => {
  const runner = makeRunner();
  const limiter = makeLimiter(allowed);
  const quota = makeQuota({ reservation });
  const model = makeModel({ createError: new Error('write failed') });

  const app = buildApp({ runner, limiter, quota, ExperimentModel: model });
  await request(app).post('/api/experiments').send({}).expect(503);

  assert.equal(quota.calls.release, 1);
  assert.equal(runner.calls.release, 1);
  assert.equal(runner.calls.launch, 0);
});

test('a spawn failure rolls the reservation back and does not record an IP start', async () => {
  const runner = makeRunner({ started: false });
  const limiter = makeLimiter(allowed);
  const quota = makeQuota({ reservation });

  const app = buildApp({ runner, limiter, quota, ExperimentModel: makeModel() });
  await request(app).post('/api/experiments').send({}).expect(503);

  assert.equal(runner.calls.rollback, 1);
  assert.equal(quota.calls.release, 1);
  assert.equal(limiter.calls.record, 0);
});

test('an unexpected launch exception is sanitized and releases the slot', async () => {
  const runner = makeRunner({ launchError: new Error('internal stack trace') });
  const limiter = makeLimiter(allowed);
  const quota = makeQuota({ reservation });

  const app = buildApp({ runner, limiter, quota, ExperimentModel: makeModel() });
  const res = await request(app).post('/api/experiments').send({}).expect(503);

  assert.equal(res.body.error, 'Experiments are temporarily unavailable. Please try again later.');
  assert.equal(quota.calls.release, 1);
  assert.equal(runner.calls.release, 1);
});

test('invalid experiment ids are rejected before any database lookup', async () => {
  const runner = makeRunner();
  const limiter = makeLimiter(allowed);
  const quota = makeQuota({ reservation });
  const model = makeModel();

  const app = buildApp({ runner, limiter, quota, ExperimentModel: model });
  const res = await request(app).get('/api/experiments/not-an-id').expect(400);

  assert.equal(res.body.error, 'Invalid experiment id');
});

test('SSE connections above the cap return 429', async () => {
  const sse = makeSse({ allow: false });
  const app = buildApp({
    runner: makeRunner(),
    limiter: makeLimiter(allowed),
    quota: makeQuota({ reservation }),
    sse,
    ExperimentModel: makeModel({ exp: { _id: EXP_ID, status: 'running' } }),
  });

  const res = await request(app).get(`/api/experiments/${EXP_ID}/stream`).expect(429);
  assert.match(res.body.error, /concurrent progress streams/i);
  assert.equal(res.headers['retry-after'], '10');
});

test('SSE for a completed experiment sends its terminal state and cleans up', async () => {
  const sse = makeSse({ allow: true });
  const app = buildApp({
    runner: makeRunner(),
    limiter: makeLimiter(allowed),
    quota: makeQuota({ reservation }),
    sse,
    ExperimentModel: makeModel({ exp: { _id: EXP_ID, status: 'completed' } }),
  });

  const res = await request(app)
    .get(`/api/experiments/${EXP_ID}/stream`)
    .buffer(true)
    .expect(200);

  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.match(res.text, /"type":"completed"/);
  assert.equal(sse.calls.add, 1);
  assert.equal(sse.calls.remove, 1);
});

test('the ordinary API limiter returns 429 after its configured budget', async () => {
  const cfg = makeConfig({ api: { windowMs: 60000, max: 3 } });
  const model = {
    find: () => ({ select: () => ({ sort: async () => [] }) }),
  };

  const app = buildApp({ config: cfg, ExperimentModel: model });

  await request(app).get('/api/experiments').expect(200);
  await request(app).get('/api/experiments').expect(200);
  await request(app).get('/api/experiments').expect(200);
  const res = await request(app).get('/api/experiments').expect(429);

  assert.ok(Number(res.headers['retry-after']) > 0);
  assert.ok(res.body.retryAfterSeconds > 0);
});
