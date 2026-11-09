'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');

const Experiment = require('../models/Experiment');
const compare = require('../services/compare');
const { config: defaultConfig } = require('../config');
const { createExperimentLimiter } = require('../services/experimentLimiter');
const { createQuotaService } = require('../services/quota');
const { createSseRegistry } = require('../services/sseRegistry');
const { validateStartBody, validateExperimentId } = require('../services/validation');
const { runner: defaultRunner } = require('../services/runner');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MESSAGES = {
  busy: 'Another SynFlow experiment is currently running. Please try again shortly.',
  rateLimited: 'Too many experiment requests. Please try again later.',
  quota: "Today's public experiment capacity has been reached. Please try again tomorrow.",
  unavailable: 'Experiments are temporarily unavailable. Please try again later.',
  sse: 'Too many concurrent progress streams. Close another SynFlow tab and try again.',
};

function secondsUntil(iso) {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return 60;
  return Math.max(1, Math.ceil((target - Date.now()) / 1000));
}

function createApiLimiter(cfg) {
  return rateLimit({
    windowMs: cfg.api.windowMs,
    limit: cfg.api.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler(req, res) {
      const reset = req.rateLimit && req.rateLimit.resetTime;
      const retryAfterSeconds = reset
        ? Math.max(1, Math.ceil((new Date(reset).getTime() - Date.now()) / 1000))
        : Math.max(1, Math.ceil(cfg.api.windowMs / 1000));
      res
        .status(429)
        .set('Retry-After', String(retryAfterSeconds))
        .json({ error: 'Too many requests. Please try again later.', retryAfterSeconds });
    },
  });
}

// Shared defaults for the running server. Exported so server shutdown can
// close active progress streams cleanly.
const defaultLimiter = createExperimentLimiter({
  cooldownWindowMs: defaultConfig.experiments.cooldownWindowMs,
  cooldownMax: defaultConfig.experiments.cooldownMax,
  hourlyWindowMs: defaultConfig.experiments.hourlyWindowMs,
  hourlyMax: defaultConfig.experiments.hourlyMax,
  dailyWindowMs: defaultConfig.experiments.dailyWindowMs,
  dailyMax: defaultConfig.experiments.dailyMax,
});
const defaultQuota = createQuotaService({ limit: defaultConfig.experiments.globalDailyLimit });
const defaultSse = createSseRegistry({
  maxPerIp: defaultConfig.sse.maxPerIp,
  maxTotal: defaultConfig.sse.maxTotal,
});

