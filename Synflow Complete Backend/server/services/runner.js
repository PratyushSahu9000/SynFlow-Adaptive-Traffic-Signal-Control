const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Experiment = require('../models/Experiment');

const events = new EventEmitter(); // one channel per experiment id, used by SSE
const CONTROLLERS = ['fixed', 'nn', 'nesy'];

// Creates the experiment, starts the Python matched experiment runner, returns right away.
// Notice: Python is the single source of truth for seed generation.
async function startExperiment() {
  const exp = await Experiment.create({});
  run(exp).catch(() => {});
  return exp;
}

async function run(exp) {
  const id = String(exp._id);
  // Default to run_matched_experiment_three.py in ../engine if RUNNER_PATH not provided
  const defaultRunner = path.resolve(__dirname, '../../engine/run_matched_experiment_three.py');
  const runnerPath = process.env.RUNNER_PATH ? path.resolve(process.env.RUNNER_PATH) : defaultRunner;

  // Working directory is the engine directory where run_matched_experiment_three.py lives
  const projectRoot = path.dirname(runnerPath);

  // Output directory for results. Python creates baseOutputDir/{seed}/
  // containing fixed.json, nn.json, nesy.json and writes manifest.json
  // to baseOutputDir/.
  const baseOutputDir = process.env.RESULTS_DIR
    ? path.resolve(process.env.RESULTS_DIR)
    : path.resolve(projectRoot, '../Result');

  fs.mkdirSync(baseOutputDir, { recursive: true });

  // Invoke run_matched_experiment_three.py:
  // - No seed arguments passed: Python generates the seed internally.
  // - Pass --output-dir so results go to baseOutputDir; Python creates
  //   baseOutputDir/{seed}/ with the three controller output files.
  const rawPythonCmd = process.env.PYTHON_CMD || 'python';
  const pythonCmd = path.isAbsolute(rawPythonCmd) ? rawPythonCmd : path.resolve(projectRoot, rawPythonCmd);
  const args = [
    runnerPath,
    '--output-dir', baseOutputDir,
    '--runs', '1',
  ];

  const child = spawn(pythonCmd, args, { cwd: projectRoot });

  let stdoutBuffer = '';
  let stderrBuffer = '';

  child.stdout.on('data', (d) => {
    const text = d.toString();
    stdoutBuffer += text;
    events.emit(id, { type: 'progress', message: text.trim() });
  });

  child.stderr.on('data', (d) => {
    const text = d.toString();
    stderrBuffer += text;
  });

  child.on('error', (err) => finish(exp, 'failed', { error: `Failed to spawn Python process: ${err.message}` }));

  child.on('close', async (code) => {
    if (code !== 0) {
      const errorMsg = stderrBuffer.trim() || stdoutBuffer.trim() || `Python process exited with code ${code}`;
      return finish(exp, 'failed', { error: errorMsg });
    }

    try {
      // 1. Locate manifest.json to extract run metadata and the Python-generated seed
      const manifestPath = path.join(baseOutputDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return finish(exp, 'failed', { error: `Manifest file not found at: ${manifestPath}` });
      }

      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (parseErr) {
        return finish(exp, 'failed', { error: `Invalid JSON in manifest: ${parseErr.message}` });
      }

      // Check results for run_001
      const runInfo = manifest.results && manifest.results['run_001'];
      const seed = runInfo ? runInfo.seed : undefined;
      const seedDir = path.join(baseOutputDir, String(seed));

      // 2. Read and validate fixed.json, nn.json, nesy.json
      const results = {};
      for (const c of CONTROLLERS) {
        const filePath = (runInfo && runInfo[c]) ? path.resolve(runInfo[c]) : path.join(seedDir, `${c}.json`);
        if (!fs.existsSync(filePath)) {
          return finish(exp, 'failed', { error: `Expected controller result file missing: ${filePath}` });
        }

        const rawData = fs.readFileSync(filePath, 'utf8');
        try {
          results[c] = JSON.parse(rawData);
        } catch (jsonErr) {
          return finish(exp, 'failed', { error: `Invalid JSON in ${c}.json: ${jsonErr.message}` });
        }
      }

      // 3. Mark completed with Python-generated seed and results
      await finish(exp, 'completed', { seed, results });
    } catch (err) {
      await finish(exp, 'failed', { error: `Error processing experiment results: ${err.message}` });
    }
  });
}

async function finish(exp, status, data) {
  await Experiment.findByIdAndUpdate(exp._id, { status, finishedAt: new Date(), ...data });
  events.emit(String(exp._id), { type: status, error: data ? data.error : undefined });
}

module.exports = { startExperiment, events };
