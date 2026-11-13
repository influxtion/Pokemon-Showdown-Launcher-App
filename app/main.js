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
const { ReplayImports } = require('./replay-imports');
const { ReplayReview } = require('./replay-review');
const { PracticeRuntime } = require('./practice-runtime');
const { HostedPractice } = require('./hosted-practice');
const { readBotConfig, runtimeOptions } = require('./bot-config');
const { PracticeView } = require('./practice-view');
const { Logger } = require('./logging');
const { WindowState } = require('./window-state');
const { ShowdexIntegration, registerShowdexScheme } = require('./showdex-integration');

if (!app.isReady()) registerShowdexScheme(protocol);
const showdex = new ShowdexIntegration();
let showdexBundle = { installed: false, version: '1.4.2' };
let showdexApplied = false;
let showdexLoadFailed = false;

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const CLIENT_CSS = ['client-theme.css', 'client-shell.css', 'client-battle.css', 'client-ladder.css', 'showdex-theme.css']
  .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
const REPLAY_CSS = ['client-theme.css', 'replay-theme.css']
  .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
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
let replayImports = null;
let replayReview = null;
let practice = null;
let practiceView = null;
let choosingReplayImport = false;
let undoingReplayImport = false;
let replayDirty = false;
let exportingReplays = false;
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

function reviewNoteId(event) {
  if (!isLauncherFrame(event)) return null;
  const url = parseUrl(event.senderFrame.url);
  if (!url || !url.pathname.endsWith('/replays.html')) return null;
  const id = url.searchParams.get('review');
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
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
    bridge.installFormatModal();
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
    opacity: process.env.SHOWDOWN_DESKTOP_BACKGROUND === '1' ? 0 : 1,
    focusable: process.env.SHOWDOWN_DESKTOP_BACKGROUND !== '1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const currentWindow = win;
  if (process.env.SHOWDOWN_DESKTOP_BACKGROUND === '1') win.setIgnoreMouseEvents(true);
  replayReview = new ReplayReview({ window: win, css: REPLAY_CSS, background: background() });
  let practiceRoot = app.isPackaged ? path.join(process.resourcesPath, 'practice')
    : path.join(__dirname, '..', 'vendor', 'laplace', 'dist');
  const practiceScripts = app.isPackaged ? path.join(process.resourcesPath, 'practice-adapter')
    : path.join(__dirname, '..', 'scripts', 'laplace');
  try {
    const service = process.env.SHOWDOWN_BOT_SERVICE_URL;
    const botConfig = !service && !app.isPackaged ? readBotConfig(process.env.SHOWDOWN_BOT_CONFIG || path.join(__dirname, '../out/bots/config.json')) : null;
    if (botConfig) practiceRoot = botConfig.root;
    practice = service
      ? new HostedPractice({ url: service, key: process.env.SHOWDOWN_BOT_SERVICE_KEY })
      : new PracticeRuntime(botConfig ? runtimeOptions(botConfig, path.join(__dirname, '..')) : { root: practiceRoot, scripts: practiceScripts });
  } catch {
    practice = new PracticeRuntime({ root: practiceRoot, scripts: practiceScripts });
    practice.installed = () => false;
    practice.state = 'failed';
    practice.error = 'Battle configuration could not load. Check the server address and runtime setup.';
  }
  practiceView = new PracticeView({ window: win, root: path.join(practiceRoot, 'client'), css: CLIENT_CSS,
    background: background(), onFailure: token => practice?.clientFailed(token) });
  practice.on('ready', connection => { logger.write('practice-ready'); practiceView?.open(connection); });
  practice.on('failure', code => logger.write('practice-failed', { start: 1, exited: 2, timeout: 3, client: 4, integrity: 5 }[code] || 0));
  practice.on('change', state => { if (state.state === 'failed' || state.state === 'idle') practiceView?.close(); });
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
      replayReview?.close();
      practiceView?.hide();
    }
  });
  contents.on('did-navigate', () => {
    // An outgoing page's ResizeObserver can enqueue bounds during navigation.
    if (!parseUrl(contents.getURL())?.pathname.endsWith('/practice.html')) practiceView?.hide();
  });

  win.on('close', (event) => {
    if (allowClose) { persistWindow(); return; }
    event.preventDefault();
    if (confirmingClose) return;
    confirmingClose = true;
    (async () => {
      if (maintenance) return;
      if (replayDirty && !(await confirmDiscardReplay())) return;
      if (settings.get('confirmOnClose') && practice?.battle && !practice.battle.finished) {
        const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['Keep playing', 'Close app'],
          defaultId: 0, cancelId: 0, message: 'Close during practice?', detail: 'The practice battle will end.' });
        if (result.response !== 1) return;
      }
      if (settings.get('confirmOnClose') && !(await confirmClientInterruption('Close app', 'Close the app?'))) return;
      if (win) {
        allowClose = true;
        win.close();
      }
    })().catch(() => {}).finally(() => { confirmingClose = false; });
  });

  win.once('ready-to-show', () => {
    if (maximized) win.maximize();
    if (process.env.SHOWDOWN_DESKTOP_BACKGROUND === '1') win.showInactive();
    else win.show();
  });
  win.on('closed', () => {
    clearTimeout(windowSaveTimer);
    if (client && !client.webContents.isDestroyed()) client.webContents.close();
    replayReview?.close();
    replayReview = null;
    if (practice?.dispose) practice.dispose();
    else practice?.stop();
    practiceView?.close();
    practice = null;
    practiceView = null;
    win = null;
    client = null;
    allowClose = false;
  });
  const pages = { home: 'index.html', showdown: 'play.html', replays: 'replays.html' };
  win.loadFile(path.join(RENDERER_DIR, pages[settings.get('startPage')] || 'index.html'));
  ensureClient();
}

