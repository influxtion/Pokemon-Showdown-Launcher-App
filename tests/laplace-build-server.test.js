'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildServer } = require('../scripts/laplace/build-server.cjs');

test('server builder refuses paths inside the active runtime', () => {
  const active = path.resolve(__dirname, '../vendor/laplace/dist');
  assert.throws(() => buildServer(active), /outside the active Practice runtime/);
  assert.throws(() => buildServer(path.join(active, 'server')), /outside the active Practice runtime/);
});

test('server builder preserves an existing staging directory', t => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-server-stage-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const sentinel = path.join(target, 'existing.txt');
  fs.writeFileSync(sentinel, 'preserve');
  assert.throws(() => buildServer(target), /output already exists/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
});
