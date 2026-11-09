'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../config');
const { createRunner } = require('../services/runner');

const FIXTURES = path.join(__dirname, '..', 'test-fixtures');
const EXP_ID = '64b7f0c2a1b2c3d4e5f60718';

function makeConfig(timeoutMs = 5000) {
  const cfg = loadConfig({});
  cfg.experiments = { ...cfg.experiments, maxConcurrent: 1, timeoutMs };
  return cfg;
}

function makeModel() {
  const updates = [];
  return {
    updates,
    async findByIdAndUpdate(id, update) {
      updates.push({ id: String(id), update });
      return update;
    },
  };
}

function useFixture(t, fixture, { python } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synflow-runner-test-'));
  const previous = {
    RUNNER_PATH: process.env.RUNNER_PATH,
    RESULTS_DIR: process.env.RESULTS_DIR,
    PYTHON_CMD: process.env.PYTHON_CMD,
  };

  process.env.RUNNER_PATH = path.join(FIXTURES, fixture);
  process.env.RESULTS_DIR = path.join(root, 'Result');
  process.env.PYTHON_CMD = python || process.execPath;

  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, outputDir: path.join(root, 'Result', EXP_ID) };
}

function waitTerminal(runner, id, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runner.events.off(id, onEvent);
      reject(new Error('timed out waiting for a terminal event'));
    }, timeoutMs);

    function onEvent(event) {
      if (event.type === 'progress') return;
      clearTimeout(timer);
      runner.events.off(id, onEvent);
      resolve(event);
    }

    runner.events.on(id, onEvent);
  });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('concurrency slots are exclusive and reusable', () => {
  const runner = createRunner({ config: makeConfig(), ExperimentModel: makeModel() });

  const first = runner.tryAcquireSlot();
  assert.ok(first);
  assert.equal(runner.tryAcquireSlot(), null);

  runner.releaseSlot(first);
  assert.equal(runner.slotCount(), 0);
  assert.ok(runner.tryAcquireSlot());
});

test('a successful run persists all three controllers and releases its slot', async (t) => {
  const { outputDir } = useFixture(t, 'runner-success.js');
  const model = makeModel();
  const runner = createRunner({ config: makeConfig(), ExperimentModel: model });

  const slot = runner.tryAcquireSlot();
  const terminal = waitTerminal(runner, EXP_ID);
  const result = await runner.launch({ _id: EXP_ID }, { slotToken: slot });

  assert.equal(result.started, true);
  const event = await terminal;
  await settle();

  assert.equal(event.type, 'completed');
  assert.equal(runner.slotCount(), 0);

  const final = model.updates.at(-1);
  assert.equal(final.update.status, 'completed');
  assert.equal(final.update.seed, 123456);
  assert.deepEqual(Object.keys(final.update.results).sort(), ['fixed', 'nesy', 'nn']);
  assert.equal(final.update.results.nesy.controller, 'nesy');
  assert.equal(fs.existsSync(outputDir), false);
});

test('a manifest seed that escapes the scratch directory is rejected', async (t) => {
  const { outputDir } = useFixture(t, 'runner-bad-seed.js');
  const model = makeModel();
  const runner = createRunner({ config: makeConfig(), ExperimentModel: model });

  const slot = runner.tryAcquireSlot();
  const terminal = waitTerminal(runner, EXP_ID);
  const result = await runner.launch({ _id: EXP_ID }, { slotToken: slot });

  assert.equal(result.started, true);
  const event = await terminal;
  await settle();

  assert.equal(event.type, 'failed');
  assert.equal(event.error, 'Experiment result validation failed.');
  assert.equal(runner.slotCount(), 0);
  assert.equal(model.updates.at(-1).update.status, 'failed');
  assert.equal(fs.existsSync(outputDir), false);
});

test('a spawn failure rolls back the reservation and releases the slot', async (t) => {
  const { root } = useFixture(t, 'runner-success.js', {
    python: path.join(os.tmpdir(), 'synflow-missing-python.exe'),
  });
  const model = makeModel();
  const runner = createRunner({ config: makeConfig(), ExperimentModel: model });

  let rollbacks = 0;
  const slot = runner.tryAcquireSlot();
  const result = await runner.launch(
    { _id: EXP_ID },
    {
      slotToken: slot,
      onSpawnFailure: async () => {
        rollbacks += 1;
      },
    }
  );

  assert.equal(result.started, false);
  assert.equal(rollbacks, 1);
  assert.equal(runner.slotCount(), 0);
  assert.equal(model.updates.at(-1).update.status, 'failed');
  assert.equal(model.updates.at(-1).update.error, 'The simulation engine could not be started.');
  assert.equal(fs.existsSync(path.join(root, 'Result', EXP_ID)), false);
});

test('a non-zero exit marks the run failed and releases its slot', async (t) => {
  useFixture(t, 'runner-fail.js');
  const model = makeModel();
  const runner = createRunner({ config: makeConfig(), ExperimentModel: model });

  const slot = runner.tryAcquireSlot();
  const terminal = waitTerminal(runner, EXP_ID);
  const result = await runner.launch({ _id: EXP_ID }, { slotToken: slot });

  assert.equal(result.started, true);
  const event = await terminal;
  await settle();

  assert.equal(event.type, 'failed');
  assert.equal(event.error, 'The simulation engine stopped unexpectedly.');
  // Raw stderr is logged server-side only, never persisted for public reads.
  assert.equal(event.error.includes('synthetic engine failure'), false);
  assert.equal(runner.slotCount(), 0);
  assert.equal(model.updates.at(-1).update.status, 'failed');
});

test('the timeout kills the process tree and releases its slot', async (t) => {
  const { outputDir } = useFixture(t, 'runner-slow.js');
  const model = makeModel();
  const runner = createRunner({ config: makeConfig(300), ExperimentModel: model });

  const slot = runner.tryAcquireSlot();
  const terminal = waitTerminal(runner, EXP_ID);
  const result = await runner.launch({ _id: EXP_ID }, { slotToken: slot });

  assert.equal(result.started, true);
  const event = await terminal;
  await settle();

  assert.equal(event.type, 'failed');
  assert.match(event.error, /timed out/i);
  assert.equal(runner.slotCount(), 0);
  assert.equal(fs.existsSync(outputDir), false);
});

test('shutdown terminates an active run and frees the slot', async (t) => {
  useFixture(t, 'runner-slow.js');
  const model = makeModel();
  const runner = createRunner({ config: makeConfig(60000), ExperimentModel: model });

  const slot = runner.tryAcquireSlot();
  const terminal = waitTerminal(runner, EXP_ID);
  const result = await runner.launch({ _id: EXP_ID }, { slotToken: slot });
  assert.equal(result.started, true);

  await runner.shutdown({ waitMs: 5000 });
  await terminal;
  await settle();

  assert.equal(runner.slotCount(), 0);
  assert.equal(model.updates.at(-1).update.status, 'failed');
});
