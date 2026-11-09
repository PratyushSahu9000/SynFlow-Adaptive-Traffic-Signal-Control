'use strict';

const OBJECT_ID = /^[a-f0-9]{24}$/i;

// Clients may not choose a seed, controller, script, path, run count, or any
// other execution parameter. An empty JSON object (or no body) is the only
// accepted start payload; anything else is rejected instead of ignored.
const ALLOWED_START_FIELDS = new Set();

function validateStartBody(body) {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request body' };
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_START_FIELDS.has(key)) {
      return { ok: false, error: 'Unexpected request fields' };
    }
  }

  return { ok: true, value: {} };
}

function isValidExperimentId(value) {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

function validateExperimentId(value) {
  if (!isValidExperimentId(value)) {
    return { ok: false, error: 'Invalid experiment id' };
  }
  return { ok: true, value };
}

module.exports = {
  validateStartBody,
  validateExperimentId,
  isValidExperimentId,
};
