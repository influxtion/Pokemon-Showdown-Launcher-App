'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, nativeTheme, shell } = require('electron');
const { Settings } = require('./settings');
const { ShowdownBridge } = require('./showdown');

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
  // Re-applied on every load; the stylesheet follows prefers-color-scheme, which tracks nativeTheme.
  contents.on('dom-ready', () => {
    contents.insertCSS(CLIENT_CSS, { cssOrigin: 'user' }).catch(() => {});
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
  contents.loadURL(CLIENT_URL);
  return client;
}

function hideClient() {
  if (client) client.setVisible(false);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366,
    height: 768,
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
    if (details.isMainFrame && !details.isSameDocument) hideClient();
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
    client = null;
  });
  win.loadFile(path.join(RENDERER_DIR, 'index.html'));
  ensureClient();
}

ipcMain.on('client:show', (event, value) => {
  if (!isLauncherFrame(event)) return;
  const bounds = toBounds(value);
  if (!bounds) return;
  const view = ensureClient();
  view.setBounds(bounds);
  view.setVisible(true);
});

ipcMain.on('client:hide', (event) => {
  if (isLauncherFrame(event)) hideClient();
});

ipcMain.on('client:reload', (event) => {
  if (isLauncherFrame(event) && client) client.webContents.reload();
});

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

ipcMain.handle('settings:get-theme', (event) => {
  if (!isLauncherFrame(event)) return null;
  return settings.get('theme');
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

app.whenReady().then(() => {
  settings = new Settings(app.getPath('userData'));
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
