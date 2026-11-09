'use strict';

const { hashIp } = require('./privacy');

// Tracks long-lived SSE responses. Per-IP keys are hashed so raw visitor IPs
// are never retained in memory beyond Express's request object.
function createSseRegistry({ maxPerIp, maxTotal }) {
  const clients = new Map(); // res -> { key }
  const perIp = new Map();
  let total = 0;

  function tryAdd(ip, res) {
    const key = hashIp(ip || 'unknown');
    const current = perIp.get(key) || 0;

    if (total >= maxTotal || current >= maxPerIp) return false;

    perIp.set(key, current + 1);
    clients.set(res, { key });
    total += 1;
    return true;
  }

  function remove(res) {
    const entry = clients.get(res);
    if (!entry) return false;

    clients.delete(res);
    total -= 1;

    const next = (perIp.get(entry.key) || 1) - 1;
    if (next <= 0) perIp.delete(entry.key);
    else perIp.set(entry.key, next);

    return true;
  }

  function closeAll() {
    for (const res of Array.from(clients.keys())) {
      try {
        res.end();
      } catch {
        // Client may already be gone.
      }
    }
    clients.clear();
    perIp.clear();
    total = 0;
  }

  function stats() {
    return { total, keys: perIp.size };
  }

  return { tryAdd, remove, closeAll, stats };
}

module.exports = { createSseRegistry };
