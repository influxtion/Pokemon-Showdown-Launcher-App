'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { ReplayReview } = require('../app/replay-review');

const NOTE = { id: 'note-1', url: 'https://replay.pokemonshowdown.com/gen9ou-12345-examplepw' };
const OTHER = { id: 'note-2', url: 'https://replay.pokemonshowdown.com/gen9ou-67890' };
const BOUNDS = { x: 177, y: 70, width: 500, height: 400 };

function harness() {
  const views = [];
  const session = new EventEmitter();
  session.setPermissionCheckHandler = (handler) => { session.check = handler; };
  session.setPermissionRequestHandler = (handler) => { session.request = handler; };

  class FakeView {
    constructor(options) {
      this.options = options;
      const contents = new EventEmitter();
      contents.session = session;
      contents.setWindowOpenHandler = (handler) => { contents.popup = handler; };
      contents.setAudioMuted = (muted) => { contents.muted = muted; };
      contents.insertCSS = async (...args) => { contents.css = args; };
      contents.isDestroyed = () => Boolean(contents.destroyed);
      contents.close = () => {
        contents.destroyed = true;
        contents.emit('destroyed');
      };
      contents.getURL = () => contents.url;
      contents.loadURL = (url) => {
        contents.url = url;
        contents.loads = (contents.loads ?? 0) + 1;
        return new Promise((_resolve, reject) => { contents.rejectLoad = reject; });
      };
      this.webContents = contents;
      views.push(this);
    }

    setVisible(visible) { this.visible = visible; }
    setBounds(bounds) { this.bounds = bounds; }
    setBackgroundColor(color) { this.background = color; }
  }

  const children = new Set();
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 35, y: 55, width: 1024, height: 640 }),
    contentView: {
      addChildView: (view) => children.add(view),
      removeChildView: (view) => children.delete(view),
    },
  };
  const css = 'body { color: navy; }';
  const review = new ReplayReview({ window, css, background: '#e6ecf5', View: FakeView });
  return { review, views, session, children, css };
}

