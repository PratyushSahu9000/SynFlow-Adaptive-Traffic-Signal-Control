import test from 'node:test';
import assert from 'node:assert/strict';

import { describeStartError } from '../src/lib/startError.js';

test('409 reports another demonstration without exposing internals', () => {
  const notice = describeStartError({ status: 409, body: { error: 'raw server text' } });

  assert.match(notice.message, /another SynFlow demonstration is currently running/i);
  assert.equal(notice.detail, undefined);
  assert.equal(JSON.stringify(notice).includes('raw server text'), false);
});

test('429 per-IP cooldown uses the retry delay', () => {
  const notice = describeStartError({
    status: 429,
    retryAfterSeconds: 120,
    body: { error: 'Too many experiment requests. Please try again later.', retryAfterSeconds: 120 },
  });

  assert.match(notice.message, /start limit for now/i);
  assert.match(notice.detail, /2 minutes/);
});

test('429 global capacity shows the dynamic reset time', () => {
  const notice = describeStartError({
    status: 429,
    body: {
      error: 'Today\'s public experiment capacity has been reached. Please try again tomorrow.',
      limit: 25,
      resetAt: '2026-05-02T00:00:00.000Z',
    },
  });

  assert.equal(
    notice.message,
    "Today's public experiment capacity has been reached. Please come back tomorrow."
  );
  assert.match(notice.detail, /Capacity resets at/);
});

test('429 without timing details still gives a safe message', () => {
  const notice = describeStartError({ status: 429, body: {} });

  assert.match(notice.message, /start limit/i);
  assert.match(notice.detail, /try again later/i);
});

test('503 reports temporary unavailability without backend details', () => {
  const notice = describeStartError({
    status: 503,
    body: { error: 'mongodb connection string leaked?' },
  });

  assert.equal(notice.message, 'Experiments are temporarily unavailable. Please try again later.');
  assert.equal(JSON.stringify(notice).includes('mongodb'), false);
});

test('network failures are distinguished from server errors', () => {
  const notice = describeStartError({ status: 0 });
  assert.match(notice.message, /could not reach/i);
});

test('unknown failures never echo the backend error text', () => {
  const notice = describeStartError({
    status: 500,
    body: { error: 'stack trace and filesystem path' },
  });

  assert.equal(notice.message, 'Could not start the experiment. Please try again later.');
  assert.equal(JSON.stringify(notice).includes('stack trace'), false);
});
