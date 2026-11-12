'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
delete env.ELECTRON_RUN_AS_NODE;
const liveFile = process.argv.includes('--showdex-live') ? 'showdex-live.cjs'
  : process.argv.includes('--replay-review-live') ? 'replay-review-live.cjs'
    : process.argv.includes('--shell-live') ? 'shell-live.cjs'
      : process.argv.includes('--practice') ? 'practice-desktop.cjs' : null;
for (const file of liveFile ? [liveFile] : ['desktop.cjs', 'replays-desktop.cjs', 'replay-import-desktop.cjs', 'replay-review-desktop.cjs', 'settings-desktop.cjs']) {
  const result = spawnSync(require('electron'), [path.join(__dirname, '..', 'tests', file)], {
    stdio: 'inherit', env, timeout: liveFile === 'practice-desktop.cjs' ? 300000 : liveFile ? 180000 : 90000,
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) {
    process.exitCode = 1;
    break;
  }
}