function navigation(url, isMainFrame = true) {
  return {
    url,
    isMainFrame,
    isSameDocument: false,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

test('creates one isolated view on valid saved-note open and shows it only after load', () => {
  const { review, views, session, css } = harness();
  assert.deepEqual(review.status(), { ok: true, state: 'idle', error: '', noteId: null });
  assert.equal(review.show(BOUNDS).state, 'idle');
  assert.equal(review.open(null, BOUNDS).ok, false);
  assert.equal(review.open({ ...NOTE, url: 'file:///C:/app/index.html' }, BOUNDS).ok, false);
  assert.equal(review.open({ ...NOTE, id: 3 }, BOUNDS).ok, false);
  assert.equal(views.length, 0);

  assert.deepEqual(review.open(NOTE, BOUNDS), { ok: true, state: 'loading', error: '', noteId: NOTE.id });
  const [view] = views;
  assert.deepEqual(view.options.webPreferences, {
    partition: 'replay-review', sandbox: true, contextIsolation: true, nodeIntegration: false,
  });
  assert.equal(view.visible, false);
  assert.equal(view.webContents.url, NOTE.url);
  assert.equal(session.check(), false);
  session.request(view.webContents, 'geolocation', (allowed) => assert.equal(allowed, false));
  const download = navigation();
  session.emit('will-download', download);
  assert.equal(download.prevented, true);
  view.webContents.emit('dom-ready');
  assert.deepEqual(view.webContents.css, [css, { cssOrigin: 'user' }]);

  view.webContents.emit('did-finish-load');
  assert.equal(review.status().state, 'loaded');
  assert.equal(view.visible, true);
  assert.equal(view.webContents.muted, false);
  assert.equal(view.background, '#e6ecf5');
  review.backgroundChanged('#24304a');
  assert.equal(view.background, '#24304a');
  review.open(NOTE, { ...BOUNDS, width: 550 });
  assert.equal(views.length, 1);
  assert.equal(view.webContents.loads, 1);
  assert.equal(view.bounds.width, 550);
});

test('validates and clips renderer bounds to the window content area', () => {
  const { review, views } = harness();
  for (const bounds of [
    null, [], {}, { ...BOUNDS, width: 0 }, { ...BOUNDS, height: 0.1 }, { ...BOUNDS, width: '500' },
    { ...BOUNDS, x: -0.1 }, { ...BOUNDS, y: NaN }, { ...BOUNDS, x: 1024 }, { ...BOUNDS, height: Infinity },
  ]) assert.equal(review.open(NOTE, bounds).ok, false);
  assert.equal(views.length, 0);

  review.open(NOTE, { x: 800.2, y: 390.7, width: 2000, height: 2000 });
  const [view] = views;
  view.webContents.emit('did-finish-load');
  assert.deepEqual(view.bounds, { x: 800, y: 391, width: 224, height: 249 });
  review.show({ ...BOUNDS, y: 640 });
  assert.equal(view.visible, false);
  assert.equal(view.webContents.muted, true);
  review.show(BOUNDS);
  assert.equal(view.visible, true);
  assert.deepEqual(view.bounds, BOUNDS);
});

test('allows replay playback URLs but blocks other documents, popups and redirects', () => {
  const { review, views } = harness();
  review.open(NOTE, BOUNDS);
  const { webContents: contents } = views[0];
  for (const url of [NOTE.url, `${NOTE.url}?p2`, `${NOTE.url}?p2=1&t=4`, `${NOTE.url}?turn=10000`]) {
    const event = navigation(url);
    contents.emit('will-frame-navigate', event);
    assert.equal(event.prevented, false, url);
  }
  for (const url of [
    OTHER.url, NOTE.url.replace('-examplepw', ''), `${NOTE.url}.json`, `${NOTE.url}?t=-1`,
    `${NOTE.url}?t=10001`, `${NOTE.url}?t=10e1`, `${NOTE.url}?t=2&t=3`, `${NOTE.url}?search=1`,
    `${NOTE.url}#`, `${NOTE.url}#/gen9ou-67890`,
    NOTE.url.replace('https:', 'http:'), NOTE.url.replace('showdown.com/', 'showdown.com:444/'),
    NOTE.url.replace('://', '://u@'), 'https://example.com', 'javascript:alert(1)', 'file:///C:/app/index.html',
  ]) {
    const event = navigation(url);
    contents.emit('will-frame-navigate', event);
    assert.equal(event.prevented, true, url);
    assert.deepEqual(contents.popup({ url }), { action: 'deny' });
  }
  const child = navigation(NOTE.url, false);
  contents.emit('will-frame-navigate', child);
  assert.equal(child.prevented, true);

  const redirect = navigation(NOTE.url);
  contents.emit('will-redirect', redirect);
  assert.equal(redirect.prevented, true);
  assert.equal(review.status().state, 'failed');
});

test('keeps the selected note after failures and restores the saved URL on reload', async () => {
  const { review, views, children, session } = harness();
  review.open(NOTE, BOUNDS);
  const first = views[0];
  first.webContents.emit('did-navigate', {}, NOTE.url, 404);
  first.webContents.emit('did-finish-load');
  assert.deepEqual(review.status(), { ok: true, state: 'failed', error: 'Could not load the replay.', noteId: NOTE.id });
  assert.equal(first.visible, false);
  assert.equal(review.open(NOTE, BOUNDS).state, 'failed');
  assert.equal(review.show(BOUNDS).state, 'failed');
  assert.equal(views.length, 1);

  assert.equal(review.reload().state, 'loading');
  const second = views[1];
  assert.equal(first.webContents.destroyed, true);
  assert.deepEqual([...children], [second]);
  assert.equal(session.listenerCount('will-download'), 1);
  first.webContents.emit('render-process-gone');
  first.webContents.rejectLoad(new Error(NOTE.url));
  await Promise.resolve();
  assert.equal(review.status().state, 'loading');
  assert.equal(second.webContents.url, NOTE.url);
  second.webContents.emit('did-fail-load', {}, -105, '', NOTE.url, false);
  second.webContents.emit('did-finish-load');
  assert.equal(review.status().state, 'loaded');

  second.webContents.emit('did-navigate-in-page', {}, `${NOTE.url}?p2`, true);
  assert.equal(review.status().state, 'loaded');
  second.webContents.emit('did-navigate-in-page', {}, OTHER.url, false);
  assert.equal(review.status().state, 'loaded');
  second.webContents.emit('did-navigate-in-page', {}, OTHER.url, true);
  assert.deepEqual(review.status(), {
    ok: true, state: 'failed', error: 'Replay page changed. Reload to return to this note.', noteId: NOTE.id,
  });
  assert.equal(second.visible, false);
  assert.equal(second.webContents.muted, true);
  await new Promise(setImmediate);
  assert.equal(second.webContents.destroyed, true);
  assert.equal(children.size, 0);

  review.reload();
  views[2].webContents.emit('did-fail-load', {}, -105, NOTE.url, NOTE.url, true);
  assert.equal(review.status().error, 'Could not load the replay.');
  review.reload();
  views[3].webContents.rejectLoad(new Error(NOTE.url));
  await Promise.resolve();
  assert.equal(review.status().error, 'Could not load the replay.');
});

test('switching notes and closing release the old view and ignore late events', async () => {
  const { review, views, children } = harness();
  review.open(NOTE, BOUNDS);
  assert.equal(review.open(OTHER, BOUNDS).noteId, OTHER.id);
  assert.equal(views[0].webContents.destroyed, true);
  assert.deepEqual([...children], [views[1]]);
  views[0].webContents.emit('did-finish-load');
  assert.equal(review.status().state, 'loading');
  views[1].webContents.emit('render-process-gone');
  assert.equal(review.status().state, 'failed');

  assert.deepEqual(review.close(), { ok: true, state: 'idle', error: '', noteId: null });
  assert.equal(views[1].webContents.destroyed, true);
  assert.equal(children.size, 0);
  views[1].webContents.rejectLoad(new Error(OTHER.url));
  await Promise.resolve();
  assert.equal(review.close().state, 'idle');
  assert.equal(review.reload().ok, false);
});
