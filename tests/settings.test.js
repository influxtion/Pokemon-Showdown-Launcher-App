'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Settings, DEFAULTS } = require('../app/settings');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-settings-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function disk(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
}

test('defaults, validation and all settings persist across restarts', (t) => {
  const dir = fixture(t);
  const settings = new Settings(dir);
  assert.deepEqual(settings.snapshot(), DEFAULTS);
  assert.equal(settings.set('theme', 'purple'), false);
  assert.equal(settings.set('startPage', 'settings'), false);
  assert.equal(settings.set('confirmOnClose', 'false'), false);
  assert.equal(settings.set('unknown', undefined), false);
  assert.equal(settings.set('theme', undefined), false);
  assert.equal(settings.set('__proto__', {}), false);
  assert.deepEqual(settings.snapshot(), DEFAULTS);
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);

  assert.equal(settings.set('theme', 'dark'), true);
  assert.equal(settings.set('startPage', 'replays'), true);
  assert.equal(settings.set('confirmOnClose', false), true);
  assert.deepEqual(new Settings(dir).snapshot(), { theme: 'dark', startPage: 'replays', confirmOnClose: false });
  assert.deepEqual(disk(dir), { theme: 'dark', startPage: 'replays', confirmOnClose: false });
  const snapshot = settings.snapshot();
  snapshot.theme = 'light';
  assert.equal(settings.get('theme'), 'dark');
});

test('legacy theme-only settings gain new defaults and reset persists defaults', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"theme":"light"}');
  const settings = new Settings(dir);
  assert.deepEqual(settings.snapshot(), { theme: 'light', startPage: 'home', confirmOnClose: true });
  assert.deepEqual(settings.reset(), DEFAULTS);
  assert.deepEqual(disk(dir), DEFAULTS);
});

test('invalid settings are preserved before a new file is saved', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{broken');
  const settings = new Settings(dir);
  assert.deepEqual(settings.snapshot(), DEFAULTS);
  const backup = fs.readdirSync(dir).find((file) => file.startsWith('settings.json.corrupt-'));
  assert.ok(backup);
  settings.set('theme', 'light');
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), '{broken');
  assert.equal(disk(dir).theme, 'light');
});

test('unknown saved keys are treated as invalid and preserved', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"theme":"dark","unexpected":true}');
  const settings = new Settings(dir);
  assert.deepEqual(settings.snapshot(), DEFAULTS);
  assert.ok(fs.readdirSync(dir).some((file) => file.startsWith('settings.json.corrupt-')));
});

test('failed write or rename preserves previous settings on disk and in memory', (t) => {
  const dir = fixture(t);
  const initial = new Settings(dir);
  initial.set('theme', 'dark');
  for (const method of ['writeFileSync', 'renameSync']) {
    const fileSystem = { ...fs, [method]() { throw new Error(`failed ${method}`); } };
    const settings = new Settings(dir, fileSystem);
    assert.throws(() => settings.set('theme', 'light'), /failed/);
    assert.equal(settings.get('theme'), 'dark');
    assert.deepEqual(disk(dir), { theme: 'dark', startPage: 'home', confirmOnClose: true });
    assert.equal(fs.readdirSync(dir).some((file) => file.includes('.tmp-')), false);
  }
});

test('unreadable or unpreserved invalid settings cannot be overwritten', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{broken');
  const renameFails = { ...fs, renameSync() { throw new Error('failed rename'); } };
  const settings = new Settings(dir, renameFails);
  assert.match(settings.loadError, /could not be preserved/);
  assert.throws(() => settings.set('theme', 'dark'), /could not be preserved/);
  assert.throws(() => settings.reset(), /could not be preserved/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');

  const readFails = { ...fs, readFileSync() { const error = new Error('access denied'); error.code = 'EACCES'; throw error; } };
  const unreadable = new Settings(dir, readFails);
  assert.match(unreadable.loadError, /could not be read/);
  assert.throws(() => unreadable.set('theme', 'light'), /could not be read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
