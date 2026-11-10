'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, nativeTheme, shell, dialog,
  protocol, session: electronSession, screen } = require('electron');
require('./profile').configureProfile(app);
const { Settings } = require('./settings');
const { ShowdownBridge } = require('./showdown');
const { Replays } = require('./replays');
const { Logger } = require('./logging');
const { WindowState } = require('./window-state');
const { ShowdexIntegration, registerShowdexScheme } = require('./showdex-integration');

if (!app.isReady()) registerShowdexScheme(protocol);
const showdex = new ShowdexIntegration();
let showdexBundle = { installed: false, version: '1.4.2' };
let showdexApplied = false;
let showdexLoadFailed = false;

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const CLIENT_CSS = fs.readFileSync(path.join(__dirname, 'client-theme.css'), 'utf8');
// Window and view fills shown before pages paint; match --bg-app in each theme.
const BACKGROUND = { light: '#e6ecf5', dark: '#24304a' };
const RENDERER_URL = pathToFileURL(RENDERER_DIR + path.sep).href;
const CLIENT_URL = 'https://play.pokemonshowdown.com/';
// Persistent partition keeps the Showdown login across launches, isolated from the launcher.
const CLIENT_PARTITION = 'persist:showdown';
// Showdown's "Log in with Google" opens a popup; everything else goes to the system browser.
const POPUP_HOSTS = new Set(['accounts.google.com']);

let win = null;
let client = null;
let settings = null;
let replays = null;
let replayDirty = false;
let confirmingClose = false;
let allowClose = false;
let maintenance = false;
let logger = null;
let windowState = null;
const bridge = new ShowdownBridge(() => (client ? client.webContents : null));

function background() {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isShowdownUrl(url) {
  const u = parseUrl(url);
  return Boolean(u && u.protocol === 'https:' &&
    (u.hostname === 'pokemonshowdown.com' || u.hostname.endsWith('.pokemonshowdown.com')));
}

function openExternal(url) {
  const u = parseUrl(url);
  if (u && (u.protocol === 'https:' || u.protocol === 'http:')) shell.openExternal(u.href);
}

function isLauncherFrame(event) {
  return Boolean(win && event.sender === win.webContents &&
    event.senderFrame && event.senderFrame.url.startsWith(RENDERER_URL));
}

function toBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 20000) return null;
    out[key] = Math.round(n);
  }
  return out.width > 0 && out.height > 0 ? out : null;
}

// Loaded hidden at startup so Home can read formats, teams and rooms. Leaving Play only
// hides it, so an active battle survives screen changes.
function ensureClient() {
  if (client) return client;

  client = new WebContentsView({
    webPreferences: {
      partition: CLIENT_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep battle timers and the connection running at full speed while hidden.
      backgroundThrottling: false,
    },
  });
  client.setVisible(false);
  client.setBackgroundColor(background());

  const contents = client.webContents;
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame) logger.write('client-load-failed', code);
  });
  contents.on('render-process-gone', () => logger.write('client-process-gone'));
  // Re-applied on every load; the stylesheet follows prefers-color-scheme, which tracks nativeTheme.
  contents.on('dom-ready', () => {
    contents.insertCSS(CLIENT_CSS, { cssOrigin: 'user' }).catch(() => {});
    showdexApplied = Boolean(showdexBundle.installed && settings.get('showdexEnabled'));
    showdexLoadFailed = false;
    if (showdexApplied) bridge.loadShowdex().then((loaded) => {
      if (!loaded) showdexLoadFailed = true;
    });
  });
  contents.setWindowOpenHandler(({ url }) => {
    const u = parseUrl(url);
    if (u && u.protocol === 'https:' && POPUP_HOSTS.has(u.hostname)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isShowdownUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });

  win.contentView.addChildView(client);
  contents.loadURL(CLIENT_URL).catch(() => {});
  return client;
}

function hideClient() {
  if (client) client.setVisible(false);
}

function windowDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display) => ({ ...display, primary: display.id === primary }));
}

function createWindow() {
  const { maximized, ...savedBounds } = windowState.load(windowDisplays());
  win = new BrowserWindow({
    ...savedBounds,
    minWidth: 1024,
    minHeight: 640,
    title: 'Showdown Desktop',
    backgroundColor: background(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const currentWindow = win;
  let windowSaveTimer;
  const persistWindow = () => {
    if (!currentWindow.isDestroyed()) windowState.save({
      bounds: currentWindow.getNormalBounds(), maximized: currentWindow.isMaximized(),
    });
  };
  for (const event of ['move', 'resize', 'maximize', 'unmaximize']) {
    currentWindow.on(event, () => {
      clearTimeout(windowSaveTimer);
      windowSaveTimer = setTimeout(persistWindow, 250);
    });
  }

  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(RENDERER_URL)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  // Every launcher page change hides the client; play.html shows it again with fresh bounds.
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      hideClient();
    }
  });

  win.on('close', (event) => {
    if (allowClose) { persistWindow(); return; }
    event.preventDefault();
    if (confirmingClose) return;
    confirmingClose = true;
    (async () => {
      if (maintenance) return;
      if (replayDirty && !(await confirmDiscardReplay())) return;
      if (settings.get('confirmOnClose') && !(await confirmClientInterruption('Close app', 'Close the app?'))) return;
      if (win) {
        allowClose = true;
        win.close();
      }
    })().catch(() => {}).finally(() => { confirmingClose = false; });
  });

  win.once('ready-to-show', () => {
    if (maximized) win.maximize();
    win.show();
  });
  win.on('closed', () => {
    clearTimeout(windowSaveTimer);
    if (client && !client.webContents.isDestroyed()) client.webContents.close();
    win = null;
    client = null;
    allowClose = false;
  });
  const pages = { home: 'index.html', showdown: 'play.html', replays: 'replays.html' };
  win.loadFile(path.join(RENDERER_DIR, pages[settings.get('startPage')] || 'index.html'));
  ensureClient();
}

ipcMain.on('client:show', (event, value) => {
  if (!isLauncherFrame(event)) return;
  if (maintenance && !client) return;
  const bounds = toBounds(value);
  if (!bounds) return;
  const view = ensureClient();
  view.setBounds(bounds);
  view.setVisible(true);
});

ipcMain.on('client:hide', (event) => {
  if (isLauncherFrame(event)) hideClient();
});

ipcMain.handle('client:reload', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance) return { ok: false, error: 'Another operation is in progress.' };
  maintenance = true;
  try {
    if (!(await confirmClientInterruption('Reload client', 'Reload the Showdown client?'))) return { ok: true, cancelled: true };
    if (client) client.webContents.reload();
    logger.write('client-reload-requested');
    return { ok: true };
  } finally { maintenance = false; }
});

async function confirmClientInterruption(title, message) {
  const state = await Promise.race([
    bridge.session(), new Promise((resolve) => setTimeout(() => resolve({ ready: false }), 2000)),
  ]);
  const active = state.ready && (state.rooms.some((room) => room.battle && !room.ended &&
    state.me && room.players.includes(state.me)) || state.search.pending || state.search.formats.length);
  if (state.ready && !active) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', title, message,
    detail: active ? 'A battle or search is in progress. The connection will be interrupted.' :
      'The client state could not be checked. A battle or search may still be running.',
    buttons: ['Cancel', title], defaultId: 0, cancelId: 0, noLink: true,
  });
  return response === 1;
}

ipcMain.handle('showdown:snapshot', (event) => {
  if (!isLauncherFrame(event)) return { ready: false };
  return bridge.snapshot();
});

ipcMain.handle('showdown:session', (event) => {
  if (!isLauncherFrame(event)) return { ready: false, rooms: [] };
  return bridge.session();
});

