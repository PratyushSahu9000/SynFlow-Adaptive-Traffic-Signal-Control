'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateStartBody,
  validateExperimentId,
  isValidExperimentId,
} = require('../services/validation');

test('empty or absent bodies are accepted', () => {
  assert.equal(validateStartBody(undefined).ok, true);
  assert.equal(validateStartBody(null).ok, true);
  assert.equal(validateStartBody({}).ok, true);
});

test('client-controlled execution fields are rejected', () => {
  for (const body of [
    { seed: 42 },
    { runs: 100 },
    { script: '/tmp/evil.py' },
    { python: '/bin/sh' },
    { outputDir: 'C:\\Windows' },
    { sumocfg: 'x.sumocfg' },
    { nested: { arbitrary: true } },
  ]) {
    const result = validateStartBody(body);
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.error, 'Unexpected request fields');
  }
});

test('non-object bodies are rejected', () => {
  assert.equal(validateStartBody([]).ok, false);
  assert.equal(validateStartBody('seed=1').ok, false);
  assert.equal(validateStartBody(12).ok, false);
});

test('experiment ids must be 24 hexadecimal characters', () => {
  assert.equal(isValidExperimentId('64b7f0c2a1b2c3d4e5f60718'), true);
  assert.equal(validateExperimentId('64b7f0c2a1b2c3d4e5f60718').ok, true);

  assert.equal(isValidExperimentId('not-an-id'), false);
  assert.equal(isValidExperimentId('64b7f0c2a1b2c3d4e5f6071'), false);
  assert.equal(isValidExperimentId('64b7f0c2a1b2c3d4e5f60718x'), false);
  assert.equal(isValidExperimentId({ $ne: null }), false);
  assert.equal(validateExperimentId('../../etc/passwd').ok, false);
});
