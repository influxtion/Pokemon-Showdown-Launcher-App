'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';

// Settings smoke test. All Electron storage stays inside a disposable profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-settings-desktop-'));
const rendererDir = path.join(__dirname, '..', 'renderer');
const fixtureFile = path.join(profile, 'showdown-fixture.html');
const settingsFile = path.join(profile, 'settings.json');
const replayFile = path.join(profile, 'replays.json');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'system', startPage: 'replays', confirmOnClose: true, showdexEnabled: false }));
fs.writeFileSync(fixtureFile, `<!doctype html><html><body><script>
window.app = {
  rooms: { '': { searching: false, $: () => ({ length: 0 }) } },
  user: { get: key => key === 'name' ? 'Tester' : '' },
  curRoom: { id: '' }, updateLayout() {}, isDisconnected: false, popups: []
};
</script></body></html>`);
app.setPath('userData', profile);

async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await check()) return; } catch {}
    await pause(80);
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  const clientSession = session.fromPartition('persist:showdown');
  clientSession.protocol.handle('https', (request) => {
    if (new URL(request.url).hostname === 'play.pokemonshowdown.com') {
      return new Response(fs.readFileSync(fixtureFile), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('', { status: 404 });
  });
  const dialogs = [];
  const responses = new Map();
  const openedPaths = [];
  dialog.showMessageBox = async (_window, options) => {
    dialogs.push(options);
    return { response: responses.get(options.title) ?? 0, checkboxChecked: false };
  };
  shell.openPath = async (folder) => { openedPaths.push(folder); return ''; };
  shell.openExternal = async () => { throw new Error('Unexpected external open'); };

  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length === 1, 'launcher window');
  const win = BrowserWindow.getAllWindows()[0];
  const renderer = win.webContents;
  const run = (code) => renderer.executeJavaScript(code);
  const load = async (page) => {
    await win.loadFile(path.join(rendererDir, page));
    await until(() => !renderer.isLoading() && renderer.getURL().endsWith(page), page);
  };
  const client = () => win.contentView.children[0].webContents;
  const loadFixture = async () => {
    await client().loadURL('https://play.pokemonshowdown.com/');
    await until(() => !client().isLoading() && client().getURL() === 'https://play.pokemonshowdown.com/', 'client fixture');
  };
  const result = (expression) => run(`window.desktop.${expression}`);
  const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const noteCount = async () => (await result('getReplayNotes()')).notes.length;
  const note = { title: 'Settings test note', url: 'https://replay.pokemonshowdown.com/gen9ou-123456789', format: 'gen9ou', notes: 'Keep me.' };

  // The file written before app startup selects the first page.
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('replays.html'), 'configured start page');
  await loadFixture();
  assert.equal(await client().executeJavaScript('typeof window.desktop'), 'undefined');
  assert.equal((await result('getSettings()')).settings.startPage, 'replays');

  await load('settings.html');
  await until(() => run("document.getElementById('start-page').value === 'replays'"), 'Settings loaded');
  assert.equal(await run("document.getElementById('confirm-on-close').checked"), true);
  for (const id of ['theme', 'start-page', 'confirm-on-close', 'reload-client', 'open-logs', 'sign-out', 'reset-launcher', 'showdex-enabled', 'showdex-status', 'showdex-reload-banner', 'showdex-reload']) {
    assert.equal(await run(`Boolean(document.getElementById(${JSON.stringify(id)}))`), true, `${id} control`);
  }
  await run("document.getElementById('start-page').value = 'home'; document.getElementById('start-page').dispatchEvent(new Event('change', {bubbles:true}))");
  await until(() => readSettings().startPage === 'home', 'start page saved');
  await run("document.getElementById('confirm-on-close').click()");
  await until(() => readSettings().confirmOnClose === false, 'close setting saved');
  await run("document.getElementById('theme').value = 'dark'; document.getElementById('theme').dispatchEvent(new Event('change', {bubbles:true}))");
  await until(() => readSettings().theme === 'dark', 'appearance saved');
  renderer.reload();
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('settings.html'), 'settings reload');
  await until(() => run("document.getElementById('theme').value === 'dark'"), 'settings restored');
  assert.equal(await run("document.getElementById('confirm-on-close').checked"), false);
  assert.equal(await run("document.getElementById('start-page').value"), 'home');
  assert.deepEqual((await result('getSettings()')).settings, readSettings());
  assert.equal((await result("setSetting('unknown', true)")).ok, false);
  assert.equal((await result("setSetting('showdexEnabled', 'true')")).ok, false);
  const actualShowdex = await result('getShowdex()');
  assert.equal(typeof actualShowdex.installed, 'boolean');
  assert.equal(actualShowdex.enabled, false);
  assert.equal(actualShowdex.loaded, false);

  await run("document.getElementById('open-logs').click()");
  await until(() => openedPaths.length === 1, 'logs path opened');
  assert.equal(openedPaths[0], path.join(profile, 'logs'));

  // The fixture supplies a real bridge-readable live battle for native confirmations.
  await client().executeJavaScript(`app.rooms['battle-gen9ou-1'] = {
    title: 'Battle', battle: { p1: {name:'Tester'}, p2: {name:'Opponent'}, tier:'[Gen 9] OU', ended:false }
  }; app.curRoom = {id:'battle-gen9ou-1'}; 0`);
  await load('play.html');
  assert.equal((await result('getSession()')).rooms[0].players[0], 'Tester');
  assert.equal((await result("setSetting('confirmOnClose', true)")).ok, true);
  responses.set('Close app', 0);
  const closeBefore = dialogs.length;
  win.close();
  await until(() => dialogs.length > closeBefore, 'own battle close confirmation');
  assert.equal(dialogs.at(-1).title, 'Close app');
  assert.equal(win.isDestroyed(), false, 'cancel keeps window open');

  responses.set('Reload client', 0);
  const clientId = client().id;
  const cancelReload = await result('reloadClient()');
  assert.deepEqual(cancelReload, { ok: true, cancelled: true });
  assert.equal(client().id, clientId);
  responses.set('Reload client', 1);
  const reloadCount = dialogs.length;
  assert.equal((await result('reloadClient()')).ok, true);
  await until(() => dialogs.length > reloadCount && !client().isLoading(), 'accepted client reload');
  assert.equal(client().id, clientId, 'reload keeps view');
  assert.equal((await result('getSession()')).ready, true, 'fixture loaded after reload');

  // Sign-out cancel preserves partition storage and replay notes.
  await client().executeJavaScript("localStorage.setItem('session-marker', 'signed-in'); 0");
  assert.equal((await result(`saveReplayNote(${JSON.stringify(note)})`)).ok, true);
  assert.equal(await noteCount(), 1);
  responses.set('Sign out of Showdown', 0);
  assert.deepEqual(await result('signOutShowdown()'), { ok: true, cancelled: true });
  assert.equal(await client().executeJavaScript("localStorage.getItem('session-marker')"), 'signed-in');
  assert.equal(await noteCount(), 1);
  responses.set('Sign out of Showdown', 1);
  assert.equal((await result('signOutShowdown()')).ok, true);
  await until(() => win.contentView.children.length === 1 && client().id !== clientId, 'replacement client');
  await loadFixture();
  assert.equal(await client().executeJavaScript("localStorage.getItem('session-marker')"), null);
  assert.equal(await noteCount(), 1, 'sign-out keeps notes');

  // Reset clears launcher state while leaving the separate client partition intact.
  await client().executeJavaScript("localStorage.setItem('session-marker', 'keep-after-reset'); 0");
  await run("localStorage.setItem('launcher-marker', 'clear-me'); 0");
  responses.set('Reset launcher data', 0);
  assert.deepEqual(await result('resetLauncher()'), { ok: true, cancelled: true });
  assert.equal(await noteCount(), 1);
  assert.equal(await run("localStorage.getItem('launcher-marker')"), 'clear-me');
  assert.equal(readSettings().theme, 'dark');
  responses.set('Reset launcher data', 1);
  assert.equal((await result('resetLauncher()')).ok, true);
  assert.equal(await noteCount(), 0);
  assert.equal(fs.existsSync(replayFile), false);
  assert.deepEqual(readSettings(), { theme: 'system', startPage: 'home', confirmOnClose: true, showdexEnabled: false });
  assert.equal(await run("localStorage.getItem('launcher-marker')"), null);
  assert.equal(await client().executeJavaScript("localStorage.getItem('session-marker')"), 'keep-after-reset');

  await load('settings.html');
  win.setSize(1024, 640);
  win.showInactive();
  const captures = path.join(__dirname, '..', 'out', 'desktop-smoke');
  fs.mkdirSync(captures, { recursive: true });
  for (const theme of ['light', 'dark']) {
    assert.equal((await result(`setSetting('theme', '${theme}')`)).ok, true);
    await load('settings.html');
    await until(() => run(`document.getElementById('theme').value === '${theme}'`), `${theme} setting shown`);
    await until(() => run(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`), `${theme} theme`);
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, `${theme} horizontal overflow`);
    fs.writeFileSync(path.join(captures, `settings-1024-${theme}.png`), (await renderer.capturePage()).toPNG());
    await run("document.querySelector('.content').scrollTop = document.querySelector('.content').scrollHeight; 0");
    await pause(100);
    assert.equal(await run("document.getElementById('reset-launcher').closest('.setting-row').getBoundingClientRect().bottom <= innerHeight + 1"), true, `${theme} reset row reachable`);
    fs.writeFileSync(path.join(captures, `settings-1024-${theme}-bottom.png`), (await renderer.capturePage()).toPNG());
  }

  // Deterministic status snapshots exercise truthful UI labels without loading Showdex in the fixture.
  let showdexState = {
    installed: true, enabled: false, loaded: false, status: 'disabled',
    pendingReload: false, error: '', version: 'test',
  };
  ipcMain.removeHandler('showdex:status');
  ipcMain.handle('showdex:status', () => ({ ...showdexState }));
  await until(() => run("document.getElementById('showdex-status').textContent === 'Disabled'"), 'Showdex disabled label');
  assert.equal(await run("document.getElementById('showdex-enabled').disabled"), false);
  await run("document.getElementById('showdex-enabled').click()");
  await until(() => readSettings().showdexEnabled === true, 'Showdex preference enabled');
  showdexState = { ...showdexState, enabled: true, pendingReload: true };
  await until(() => run("document.getElementById('showdex-status').textContent === 'Will load after reload' && !document.getElementById('showdex-reload-banner').hidden"), 'Showdex enable pending');
  showdexState = { ...showdexState, loaded: true, status: 'loaded', pendingReload: false };
  await until(() => run("document.getElementById('showdex-status').textContent === 'Loaded' && document.getElementById('showdex-reload-banner').hidden"), 'Showdex loaded label');
  await run("document.getElementById('showdex-enabled').click()");
  await until(() => readSettings().showdexEnabled === false, 'Showdex preference disabled');
  showdexState = { ...showdexState, enabled: false, pendingReload: true };
  await until(() => run("document.getElementById('showdex-status').textContent === 'Loaded · reload to disable' && !document.getElementById('showdex-reload-banner').hidden"), 'Showdex disable pending');
  await load('play.html');
  await until(() => run("document.getElementById('showdex-status').textContent === 'Showdex: Loaded · reload to disable'"), 'Play loaded pending label');
  showdexState = { ...showdexState, loaded: false, status: 'failed', pendingReload: false, error: 'Test load error' };
  await until(() => run("document.getElementById('showdex-status').textContent === 'Showdex: Failed to load'"), 'Play failed label');
  showdexState = { ...showdexState, installed: false, status: 'not-installed', error: '' };
  await load('settings.html');
  await until(() => run("document.getElementById('showdex-status').textContent === 'Not installed'"), 'not installed label');
  assert.equal(await run("document.getElementById('showdex-enabled').disabled"), true);

  // Spectating is not the user's battle, so closing should not ask again.
  await client().executeJavaScript(`app.rooms['battle-gen9ou-2'] = {
    title:'Spectating', battle:{p1:{name:'Alpha'},p2:{name:'Beta'},tier:'[Gen 9] OU',ended:false}
  }; app.curRoom = {id:'battle-gen9ou-2'}; 0`);
  const spectateDialogs = dialogs.length;
  app.on('before-quit', (event) => event.preventDefault());
  win.close();
  await until(() => win.isDestroyed(), 'spectated battle close');
  assert.equal(dialogs.length, spectateDialogs, 'spectating does not prompt');

  console.log('PASS settings desktop smoke: startup, persistence, close/reload dialogs, logs, sign-out/reset isolation, Showdex status UI');
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
