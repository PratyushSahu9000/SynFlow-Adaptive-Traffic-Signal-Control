'use strict';

const fs = require('fs');
const path = require('path');

const outputIndex = process.argv.indexOf('--output-dir');
const outputDir = process.argv[outputIndex + 1];

if (!outputDir) {
  console.error('missing --output-dir');
  process.exit(2);
}

const seed = 123456;
const seedDir = path.join(outputDir, String(seed));
fs.mkdirSync(seedDir, { recursive: true });

fs.writeFileSync(
  path.join(outputDir, 'manifest.json'),
  JSON.stringify({ experiment_type: 'matched_three_controller', results: { run_001: { seed } } })
);

for (const controller of ['fixed', 'nn', 'nesy']) {
  fs.writeFileSync(
    path.join(seedDir, `${controller}.json`),
    JSON.stringify({ controller, total: { average_waiting_time: 10 } })
  );
}

console.log('synthetic progress from fixture');
