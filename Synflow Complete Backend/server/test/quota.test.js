'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createQuotaService, utcDayKey, nextUtcMidnight } = require('../services/quota');

// Minimal in-process stand-in for the Mongoose model. It preserves the one
// property we depend on: the conditional increment and insert happen in a
// single logical step.
function createFakeModel() {
  const docs = new Map();
  let failure = null;
  let duplicateNext = false;

  function applyIncrement(doc, update) {
    if (update.$inc && typeof update.$inc.count === 'number') doc.count += update.$inc.count;
    return doc;
  }

  return {
    docs,
    fail(err) {
      failure = err;
    },
    failNextWithDuplicate() {
      duplicateNext = true;
    },
    async findOneAndUpdate(filter, update, options = {}) {
      if (failure) throw failure;
      if (duplicateNext) {
        duplicateNext = false;
        const err = new Error('E11000 duplicate key');
        err.code = 11000;
        throw err;
      }

      const id = filter._id;
      const doc = docs.get(id);
      const cond = filter.count || {};
      const matches =
        doc &&
        (cond.$lt === undefined || doc.count < cond.$lt) &&
        (cond.$gt === undefined || doc.count > cond.$gt);

      if (!matches) {
        if (!options.upsert) return null;
        if (doc) {
          const err = new Error('E11000 duplicate key');
          err.code = 11000;
          throw err;
        }
        const created = {
          _id: id,
          count: 0,
          createdAt: update.$setOnInsert ? update.$setOnInsert.createdAt : undefined,
        };
        applyIncrement(created, update);
        docs.set(id, created);
        return created;
      }

      return applyIncrement(doc, update);
    },
    findById(id) {
      const doc = docs.get(id);
      return {
        select() {
          return { lean: async () => (doc ? { count: doc.count } : null) };
        },
      };
    },
  };
}

test('UTC helpers use calendar-day keys and the next midnight', () => {
  const date = new Date('2026-01-01T12:34:56.000Z');
  assert.equal(utcDayKey(date), '2026-01-01');
  assert.equal(nextUtcMidnight(date).toISOString(), '2026-01-02T00:00:00.000Z');

  assert.equal(utcDayKey(new Date('2026-12-31T23:59:59.000Z')), '2026-12-31');
  assert.equal(
    nextUtcMidnight(new Date('2026-12-31T23:59:59.000Z')).toISOString(),
    '2027-01-01T00:00:00.000Z'
  );
});

test('first reservation creates the daily counter', async () => {
  const model = createFakeModel();
  const quota = createQuotaService({
    limit: 25,
    model,
    clock: () => new Date('2026-05-01T08:00:00.000Z'),
  });

  const result = await quota.reserve();

  assert.equal(result.allowed, true);
  assert.equal(result.count, 1);
  assert.equal(result.remaining, 24);
  assert.equal(result.dayKey, '2026-05-01');
  assert.equal(result.resetAt, '2026-05-02T00:00:00.000Z');
  assert.equal(model.docs.get('2026-05-01').count, 1);
});

test('25 reservations are accepted and the 26th is rejected', async () => {
  const model = createFakeModel();
  const quota = createQuotaService({
    limit: 25,
    model,
    clock: () => new Date('2026-05-01T08:00:00.000Z'),
  });

  for (let i = 1; i <= 25; i += 1) {
    const result = await quota.reserve();
    assert.equal(result.allowed, true, `reservation ${i}`);
    assert.equal(result.count, i);
  }

  const denied = await quota.reserve();
  assert.equal(denied.allowed, false);
  assert.equal(denied.limit, 25);
  assert.equal(model.docs.get('2026-05-01').count, 25);
});

test('concurrent reservations never exceed the limit', async () => {
  const model = createFakeModel();
  const quota = createQuotaService({
    limit: 25,
    model,
    clock: () => new Date('2026-05-01T08:00:00.000Z'),
  });

  const results = await Promise.all(Array.from({ length: 40 }, () => quota.reserve()));
  const accepted = results.filter((r) => r.allowed).length;

  assert.equal(accepted, 25);
  assert.equal(model.docs.get('2026-05-01').count, 25);
});

test('duplicate-key init race is retried and still enforced', async () => {
  const model = createFakeModel();
  model.docs.set('2026-05-01', { _id: '2026-05-01', count: 24, createdAt: new Date() });

  const quota = createQuotaService({
    limit: 25,
    model,
    clock: () => new Date('2026-05-01T08:00:00.000Z'),
  });

  // Simulate the loser of a first-request upsert race, then a normal retry.
  model.failNextWithDuplicate();
  const accepted = await quota.reserve();
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.count, 25);

  const denied = await quota.reserve();
  assert.equal(denied.allowed, false);
});

test('a full day followed by an upsert race fails closed without throwing', async () => {
  const model = createFakeModel();
  model.docs.set('2026-05-01', { _id: '2026-05-01', count: 25, createdAt: new Date() });

  const quota = createQuotaService({
    limit: 25,
    model,
    clock: () => new Date('2026-05-01T08:00:00.000Z'),
  });

  const denied = await quota.reserve();
  assert.equal(denied.allowed, false);
  assert.equal(denied.count, null);
});

test('release refunds only an existing reservation and never goes negative', async () => {
  const model = createFakeModel();
  const quota = createQuotaService({
    limit: 25,
    model,
    clock: () => new Date('2026-05-01T08:00:00.000Z'),
  });

  assert.equal(await quota.release('2026-05-01'), false);
  await quota.reserve();
  assert.equal(await quota.release('2026-05-01'), true);
  assert.equal(model.docs.get('2026-05-01').count, 0);
  assert.equal(await quota.release('2026-05-01'), false);
});

test('UTC rollover starts a fresh daily counter', async () => {
  const model = createFakeModel();
  let now = new Date('2026-05-01T23:59:00.000Z');
  const quota = createQuotaService({ limit: 25, model, clock: () => now });

  for (let i = 0; i < 25; i += 1) await quota.reserve();
  assert.equal((await quota.reserve()).allowed, false);

  now = new Date('2026-05-02T00:00:01.000Z');
  const nextDay = await quota.reserve();

  assert.equal(nextDay.allowed, true);
  assert.equal(nextDay.dayKey, '2026-05-02');
  assert.equal(nextDay.count, 1);
});

test('database failures reject so the route can fail closed', async () => {
  const model = createFakeModel();
  model.fail(new Error('connection lost'));

  const quota = createQuotaService({
    limit: 25,
    model,
    clock: () => new Date('2026-05-01T08:00:00.000Z'),
  });

  await assert.rejects(() => quota.reserve(), /connection lost/);
});

test('a configured limit of zero never accepts a start', async () => {
  const model = createFakeModel();
  const quota = createQuotaService({
    limit: 0,
    model,
    clock: () => new Date('2026-05-01T08:00:00.000Z'),
  });

  const result = await quota.reserve();
  assert.equal(result.allowed, false);
  assert.equal(model.docs.size, 0);
});
