'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configureProfile } = require('../app/profile');

test('packaged profiles stay stable and explicit test/portable profiles remain isolated', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-profile-test-'));
  const saved = process.env.SHOWDOWN_DESKTOP_USER_DATA;
  t.after(() => {
    if (saved === undefined) delete process.env.SHOWDOWN_DESKTOP_USER_DATA;
    else process.env.SHOWDOWN_DESKTOP_USER_DATA = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });
  delete process.env.SHOWDOWN_DESKTOP_USER_DATA;
  let userData = path.join(root, 'Showdown Desktop');
  const app = { getName: () => 'Showdown Desktop', getPath: (key) => key === 'appData' ? root : userData,
    setPath: (_key, value) => { userData = value; } };
  assert.equal(configureProfile(app), path.join(root, 'showdown-desktop'));
  userData = path.join(root, 'test-isolated');
  assert.equal(configureProfile(app), userData);
  process.env.SHOWDOWN_DESKTOP_USER_DATA = path.join(root, 'portable');
  assert.equal(configureProfile(app), process.env.SHOWDOWN_DESKTOP_USER_DATA);
  assert.equal(fs.existsSync(userData), true);
  process.env.SHOWDOWN_DESKTOP_USER_DATA = 'relative-profile';
  assert.throws(() => configureProfile(app), /absolute directory/);
});
