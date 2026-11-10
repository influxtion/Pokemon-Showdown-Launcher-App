'use strict';

const { WebContentsView } = require('electron');
const { normalizeReplayUrl } = require('./replays');

const PARTITION = 'replay-review';
const LOAD_ERROR = 'Could not load the replay.';
const ROUTE_ERROR = 'Replay page changed. Reload to return to this note.';
const securedSessions = new WeakSet();

function secureSession(session) {
  if (securedSessions.has(session)) return;
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  session.on('will-download', (event) => event.preventDefault());
  securedSessions.add(session);
}

function matchesReplayRoute(value, savedUrl) {
  if (typeof value !== 'string' || value.length > 500) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.origin + url.pathname !== savedUrl || url.username || url.password) return false;
  // The upstream router can read a fragment as part of the replay ID.
  if (url.href.includes('#')) return false;

  // The replay player changes the query in place when switching viewpoints.
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === 'p2' && (value === '' || value === '1')) continue;
    if ((key === 'turn' || key === 't') && /^\d{1,5}$/.test(value) && Number(value) <= 10000) continue;
    return false;
  }
  return true;
}

function fitBounds(value, content) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = [value.x, value.y, value.width, value.height];
  if (fields.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [x, y, width, height] = fields.map(Math.round);
  const clippedWidth = Math.min(width, content.width - x);
  const clippedHeight = Math.min(height, content.height - y);
  if (clippedWidth <= 0 || clippedHeight <= 0) return null;
  return { x, y, width: clippedWidth, height: clippedHeight };
}

class ReplayReview {
  constructor({ window, css, background, View = WebContentsView }) {
    this.window = window;
    this.css = css;
    this.background = background;
    this.View = View;
    this.view = null;
    this.note = null;
    this.bounds = null;
    this.state = 'idle';
    this.error = '';
  }

  status() {
    return { ok: true, state: this.state, error: this.error, noteId: this.note?.id ?? null };
  }

  open(note, bounds) {
    const url = normalizeReplayUrl(note?.url);
    if (!url || typeof note.id !== 'string' || !note.id.trim() || note.id.length > 100) {
      return { ok: false, error: 'Choose a saved replay note.' };
    }
    const fitted = this.fit(bounds);
    if (!fitted) return { ok: false, error: 'Replay player area is unavailable.' };
    this.bounds = fitted;
    if (this.note?.id === note.id && this.note.url === url) {
      this.placeView();
    } else {
      this.note = { id: note.id, url };
      this.startLoad();
    }
    return this.status();
  }

  show(bounds) {
    if (!this.note) return this.status();
    this.bounds = this.fit(bounds);
    this.placeView();
    return this.status();
  }

  reload() {
    if (!this.note) return { ok: false, error: 'Choose a saved replay note.' };
    if (this.window.isDestroyed()) return { ok: false, error: 'Replay player area is unavailable.' };
    this.bounds = this.fit(this.bounds);
    this.startLoad();
    return this.status();
  }

  close() {
    this.disposeView();
    this.note = null;
    this.bounds = null;
    this.state = 'idle';
    this.error = '';
    return this.status();
  }

  backgroundChanged(color) {
    this.background = color;
    this.view?.setBackgroundColor(color);
  }

  fit(bounds) {
    return this.window.isDestroyed() ? null : fitBounds(bounds, this.window.getContentBounds());
  }

  placeView() {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    const visible = this.state === 'loaded' && Boolean(this.bounds);
    if (this.bounds) view.setBounds(this.bounds);
    view.webContents.setAudioMuted(!visible);
    view.setVisible(visible);
  }

  disposeView() {
    const view = this.view;
    if (!view) return;
    this.view = null;
    const contents = view.webContents;
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    if (!contents.isDestroyed()) contents.close();
  }

  startLoad() {
    this.disposeView();
    this.state = 'loading';
    this.error = '';

    const url = this.note.url;
    const view = new this.View({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.view = view;
    view.setVisible(false);
    view.setBackgroundColor(this.background);

    const contents = view.webContents;
    secureSession(contents.session);
    const current = () => this.view === view && this.state !== 'failed';
    const fail = (error = LOAD_ERROR) => {
      if (!current()) return;
      this.state = 'failed';
      this.error = error;
      this.placeView();
      // Release the failed page after Electron finishes dispatching its navigation event.
      setImmediate(() => {
        if (this.view === view) this.disposeView();
      });
    };
    const allows = (destination) => matchesReplayRoute(destination, url);

    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-frame-navigate', (event) => {
      if (!current() || !event.isMainFrame || !allows(event.url)) event.preventDefault();
    });
    contents.on('will-redirect', (event) => {
      event.preventDefault();
      if (event.isMainFrame) fail();
    });
    contents.on('did-start-navigation', (event) => {
      if (!current() || !event.isMainFrame || event.isSameDocument || !allows(event.url)) return;
      this.state = 'loading';
      this.placeView();
    });
    contents.on('did-navigate-in-page', (_event, destination, mainFrame) => {
      if (mainFrame && !allows(destination)) fail(ROUTE_ERROR);
    });
    contents.on('did-navigate', (_event, destination, code) => {
      if (!allows(destination)) fail(ROUTE_ERROR);
      else if (code >= 400) fail();
    });
    contents.on('did-fail-load', (_event, code, _description, _destination, mainFrame) => {
      // A superseded provisional load can abort before the next navigation commits.
      if (mainFrame && code !== -3) fail();
    });
    contents.on('render-process-gone', () => fail());
    contents.on('destroyed', () => fail());
    contents.on('dom-ready', () => {
      if (current() && this.css) contents.insertCSS(this.css, { cssOrigin: 'user' }).catch(() => {});
    });
    contents.on('did-finish-load', () => {
      if (!current()) return;
      if (!allows(contents.getURL())) {
        fail(ROUTE_ERROR);
        return;
      }
      this.state = 'loaded';
      this.placeView();
    });

    this.window.contentView.addChildView(view);
    this.placeView();
    contents.loadURL(url).catch(() => fail());
  }
}

module.exports = { ReplayReview };
