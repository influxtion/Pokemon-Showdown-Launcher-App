'use strict';

// Simulated desktop smoke test. Never loads the user's profile or contacts Showdown.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-desktop-test-'));
app.setPath('userData', profile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  // The production partition name is safe inside this temporary userData directory.
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) });
  });
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length, 'launcher window');
  const win = BrowserWindow.getAllWindows()[0];
  const renderer = win.webContents;
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('index.html'), 'initial page load');
  const client = win.contentView.children[0];
  const clientId = client.webContents.id;
  let current = { ready: true, connected: true, me: 'Tester', rooms: [], search: { pending: false, formats: [] }, popups: 0 };
  const snapshot = {
    ready: true, connected: true, user: { name: 'Tester', userid: 'tester', registered: true },
    counts: { users: 100, battles: 20 }, currentFormat: 'gen9randombattle',
    formats: [
      { id: 'gen9randombattle', name: '[Gen 9] Random Battle', section: 'Singles', presetTeam: true },
      { id: 'gen9ou', name: '[Gen 9] OU', section: 'Singles', presetTeam: false },
    ],
    teams: [{ index: 1, name: 'Selected team', format: 'gen9ou', sprites: [] }], news: [], rooms: [], ratings: {},
    friends: { available: true, items: [
      { userid: 'onlinefriend', name: 'Online Friend', online: true, status: 'online' },
      { userid: 'busyfriend', name: 'Busy Friend', online: true, status: 'busy' },
      { userid: 'offlinefriend', name: 'Offline Friend', online: false, status: 'offline' },
    ] },
  };
  ipcMain.removeHandler('showdown:session');
  ipcMain.handle('showdown:session', () => current);
  ipcMain.removeHandler('showdown:snapshot');
  ipcMain.handle('showdown:snapshot', () => ({ ...snapshot, connected: current.connected }));
  const run = (code) => renderer.executeJavaScript(code);
  const load = async (file) => {
    await win.loadFile(path.join(__dirname, '..', 'renderer', file));
    await pause(200);
  };
  await load('index.html');
  await until(() => run("!document.getElementById('battle').disabled"), 'Home ready');
  await until(() => run("document.getElementById('friends').textContent.includes('Busy Friend')"), 'friends rendered');
  assert.doesNotMatch(await run("document.getElementById('friends').textContent"), /Battling/);
  const actions = [];
  ipcMain.removeHandler('showdown:action');
  ipcMain.handle('showdown:action', (_event, action, args) => { actions.push({ action, args }); return true; });
  await run("document.getElementById('edit-team').click(); 0");
  await until(() => renderer.getURL().endsWith('/play.html'), 'random-format team list shortcut');
  assert.deepEqual(actions.pop(), { action: 'edit-team', args: { team: null } });
  await load('index.html');
  await until(() => run("!document.getElementById('format').disabled"), 'formats ready for team shortcut');
  await run("document.getElementById('format').value = 'gen9ou'; document.getElementById('format').dispatchEvent(new Event('change')); document.getElementById('edit-team').click(); 0");
  await until(() => renderer.getURL().endsWith('/play.html'), 'selected team shortcut');
  assert.deepEqual(actions.pop(), { action: 'edit-team', args: { team: 1, name: 'Selected team', format: 'gen9ou' } });
  await load('index.html');
  current = { ...current, connected: false };
  await until(() => run("document.getElementById('battle').disabled"), 'disconnect disables search');
  current = { ...current, connected: true };
  await until(() => run("!document.getElementById('battle').disabled"), 'reconnect enables search');
  await load('play.html');
  await until(() => client.getVisible(), 'client shown');
  await until(async () => (await run("document.getElementById('connection-banner').hidden")) &&
    client.getBounds().height === await run("Math.round(document.querySelector('.client-view').getBoundingClientRect().height)"), 'connected view layout');
  assert.equal(client.webContents.id, clientId);
  const originalHeight = client.getBounds().height;
  current = { ...current, connected: false };
  await until(() => client.getBounds().height < originalHeight, 'disconnect banner adjusts native view');
  current = { ...current, connected: true };
  await until(() => client.getBounds().height === originalHeight, 'reconnect restores client bounds');
  await load('settings.html');
  assert.equal(client.getVisible(), false);
  for (const theme of ['dark', 'light']) {
    assert.equal(await run(`window.desktop.setTheme('${theme}')`), true);
    await until(() => run(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`), `${theme} theme`);
  }
  await load('play.html');
  assert.equal(client.webContents.id, clientId);
  await load('index.html');
  current = { ...current, rooms: [{ id: 'battle-test-1', title: 'Spectating', battle: true, ended: false, players: ['A', 'B'], format: 'Test' }] };
  await pause(3400);
  assert.match(renderer.getURL(), /index\.html$/);
  // Player identities can arrive after a battle room first appears.
  current = { ...current, rooms: [...current.rooms, { id: 'battle-test-2', title: 'Battle', battle: true, ended: false, players: [], format: 'Test' }] };
  await pause(3400);
  current = { ...current, rooms: current.rooms.map((room) => room.id.endsWith('-2') ? { ...room, players: ['Tester', 'Opponent'] } : room) };
  await until(() => /play\.html$/.test(renderer.getURL()), 'player battle auto-switch');
  // Launcher-owned room navigation: rail rows, top bar and the finished-battle bar.
  const detail = (extra) => ({ kind: 'battle', battle: true, formatId: 'gen9randombattle', turn: 3, unread: false, ended: false, ...extra });
  current = {
    ...current, named: true, current: 'battle-test-2', menuUnread: false,
    rooms: [
      detail({ id: 'battle-test-2', title: 'Battle', players: ['Tester', 'Opponent'], format: 'Random Battle' }),
      { id: 'lobby', title: 'Lobby', kind: 'chat', battle: false, players: [], format: '', formatId: '', ended: false, turn: null, unread: true },
    ],
  };
  await load('play.html');
  await until(() => run("document.querySelectorAll('[data-nav=rooms] .nav-room').length === 2"), 'rail rooms rendered');
  assert.equal(await run("document.querySelector('[data-nav=rooms] .nav-room[aria-current=page] .nav-room-title').textContent"), 'vs. Opponent');
  assert.deepEqual(await run("[...document.querySelectorAll('[data-nav=rooms] .nav-tab .nav-room-title')].map((n) => n.textContent)"), ['Battle', 'Teambuilder', 'Community']);
  assert.equal(await run("document.querySelector('[data-nav=rooms] .nav-room-sub').textContent"), 'Random Battle · Turn 3');
  assert.equal(await run("document.querySelectorAll('[data-nav=rooms] .nav-unread').length"), 1);
  assert.equal(await run("document.querySelector('[data-nav=me]').textContent"), 'Tester');
  assert.equal(await run("document.getElementById('room-title').textContent"), 'vs. Opponent');
  assert.equal(await run("document.getElementById('room-format').textContent"), 'gen9randombattle');
  assert.equal(await run("document.getElementById('room-status').textContent"), 'Turn 3');
  assert.equal(await run("document.getElementById('save-note').hidden"), false);
  assert.equal(await run("document.getElementById('result-bar').hidden"), true);
  assert.equal(await run("!!document.querySelector('[data-action=reload-client]')"), false);
  actions.length = 0;
  await run("document.querySelector('[aria-label=\"Close Lobby\"]').click(); 0");
  await until(() => actions.some((a) => a.action === 'leave-room'), 'close sends leave-room');
  assert.deepEqual(actions.find((a) => a.action === 'leave-room'), { action: 'leave-room', args: { room: 'lobby' } });
  assert.match(renderer.getURL(), /play.html$/);
  await run("document.querySelector('[data-action=sounds]').click(); 0");
  await until(() => actions.some((a) => a.action === 'sounds'), 'sound button');
  current = { ...current, rooms: [detail({ ...current.rooms[0], ended: true }), current.rooms[1]] };
  await until(() => run("!document.getElementById('result-bar').hidden"), 'result bar for finished own battle');
  assert.equal(await run("document.getElementById('result-message').textContent"), 'Battle finished · vs. Opponent');
  assert.equal(await run("document.getElementById('room-status').textContent"), 'Finished');
  actions.length = 0;
  await pause(1500);
  assert.equal(actions.some((a) => a.action === 'search'), false, 'no search without a click');
  fs.mkdirSync(path.join(__dirname, '..', 'out', 'desktop-smoke'), { recursive: true });
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  for (const theme of ['light', 'dark']) {
    await run(`window.desktop.setTheme('${theme}')`);
    await pause(250);
    fs.writeFileSync(path.join(__dirname, '..', 'out', 'desktop-smoke', `play-${theme}.png`), (await renderer.capturePage()).toPNG());
  }
  await run("document.getElementById('result-again').click(); 0");
  await until(() => actions.some((a) => a.action === 'search'), 'Battle again search');
  assert.deepEqual(actions.find((a) => a.action === 'search'), { action: 'search', args: { format: 'gen9randombattle', team: null } });
  await until(() => /index.html$/.test(renderer.getURL()), 'Battle again returns to Home');
  await load('play.html');
  win.setSize(1024, 640);
  await until(() => {
    try {
      const savedWindow = JSON.parse(fs.readFileSync(path.join(profile, 'window-state.json'), 'utf8'));
      const actual = win.getNormalBounds();
      return savedWindow.bounds.width === actual.width && savedWindow.bounds.height === actual.height;
    } catch { return false; }
  }, 'window bounds saved');
  await load('index.html');
  assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
  const captures = path.join(__dirname, '..', 'out', 'desktop-smoke');
  fs.mkdirSync(captures, { recursive: true });
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  for (const theme of ['light', 'dark']) {
    await run(`window.desktop.setTheme('${theme}')`);
    await pause(250);
    fs.writeFileSync(path.join(captures, `home-${theme}.png`), (await renderer.capturePage()).toPNG());
  }
  console.log('PASS desktop smoke: connection, view bounds/survival, themes, spectating, delayed battle identity, launcher rail rooms, room top bar, result bar, minimum width');
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
