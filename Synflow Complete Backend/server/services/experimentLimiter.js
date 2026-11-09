'use strict';

const { hashIp } = require('./privacy');

// Layered per-IP experiment limits.
//
// All three windows are evaluated before a start is recorded, so a request
// rejected by the cooldown does not silently consume an hourly or daily slot.
// The route calls `evaluate()` before reserving global capacity and
// `record()` only after the global quota reservation succeeds.
function createExperimentLimiter({
  cooldownWindowMs,
  cooldownMax,
  hourlyWindowMs,
  hourlyMax,
  dailyWindowMs,
  dailyMax,
  clock = () => Date.now(),
}) {
  const buckets = new Map();

  function bucketFor(ip) {
    const key = hashIp(ip || 'unknown');
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    return bucket;
  }

  function existingBucket(ip) {
    return buckets.get(hashIp(ip || 'unknown')) || [];
  }

  function prune(bucket, now) {
    const cutoff = now - dailyWindowMs;
    let drop = 0;
    while (drop < bucket.length && bucket[drop] <= cutoff) drop += 1;
    if (drop > 0) bucket.splice(0, drop);
  }

  function countSince(bucket, since) {
    let count = 0;
    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      if (bucket[i] <= since) break;
      count += 1;
    }
    return count;
  }

  function retrySeconds(bucket, windowMs, max, now) {
    if (max <= 0) return Math.max(1, Math.ceil(windowMs / 1000));

    const since = now - windowMs;
    let first = bucket.length;
    while (first > 0 && bucket[first - 1] > since) first -= 1;

    const inWindow = bucket.length - first;
    if (inWindow < max) return 0;

    // This timestamp must age out before another start is allowed.
    const mustExpire = bucket[first + (inWindow - max)];
    return Math.max(1, Math.ceil((mustExpire + windowMs - now) / 1000));
  }

  function evaluate(ip) {
    const now = clock();
    const bucket = existingBucket(ip);
    if (bucket.length > 0) prune(bucket, now);

    const windows = [
      ['cooldown', cooldownWindowMs, cooldownMax],
      ['hourly', hourlyWindowMs, hourlyMax],
      ['daily', dailyWindowMs, dailyMax],
    ];

    for (const [reason, windowMs, max] of windows) {
      if (max <= 0) {
        return {
          allowed: false,
          reason,
          limit: max,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
          resetSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
        };
      }

      if (countSince(bucket, now - windowMs) >= max) {
        const retryAfterSeconds = retrySeconds(bucket, windowMs, max, now);
        return {
          allowed: false,
          reason,
          limit: max,
          remaining: 0,
          retryAfterSeconds,
          resetSeconds: retryAfterSeconds,
        };
      }
    }

    const cooldownCount = countSince(bucket, now - cooldownWindowMs);
    const hourlyCount = countSince(bucket, now - hourlyWindowMs);
    const dailyCount = countSince(bucket, now - dailyWindowMs);

    return {
      allowed: true,
      reason: null,
      limit: hourlyMax,
      remaining: Math.max(
        0,
        Math.min(
          cooldownMax - cooldownCount,
          hourlyMax - hourlyCount,
          dailyMax - dailyCount
        )
      ),
      retryAfterSeconds: 0,
      resetSeconds: Math.max(1, Math.ceil(hourlyWindowMs / 1000)),
    };
  }

  function record(ip) {
    const now = clock();
    const bucket = bucketFor(ip);
    prune(bucket, now);
    bucket.push(now);
  }

  function purge() {
    const now = clock();
    for (const [key, bucket] of buckets) {
      prune(bucket, now);
      if (bucket.length === 0) buckets.delete(key);
    }
  }

  function reset() {
    buckets.clear();
  }

  function size() {
    return buckets.size;
  }

  return { evaluate, record, purge, reset, size };
}

module.exports = { createExperimentLimiter };