function isPracticeFrame(event) {
  return isLauncherFrame(event) && parseUrl(event.senderFrame.url)?.pathname.endsWith('/practice.html') &&
    parseUrl(win.webContents.getURL())?.pathname.endsWith('/practice.html');
}

ipcMain.handle('practice:status', async event => {
  if (!isLauncherFrame(event)) return null;
  const clientState = await practiceView.status();
  return { ...practice.status(), clientState: clientState.state, clientError: clientState.error };
});
ipcMain.handle('practice:start', (event, preset) => {
  if (!isPracticeFrame(event)) return { ok: false };
  return practice.start(preset);
});
ipcMain.handle('practice:stop', async event => {
  if (!isPracticeFrame(event)) return { ok: false };
  if (practice.battle && !practice.battle.finished) {
    const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['Keep playing', 'Stop practice'],
      defaultId: 0, cancelId: 0, message: 'Stop this practice session?', detail: 'The practice battle will end.' });
    if (result.response !== 1) return { ok: false, cancelled: true };
  }
  return practice.stop();
});
ipcMain.handle('practice:show', (event, bounds) => {
  if (!isPracticeFrame(event)) return { ok: false };
  return { ok: practiceView.show(bounds) };
});
ipcMain.handle('practice:next', async event => {
  if (!isPracticeFrame(event) || !practice.battle?.finished || !practiceView.view) return { ok: false };
  try {
    const ok = await practiceView.view.webContents.executeJavaScript('Boolean(window.desktopPracticeStart?.())');
    return { ok };
  } catch { return { ok: false, error: 'Could not start another battle. Stop and try again.' }; }
});

ipcMain.on('client:show', (event, value) => {
  if (!isLauncherFrame(event)) return;
  if (maintenance && !client) return;
  const bounds = toBounds(value);
  if (!bounds) return;
  const view = ensureClient();
  view.setBounds(bounds);
  view.setVisible(true);
});

ipcMain.handle('review:show', (event, bounds) => {
  const id = reviewNoteId(event);
  if (!id) return { ok: false, error: 'This saved replay note is unavailable.' };
  if (replayReview.status().noteId === id) return replayReview.show(bounds);
  const note = replays.get(id);
  if (!note) return { ok: false, error: 'This saved replay note is unavailable.' };
  hideClient();
  return replayReview.open(note, bounds);
});

