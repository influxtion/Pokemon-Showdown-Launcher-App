'use strict';

// Real staged Practice runtime in a disposable Electron profile.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, session, shell } = require('electron');

const root = path.join(__dirname, '..');
const captures = path.join(root, 'out', 'desktop-smoke');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-practice-test-'));
process.env.SHOWDOWN_DESKTOP_USER_DATA = profile;
app.setPath('userData', profile);
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = Date.now() + 85000;
const children = [];
const diagnose = process.argv.includes('--diagnose-practice');

async function until(check, label, timeout = 12000) {
  const end = Math.min(Date.now() + timeout, deadline);
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function recordRuntimeChildren() {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (executable, args, options) => {
    const child = originalSpawn(executable, args, options);
    const name = args.find(arg => typeof arg === 'string' && /[\\/]scripts[\\/]laplace[\\/](server\.cjs|runner\.py)$/.test(arg));
    if (name) children.push(child);
    return child;
  };
  try {
    require('../app/main');
  } finally {
    childProcess.spawn = originalSpawn;
  }
}

function blockNetwork(partition) {
  partition.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^(https?|wss?):/i.test(details.url) });
  });
}

function battleEval(contents, script) {
  return contents.executeJavaScript(`(() => {
    const room = Object.values(window.app?.rooms || {}).find(value =>
      /^battle-gen9randombattle-/.test(value.id) && value.side && value.battle && value.request);
    if (!room) return null;
    const control = (name) => [...room.el.querySelectorAll('button[name="' + name + '"]:enabled')]
      .find(button => button.getClientRects().length && getComputedStyle(button).visibility === 'visible');
    ${script}
  })()`);
}

async function capture(contents, name) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const screenshot = await contents.capturePage();
      if (!screenshot.isEmpty()) {
        fs.writeFileSync(path.join(captures, `${name}.png`), screenshot.toPNG());
        return;
      }
    } catch (error) {
      if (!/UnknownVizError|display surface not available/i.test(error.message)) throw error;
    }
    await pause(250);
  }
  throw new Error(`Could not capture ${name}`);
}

