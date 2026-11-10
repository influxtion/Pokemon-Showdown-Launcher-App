'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const dir of ['app', 'renderer', 'scripts', 'tests']) {
  for (const file of fs.readdirSync(path.join(__dirname, '..', dir))) {
    if (!/\.(?:js|cjs)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(__dirname, '..', dir, file)], { stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exit(1);
  }
}
