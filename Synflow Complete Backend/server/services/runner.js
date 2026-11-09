'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const Experiment = require('../models/Experiment');
const { config: defaultConfig } = require('../config');

const CONTROLLERS = ['fixed', 'nn', 'nesy'];
const MAX_ERROR_CHARS = 2000;
const MAX_PROGRESS_LINE_CHARS = 500;

function redact(value) {
  return String(value || '')
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, '[redacted-mongodb-uri]')
    .replace(/password=[^&\s"']+/gi, 'password=[redacted]');
}

function shortError(value) {
  return redact(value).trim().slice(0, MAX_ERROR_CHARS);
}

// Detailed diagnostics stay in server logs; the database (and therefore the
// public API) only stores a generic, safe failure reason.
function logDiagnostic(label, value) {
  console.error(label, shortError(value));
}

function killProcessTree(child) {
  if (!child || child.pid === undefined) return;

  if (process.platform === 'win32') {
    // SUMO is a grandchild of Node on Windows; taskkill /T removes the tree.
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
      killer.unref();
    } catch {
      // Best effort only.
    }
    return;
  }

  try {
    // The child is spawned as a process-group leader (`detached: true`), so a
    // negative PID terminates Python and every SUMO process it started.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function createRunner({
  config = defaultConfig,
  ExperimentModel = Experiment,
  events = new EventEmitter(),
  spawnFn = spawn,
  fsImpl = fs,
  clock = () => Date.now(),
} = {}) {
  events.setMaxListeners(100);

  const activeSlots = new Set();
  const activeChildren = new Map();
  let activeExperimentId = null;

  function tryAcquireSlot() {
    if (activeSlots.size >= config.experiments.maxConcurrent) return null;
    const token = Symbol('experiment-slot');
    activeSlots.add(token);
    return token;
  }

  function releaseSlot(token) {
    if (token) activeSlots.delete(token);
  }

  function slotCount() {
    return activeSlots.size;
  }

  async function persistTerminal(exp, status, data) {
    try {
      await ExperimentModel.findByIdAndUpdate(exp._id, {
        status,
        finishedAt: new Date(clock()),
        ...data,
      });
    } catch (err) {
      // Type only: never log stack traces, connection strings, or stderr.
      console.error('Failed to persist experiment status:', err && err.name ? err.name : 'Error');
    }

    events.emit(String(exp._id), {
      type: status,
      error: status === 'failed' && data ? data.error : undefined,
    });
  }

  function removeOutput(outputDir) {
    try {
      fsImpl.rmSync(outputDir, { recursive: true, force: true });
    } catch {
      // Ephemeral disk cleanup is best effort.
    }
  }

  function isInside(parent, candidate) {
    const rel = path.relative(parent, candidate);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  // Creates the experiment output directory and starts the trusted Python
  // runner with a fixed executable and argument array. Resolves only after the
  // child process has actually spawned (or failed to spawn).
  async function launch(exp, { slotToken = null, onSpawnFailure = null } = {}) {
    const id = String(exp._id);
    const runnerPath = process.env.RUNNER_PATH
      ? path.resolve(process.env.RUNNER_PATH)
      : path.resolve(__dirname, '../../engine/run_matched_experiment.py');
    const engineDir = path.dirname(runnerPath);
    const baseOutputDir = process.env.RESULTS_DIR
      ? path.resolve(process.env.RESULTS_DIR)
      : path.resolve(engineDir, '../Result');
    const outputDir = path.join(baseOutputDir, id);

    const rawPythonCmd = process.env.PYTHON_CMD || 'python';
    const pythonCmd = path.isAbsolute(rawPythonCmd)
      ? rawPythonCmd
      : path.resolve(engineDir, rawPythonCmd);

    const args = [runnerPath, '--output-dir', outputDir, '--runs', '1', '--quiet'];

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let timedOut = false;
    let settled = false;
    let timer = null;

    const childEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
    // The simulation engine needs no backend configuration or database
    // credentials. Remove them explicitly while keeping PATH/SUMO_HOME/HOME.
    const backendOnly = new Set([
      'MONGO_URI',
      'FRONTEND_ORIGIN',
      'TRUST_PROXY_HOPS',
      'PORT',
      'RUNNER_PATH',
      'RESULTS_DIR',
      'PYTHON_CMD',
      'API_RATE_LIMIT_MAX',
      'API_RATE_LIMIT_WINDOW_MS',
      'GLOBAL_DAILY_EXPERIMENT_LIMIT',
      'MAX_CONCURRENT_EXPERIMENTS',
      'EXPERIMENT_TIMEOUT_MS',
    ]);
    for (const key of Object.keys(childEnv)) {
      if (backendOnly.has(key) || key.startsWith('EXPERIMENT_IP_') || key.startsWith('SSE_')) {
        delete childEnv[key];
      }
    }

    let child;
    try {
      fsImpl.mkdirSync(outputDir, { recursive: true });
      child = spawnFn(pythonCmd, args, {
        cwd: engineDir,
        env: childEnv,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      logDiagnostic('Failed to start Python process:', err.message);
      removeOutput(outputDir);
      releaseSlot(slotToken);
      if (onSpawnFailure) {
        try {
          await onSpawnFailure();
        } catch {
          // Fail closed: the reservation remains if rollback itself fails.
        }
      }
      await persistTerminal(exp, 'failed', {
        error: 'The simulation engine could not be started.',
      });
      return { started: false };
    }

    activeChildren.set(id, child);

    const spawned = await new Promise((resolve) => {
      let done = false;
      child.once('spawn', () => {
        if (done) return;
        done = true;
        resolve({ ok: true });
      });
      child.once('error', (err) => {
        if (done) return;
        done = true;
        resolve({ ok: false, error: err });
      });
    });

    if (!spawned.ok) {
      activeChildren.delete(id);
      logDiagnostic('Failed to start Python process:', spawned.error.message);
      // A process that never spawned must not consume quota.
      if (onSpawnFailure) {
        try {
          await onSpawnFailure();
        } catch {
          // Fail closed.
        }
      }
      await persistTerminal(exp, 'failed', {
        error: 'The simulation engine could not be started.',
      });
      removeOutput(outputDir);
      releaseSlot(slotToken);
      return { started: false };
    }

    activeExperimentId = id;

    const finalize = async (status, data) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      try {
        await persistTerminal(exp, status, data);
      } finally {
        activeChildren.delete(id);
        if (activeExperimentId === id) activeExperimentId = null;
        removeOutput(outputDir);
        releaseSlot(slotToken);
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, config.experiments.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuffer = (stdoutBuffer + text).slice(-MAX_ERROR_CHARS * 4);
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim().slice(0, MAX_PROGRESS_LINE_CHARS);
        if (line) events.emit(id, { type: 'progress', message: line });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer = (stderrBuffer + chunk.toString()).slice(-MAX_ERROR_CHARS * 4);
    });

    // An error after a successful spawn (for example a kill failure) is still
    // a terminal condition for this experiment.
    child.on('error', (err) => {
      logDiagnostic('Simulation process error:', err.message);
      killProcessTree(child);
      finalize('failed', {
        error: 'The simulation engine stopped unexpectedly.',
      }).catch(() => {});
    });

    child.on('close', async (code) => {
      if (settled) return;

      try {
        if (timedOut) {
          await finalize('failed', { error: 'Experiment timed out and was stopped.' });
          return;
        }

        // A crashed Python process may leave SUMO children behind.
        if (code !== 0) killProcessTree(child);

        if (code !== 0) {
          const detail = stderrBuffer.trim() || stdoutBuffer.trim() || `exit code ${code}`;
          logDiagnostic('Simulation engine stopped unexpectedly:', detail);
          await finalize('failed', { error: 'The simulation engine stopped unexpectedly.' });
          return;
        }

        const manifestPath = path.join(outputDir, 'manifest.json');
        if (!fsImpl.existsSync(manifestPath)) {
          await finalize('failed', { error: 'Experiment finished without producing a manifest.' });
          return;
        }

        let manifest;
        try {
          manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
        } catch {
          await finalize('failed', { error: 'Experiment manifest could not be parsed.' });
          return;
        }

        const runInfo = manifest.results && manifest.results.run_001;
        if (!runInfo) {
          await finalize('failed', { error: 'Experiment manifest is missing run data.' });
          return;
        }

        // The manifest is trusted output, but a non-numeric seed would make
        // path.join escape the experiment scratch directory.
        const seed = runInfo.seed;
        const seedDir = Number.isSafeInteger(seed) && seed > 0
          ? path.resolve(outputDir, String(seed))
          : null;
        if (!seedDir || !isInside(outputDir, seedDir)) {
          await finalize('failed', { error: 'Experiment result validation failed.' });
          return;
        }

        const results = {};

        for (const controller of CONTROLLERS) {
          const candidate =
            typeof runInfo[controller] === 'string'
              ? path.resolve(runInfo[controller])
              : path.join(seedDir, `${controller}.json`);

          // The manifest is produced by our own Python code, but keep result
          // reads confined to this experiment's scratch directory anyway.
          const filePath = isInside(outputDir, candidate) ? candidate : path.join(seedDir, `${controller}.json`);

          if (!fsImpl.existsSync(filePath)) {
            console.error(`Missing controller result: ${controller}.json`);
            await finalize('failed', { error: 'Experiment result validation failed.' });
            return;
          }

          try {
            results[controller] = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
          } catch {
            console.error(`Invalid JSON in ${controller}.json`);
            await finalize('failed', { error: 'Experiment result validation failed.' });
            return;
          }
        }

        // Persist first; output cleanup happens in finalize() only afterwards.
        await finalize('completed', { seed, results });
      } catch (err) {
        console.error('Error processing experiment results:', err && err.name ? err.name : 'Error');
        await finalize('failed', { error: 'Error processing experiment results.' });
      }
    });

    return { started: true };
  }

  // Best-effort termination used by the HTTP shutdown handler.
  async function shutdown({ waitMs = 5000 } = {}) {
    const entries = Array.from(activeChildren.entries());
    if (entries.length === 0) return;

    for (const [, child] of entries) killProcessTree(child);

    await Promise.all(
      entries.map(
        ([, child]) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const wait = setTimeout(() => resolve(), waitMs);
            if (typeof wait.unref === 'function') wait.unref();
            child.once('close', () => {
              clearTimeout(wait);
              resolve();
            });
          })
      )
    );
  }

  return {
    events,
    tryAcquireSlot,
    releaseSlot,
    slotCount,
    launch,
    shutdown,
    activeExperimentId: () => activeExperimentId,
  };
}

const runner = createRunner();

module.exports = { createRunner, runner, ...runner };
