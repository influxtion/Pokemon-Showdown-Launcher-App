'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WindowState, DEFAULT_BOUNDS } = require('../app/window-state');

const DISPLAY = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-window-state-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('missing state returns safe default dimensions without a fixed position', (t) => {
  const state = new WindowState(fixture(t));
  assert.deepEqual(state.load(DISPLAY), DEFAULT_BOUNDS);
});

test('valid normal bounds and maximized state survive restart', (t) => {
  const dir = fixture(t);
  const original = new WindowState(dir);
  const saved = { bounds: { x: 140, y: 90, width: 1280, height: 800 }, maximized: true };
  assert.equal(original.save(saved), true);
  assert.deepEqual(new WindowState(dir).load(DISPLAY), { ...saved.bounds, maximized: true });

  const multiMonitor = [{ workArea: { x: -1600, y: 0, width: 1600, height: 900 } }, ...DISPLAY];
  const negative = { bounds: { x: -1500, y: 40, width: 1200, height: 700 }, maximized: false };
  assert.equal(original.save(negative), true);
  assert.deepEqual(new WindowState(dir).load(multiMonitor), { ...negative.bounds, maximized: false });
});

test('saved window on a disconnected display falls back to default placement', (t) => {
  const dir = fixture(t);
  const state = new WindowState(dir);
  assert.equal(state.save({ bounds: { x: -2500, y: 120, width: 1200, height: 700 }, maximized: false }), true);
  assert.deepEqual(state.load(DISPLAY), DEFAULT_BOUNDS);
});

test('saved position is rejected when the titlebar is not usefully reachable', (t) => {
  const dir = fixture(t);
  const state = new WindowState(dir);
  assert.equal(state.save({ bounds: { x: 1800, y: 1030, width: 1200, height: 700 }, maximized: false }), true);
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  assert.deepEqual(state.load(displays), DEFAULT_BOUNDS);
});

test('saved bounds shrink to a smaller workArea after display scaling changes', (t) => {
  const dir = fixture(t);
  const state = new WindowState(dir);
  assert.equal(state.save({ bounds: { x: -1000, y: 20, width: 1600, height: 900 }, maximized: false }), true);
  const smallerDisplay = [{ workArea: { x: -1200, y: 0, width: 1280, height: 720 } }];
  assert.deepEqual(state.load(smallerDisplay), {
    x: -1200, y: 0, width: 1280, height: 720, maximized: false,
  });
});

test('oversized persisted bounds are capped and moved fully into the chosen display', (t) => {
  const dir = fixture(t);
  const state = new WindowState(dir);
  assert.equal(state.save({ bounds: { x: 1800, y: 900, width: 20000, height: 20000 }, maximized: true }), true);
  const display = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  assert.deepEqual(state.load(display), {
    x: 0, y: 0, width: 1920, height: 1040, maximized: true,
  });
});

test('default dimensions fit the primary display when saved state is unavailable', (t) => {
  const state = new WindowState(fixture(t));
  const displays = [
    { workArea: { x: 0, y: 0, width: 1100, height: 650 } },
    { primary: true, workArea: { x: -1280, y: 0, width: 1280, height: 700 } },
  ];
  assert.deepEqual(state.load(displays), { width: 1280, height: 700 });
});

test('malformed bytes fall back safely and remain untouched', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'window-state.json');
  const malformed = '{unreadable bytes';
  fs.writeFileSync(file, malformed);
  assert.deepEqual(new WindowState(dir).load(DISPLAY), DEFAULT_BOUNDS);
  assert.equal(fs.readFileSync(file, 'utf8'), malformed);
});

test('invalid bounds are rejected and failed rename preserves the prior state', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'window-state.json');
  const state = new WindowState(dir);
  const prior = { bounds: { x: 20, y: 40, width: 1366, height: 768 }, maximized: false };
  assert.equal(state.save(prior), true);
  const priorBytes = fs.readFileSync(file, 'utf8');

  assert.equal(state.save({ bounds: { x: 1.5, y: 0, width: 1366, height: 768 }, maximized: false }), false);
  assert.equal(state.save({ bounds: { x: 0, y: 0, width: 20001, height: 768 }, maximized: false }), false);

  const failingFs = { ...fs, renameSync() { throw new Error('rename failed'); } };
  assert.equal(new WindowState(dir, failingFs).save({
    bounds: { x: 80, y: 90, width: 1400, height: 820 }, maximized: true,
  }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), priorBytes);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.tmp-')), false);
});
