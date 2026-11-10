'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ShowdexIntegration, registerShowdexScheme, SHOWDEX_ENTRY_URL } = require('../app/showdex-integration');

const ORIGIN = 'https://play.pokemonshowdown.com';
const COMMIT = '165abdb05ad08c5b286f71e21cc1907852efd76f';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showdex-manager-test-'));
  const distDir = path.join(dir, 'dist');
  fs.mkdirSync(distDir);
  const bytes = Buffer.from('trusted Showdex test asset');
  fs.writeFileSync(path.join(distDir, 'main.js'), bytes);
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = {
    commit: COMMIT, version: '1.4.2', resourceProtocol: 'showdex', resourcePrefix: 'assets',
    assets: { 'main.js': crypto.createHash('sha256').update(bytes).digest('hex') },
  };
  const writeManifest = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  writeManifest();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, distDir, manifestFile, manifest, writeManifest, bytes };
}

test('registers a secure local scheme without bypassing the client CSP', () => {
  let schemes;
  registerShowdexScheme({ registerSchemesAsPrivileged(value) { schemes = value; } });
  assert.equal(SHOWDEX_ENTRY_URL, 'showdex://assets/main.js');
  assert.deepEqual(schemes, [{ scheme: 'showdex', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
  } }]);
});

test('checks every pinned asset before registering and rejects missing or changed bytes', async (t) => {
  const f = fixture(t);
  const manager = new ShowdexIntegration(f);
  assert.equal(manager.bundleInfo().installed, true);
  let handled = false;
  const session = { protocol: {
    async isProtocolHandled() { return false; },
    handle(scheme) { assert.equal(scheme, 'showdex'); handled = true; },
  } };
  assert.equal((await manager.registerAssets(session)).installed, true);
  assert.equal(handled, true);
  fs.writeFileSync(path.join(f.distDir, 'main.js'), 'changed');
  assert.equal(manager.bundleInfo().installed, false);
  assert.match(manager.bundleInfo().error, /mismatch/);
  assert.equal((await new ShowdexIntegration(f).registerAssets(session)).installed, false);
  fs.rmSync(path.join(f.distDir, 'main.js'));
  assert.equal(new ShowdexIntegration(f).bundleInfo().installed, false);
  fs.writeFileSync(path.join(f.distDir, 'main.js'), f.bytes);
  f.manifest.commit = 'wrong';
  f.writeManifest();
  assert.equal(new ShowdexIntegration(f).bundleInfo().installed, false);
});

test('serves exact verified assets only to the Showdown origin', async (t) => {
  const f = fixture(t);
  const manager = new ShowdexIntegration(f);
  let handler;
  await manager.registerAssets({ protocol: {
    async isProtocolHandled() { return false; },
    handle(_scheme, value) { handler = value; },
  } });
  const request = { method: 'GET', url: SHOWDEX_ENTRY_URL, initiatorOrigin: ORIGIN, referrer: '' };
  const response = handler(request);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(handler({ ...request, method: 'POST' }).status, 405);
  assert.equal(handler({ ...request, initiatorOrigin: 'https://example.com' }).status, 403);
  assert.equal(handler({ ...request, initiatorOrigin: undefined, referrer: 'https://example.com/' }).status, 403);
  assert.equal(handler({ ...request, url: 'showdex://other/main.js' }).status, 404);
  assert.equal(handler({ ...request, url: 'showdex://assets/other.js' }).status, 404);
  assert.equal(handler({ ...request, url: 'showdex://assets/main.js?cache=1' }).status, 404);
  fs.writeFileSync(path.join(f.distDir, 'main.js'), 'changed after startup');
  assert.equal(handler(request).status, 404, 'serve checks bytes again after startup');
});
