const express = require('express');
const Experiment = require('../models/Experiment');
const compare = require('../services/compare');
const { startExperiment, events } = require('../services/runner');

const router = express.Router();

// Express 4 does not forward rejected async handlers to the error middleware.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Small per-IP limiter for experiment creation. A run is CPU-heavy, so a
// single client must not be able to queue many simulations in a row.
const WINDOW_MS = 60_000;
const MAX_STARTS = 3;
const starts = new Map();

function startLimiter(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';

  let record = starts.get(key);
  if (!record || now > record.resetAt) {
    record = { count: 0, resetAt: now + WINDOW_MS };
    starts.set(key, record);
  }

  record.count += 1;
  if (record.count > MAX_STARTS) {
    return res
      .status(429)
      .json({ error: 'Too many experiment requests. Try again shortly.' });
  }
  return next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of starts) {
    if (now > record.resetAt) starts.delete(key);
  }
}, WINDOW_MS).unref();

// Start a new experiment (new seed, same seed for Fixed, NN and NeSy).
router.post(
  '/',
  startLimiter,
  asyncHandler(async (_req, res) => {
    const exp = await startExperiment();
    res.status(201).json({ id: exp._id, seed: exp.seed, status: exp.status });
  })
);

// List experiments (without the heavy results).
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const list = await Experiment.find().select('-results').sort({ createdAt: -1 });
    res.json(list);
  })
);

// One experiment with all three controllers' results.
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const exp = await Experiment.findById(req.params.id);
    if (!exp) return res.status(404).json({ error: 'Experiment not found' });
    res.json(exp);
  })
);

// Comparison screen data.
router.get(
  '/:id/compare',
  asyncHandler(async (req, res) => {
    const exp = await Experiment.findById(req.params.id);
    if (!exp) return res.status(404).json({ error: 'Experiment not found' });
    if (exp.status !== 'completed') {
      return res.status(409).json({ error: `Experiment is ${exp.status}` });
    }
    res.json({ seed: exp.seed, metrics: compare(exp.results) });
  })
);

// Live progress (Server-Sent Events).
router.get(
  '/:id/stream',
  asyncHandler(async (req, res) => {
    const exp = await Experiment.findById(req.params.id).select('status error');
    if (!exp) return res.status(404).json({ error: 'Experiment not found' });

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const id = String(exp._id);
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    let closed = false;
    let heartbeat;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      events.off(id, onEvent);
    };
    const onEvent = (data) => {
      send(data);
      if (data.type !== 'progress') {
        cleanup();
        res.end();
      }
    };

    if (exp.status !== 'running') {
      send({ type: exp.status, error: exp.error });
      cleanup();
      return res.end();
    }

    heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15000);
    heartbeat.unref();

    events.on(id, onEvent);
    req.on('close', cleanup);
  })
);

module.exports = router;
