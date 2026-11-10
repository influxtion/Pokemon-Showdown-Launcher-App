'use strict';

// Optional official replay-site smoke in a temporary guest profile. No account or battle actions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session, shell } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-review-live-'));
app.setPath('userData', profile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await pause(150);
  }
  throw new Error(`Timed out: ${label}`);
}

async function capture(contents) {
  for (let attempt = 1; ; attempt++) {
    try {
      const screenshot = await contents.capturePage();
      assert.equal(screenshot.isEmpty(), false, 'screenshot contains a rendered surface');
      return screenshot.toPNG();
    } catch (error) {
      if (attempt === 4 || !/^(UnknownVizError|Current display surface not available)/i.test(error.message)) throw error;
      await pause(250);
    }
  }
}

app.whenReady().then(async () => {
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  shell.openExternal = async () => { throw new Error('Unexpected external browser launch'); };
  require('../app/main');
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'launcher');
  const renderer = win.webContents;
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('index.html'), 'Home');
  const live = win.contentView.children[0];
  const liveId = live.webContents.id;
  const call = (method, ...args) => renderer.executeJavaScript(`window.desktop[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  // This public replay is used as an example by upstream's own API documentation.
  const result = await call('saveReplayNote', {
    title: 'Doubles review', url: 'https://replay.pokemonshowdown.com/gen7randomdoublesbattle-865046831',
    notes: 'Review the opening turns and positioning.', format: 'gen7randomdoublesbattle',
  });
  assert.equal(result.ok, true);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'replays.html'), { query: { review: result.note.id } });
  const view = await until(() => win.contentView.children.find((candidate) => candidate !== live), 'review view');
  const player = view.webContents;
  await until(async () => (await call('getReplayReviewStatus')).state === 'loaded', 'official replay page');
  await until(() => player.executeJavaScript('Boolean(window.battle && battle.stepQueue.length && document.querySelector(".replay-controls button"))'), 'official battle renderer');
  assert.equal(await player.executeJavaScript('typeof window.desktop'), 'undefined');
  assert.equal(await player.executeJavaScript('typeof require'), 'undefined');
  assert.equal(live.webContents.id, liveId);
  assert.equal(live.getVisible(), false);
  await player.executeJavaScript(`(() => {
    const sound = document.querySelector('select[name=sound]');
    if (sound) { sound.value = 'off'; sound.dispatchEvent(new Event('change', {bubbles:true})); }
    const play = [...document.querySelectorAll('.replay-controls button')].find(button => button.textContent.trim() === 'Play');
    if (!play) throw new Error('Play control missing');
    play.click();
  })()`);
  await until(() => player.executeJavaScript('battle.turn >= 1'), 'replay advances');
  await player.executeJavaScript(`(() => {
    const pause = [...document.querySelectorAll('.replay-controls button')].find(button => button.textContent.trim() === 'Pause');
    if (pause) pause.click();
  })()`);
  assert.equal(await player.executeJavaScript('battle.paused'), true);

  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  const captures = path.join(__dirname, '..', 'out', 'desktop-smoke');
  fs.mkdirSync(captures, { recursive: true });
  const battleBefore = await player.executeJavaScript('battle.turn');
  for (const [width, height] of [[1366, 768], [1024, 640]]) {
    win.setSize(width, height);
    win.show();
    win.focus();
    let geometry;
    await until(async () => {
      const [windowWidth, windowHeight] = win.getSize();
      const expected = await renderer.executeJavaScript(`(() => {
        const rect = document.getElementById('review-view').getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      })()`);
      const bounds = view.getBounds();
      const viewport = await player.executeJavaScript('({ width: innerWidth, height: innerHeight })');
      geometry = { windowWidth, windowHeight, content: win.getContentBounds(), visible: win.isVisible(),
        viewVisible: view.getVisible(), expected, bounds, viewport };
      return Math.abs(windowWidth - width) <= 2 && Math.abs(windowHeight - height) <= 2 &&
        geometry.visible && geometry.viewVisible && Object.keys(expected).every(key => bounds[key] === expected[key]) &&
        Math.abs(viewport.width - bounds.width) <= 2 && Math.abs(viewport.height - bounds.height) <= 2;
    }, `visible player follows the ${width}px window`, 10000).catch(error => {
      throw new Error(`${error.message} ${JSON.stringify(geometry)}`);
    });
    let layout;
    await until(async () => {
      layout = await player.executeJavaScript(`(() => {
        const field = document.querySelector('.battle').getBoundingClientRect();
        const viewport = document.documentElement.clientWidth;
        return {viewport, fieldRight: field.right, visibility: document.visibilityState};
      })()`);
      return layout.viewport >= 640 || layout.fieldRight <= layout.viewport + 2;
    }, `upstream battlefield scales to the ${width}px window`, 10000).catch(error => {
      throw new Error(`${error.message} ${JSON.stringify(layout)}`);
    });
    for (const theme of ['light', 'dark']) {
      await call('setTheme', theme);
      await pause(250);
      assert.equal(await player.executeJavaScript('battle.turn'), battleBefore);
      assert.equal(await renderer.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
      assert.equal(await player.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches"), theme === 'dark');
      fs.writeFileSync(path.join(captures, `review-live-${width}-${theme}-shell.png`), await capture(renderer));
      fs.writeFileSync(path.join(captures, `review-live-${width}-${theme}-player.png`), await capture(player));
      const layout = await player.executeJavaScript(`(() => {
        const {clientWidth, scrollWidth, clientHeight} = document.documentElement;
        const controls = [...document.querySelectorAll('.replay-controls :is(button, select, input)')]
          .filter(element => element.getClientRects().length);
        const button = document.querySelector('.replay-controls button');
        const style = getComputedStyle(button);
        const horizontalFit = controls.length > 0 && controls.every(element => {
          const rect = element.getBoundingClientRect();
          return rect.left >= -1 && rect.right <= clientWidth + 1;
        });
        const originalY = scrollY;
        const last = controls.at(-1);
        last?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const bottom = last?.getBoundingClientRect();
        const verticalReach = Boolean(bottom && bottom.top >= -1 && bottom.bottom <= clientHeight + 1);
        window.scrollTo({ left: 64, top: originalY, behavior: 'instant' });
        const horizontalScroll = scrollX;
        window.scrollTo({ left: 0, top: originalY, behavior: 'instant' });
        return {clientWidth, scrollWidth, horizontalScroll, horizontalFit, verticalReach,
          readable: style.color !== style.backgroundColor};
      })()`);
      const condition = `${width}px ${theme}`;
      assert.ok(layout.scrollWidth <= layout.clientWidth && layout.horizontalScroll === 0,
        `${condition} replay has no horizontal overflow ${JSON.stringify(layout)}`);
      assert.ok(layout.readable && layout.horizontalFit && layout.verticalReach,
        `${condition} playback controls are readable and reachable ${JSON.stringify(layout)}`);
    }
  }
  await renderer.executeJavaScript("document.getElementById('review-toggle-notes').click()");
  await pause(200);
  assert.equal(await renderer.executeJavaScript("document.body.classList.contains('review-wide')"), true);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await until(() => player.isDestroyed(), 'review closed on leaving');
  assert.equal(live.webContents.id, liveId);
  console.log('PASS live replay review: official public replay playback/pause, isolated guest view, notes layout, both themes/sizes, cleanup');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
