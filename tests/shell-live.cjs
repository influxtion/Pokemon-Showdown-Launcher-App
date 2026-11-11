'use strict';

// Optional live guest check that the official client still has what the launcher shell
// relies on. Run before a release. It spectates only: it never searches, challenges or logs in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, shell } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-live-guest-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  theme: 'dark', startPage: 'showdown', confirmOnClose: false, showdexEnabled: false,
}));
require('../app/main');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 60000) {
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
  const view = await until(() => win.contentView.children[0], 'Showdown view', 30000);
  const client = view.webContents;
  const js = (code) => client.executeJavaScript(code);
  const page = (code) => renderer.executeJavaScript(code);
  const session = () => page('window.desktop.getSession()');
  const rail = () => page(`[...document.querySelectorAll('[data-nav="rooms"] .nav-room')].map((n) => ({
    title: n.querySelector('.nav-room-title').textContent, current: n.getAttribute('aria-current') === 'page',
    live: n.classList.contains('nav-item--live') }))`);
  const clickRow = (title, selector) => page(`(() => {
    const row = [...document.querySelectorAll('[data-nav="rooms"] .nav-room')]
      .find((n) => n.querySelector('.nav-room-title').textContent === ${JSON.stringify(title)});
    if (!row || !row.querySelector(${JSON.stringify(selector)})) return false;
    row.querySelector(${JSON.stringify(selector)}).click();
    return true;
  })()`);
  const headerShown = () => js("getComputedStyle(document.getElementById('header')).display !== 'none'");
  const roomTop = () => js('Math.round(app.curRoom.el.getBoundingClientRect().top)');

  // What the bridge calls must still exist in the official client.
  const state = await until(async () => { const s = await session(); return s.ready && s.shell ? s : null; }, 'launcher shell active', 90000);
  assert.equal(state.named, false, 'isolated guest session');
  const globals = await js(`({
    app: ['updateLayout', 'focusRoom', 'leaveRoom', 'joinRoom', 'addPopup', 'closePopup'].filter((name) => typeof app[name] !== 'function'),
    popups: [typeof SoundsPopup, typeof OptionsPopup, typeof LoginPopup],
    header: Boolean(document.getElementById('header')),
    menu: Boolean(app.rooms[''] && typeof app.rooms[''].search === 'function'),
  })`);
  assert.deepEqual(globals, { app: [], popups: ['function', 'function', 'function'], header: true, menu: true });
  assert.equal(await js('app.singlePanelMode'), true);
  assert.equal(await headerShown(), false, 'client header hidden while the launcher drives rooms');
  assert.equal(await roomTop(), 0, 'room fills the view');
  assert.equal(await js("Dex.prefs('onepanel') ? 1 : 0"), 0, 'saved layout preference untouched');

  // The main menu is split across the Battle and Community tabs by these client selectors.
  const shown = (selector) => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return Boolean(n && n.getClientRects().length); })()`);
  const menuView = async () => ({
    form: await shown('.mainmenu .battleform'), ladder: await shown('.mainmenu button[value="ladder"]'),
    watch: await shown('.mainmenu button[value="battles"]'), teambuilder: await shown('.mainmenu button[value="teambuilder"]'),
    finduser: await shown('.mainmenu button[name="finduser"]'), friends: await shown('.mainmenu button[value="/friends"]'),
    resources: await shown('.mainmenu button[value="resources"]'), chat: await shown('.rightmenu button[value="rooms"]'),
  });
  assert.equal(await page("window.desktop.showdown('show-menu', { tab: 'community' })"), true);
  assert.equal((await session()).menuTab, 'community');
  assert.deepEqual(await menuView(), { form: false, ladder: false, watch: false, teambuilder: false, finduser: true, friends: true, resources: true, chat: true });
  assert.equal(await page("window.desktop.showdown('show-menu', { tab: 'battle' })"), true);
  assert.equal((await session()).menuTab, 'battle');
  assert.deepEqual(await menuView(), { form: true, ladder: true, watch: true, teambuilder: false, finduser: false, friends: false, resources: false, chat: false });

  // Rooms appear in the rail and can be switched and closed from it.
  assert.equal(await page("window.desktop.showdown('join', { room: 'lobby' })"), true);
  assert.equal(await page("window.desktop.showdown('join', { room: 'battles' })"), true);
  const href = await until(() => js(`(() => { const a = document.querySelector('a.blocklink[href^="/battle-"]'); return a ? a.getAttribute('href') : null; })()`), 'a public battle to spectate', 30000);
  const battleId = href.slice(1);
  assert.equal(await page(`window.desktop.showdown('join', { room: ${JSON.stringify(battleId)} })`), true);
  await until(async () => (await rail()).some((row) => row.live && row.current), 'spectated battle current in the rail', 30000);
  const battle = (await session()).rooms.find((room) => room.id === battleId);
  assert.equal(battle.kind, 'battle');
  assert.ok(battle.formatId && Number.isInteger(battle.turn), 'battle format and turn readable');
  assert.equal(await js('Object.keys(app.rooms).filter((id) => app.rooms[id].el && app.rooms[id].el.getClientRects().length).length'), 1, 'one room at a time');
  assert.equal(await roomTop(), 0);
  const battleTitle = (await rail()).find((row) => row.live).title;

  assert.equal(await clickRow('Lobby', '.nav-room-main'), true);
  await until(async () => (await js('app.curRoom.id')) === 'lobby', 'rail click focuses Lobby');
  await until(async () => (await page("document.getElementById('room-title').textContent")) === 'Lobby', 'top bar names Lobby');

  // Popups that used to hang off the hidden user bar.
  for (const action of ['sounds', 'options']) {
    assert.equal(await page(`window.desktop.showdown(${JSON.stringify(action)}, {})`), true);
    assert.equal(await js('app.popups.length'), 1, `${action} popup opened`);
    await js('app.closePopup(); 0');
  }

  // Fail safe: if a room control disappears, the client's own header returns, and the
  // launcher takes over again once the control does.
  await js('window.__sdLeave = app.leaveRoom; app.leaveRoom = undefined; 0');
  await until(async () => (await session()).shell === false, 'shell withdrawn');
  assert.equal(await headerShown(), true, 'client header restored when the bridge cannot drive rooms');
  assert.ok(await roomTop() > 0, 'room sits below the restored header');
  await js('app.leaveRoom = window.__sdLeave; delete window.__sdLeave; 0');
  await until(async () => (await session()).shell === true, 'shell restored');
  assert.equal(await headerShown(), false);

  // Spectated and chat rooms close from the rail without any prompt; the last close goes Home.
  for (const title of ['Battles', 'Lobby']) {
    assert.equal(await clickRow(title, '.nav-close'), true);
    await until(async () => !(await rail()).some((row) => row.title === title), `${title} closed`);
  }
  assert.equal(await clickRow(battleTitle, '.nav-close'), true);
  await until(() => page("location.pathname.endsWith('index.html')"), 'Home after the last room closes');
  assert.deepEqual(await js("Object.keys(app.rooms).filter((id) => id && id !== 'rooms')"), []);
  assert.equal(await js('app.popups.length'), 0);

  console.log('PASS launcher shell live guest check: client hooks present, header hidden, one room, rail focus/close, popups, fail-safe header restore');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