function createExperimentsRouter({
  config = defaultConfig,
  limiter = defaultLimiter,
  quota = defaultQuota,
  sse = defaultSse,
  runner = defaultRunner,
  ExperimentModel = Experiment,
  apiLimiter = createApiLimiter(config),
} = {}) {
  const router = express.Router();

  // express.json() only parses application/json. Reject any other non-empty
  // payload instead of silently ignoring it (a text/plain body must not look
  // like an empty start request).
  function requireJsonBody(req, res, next) {
    const hasBody =
      Number(req.headers['content-length'] || 0) > 0 ||
      Boolean(req.headers['transfer-encoding']);
    if (!hasBody) return next();

    const type = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (type !== 'application/json') {
      req.resume();
      return res.status(400).json({ error: 'Content-Type must be application/json' });
    }
    return next();
  }

  // Start a new matched experiment. Ordering is deliberate:
  //   validate -> acquire concurrency slot -> per-IP limits -> reserve global
  //   quota -> create document -> spawn Python -> record per-IP start.
  // Rejected lock/limit/quota requests never reach Python and never consume
  // the global quota.
  router.post(
    '/',
    requireJsonBody,
    asyncHandler(async (req, res) => {
      const validation = validateStartBody(req.body);
      if (!validation.ok) return res.status(400).json({ error: validation.error });

      const slotToken = runner.tryAcquireSlot();
      if (!slotToken) return res.status(409).json({ error: MESSAGES.busy });

      const decision = limiter.evaluate(req.ip);
      if (!decision.allowed) {
        runner.releaseSlot(slotToken);
        return res
          .status(429)
          .set('Retry-After', String(decision.retryAfterSeconds))
          .json({
            error: MESSAGES.rateLimited,
            retryAfterSeconds: decision.retryAfterSeconds,
          });
      }

      let reservation = null;
      const rollbackReservation = async () => {
        if (!reservation) return;
        const dayKey = reservation.dayKey;
        reservation = null;
        await quota.release(dayKey);
      };

      try {
        reservation = await quota.reserve();
      } catch (err) {
        runner.releaseSlot(slotToken);
        console.error('Global quota reservation failed:', err && err.name ? err.name : 'Error');
        return res.status(503).json({ error: MESSAGES.unavailable });
      }

      if (!reservation.allowed) {
        runner.releaseSlot(slotToken);
        return res
          .status(429)
          .set('Retry-After', String(secondsUntil(reservation.resetAt)))
          .json({
            error: MESSAGES.quota,
            limit: reservation.limit,
            resetAt: reservation.resetAt,
          });
      }

      let exp;
      try {
        exp = await ExperimentModel.create({});
      } catch (err) {
        await rollbackReservation().catch(() => {});
        runner.releaseSlot(slotToken);
        console.error('Experiment creation failed:', err && err.name ? err.name : 'Error');
        return res.status(503).json({ error: MESSAGES.unavailable });
      }

      let launch;
      try {
        launch = await runner.launch(exp, {
          slotToken,
          onSpawnFailure: rollbackReservation,
        });
      } catch (err) {
        await rollbackReservation().catch(() => {});
        runner.releaseSlot(slotToken);
        console.error('Experiment launch failed:', err && err.name ? err.name : 'Error');
        try {
          await ExperimentModel.findByIdAndUpdate(exp._id, {
            status: 'failed',
            error: 'Experiment could not be started.',
            finishedAt: new Date(),
          });
        } catch {
          // Best effort; never expose this to the client.
        }
        return res.status(503).json({ error: MESSAGES.unavailable });
      }

      if (!launch || !launch.started) {
        // The runner already released the slot and rolled the reservation back.
        return res.status(503).json({ error: MESSAGES.unavailable });
      }

      // Only an actually spawned simulation consumes this IP's allowance.
      limiter.record(req.ip);

      return res.status(201).json({ id: exp._id, seed: exp.seed, status: exp.status });
    })
  );

  // List experiments (without the heavy results).
  router.get(
    '/',
    apiLimiter,
    asyncHandler(async (_req, res) => {
      const list = await ExperimentModel.find().select('-results').sort({ createdAt: -1 });
      res.json(list);
    })
  );

  // One experiment with all three controllers' results.
  router.get(
    '/:id',
    apiLimiter,
    asyncHandler(async (req, res) => {
      const check = validateExperimentId(req.params.id);
      if (!check.ok) return res.status(400).json({ error: check.error });

      const exp = await ExperimentModel.findById(req.params.id);
      if (!exp) return res.status(404).json({ error: 'Experiment not found' });
      return res.json(exp);
    })
  );

  // Comparison screen data.
  router.get(
    '/:id/compare',
    apiLimiter,
    asyncHandler(async (req, res) => {
      const check = validateExperimentId(req.params.id);
      if (!check.ok) return res.status(400).json({ error: check.error });

      const exp = await ExperimentModel.findById(req.params.id);
      if (!exp) return res.status(404).json({ error: 'Experiment not found' });
      if (exp.status !== 'completed') {
        return res.status(409).json({ error: `Experiment is ${exp.status}` });
      }
      return res.json({ seed: exp.seed, metrics: compare(exp.results) });
    })
  );

  // Live progress (Server-Sent Events). Deliberately not covered by the
  // ordinary API limiter: these responses are long-lived, not request bursts.
  router.get(
    '/:id/stream',
    asyncHandler(async (req, res) => {
      const check = validateExperimentId(req.params.id);
      if (!check.ok) return res.status(400).json({ error: check.error });

      const exp = await ExperimentModel.findById(req.params.id).select('status error');
      if (!exp) return res.status(404).json({ error: 'Experiment not found' });

      if (!sse.tryAdd(req.ip, res)) {
        return res
          .status(429)
          .set('Retry-After', '10')
          .json({ error: MESSAGES.sse, retryAfterSeconds: 10 });
      }

      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      // Ask EventSource to reconnect after 5 seconds if the connection drops.
      res.write('retry: 5000\n\n');

      const id = String(exp._id);
      let closed = false;
      let heartbeat = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        runner.events.off(id, onEvent);
        sse.remove(res);
      };

      const send = (data) => {
        if (closed) return;
        // Drop progress frames for a stalled client instead of buffering
        // without bound. Terminal frames are always attempted.
        if (data.type === 'progress' && res.writableLength > 64 * 1024) return;
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const onEvent = (data) => {
        send(data);
        if (data.type !== 'progress') {
          cleanup();
          res.end();
        }
      };

      req.on('close', cleanup);
      res.on('close', cleanup);

      if (exp.status !== 'running') {
        send({ type: exp.status, error: exp.error });
        cleanup();
        return res.end();
      }

      heartbeat = setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, config.sse.heartbeatMs);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();

      runner.events.on(id, onEvent);
      return undefined;
    })
  );

  return router;
}

const router = createExperimentsRouter();

module.exports = router;
module.exports.createExperimentsRouter = createExperimentsRouter;
module.exports.MESSAGES = MESSAGES;
module.exports.sse = defaultSse;
module.exports.limiter = defaultLimiter;
module.exports.quota = defaultQuota;