async function smoke() {
  blockNetwork(session.defaultSession);
  blockNetwork(session.fromPartition('persist:showdown'));
  if (diagnose) {
    app.on('web-contents-created', (_event, contents) => {
      contents.on('console-message', details => {
        if (!contents.getURL().includes('practice-client.html')) return;
        const message = String(details.message).replace(/[a-f0-9]{32,128}/gi, '[session]');
        if (details.level === 'error') console.error(message);
        if (/^>> .*\|\/choose /.test(message)) console.error(message);
        if (/^<< /.test(message)) {
          const events = message.split('\n').flatMap(line => {
            const event = /^\|(error|turn|move|switch|request|-terastallize)\|/.exec(line);
            return event ? [event[1]] : [];
          });
          if (events.length) console.error(events.join(' '));
        }
      });
    });
  }
  let externalOpens = 0;
  shell.openExternal = async () => { externalOpens++; };
  let response = 0;
  const dialogs = [];
  dialog.showMessageBox = async (_win, options) => {
    dialogs.push(options);
    return { response };
  };
  recordRuntimeChildren();

  const win = await until(() => BrowserWindow.getAllWindows()[0], 'launcher window');
  const renderer = win.webContents;
  if (diagnose) renderer.on('did-start-navigation', (details, url, sameDocument, main) => {
    console.error('Launcher navigation', path.basename(details.url || url),
      details.isSameDocument ?? sameDocument, details.isMainFrame ?? main);
  });
  const run = (script) => renderer.executeJavaScript(script);
  const call = (method, ...args) => run(`window.desktop[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const status = () => call('getPractice');
  const load = (page) => win.loadFile(path.join(root, 'renderer', page));
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('/index.html'), 'Home');
  const live = win.contentView.children[0];
  const liveId = live.webContents.id;
  const practice = () => win.contentView.children.find(view => view !== live);
  assert.equal((await call('startPractice', 'balanced')).ok, false, 'Home cannot start Practice');

  await load('practice.html');
  assert.equal((await status()).installed, true, 'Stage the local server, Python runtime, model and client first');
  assert.equal((await status()).state, 'idle');
  assert.equal((await call('startPractice', 'balanced')).ok, true);
  await until(async () => {
    const state = await status();
    if (state.error || state.clientError) throw new Error(state.error || state.clientError);
    return state.state === 'ready' && practice();
  }, 'local runtime ready', 47000);
  const view = practice();
  const player = view.webContents;
  const playerId = player.id;
  await until(() => !player.isLoading() && player.getURL().startsWith('file:'), 'local client document');
  assert.equal(new URL(player.getURL()).pathname.endsWith('/practice-client.html'), true);
  assert.notEqual(player.session, live.webContents.session);
  const preferences = player.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.preload, undefined);
  assert.equal(await player.executeJavaScript('typeof window.desktop'), 'undefined');
  assert.equal(await player.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await player.executeJavaScript(`(() => {
    const url = new URL(window.Config.practiceSocketUrl);
    return url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.pathname === '/showdown/websocket';
  })()`), true);
  assert.equal(live.getVisible(), false);
  const roomId = await until(async () => {
    const state = await status();
    if (state.error || state.clientError) throw new Error(state.error || state.clientError);
    if (await player.executeJavaScript("document.documentElement.dataset.practiceState === 'failed'")) {
      throw new Error('Local battle client reported failure');
    }
    const browserRoom = await battleEval(player, "return control('chooseMove') ? room.id : null;");
    return state.battle?.room === browserRoom && view.getVisible() ? browserRoom : null;
  }, 'real local battle with a move request', 18000);
  assert.equal(children.length, 2, 'local server and Laplace runner started');

  const firstMove = await battleEval(player, `
    const move = control('chooseMove');
    if (!move) return null;
    const tera = room.el.querySelector('input[name="terastallize"]:enabled');
    const initial = { turn: room.battle.turn, move: move.dataset.move,
      queued: room.battle.stepQueue.length, tera: Boolean(tera?.getClientRects().length) };
    if (initial.tera && !tera.checked) tera.click();
    move.click();
    return initial;
  `);
  assert.ok(firstMove?.move, 'clicked an enabled upstream move button');
  await until(() => battleEval(player, `
    const player = room.side + 'a:';
    const events = room.battle.stepQueue.slice(${firstMove.queued});
    return room.battle.turn > ${firstMove.turn} ||
      events.some(line => line.startsWith('|move|' + player) || line.startsWith('|cant|' + player)) ||
      room.request.requestType === 'switch';
  `), 'server processed the human move').catch(async error => {
    if (diagnose) {
      const state = await status();
      console.error('Laplace state', { turn: state.battle?.turn, elapsed: state.battle?.elapsedMs });
      console.error('Browser battle state', await battleEval(player, `
        return { turn: room.battle.turn, rqid: room.request.rqid, type: room.request.requestType,
          choice: room.choice, position: room.battle.currentStep, queued: room.battle.stepQueue.length };
      `));
    }
    throw error;
  });
  if (firstMove.tera) {
    await until(() => battleEval(player, `
      return room.battle.stepQueue.slice(${firstMove.queued})
        .some(line => line.startsWith('|-terastallize|' + room.side + 'a:'));
    `), 'server reported the human Terastallization');
  }
  await until(async () => (await status()).battle?.elapsedMs > 0, 'Laplace submitted a searched move');

  const firstSwitch = await until(() => battleEval(player, `
    const button = control('chooseSwitch');
    const active = room.request.side?.pokemon?.find(mon => mon.active)?.ident;
    if (!button || !active) return null;
    button.click();
    return { active, turn: room.battle.turn };
  `), 'clicked an enabled upstream switch button');
  await until(() => battleEval(player, `
    const active = room.request.side?.pokemon?.find(mon => mon.active)?.ident;
    return Boolean(active && active !== ${JSON.stringify(firstSwitch.active)});
  `), 'server processed the human switch');
  await until(() => battleEval(player, "return Boolean(control('chooseMove') || control('chooseSwitch'));"), 'next human decision');

  await load('index.html');
  await until(() => !view.getVisible(), 'Practice hides on Home');
  assert.equal((await status()).battle.room, roomId);
  assert.equal(player.isAudioMuted(), true);
  assert.equal(player.isDestroyed(), false);
  await load('play.html');
  await until(() => live.getVisible(), 'live Showdown view restored');
  assert.equal(live.webContents.id, liveId);
  assert.equal(view.getVisible(), false);
  await load('practice.html');
  await until(() => view.getVisible(), 'Practice returns');
  assert.equal(practice().webContents.id, playerId);
  assert.equal((await status()).battle.room, roomId);
  assert.equal(await battleEval(player, 'return room.id;'), roomId);
  assert.equal(live.getVisible(), false);
  assert.equal(live.webContents.id, liveId);

  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  fs.mkdirSync(captures, { recursive: true });
  const turnBeforeResize = await battleEval(player, 'return room.battle.turn;');
  const layoutFailures = [];
  for (const [width, height] of [[1366, 768], [1024, 640]]) {
    win.setSize(width, height);
    await until(async () => {
      const [actualWidth, actualHeight] = win.getSize();
      const content = win.getContentBounds();
      const viewport = await run('({ width: innerWidth, height: innerHeight })');
      return Math.abs(actualWidth - width) <= 2 && Math.abs(actualHeight - height) <= 2 &&
        Math.abs(viewport.width - content.width) <= 2 && Math.abs(viewport.height - content.height) <= 2;
    }, `launcher resized to ${width}×${height}`).catch(async error => {
      if (diagnose) console.error('Window size', win.getSize(), win.getContentBounds(),
        await run('({ width: innerWidth, height: innerHeight })'));
      throw error;
    });
    for (const theme of ['light', 'dark']) {
      assert.equal(await call('setTheme', theme), true);
      await until(async () => {
        const expected = await run(`(() => {
          const rect = document.getElementById('practice-area').getBoundingClientRect();
          return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        })()`);
        const bounds = view.getBounds();
        return Object.keys(expected).every(key => bounds[key] === expected[key]) &&
          (await player.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches")) === (theme === 'dark');
      }, `local client fits ${width}px in ${theme}`);
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
      assert.equal(await battleEval(player, 'return room.battle.turn;'), turnBeforeResize);
      assert.equal(practice().webContents.id, playerId);
      await pause(250);
      const layout = await battleEval(player, `
        const box = element => {
          if (!element) return null;
          const {left, right, top, bottom, width, height} = element.getBoundingClientRect();
          return {left, right, top, bottom, width, height};
        };
        const choiceBox = (choice, menu) => {
          if (!control(choice)) control(menu)?.click();
          return box(control(choice));
        };
        const switchChoice = choiceBox('chooseSwitch', 'selectSwitch');
        const moveChoice = choiceBox('chooseMove', 'selectMove');
        const field = room.el.querySelector('.battle');
        const scene = field?.querySelector('.innerbattle');
        const backdrop = scene?.querySelector('.backdrop');
        return { width: innerWidth, height: innerHeight, room: box(room.el), moveChoice, switchChoice,
          expectMove: room.request.requestType === 'move',
          expectSwitch: Boolean(room.el.querySelector('button[name=chooseSwitch]:enabled')),
          field: box(field), log: box(room.el.querySelector('.battle-log')),
          logButton: box(control('showChat')), hp: scene?.querySelectorAll('.statbar .hp').length ?? 0,
          sprites: [...(scene?.querySelectorAll('img') ?? [])].filter(img => img.naturalWidth > 0).length,
          backdrop: backdrop ? getComputedStyle(backdrop).backgroundImage !== 'none' : false };
      `);
      const withinView = rect => rect?.width > 0 && rect.height > 0 && rect.left >= -1 &&
        rect.right <= layout.width + 1 && rect.top >= -1 && rect.bottom <= layout.height + 1;
      if ((!layout.expectMove && !layout.expectSwitch) ||
          (layout.expectMove && !withinView(layout.moveChoice)) ||
          (layout.expectSwitch && !withinView(layout.switchChoice)) ||
          !withinView(layout.field) || !layout.hp ||
          !layout.sprites || !layout.backdrop || !(layout.log?.height || withinView(layout.logButton))) {
        layoutFailures.push({ windowWidth: width, theme, ...layout });
      }
      for (const [surface, contents] of [['shell', renderer], ['battle', player]]) {
        await capture(contents, `practice-${width}-${theme}-${surface}`);
      }
    }
  }

  assert.deepEqual(await call('stopPractice'), { ok: false, cancelled: true });
  assert.equal(dialogs.at(-1).message, 'Stop this practice session?');
  assert.equal((await status()).battle.room, roomId);
  assert.equal(practice().webContents.id, playerId);
  assert.ok(children.every(child => !childExited(child)));
  response = 1;
  assert.equal((await call('stopPractice')).ok, true);
  assert.deepEqual(dialogs.map(item => item.buttons), [
    ['Keep playing', 'Stop practice'], ['Keep playing', 'Stop practice'],
  ]);
  await until(() => !practice() && player.isDestroyed(), 'Practice view disposed');
  await until(() => children.every(childExited), 'local runtime children exited');
  assert.equal((await status()).state, 'idle');
  assert.equal(live.webContents.id, liveId);
  assert.equal(externalOpens, 0);
  assert.deepEqual(layoutFailures, [], 'Battlefield, sprites, HP, log and action controls remain visible or reachable');

  assert.equal((await call('startPractice', 'balanced')).ok, true, 'restart after Stop');
  const restarted = await until(async () => {
    const state = await status();
    if (state.error || state.clientError) throw new Error(state.error || state.clientError);
    const current = practice();
    if (!current || !state.battle || state.clientState !== 'battle' || !current.getVisible()) return null;
    return (await battleEval(current.webContents, 'return room.id;')) === state.battle.room ? current : null;
  }, 'new local battle after Stop', 27000);
  const restartedPlayer = restarted.webContents;
  const forfeitedRoom = (await status()).battle.room;
  assert.notEqual(restartedPlayer.id, playerId);
  assert.equal(children.length, 4);
  assert.equal(await battleEval(restartedPlayer, `
    const close = [...document.querySelectorAll('button[name=closeRoom]')].find(button => button.value === room.id);
    if (!close) return false;
    close.click();
    return true;
  `), true, 'clicked the local battle tab close control');
  await until(() => restartedPlayer.executeJavaScript(`
    (() => {
      const popup = [...document.querySelectorAll('.ps-popup')].find(element =>
        element.textContent.includes('Forfeiting makes you lose the battle.'));
      const submit = popup?.querySelector('button[type=submit]');
      if (!submit) return false;
      if (popup.querySelector('input[name=closeroom]:checked')) throw new Error('Practice Forfeit would close the room');
      submit.click();
      return true;
    })()
  `), 'confirmed the actual battle forfeit');
  await until(async () => {
    const state = await status();
    return state.battle?.room === forfeitedRoom && state.battle.finished &&
      state.battle.result === 'loss' && state.clientState === 'finished';
  }, 'forfeit ended the battle and kept the room');
  await until(() => run(`(() => {
    const next = document.getElementById('practice-next');
    if (next.hidden || next.disabled) return false;
    next.click();
    return true;
  })()`), 'clicked New battle after forfeiting');
  await until(async () => {
    const state = await status();
    if (state.error || state.clientError) throw new Error(state.error || state.clientError);
    return state.battle?.room !== forfeitedRoom && !state.battle?.finished && state.clientState === 'battle' &&
      (await battleEval(restartedPlayer, 'return room.id;')) === state.battle?.room;
  }, 'a distinct rematch opened on the same local view');
  assert.equal(practice().webContents.id, restartedPlayer.id);
  assert.equal(children.length, 4, 'rematch reuses both local children');

  restartedPlayer.forcefullyCrashRenderer();
  await until(async () => (await status()).state === 'failed', 'renderer crash reported as a Practice failure');
  await until(() => !practice() && restartedPlayer.isDestroyed(), 'crashed Practice view disposed');
  await until(() => children.every(childExited), 'both restarted runtime children exited after the crash');
  assert.equal(live.webContents.id, liveId);
  assert.equal(live.webContents.isDestroyed(), false);
  console.log(`PASS Practice desktop: real loopback battle, move and switch, ${firstMove.tera ? 'server-confirmed Tera' : 'Tera unavailable'}, view retention, size/theme captures, Stop, Forfeit and rematch, crash cleanup`);
}

app.whenReady().then(smoke).then(() => app.exit(0), async error => {
  console.error(error);
  for (const child of children) {
    if (!childExited(child)) child.kill();
  }
  const end = Date.now() + 1500;
  while (children.some(child => !childExited(child)) && Date.now() < end) await pause(50);
  app.exit(1);
});
