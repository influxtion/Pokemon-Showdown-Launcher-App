'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Logger } = require('../app/logging');

test('logs accept fixed event labels and integer codes, rotate and tolerate IO failure', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-log-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = new Logger(dir);
  log.write('client-load-failed', -105);
  log.write('https://private.example/secret', 'username');
  log.write('client-reloaded', 'private-token');
  const content = fs.readFileSync(log.file, 'utf8');
  assert.match(content, /client-load-failed -105/);
  assert.doesNotMatch(content, /private|username|secret/);
  fs.writeFileSync(log.file, 'x'.repeat(1024 * 1024 + 1));
  log.write('app-started');
  assert.ok(fs.existsSync(path.join(log.dir, 'desktop.previous.log')));
  assert.ok(fs.statSync(log.file).size < 1000);
  log.file = dir;
  assert.doesNotThrow(() => log.write('app-started'));
});
