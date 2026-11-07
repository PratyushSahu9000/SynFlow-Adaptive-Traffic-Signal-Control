const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Experiment = require('../models/Experiment');

const events = new EventEmitter();
events.setMaxListeners(50);
const CONTROLLERS = ['fixed', 'nn', 'nesy'];

// Hard limit so a stuck simulation cannot occupy the instance forever.
const MAX_RUNTIME_MS = 20 * 60 * 1000;
const MAX_ERROR_CHARS = 2000;

// Only one simulation at a time: each run spawns three SUMO controllers.
let activeExperimentId = null;

function redact(value) {
  return String(value || '')
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, '[redacted-mongodb-uri]')
    .replace(/password=[^&\s"']+/gi, 'password=[redacted]');
}

function shortError(value) {
  return redact(value).trim().slice(0, MAX_ERROR_CHARS);
}

// Creates the experiment and starts the Python matched runner.
// Python remains the single source of truth for the shared seed.
async function startExperiment() {
  if (activeExperimentId) {
    const err = new Error('An experiment is already running. Wait for it to finish.');
    err.status = 409;
    throw err;
  }

  // Reserve synchronously before awaiting, so concurrent requests cannot race.
  activeExperimentId = 'pending';

  let exp;
  try {
    exp = await Experiment.create({});
  } catch (err) {
    activeExperimentId = null;
    throw err;
  }

  activeExperimentId = String(exp._id);
  run(exp).catch((err) => {
    console.error('Experiment runner crashed:', err && err.name ? err.name : 'Error');
    finish(exp, 'failed', { error: 'Experiment runner crashed' }).finally(() => {
      activeExperimentId = null;
    });
  });

  return exp;
}

async function run(exp) {
  const id = String(exp._id);
  const runnerPath = process.env.RUNNER_PATH
    ? path.resolve(process.env.RUNNER_PATH)
    : path.resolve(__dirname, '../../engine/run_matched_experiment.py');
  const engineDir = path.dirname(runnerPath);

  const baseOutputDir = process.env.RESULTS_DIR
    ? path.resolve(process.env.RESULTS_DIR)
    : path.resolve(engineDir, '../Result');

  // Unique directory per experiment: concurrent runs can never overwrite
  // each other's manifest.json / fixed.json / nn.json / nesy.json.
  const outputDir = path.join(baseOutputDir, id);
  fs.mkdirSync(outputDir, { recursive: true });

  const rawPythonCmd = process.env.PYTHON_CMD || 'python';
  const pythonCmd = path.isAbsolute(rawPythonCmd)
    ? rawPythonCmd
    : path.resolve(engineDir, rawPythonCmd);

  const args = [runnerPath, '--output-dir', outputDir, '--runs', '1', '--quiet'];

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let timedOut = false;
  let settled = false;

  // The Python engine never needs database credentials: do not leak them
  // into the child process environment.
  const childEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
  delete childEnv.MONGO_URI;

  const child = spawn(pythonCmd, args, {
    cwd: engineDir,
    env: childEnv,
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, MAX_RUNTIME_MS);
  timer.unref();

  child.stdout.on('data', (d) => {
    const text = d.toString();
    stdoutBuffer = (stdoutBuffer + text).slice(-MAX_ERROR_CHARS * 4);
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => events.emit(id, { type: 'progress', message: line }));
  });

  child.stderr.on('data', (d) => {
    stderrBuffer = (stderrBuffer + d.toString()).slice(-MAX_ERROR_CHARS * 4);
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    if (settled) return;
    settled = true;
    finish(exp, 'failed', {
      error: shortError(`Failed to start Python process: ${err.message}`),
    }).finally(() => {
      activeExperimentId = null;
    });
  });

  child.on('close', async (code) => {
    clearTimeout(timer);
    if (settled) return;
    settled = true;

    try {
      if (timedOut) {
        return await finish(exp, 'failed', {
          error: 'Experiment timed out and was stopped.',
        });
      }

      if (code !== 0) {
        const detail = stderrBuffer.trim() || stdoutBuffer.trim() || `exit code ${code}`;
        return await finish(exp, 'failed', { error: shortError(detail) });
      }

      const manifestPath = path.join(outputDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return await finish(exp, 'failed', {
          error: 'Experiment finished without producing a manifest.',
        });
      }

      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (parseErr) {
        return await finish(exp, 'failed', {
          error: 'Experiment manifest could not be parsed.',
        });
      }

      const runInfo = manifest.results && manifest.results.run_001;
      const seed = runInfo ? runInfo.seed : undefined;
      const seedDir = path.join(outputDir, String(seed));

      const results = {};
      for (const controller of CONTROLLERS) {
        const filePath =
          runInfo && runInfo[controller]
            ? path.resolve(runInfo[controller])
            : path.join(seedDir, `${controller}.json`);

        if (!fs.existsSync(filePath)) {
          console.error(`Missing controller result: ${controller}.json`);
          return await finish(exp, 'failed', {
            error: 'Experiment result validation failed.',
          });
        }

        try {
          results[controller] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (jsonErr) {
          console.error(`Invalid JSON in ${controller}.json`);
          return await finish(exp, 'failed', {
            error: 'Experiment result validation failed.',
          });
        }
      }

      await finish(exp, 'completed', { seed, results });

      // Results are persisted in MongoDB; the per-run scratch directory is
      // no longer needed and must not accumulate on Render's ephemeral disk.
      fs.rmSync(outputDir, { recursive: true, force: true });
      return undefined;
    } catch (err) {
      console.error('Error processing experiment results:', err && err.name ? err.name : 'Error');
      return await finish(exp, 'failed', {
        error: 'Error processing experiment results.',
      });
    } finally {
      activeExperimentId = null;
    }
  });
}

async function finish(exp, status, data) {
  try {
    await Experiment.findByIdAndUpdate(exp._id, {
      status,
      finishedAt: new Date(),
      ...data,
    });
  } catch (err) {
    // Persisting the terminal state failed (for example the database is
    // unreachable). Log the error type only and still notify SSE clients.
    console.error('Failed to persist experiment status:', err && err.name ? err.name : 'Error');
  }
  events.emit(String(exp._id), {
    type: status,
    error: data && status === 'failed' ? data.error : undefined,
  });
}

module.exports = { startExperiment, events };
