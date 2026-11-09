'use strict';

const fs = require('fs');
const path = require('path');

const outputIndex = process.argv.indexOf('--output-dir');
const outputDir = process.argv[outputIndex + 1];

// Simulate a compromised or corrupted engine manifest whose seed tries to
// escape the per-experiment scratch directory.
const seed = '../escaped';
const escaped = path.resolve(outputDir, seed);
fs.mkdirSync(escaped, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, 'manifest.json'),
  JSON.stringify({ experiment_type: 'matched_three_controller', results: { run_001: { seed } } })
);

for (const controller of ['fixed', 'nn', 'nesy']) {
  fs.writeFileSync(
    path.join(escaped, `${controller}.json`),
    JSON.stringify({ controller, total: { average_waiting_time: 1 } })
  );
}

process.exit(0);
