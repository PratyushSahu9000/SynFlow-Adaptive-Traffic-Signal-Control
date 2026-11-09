'use strict';

const ExperimentUsage = require('../models/ExperimentUsage');

// The quota document identifier is the UTC calendar day. `resetAt` is the
// next UTC midnight, computed dynamically so it is never stale.
function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function nextUtcMidnight(date = new Date()) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0)
  );
}

// Atomically reserves one experiment start for the current UTC day.
//
// The conditional update (`count < limit`) is part of the database operation,
// so two concurrent requests can never both observe "24" and both increment.
// The upsert handles the first request of the day; a duplicate-key race is
// retried once without upsert so only one document can ever exist per day.
function createQuotaService({
  limit,
  model = ExperimentUsage,
  clock = () => new Date(),
} = {}) {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('Quota limit must be a non-negative integer');
  }

  async function reserve() {
    const now = clock();
    const dayKey = utcDayKey(now);
    const resetAt = nextUtcMidnight(now).toISOString();
    const denied = { allowed: false, dayKey, limit, resetAt, count: null, remaining: 0 };

    if (limit <= 0) return denied;

    const projection = { count: 1 };

    try {
      const doc = await model.findOneAndUpdate(
        { _id: dayKey, count: { $lt: limit } },
        { $inc: { count: 1 }, $setOnInsert: { createdAt: now } },
        { upsert: true, new: true, projection }
      );
      if (doc) {
        return {
          allowed: true,
          dayKey,
          limit,
          resetAt,
          count: doc.count,
          remaining: Math.max(0, limit - doc.count),
        };
      }
      return denied;
    } catch (err) {
      // Concurrent first-requests of the day can race on the upsert. The
      // loser retries the conditional increment against the now-existing doc.
      if (!err || err.code !== 11000) throw err;

      const doc = await model.findOneAndUpdate(
        { _id: dayKey, count: { $lt: limit } },
        { $inc: { count: 1 } },
        { new: true, projection }
      );
      if (doc) {
        return {
          allowed: true,
          dayKey,
          limit,
          resetAt,
          count: doc.count,
          remaining: Math.max(0, limit - doc.count),
        };
      }
      return denied;
    }
  }

  // Used only when no Python process was ever started (for example spawn
  // failure). Failures after a real process starts must not refund quota.
  async function release(dayKey) {
    if (!dayKey) return false;
    const doc = await model.findOneAndUpdate(
      { _id: dayKey, count: { $gt: 0 } },
      { $inc: { count: -1 } },
      { new: false, projection: { count: 1 } }
    );
    return Boolean(doc);
  }

  async function usage() {
    const dayKey = utcDayKey(clock());
    const doc = await model.findById(dayKey).select('count').lean();
    return { dayKey, count: doc ? doc.count : 0, limit };
  }

  return { reserve, release, usage, dayKey: () => utcDayKey(clock()) };
}

module.exports = { createQuotaService, utcDayKey, nextUtcMidnight };