ipcMain.handle('review:status', (event) => {
  const id = reviewNoteId(event);
  if (!id || replayReview.status().noteId !== id) return { ok: false, error: 'This saved replay note is unavailable.' };
  return replayReview.status();
});

ipcMain.handle('review:reload', (event) => {
  const id = reviewNoteId(event);
  if (!id || replayReview.status().noteId !== id) return { ok: false, error: 'This saved replay note is unavailable.' };
  return replayReview.reload();
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

ipcMain.handle('replays:export', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (exportingReplays) return { ok: false, error: 'An export is already in progress.' };
  exportingReplays = true;
  try {
    const current = replays.list();
    if (!current.ok) return current;
    const result = await dialog.showSaveDialog(win, {
      title: 'Export saved replay notes and links',
      defaultPath: path.join(app.getPath('documents'), `showdown-replay-notes-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'Replay notes (JSON)', extensions: ['json'] }],
      properties: ['showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { ok: true, cancelled: true };
    return replays.exportTo(result.filePath);
  } catch {
    return { ok: false, error: 'Could not export replay notes. Try again.' };
  } finally {
    exportingReplays = false;
  }
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

ipcMain.handle('replays:choose-import', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (choosingReplayImport) return { ok: false, error: 'An import file picker is already open.' };
  choosingReplayImport = true;
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Import replay notes',
      filters: [{ name: 'Replay notes (JSON)', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths?.length || !isLauncherFrame(event)) {
      return { ok: true, cancelled: true };
    }
    return replayImports.previewFile(result.filePaths[0]);
  } catch {
    return { ok: false, error: 'Could not open the replay notes file. Try again.' };
  } finally { choosingReplayImport = false; }
});

ipcMain.handle('replays:commit-import', (event, token, choices) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance || undoingReplayImport) return { ok: false, error: 'Another operation is in progress.' };
  if (replayDirty) return { ok: false, error: 'Save your unsaved note before importing. Your changes have been kept.' };
  return replayImports.commit(token, choices);
});

ipcMain.handle('replays:cancel-import', (event, token) => {
  if (!isLauncherFrame(event)) return false;
  replayImports.cancel(token);
  return true;
});

ipcMain.handle('replays:import-status', (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  return replayImports.status();
});

ipcMain.handle('replays:undo-import', async (event) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Access denied.' };
  if (maintenance || undoingReplayImport) return { ok: false, error: 'Another operation is in progress.' };
  if (replayDirty) return { ok: false, error: 'Save your unsaved note before undoing an import. Your changes have been kept.' };
  if (!replayImports.status().canUndo) return { ok: false, error: 'This import can no longer be undone. Notes may have changed or the app was restarted.' };
  undoingReplayImport = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', title: 'Undo replay note import', message: 'Undo the last import?',
      detail: 'Restore your saved notes to exactly how they were before that import. The imported file is kept.',
      buttons: ['Keep imported notes', 'Undo import'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return { ok: true, cancelled: true };
    if (maintenance || replayDirty) return { ok: false, error: 'Notes are being edited. Finish editing before undoing the import.' };
    return replayImports.undo();
  } catch {
    return { ok: false, error: 'Could not undo the import. Your notes were kept.' };
  } finally { undoingReplayImport = false; }
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
    replayImports.reset();
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
  replayReview?.backgroundChanged(background());
  if (practiceView) {
    practiceView.background = background();
    practiceView.view?.setBackgroundColor(background());
  }
});

app.whenReady().then(async () => {
  logger = new Logger(app.getPath('userData'));
  logger.write('app-started');
  settings = new Settings(app.getPath('userData'));
  windowState = new WindowState(app.getPath('userData'));
  replays = new Replays(app.getPath('userData'));
  replayImports = new ReplayImports(replays);
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