ipcMain.handle('showdown:action', (event, action, args) => {
  if (!isLauncherFrame(event) || typeof action !== 'string') return false;
  return bridge.act(action, args);
});

async function confirmDiscardReplay() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', title: 'Unsaved replay note',
    message: 'Discard unsaved changes?',
    detail: 'Changes to this replay note have not been saved.',
    buttons: ['Keep editing', 'Discard changes'], defaultId: 0, cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

ipcMain.handle('replays:list', (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  return replays.list();
});

ipcMain.handle('replays:save', (event, value) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  return replays.save(value);
});

ipcMain.handle('replays:delete', async (event, id) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (!replays.get(id)) return { ok: false, error: 'Replay note not found.' };
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', title: 'Delete replay note', message: 'Delete this replay note?',
    detail: 'The local note will be deleted. The replay hosted by Showdown is kept. This cannot be undone.',
    buttons: ['Cancel', 'Delete note'], defaultId: 0, cancelId: 0, noLink: true,
  });
  return response === 1 ? replays.delete(id) : { ok: true, cancelled: true };
});

ipcMain.handle('replays:open', async (event, id) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  const note = replays.get(id);
  if (!note) return { ok: false, error: 'Replay note not found.' };
  try {
    await shell.openExternal(note.url);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Failed to open the replay in your browser.' };
  }
});

ipcMain.handle('replays:confirm-discard', (event) => {
  return isLauncherFrame(event) ? confirmDiscardReplay() : false;
});

ipcMain.on('replays:dirty', (event, dirty) => {
  if (isLauncherFrame(event) && new URL(event.senderFrame.url).pathname.endsWith('/replays.html') && typeof dirty === 'boolean') {
    replayDirty = dirty;
  }
});

ipcMain.handle('replays:draft', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  const session = await bridge.session();
  const battle = session.ready && session.rooms.find((room) => room.id === session.current && room.battle);
  if (!battle) return { ok: true, draft: null };
  // A room ID is not proof that a replay has been uploaded, and lacks private tokens.
  return { ok: true, draft: {
    title: (battle.players.filter(Boolean).join(' vs. ') || battle.title).slice(0, 120),
    format: /^battle-([a-z0-9]+)-\d+/.exec(battle.id)?.[1] || '',
    url: '',
  } };
});

ipcMain.handle('settings:get-theme', (event) => {
  if (!isLauncherFrame(event)) return null;
  return settings.get('theme');
});

ipcMain.handle('settings:get', (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (settings.loadError) return { ok: false, error: settings.loadError };
  return { ok: true, settings: settings.snapshot() };
});

ipcMain.handle('showdex:status', async (event) => {
  if (!isLauncherFrame(event)) return null;
  const enabled = settings.get('showdexEnabled');
  const status = showdexBundle.invalid ? 'failed' : !showdexBundle.installed ? 'not-installed' : !showdexApplied ? 'disabled' :
    showdexLoadFailed ? 'failed' : await bridge.showdexStatus();
  return {
    installed: showdexBundle.installed, enabled, loaded: status === 'loaded', status,
    pendingReload: showdexBundle.installed && enabled !== showdexApplied,
    error: status === 'failed' ? 'Showdex failed to load. Ordinary Showdown play is still available.' : '',
    version: showdexBundle.version,
  };
});

ipcMain.handle('settings:set', (event, key, value) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance) return { ok: false, error: 'Another operation is in progress.' };
  try {
    if (!settings.set(key, value)) return { ok: false, error: 'Invalid setting.' };
    nativeTheme.themeSource = settings.get('theme');
    return { ok: true, settings: settings.snapshot() };
  } catch {
    logger.write('settings-save-failed');
    return { ok: false, error: 'Settings could not be saved. Previous settings were kept.' };
  }
});

ipcMain.handle('settings:open-logs', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  logger.write('logs-opened');
  try {
    const error = await shell.openPath(logger.dir);
    return error ? { ok: false, error: 'Failed to open the logs folder.' } : { ok: true };
  } catch { return { ok: false, error: 'Failed to open the logs folder.' }; }
});

