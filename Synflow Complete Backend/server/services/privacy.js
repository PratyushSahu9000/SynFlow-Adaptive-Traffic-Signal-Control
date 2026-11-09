'use strict';

const crypto = require('crypto');

// Per-process random key. IP addresses are only ever held in memory as
// keyed hashes; the raw values are never persisted or logged.
const salt = crypto.randomBytes(32);

function hashIp(ip) {
  return crypto.createHmac('sha256', salt).update(String(ip || 'unknown')).digest('hex');
}

module.exports = { hashIp };
