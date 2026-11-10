'use strict';

const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { WebContentsView } = require('electron');

function allowRequest(details, root, connection) {
  let url;
  try { url = new URL(details.url); } catch { return false; }
  if (url.protocol === 'file:') {
    try {
      if (url.hostname) return false;
      const relative = path.relative(root, fileURLToPath(url));
      return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    } catch { return false; }
  }
  if (url.protocol === 'ws:') return url.href === `ws://127.0.0.1:${connection.port}/showdown/websocket?token=${connection.token}`;
  const spriteVersion = (url.pathname === '/sprites/pokemonicons-sheet.png' && url.search === '?v22') ||
    (url.pathname === '/sprites/itemicons-sheet.png' && url.search === '?v1');
  return details.resourceType === 'image' && url.origin === 'https://play.pokemonshowdown.com' &&
    /^\/(sprites|fx)\/[a-zA-Z0-9_./-]+\.(png|gif|webp|jpg)$/.test(url.pathname) && (!url.search || spriteVersion) && !url.hash;
}

class PracticeView {
  constructor({ window, root, css, background, onFailure = () => {}, View = WebContentsView }) {
    this.window = window;
    this.root = root;
    this.css = css;
    this.background = background;
    this.View = View;
    this.onFailure = onFailure;
    this.view = null;
    this.visible = false;
    this.bounds = null;
    this.error = '';
  }

  open(connection) {
    this.close();
    this.error = '';
    const view = new this.View({ webPreferences: { partition: `practice-${connection.token}`,
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    this.view = view;
    this.connectionToken = connection.token;
    view.setBackgroundColor(this.background);
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    const contents = view.webContents;
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    contents.session.on('will-download', event => event.preventDefault());
    contents.session.webRequest.onBeforeRequest((details, respond) => respond({ cancel: !allowRequest(details, this.root, connection) }));
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-frame-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('dom-ready', () => {
      if (this.view === view) contents.insertCSS(this.css, { cssOrigin: 'user' }).catch(() => {});
    });
    const failed = () => {
      if (this.view !== view) return;
      this.error = 'Practice client could not load. Stop and start a new session.';
      view.setVisible(false);
      contents.setAudioMuted(true);
      this.onFailure(connection.token);
    };
    contents.on('render-process-gone', failed);
    contents.on('did-fail-load', (_event, code, _description, _url, main) => { if (main && code !== -3) failed(); });
    const url = pathToFileURL(path.join(this.root, 'practice-client.html'));
    for (const key of ['port', 'token', 'human', 'bot']) url.searchParams.set(key, String(connection[key]));
    contents.loadURL(url.href).catch(failed);
    this.place();
  }

  show(bounds) {
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 20000)) return false;
    const content = this.window.getContentBounds();
    const x = Math.round(bounds.x), y = Math.round(bounds.y);
    this.bounds = { x, y, width: Math.min(Math.round(bounds.width), content.width - x),
      height: Math.min(Math.round(bounds.height), content.height - y) };
    this.visible = this.bounds.width > 0 && this.bounds.height > 0;
    this.place();
    return this.visible;
  }

  hide() { this.visible = false; this.place(); }

  async status() {
    if (!this.view || this.view.webContents.isDestroyed()) return { state: 'idle', error: this.error };
    const view = this.view;
    const token = this.connectionToken;
    try {
      const state = await view.webContents.executeJavaScript('document.documentElement.dataset.practiceState || "connecting"');
      if (view !== this.view) return { state: 'idle', error: '' };
      if (state === 'failed') {
        this.error = 'The local battle client disconnected. Start a new session to try again.';
        this.onFailure(token);
      }
      return { state: ['connecting', 'ready', 'battle', 'finished', 'failed'].includes(state) ? state : 'connecting', error: this.error };
    } catch { return { state: 'connecting', error: this.error }; }
  }

  place() {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (this.bounds && this.bounds.width > 0 && this.bounds.height > 0) this.view.setBounds(this.bounds);
    this.view.setVisible(this.visible && !this.error);
    this.view.webContents.setAudioMuted(!this.visible || Boolean(this.error));
  }

  close() {
    this.error = '';
    if (!this.view) return;
    const view = this.view;
    this.view = null;
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) { view.webContents.setAudioMuted(true); view.webContents.close(); }
  }
}

module.exports = { PracticeView, allowRequest };
