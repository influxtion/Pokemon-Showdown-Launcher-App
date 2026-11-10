'use strict';

// Optional live guest smoke. It uses the real Showdown site and never starts a battle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { app, BrowserWindow, dialog, shell } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdex-live-guest-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  theme: 'system', startPage: 'showdown', confirmOnClose: true, showdexEnabled: true,
}));

assert.equal(app.isReady(), false, 'main must register the scheme before Electron is ready');
require('../app/main');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await pause(250);
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  shell.openExternal = async () => { throw new Error('Unexpected external browser launch'); };
  dialog.showMessageBox = async () => { throw new Error('Unexpected confirmation in isolated guest session'); };
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'launcher window', 30000);
  const renderer = win.webContents;
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('/play.html'), 'Showdown start page', 30000);
  const view = await until(() => win.contentView.children[0], 'Showdown WebContentsView', 30000);
  const client = view.webContents;
  await until(() => view.getVisible(), 'visible Showdown view', 30000);
  const desktop = (method) => renderer.executeJavaScript(`window.desktop.${method}`);
  const status = await until(async () => {
    const value = await desktop('getShowdex()');
    return value?.status === 'loaded' ? value : null;
  }, 'Showdex loaded in live client');
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  assert.equal(status.loaded, true);
  assert.equal(status.pendingReload, false);
  assert.equal(status.version, '1.4.2');
  const clientPrefs = client.getLastWebPreferences();
  assert.equal(clientPrefs.preload, undefined, 'client has no preload path');
  assert.equal(clientPrefs.nodeIntegration, false);
  assert.equal(clientPrefs.sandbox, true);
  assert.equal(await client.executeJavaScript('typeof window.desktop'), 'undefined', 'client has no launcher preload');
  assert.equal(await client.executeJavaScript('typeof window.require'), 'undefined', 'client has no Node');
  assert.equal(await client.executeJavaScript("Boolean(app.rooms['view-hellodex'] && document.querySelector('[data-showdex-module=hellodex]'))"), true);

  win.setSize(1366, 768);
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  const captures = path.join(__dirname, '..', 'out', 'desktop-smoke');
  fs.mkdirSync(captures, { recursive: true });
  for (const theme of ['light', 'dark']) {
    assert.equal((await desktop(`setSetting('theme', '${theme}')`)).ok, true);
    await until(() => client.executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`), `${theme} client theme`, 10000);
    await pause(300);
    const png = (await client.capturePage()).toPNG();
    assert.ok(png.length > 10000, `${theme} client capture`);
    fs.writeFileSync(path.join(captures, `showdex-live-${theme}.png`), png);
  }

  const clientId = client.id;
  const session = await desktop('getSession()');
  assert.equal(session.ready, true, 'client session readable before reload');
  assert.equal(session.search.pending, false);
  assert.equal(session.search.formats.length, 0);
  assert.equal(session.rooms.some((room) => room.battle && !room.ended && session.me && room.players.includes(session.me)), false);
  assert.equal((await desktop("setSetting('showdexEnabled', false)")).ok, true);
  const pending = await until(async () => {
    const value = await desktop('getShowdex()');
    return value?.pendingReload ? value : null;
  }, 'disable pending reload', 10000);
  assert.equal(pending.status, 'loaded');
  assert.equal(pending.enabled, false);
  assert.equal(pending.loaded, true);
  assert.equal(client.id, clientId, 'toggle keeps client alive');

  const reloaded = once(client, 'did-finish-load');
  assert.deepEqual(await desktop('reloadClient()'), { ok: true });
  await reloaded;
  const disabled = await until(async () => {
    const value = await desktop('getShowdex()');
    return value?.status === 'disabled' ? value : null;
  }, 'Showdex disabled after explicit reload', 30000);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.loaded, false);
  assert.equal(disabled.pendingReload, false);
  assert.equal(client.id, clientId, 'reload retains native client view');
  assert.equal(await client.executeJavaScript('typeof window.__SHOWDEX_INIT'), 'undefined');
  assert.equal(await client.executeJavaScript("Boolean(document.querySelector('[data-showdex-module=hellodex]'))"), false);

  console.log('PASS Showdex live guest smoke: loaded, native captures, pending reload, disabled');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