ipcMain.handle('settings:sign-out', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance) return { ok: false, error: 'Another operation is in progress.' };
  maintenance = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', title: 'Sign out of Showdown', message: 'Sign out and clear saved Showdown data?',
      detail: 'This disconnects battles and searches and removes local Showdown teams, preferences and login data. Export any teams you want to keep first. Replay notes are kept.',
      buttons: ['Cancel', 'Sign out and clear data'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return { ok: true, cancelled: true };
    const old = ensureClient();
    const clientSession = old.webContents.session;
    const bounds = old.getBounds();
    const visible = old.getVisible();
    win.contentView.removeChildView(old);
    client = null;
    // Stop the client before clearing storage so it cannot write the login back.
    await new Promise((resolve) => {
      old.webContents.once('destroyed', resolve);
      old.webContents.close();
    });
    for (const popup of BrowserWindow.getAllWindows()) {
      if (popup !== win && popup.webContents.session === clientSession) popup.destroy();
    }
    try {
      await clientSession.clearStorageData();
      await clientSession.clearCache();
      await clientSession.clearAuthCache();
      bridge.ratings.clear();
      bridge.friendsCache.clear();
      logger.write('showdown-signed-out');
    } finally {
      const next = ensureClient();
      next.setBounds(bounds);
      next.setVisible(visible);
    }
    return { ok: true };
  } catch {
    logger.write('showdown-sign-out-failed');
    return { ok: false, error: 'Could not clear all Showdown data. Try again.' };
  } finally { maintenance = false; }
});

ipcMain.handle('settings:reset', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance) return { ok: false, error: 'Another operation is in progress.' };
  maintenance = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', title: 'Reset launcher data', message: 'Reset settings and delete all replay notes?',
      detail: 'Launcher preferences and unsaved notes will also be discarded. Your Showdown session and teams are kept. This cannot be undone.',
      buttons: ['Cancel', 'Reset launcher data'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return { ok: true, cancelled: true };
    // Remove only the launcher's two data files, never the Showdown partition.
    settings.reset();
    fs.rmSync(path.join(app.getPath('userData'), 'replays.json'), { force: true });
    fs.rmSync(path.join(app.getPath('userData'), 'window-state.json'), { force: true });
    win.unmaximize();
    const defaultBounds = windowState.load(windowDisplays());
    win.setSize(defaultBounds.width, defaultBounds.height);
    win.center();
    nativeTheme.themeSource = settings.get('theme');
    await win.webContents.executeJavaScript('localStorage.clear(); sessionStorage.clear(); void 0');
    replayDirty = false;
    logger.write('launcher-data-reset');
    return { ok: true, settings: settings.snapshot() };
  } catch {
    logger.write('launcher-reset-failed');
    return { ok: false, error: 'Reset could not finish. Some launcher data may already have been cleared.' };
  } finally { maintenance = false; }
});

ipcMain.handle('settings:set-theme', (event, value) => {
  if (!isLauncherFrame(event)) return false;
  try {
    if (!settings.set('theme', value)) return false;
  } catch {
    return false;
  }
  nativeTheme.themeSource = value;
  return true;
});

nativeTheme.on('updated', () => {
  if (win) win.setBackgroundColor(background());
  if (client) client.setBackgroundColor(background());
});

app.whenReady().then(async () => {
  logger = new Logger(app.getPath('userData'));
  logger.write('app-started');
  settings = new Settings(app.getPath('userData'));
  windowState = new WindowState(app.getPath('userData'));
  replays = new Replays(app.getPath('userData'));
  try {
    showdexBundle = await showdex.registerAssets(electronSession.fromPartition(CLIENT_PARTITION));
  } catch {
    logger.write('showdex-assets-failed');
  }
  nativeTheme.themeSource = settings.get('theme');
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
