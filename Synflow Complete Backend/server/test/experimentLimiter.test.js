'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createExperimentLimiter } = require('../services/experimentLimiter');

function harness(overrides = {}) {
  let now = 0;
  const limiter = createExperimentLimiter({
    cooldownWindowMs: 120000,
    cooldownMax: 1,
    hourlyWindowMs: 3600000,
    hourlyMax: 5,
    dailyWindowMs: 86400000,
    dailyMax: 10,
    clock: () => now,
    ...overrides,
  });
  return {
    limiter,
    advance(ms) {
      now += ms;
    },
  };
}

test('first start is allowed and immediately starts the cooldown', () => {
  const { limiter } = harness();
  assert.equal(limiter.evaluate('203.0.113.1').allowed, true);

  limiter.record('203.0.113.1');
  const decision = limiter.evaluate('203.0.113.1');

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'cooldown');
  assert.equal(decision.retryAfterSeconds, 120);
});

test('cooldown expires after two minutes', () => {
  const { limiter, advance } = harness();
  limiter.record('ip');
  advance(119999);
  assert.equal(limiter.evaluate('ip').allowed, false);

  advance(1);
  assert.equal(limiter.evaluate('ip').allowed, true);
});

test('sixth start inside one hour is rejected by the hourly window', () => {
  const { limiter, advance } = harness();
  limiter.record('ip');

  for (let i = 0; i < 4; i += 1) {
    advance(120001);
    assert.equal(limiter.evaluate('ip').allowed, true);
    limiter.record('ip');
  }

  // Five starts have happened at 0, 2, 4, 6 and 8 minutes.
  advance(120001);
  const decision = limiter.evaluate('ip');

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'hourly');
  assert.ok(decision.retryAfterSeconds > 0);
});

test('eleventh start inside 24 hours is rejected by the daily window', () => {
  const { limiter, advance } = harness({ hourlyMax: 100 });
  limiter.record('ip');

  for (let i = 0; i < 9; i += 1) {
    advance(120001);
    assert.equal(limiter.evaluate('ip').allowed, true);
    limiter.record('ip');
  }

  advance(120001);
  const decision = limiter.evaluate('ip');

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'daily');
});

test('a rejected cooldown does not consume hourly or daily allowance', () => {
  const { limiter, advance } = harness();
  assert.equal(limiter.evaluate('ip').allowed, true);
  limiter.record('ip');

  // Many rejected probes while the cooldown is active.
  for (let i = 0; i < 20; i += 1) {
    assert.equal(limiter.evaluate('ip').allowed, false);
  }

  advance(120000);
  const decision = limiter.evaluate('ip');

  assert.equal(decision.allowed, true);
  // One start was accepted; the cooldown allows one more now and the hourly
  // window still has room, so the limiting value is 1.
  assert.equal(decision.remaining, 1);
});

test('different IPs have independent allowances', () => {
  const { limiter } = harness();
  limiter.record('198.51.100.1');

  assert.equal(limiter.evaluate('198.51.100.1').allowed, false);
  assert.equal(limiter.evaluate('198.51.100.2').allowed, true);
});
