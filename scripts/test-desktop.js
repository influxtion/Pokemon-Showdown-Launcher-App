'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const live = process.argv.includes('--showdex-live');
for (const file of live ? ['showdex-live.cjs'] : ['desktop.cjs', 'replays-desktop.cjs', 'replay-import-desktop.cjs', 'settings-desktop.cjs']) {
  const result = spawnSync(require('electron'), [path.join(__dirname, '..', 'tests', file)], {
    stdio: 'inherit', env, timeout: live ? 180000 : 90000,
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) {
    process.exitCode = 1;
    break;
  }
}
