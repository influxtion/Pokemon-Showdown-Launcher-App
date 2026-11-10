'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Settings } = require('../app/settings');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-settings-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('settings default, validate values and persist across restarts', (t) => {
  const dir = fixture(t);
  const settings = new Settings(dir);
  assert.equal(settings.get('theme'), 'system');
  assert.equal(settings.set('theme', 'purple'), false);
  assert.equal(settings.set('theme', 'dark'), true);
  assert.equal(new Settings(dir).get('theme'), 'dark');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { theme: 'dark' });
});

test('corrupt settings are preserved before a new file is saved', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{broken');
  const settings = new Settings(dir);
  assert.equal(settings.get('theme'), 'system');
  const backup = fs.readdirSync(dir).find((file) => file.startsWith('settings.json.corrupt-'));
  assert.ok(backup);
  settings.set('theme', 'light');
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), '{broken');
});

test('failed temporary write preserves the previous settings on disk and in memory', (t) => {
  const dir = fixture(t);
  const settings = new Settings(dir);
  settings.set('theme', 'dark');
  fs.mkdirSync(path.join(dir, 'settings.json.tmp'));
  assert.throws(() => settings.set('theme', 'light'));
  assert.equal(settings.get('theme'), 'dark');
  assert.equal(new Settings(dir).get('theme'), 'dark');
});
