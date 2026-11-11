'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const hosted of ['0', '1']) {
  for (const opponent of ['laplace', 'foulplay']) {
    console.log(`Testing ${opponent} (${hosted === '1' ? 'service' : 'local'})`);
    const env = { ...process.env, SHOWDOWN_DESKTOP_BACKGROUND: '1', BOT_TEST_OPPONENT: opponent, BOT_TEST_HOSTED: hosted };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [path.resolve(__dirname, '../../tests/practice-desktop.cjs')], {
      stdio: 'inherit', env, windowsHide: true, timeout: 300000,
    });
    if (result.status !== 0) { process.exitCode = 1; break; }
  }
  if (process.exitCode) break;
}
