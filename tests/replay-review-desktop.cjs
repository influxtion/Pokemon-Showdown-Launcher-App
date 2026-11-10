'use strict';

// Isolated real Electron views with a deterministic replay page; no public battles or browser launches.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-review-test-'));
app.setPath('userData', profile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const url = 'https://replay.pokemonshowdown.com/gen9ou-1234-secretpw';
const rendererDir = path.join(__dirname, '..', 'renderer');

async function until(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(80);
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  let responseStatus = 200;
  const requests = [];
  session.fromPartition('replay-review').protocol.handle('https', (request) => {
    requests.push(request.url);
    return new Response(`<!doctype html><html><head><meta charset="utf-8"></head><body>
      <div><header>Upstream header</header><div class="main"><section class="section">
      <h1>Isolated replay fixture</h1><div class="battle">Battle fixture</div>
      <div class="replay-controls"><button class="button" id="play">Play fixture</button></div>
      <div class="battle-log">No real battle is contacted.</div></section></div></div>
      <script>window.fixtureCounter = 0; document.getElementById('play').onclick = () => window.fixtureCounter++;</script>
      </body></html>`, { status: responseStatus, headers: { 'content-type': 'text/html' } });
  });
  const opened = [];
  shell.openExternal = async (target) => opened.push(target);
  const dialogs = [];
  dialog.showMessageBox = async (_window, options) => { dialogs.push(options); return { response: 0 }; };
  const handlers = new Map();
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, fn) => { handlers.set(name, fn); originalHandle(name, fn); };
  require('../app/main');
  ipcMain.handle = originalHandle;
  await until(() => BrowserWindow.getAllWindows().length, 'launcher');
  const win = BrowserWindow.getAllWindows()[0];
  const renderer = win.webContents;
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('index.html'), 'Home loaded');
  const live = win.contentView.children[0];
  const liveId = live.webContents.id;
  let current = { ready: true, connected: true, me: 'Tester', rooms: [], search: { pending: false, formats: [] }, popups: 0 };
  ipcMain.removeHandler('showdown:session');
  ipcMain.handle('showdown:session', () => current);
  const run = (code) => renderer.executeJavaScript(code);
  const call = (name, ...args) => run(`window.desktop[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  const click = (id) => run(`document.getElementById(${JSON.stringify(id)}).click()`);
  const load = async (file, query) => { await win.loadFile(path.join(rendererDir, file), { query }); };
  const review = () => win.contentView.children.find((view) => view !== live);
  const ready = async () => until(async () => review() && (await call('getReplayReviewStatus')).state === 'loaded', 'replay page loaded');
  const fill = (id, value) => run(`(() => { const input = document.getElementById(${JSON.stringify(id)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles:true})); })()`);

  for (const name of ['review:show', 'review:status', 'review:reload']) {
    assert.equal((await handlers.get(name)({ sender: null, senderFrame: null }, {})).ok, false);
  }
  assert.equal((await call('showReplayReview', { x: 0, y: 0, width: 100, height: 100 })).ok, false, 'Home cannot start review');
  const saved = await call('saveReplayNote', { title: 'Review this game', url, format: 'gen9ou', notes: 'Original note.' });
  assert.equal(saved.ok, true);
  await load('replays.html');
  await until(() => run("!document.getElementById('review-replay').disabled"), 'review entry point');
  await fill('note-body', 'Draft before entering review.');
  await click('review-replay');
  await until(() => renderer.getURL().includes('?review='), 'review route');
  await ready();
  const first = review();
  const firstContents = first.webContents;
  assert.equal(first.webContents.getURL(), url, 'private replay access suffix preserved');
  const prefs = first.webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.preload, undefined);
  assert.equal(await first.webContents.executeJavaScript('typeof window.desktop'), 'undefined');
  assert.equal(await first.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.notEqual(first.webContents.session, live.webContents.session);
  assert.equal(live.webContents.id, liveId);
  assert.equal(live.getVisible(), false);
  assert.equal(await run("document.getElementById('note-body').value"), 'Draft before entering review.');

  await first.webContents.executeJavaScript("document.getElementById('play').click(); 0");
  for (const [width, height] of [[1366, 768], [1024, 640]]) {
    win.setSize(width, height);
    await pause(200);
    for (const theme of ['light', 'dark']) {
      await call('setTheme', theme);
      await pause(80);
      const expected = await run(`(() => { const r = document.getElementById('review-view').getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}; })()`);
      assert.deepEqual(first.getBounds(), expected);
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
      assert.equal(first.webContents.id, review().webContents.id);
      assert.equal(await first.webContents.executeJavaScript('window.fixtureCounter'), 1, 'resize/theme do not reload playback');
      assert.equal(await first.webContents.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches"), theme === 'dark');
    }
  }
  const narrowWidth = first.getBounds().width;
  await click('review-toggle-notes');
  await until(() => first.getBounds().width > narrowWidth, 'wide player');
  await click('review-browser');
  await until(() => opened.length === 1, 'browser fallback reachable in wide mode');
  assert.deepEqual(opened, [url]);
  await click('review-toggle-notes');
  await until(() => first.getBounds().width === narrowWidth, 'notes restored');
  await fill('note-body', 'Review notes saved alongside playback.');
  await run("document.dispatchEvent(new KeyboardEvent('keydown', {key:'s',ctrlKey:true,bubbles:true,cancelable:true}))");
  await until(async () => (await call('getReplayNotes')).notes[0].notes === 'Review notes saved alongside playback.', 'review note save');
  assert.equal(await first.webContents.executeJavaScript('window.fixtureCounter'), 1);

  // Official viewpoint changes stay on this note; other replay routes cannot silently replace it.
  await first.webContents.executeJavaScript("history.pushState({}, '', '?p2'); 0");
  assert.equal((await call('getReplayReviewStatus')).state, 'loaded');
  await first.webContents.executeJavaScript("history.pushState({}, '', '/gen9ou-9999'); 0");
  await until(async () => (await call('getReplayReviewStatus')).state === 'failed', 'route mismatch blocked');
  assert.equal(first.getVisible(), false);
  await click('review-reload');
  await ready();
  assert.notEqual(review(), first);
  assert.equal(firstContents.isDestroyed(), true);
  assert.equal(review().webContents.getURL(), url);

  responseStatus = 404;
  await click('review-reload');
  await until(async () => (await call('getReplayReviewStatus')).state === 'failed', 'unavailable replay');
  await until(() => !review(), 'failed replay view released');
  const beforeResize = requests.length;
  win.setSize(1200, 700);
  await pause(200);
  assert.equal(requests.length, beforeResize, 'resize must not retry a failed page');
  assert.equal(review(), undefined);
  responseStatus = 200;
  await click('review-reload');
  await ready();

  await fill('note-body', 'Draft before returning to notes.');
  const leaving = review().webContents;
  await click('review-back');
  await until(() => !renderer.getURL().includes('review='), 'back to list');
  await until(() => leaving.isDestroyed(), 'leaving review closes remote playback');
  await until(() => run("document.getElementById('note-body').value === 'Draft before returning to notes.'"), 'draft retained');
  assert.equal(review(), undefined);
  assert.equal(live.webContents.id, liveId);
  await click('review-replay');
  await ready();
  const battleReview = review().webContents;
  await pause(100);
  current = { ...current, rooms: [{ id: 'battle-gen9ou-42', title: 'Battle', battle: true, ended: false, format: 'gen9ou', players: ['Tester', 'Opponent'] }] };
  await until(() => renderer.getURL().endsWith('/play.html'), 'new player battle takes priority');
  assert.equal(live.webContents.id, liveId);
  await until(() => live.getVisible(), 'live battle view visible');
  assert.equal(battleReview.isDestroyed(), true);
  assert.equal(await run("JSON.parse(sessionStorage.getItem('replayNote.editorDraft')).notes"), 'Draft before returning to notes.');
  win.close();
  await until(() => dialogs.some((item) => item.title === 'Unsaved replay note'), 'close guards review draft from battle page');
  assert.equal(win.isDestroyed(), false);
  await load('replays.html', { review: 'missing-note' });
  await until(() => run("document.getElementById('review-status').textContent === 'Replay unavailable'"), 'missing note handled');
  assert.equal(review(), undefined);
  assert.deepEqual(opened, [url]);
  console.log('PASS replay review desktop: isolated view, private URLs, notes/drafts, theme/resize, reload/errors, navigation/cleanup, battle priority, IPC guards');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
