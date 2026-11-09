'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const ExperimentUsage = require('../models/ExperimentUsage');
const { createQuotaService } = require('../services/quota');

// Real MongoDB integration tests. Run with a disposable database, e.g.:
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/synflow_quota_test npm test
const uri = process.env.TEST_MONGO_URI;

test('MongoDB-backed daily quota is atomic and persistent', { skip: !uri }, async (t) => {
  mongoose.set('bufferCommands', false);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  await ExperimentUsage.deleteMany({});
  await ExperimentUsage.deleteMany({ _id: { $in: ['2099-12-31', '2100-01-01'] } });

  const clock = () => new Date('2026-05-01T08:00:00.000Z');

  await t.test('25 accepted, 26th rejected, count persisted', async () => {
    const quota = createQuotaService({ limit: 25, model: ExperimentUsage, clock });

    for (let i = 1; i <= 25; i += 1) {
      const result = await quota.reserve();
      assert.equal(result.allowed, true, `reservation ${i}`);
    }

    const denied = await quota.reserve();
    assert.equal(denied.allowed, false);

    const doc = await ExperimentUsage.findById('2026-05-01').lean();
    assert.equal(doc.count, 25);
  });

  await t.test('a new service instance keeps the persisted count', async () => {
    const restarted = createQuotaService({ limit: 25, model: ExperimentUsage, clock });
    const denied = await restarted.reserve();
    assert.equal(denied.allowed, false);
  });

  await t.test('40 parallel reservations cannot exceed 25', async () => {
    await ExperimentUsage.deleteMany({ _id: '2026-05-01' });
    const quota = createQuotaService({ limit: 25, model: ExperimentUsage, clock });

    const results = await Promise.all(Array.from({ length: 40 }, () => quota.reserve()));
    const accepted = results.filter((result) => result.allowed).length;

    assert.equal(accepted, 25);
    const doc = await ExperimentUsage.findById('2026-05-01').lean();
    assert.equal(doc.count, 25);
  });

  await t.test('release refunds a reservation but never below zero', async () => {
    await ExperimentUsage.deleteMany({ _id: '2026-05-01' });
    const quota = createQuotaService({ limit: 25, model: ExperimentUsage, clock });

    await quota.reserve();
    assert.equal(await quota.release('2026-05-01'), true);
    assert.equal(await quota.release('2026-05-01'), false);
    const doc = await ExperimentUsage.findById('2026-05-01').lean();
    assert.equal(doc.count, 0);
  });

  await t.test('UTC rollover creates a new counter', async () => {
    let now = new Date('2099-12-31T23:59:00.000Z');
    const quota = createQuotaService({ limit: 2, model: ExperimentUsage, clock: () => now });

    assert.equal((await quota.reserve()).allowed, true);
    assert.equal((await quota.reserve()).allowed, true);
    assert.equal((await quota.reserve()).allowed, false);

    now = new Date('2100-01-01T00:00:01.000Z');
    const next = await quota.reserve();
    assert.equal(next.allowed, true);
    assert.equal(next.dayKey, '2100-01-01');
  });

  await t.test('a closed connection rejects instead of bypassing the quota', async () => {
    await ExperimentUsage.deleteMany({});
    await ExperimentUsage.deleteMany({ _id: { $in: ['2099-12-31', '2100-01-01'] } });
    await mongoose.connection.close();

    const quota = createQuotaService({ limit: 25, model: ExperimentUsage, clock });
    await assert.rejects(() => quota.reserve());
  });
});
