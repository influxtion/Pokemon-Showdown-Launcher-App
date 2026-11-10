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
  const readChrome = (module, selectors) => client.executeJavaScript(`(() => {
    const root = Array.from(document.querySelectorAll('[data-showdex-module=' + ${JSON.stringify(module)} + ']'))
      .find(el => el.getClientRects().length);
    if (!root) return null;
    const color = (token) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(' + token + ')';
      root.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const read = (selector) => {
      const element = root.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, backgroundImage: style.backgroundImage,
        shadow: style.boxShadow, textShadow: style.textShadow,
        radius: style.borderRadius, filter: style.backdropFilter, color: style.color };
    };
    return { text: getComputedStyle(root).color,
      app: getComputedStyle(root, '::before').backgroundColor,
      expected: { app: color('--sd-app'), panel: color('--sd-panel'),
        subtle: color('--sd-subtle'), text: color('--sd-text'), secondary: color('--sd-text-2') },
      parts: Object.fromEntries(Object.entries(${JSON.stringify(selectors)}).map(([key, selector]) => [key, read(selector)])),
    };
  })()`);
  const checkChrome = async (module, selectors, panelNames = []) => {
    const state = await readChrome(module, selectors);
    assert.ok(state, `${module} rendered`);
    assert.equal(state.app, state.expected.app, `${module} app background`);
    assert.equal(state.text, state.expected.text, `${module} text color`);
    for (const name of panelNames) {
      const part = state.parts[name];
      assert.ok(part, `${module} ${name} present`);
      assert.equal(part.background, state.expected[name === 'settingsOverlay' ? 'subtle' : 'panel'], `${module} ${name} background`);
      assert.equal(part.shadow, 'none', `${module} ${name} flat`);
      if (name !== 'settingsOverlay') assert.equal(part.radius, '4px', `${module} ${name} radius`);
      assert.equal(part.filter, 'none', `${module} ${name} no blur`);
    }
    return state;
  };
  const click = async (selector) => {
    const found = await client.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.click();
      return true;
    })()`);
    assert.equal(found, true, `clickable ${selector}`);
  };
  const capture = async (theme, screen, size) => {
    win.setSize(size === 'minimum' ? 1024 : 1366, size === 'minimum' ? 640 : 768);
    win.show();
    win.focus();
    await pause(250);
    if (screen === 'hellodex' || screen === 'settings') {
      assert.equal(await client.executeJavaScript(`(() => {
        const button = document.querySelector('[data-showdex-module=hellodex] [class*=Hellodex-module-settingsButton--]');
        const r = button.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
      })()`), true, `${theme} ${size} Settings shortcut stays visible`);
    }
    const png = await until(async () => (await client.capturePage()).toPNG(), `${theme} ${screen} ${size} capture`, 10000);
    assert.ok(png.length > 10000, `${theme} ${screen} ${size} capture`);
    fs.writeFileSync(path.join(captures, `showdex-live-${theme}-${screen}-${size}.png`), png);
    if (screen === 'hellodex' && size === 'default') {
      fs.writeFileSync(path.join(captures, `showdex-live-${theme}.png`), png);
    }
  };
  const choose = async (field, index, value) => {
    const selector = `input[id*=${JSON.stringify(field)}]`;
    await client.executeJavaScript(`(() => {
      const root = Array.from(document.querySelectorAll('[data-showdex-module=honkdex]')).find(el => el.getClientRects().length);
      const input = root.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!input || input.disabled) throw new Error('Missing calculator field: ' + ${JSON.stringify(field)});
      input.focus();
    })()`);
    await client.insertText(value);
    await until(() => client.executeJavaScript(`(() => {
      const root = Array.from(document.querySelectorAll('[data-showdex-module=honkdex]')).find(el => el.getClientRects().length);
      const option = Array.from(root.querySelectorAll('[class*=Dropdown-module-option--]'))
        .find(el => el.textContent.trim().startsWith(${JSON.stringify(value)}));
      if (!option) return false;
      option.click();
      return true;
    })()`), `select ${value}`, 10000);
    await pause(150);
  };
  let typeColors;
  for (const theme of ['light', 'dark']) {
    win.setSize(1366, 768);
    assert.equal((await desktop(`setSetting('theme', '${theme}')`)).ok, true);
    await until(() => client.executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`), `${theme} client theme`, 10000);
    await client.executeJavaScript("app.focusRoomRight('view-hellodex'); 0");
    await until(() => client.executeJavaScript("Boolean(document.querySelector('[data-showdex-module=hellodex]'))"), `${theme} Hellodex`);
    const hello = await checkChrome('hellodex', {
      panel: '[class*="Hellodex-module-instancesContent--"]',
      title: '[class*="Hellodex-module-extensionName--"]',
    }, ['panel']);
    assert.equal(hello.parts.title.backgroundImage, 'none', `${theme} Showdex title has no gradient`);
    assert.equal(hello.parts.title.textShadow, 'none', `${theme} Showdex title has no glow`);
    for (const size of ['default', 'minimum']) await capture(theme, 'hellodex', size);

    await click('[data-showdex-module="hellodex"] [class*="Hellodex-module-settingsButton--"]');
    await until(() => client.executeJavaScript("Boolean(document.querySelector('[data-showdex-module=hellodex] [class*=SettingsPane-module-container--]'))"), `${theme} Showdex settings`);
    await checkChrome('hellodex', {
      settingsOverlay: '[class*="SettingsPane-module-container--"]',
      settingsGroup: '[class*="SettingsPane-module-settingsGroup--"]',
    }, ['settingsOverlay', 'settingsGroup']);
    for (const size of ['default', 'minimum']) await capture(theme, 'settings', size);
    win.setSize(1366, 768);
    await pause(250);
    await click('[data-showdex-module="hellodex"] [class*="Hellodex-module-settingsButton--"]');
    await until(() => client.executeJavaScript("!document.querySelector('[data-showdex-module=hellodex] [class*=SettingsPane-module-container--]')"), `${theme} settings closed`);

    await click('[data-showdex-module="hellodex"] [class*="Hellodex-module-newInstanceButton--"]');
    await until(() => client.executeJavaScript("Boolean(document.querySelector('[data-showdex-module=honkdex]'))"), `${theme} blank Honkdex calculator`);
    await choose('SpeciesForme', 0, 'Pikachu');
    await choose('SpeciesForme', 1, 'Charizard');
    await choose(':Moves:0', 0, 'Thunderbolt');
    const honk = await checkChrome('honkdex', {
      card: '[data-showdex-layout="card"]',
      moves: '[class*="PokeMoves-module-container--"]',
      damage: '[class*="PokeMoves-module-damageButtonLabel--"]',
      label: '[class*="PokeInfo-module-label--"]',
      player: '[class*="PlayerCalc-module-container--"]',
      field: '[class*="FieldCalc-module-container--"]',
    }, ['card', 'moves']);
    assert.equal(honk.parts.label.color, honk.expected.secondary, `${theme} calculator labels readable`);
    assert.equal(honk.parts.damage.color, honk.expected.text, `${theme} damage range readable`);
    const colors = await client.executeJavaScript(`(() => {
      const root = Array.from(document.querySelectorAll('[data-showdex-module=honkdex]')).find(el => el.getClientRects().length);
      return ['electric', 'fire', 'flying'].map(type => {
        const pill = root.querySelector('[class*="PokeType-module-type-' + type + '--"]');
        const label = pill?.querySelector('[class*="PokeType-module-label--"]');
        return label && getComputedStyle(label).backgroundColor;
      });
    })()`);
    assert.equal(new Set(colors).size, 3, 'calculator type colors remain distinct');
    assert.ok(colors.every(color => color && color !== 'rgba(0, 0, 0, 0)'));
    if (typeColors) assert.deepEqual(colors, typeColors, 'app appearance preserves upstream type colors');
    typeColors = colors;
    assert.ok(honk.parts.player && honk.parts.field, `${theme} Honkdex player and field controls`);
    for (const size of ['default', 'minimum']) await capture(theme, 'honkdex', size);
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

  console.log('PASS Showdex live guest smoke: themed Hellodex, settings and populated Honkdex; type colors; visible footer; pending reload; disabled');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
