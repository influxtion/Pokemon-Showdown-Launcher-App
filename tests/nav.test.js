'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'nav.js'), 'utf8');

function session(rooms, extra = {}) {
  return { ready: true, connected: true, me: 'Player', named: true, current: '', menuUnread: false, rooms, search: { pending: false, formats: [] }, popups: 0, ...extra };
}

function room(id, players = ['', ''], extra = {}) {
  return { id, title: 'Battle', kind: 'battle', battle: true, players, format: 'Gen 9 OU', formatId: 'gen9ou', ended: false, turn: null, unread: false, ...extra };
}

function chat(id, title, extra = {}) {
  return { id, title, kind: 'chat', battle: false, players: [], format: '', formatId: '', ended: false, turn: null, unread: false, ...extra };
}

class Node {
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  has(cls) { return this.className.split(' ').includes(cls); }
  click() {
    const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    if (this.listeners.click) this.listeners.click(event);
    return event;
  }
}

function harness(states, { onPlay = false, saved = new Map(), act = async () => true } = {}) {
  const timers = [];
  const events = [];
  const calls = [];
  const nav = {};
  for (const name of ['rooms', 'sign-in', 'account', 'me']) nav[name] = new Node('x');
  nav['sign-in'].hidden = true;
  nav.account.hidden = true;
  const location = { href: onPlay ? 'play.html' : 'index.html' };
  const document = {
    body: { dataset: onPlay ? { page: 'play' } : {} },
    querySelector: (selector) => nav[/data-nav="(.+)"/.exec(selector)[1]] || null,
    createElement: (tag) => new Node(tag),
    dispatchEvent: (event) => events.push(event),
  };
  const storage = { getItem: (key) => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
  let last = states[states.length - 1];
  const window = {
    desktop: {
      getSession: async () => (states.length ? (last = states.shift()) : last),
      showdown: async (action, args) => { calls.push({ action, args: JSON.parse(JSON.stringify(args)) }); return act(action, args); },
    },
  };
  vm.runInNewContext(source, {
    window,
    document,
    sessionStorage: storage,
    location,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    setTimeout: (fn, delay) => { const t = { fn, delay }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    location, nav, events, timers, saved, calls,
    rows: () => nav.rooms.children.filter((c) => c.has('nav-room')),
    row: (i) => nav.rooms.children.filter((c) => c.has('nav-room'))[i],
    tabs: () => nav.rooms.children.filter((c) => c.has('nav-tab')),
    tab: (title) => nav.rooms.children.find((c) => c.has('nav-tab') && c.children[0].children[1].children[0].textContent === title),
    main: (r) => r.children[0],
    close: (r) => r.children[1],
    title: (r) => r.children[0].children[1].children[0].textContent,
    sub: (r) => (r.children[0].children[1].children[1] || {}).textContent,
    async settle() { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); },
    async poll() { assert.ok(timers.length); timers.shift().fn(); await this.settle(); },
  };
}

test('new player battle switches after names arrive', async () => {
  const h = harness([session([]), session([room('battle-gen9ou-1')]), session([room('battle-gen9ou-1', ['Player', 'Rival'])])]);
  await h.settle();
  assert.equal(h.location.href, 'index.html');
  await h.poll();
  assert.equal(h.location.href, 'index.html');
  await h.poll();
  assert.equal(h.location.href, 'play.html');
  assert.equal(h.title(h.row(0)), 'vs. Rival');
});

test('first poll waits for an unresolved battle room to identify its players', async () => {
  const h = harness([session([room('battle-gen9ou-4')]), session([room('battle-gen9ou-4', ['Player', 'Rival'])])]);
  await h.settle();
  assert.equal(h.location.href, 'index.html');
  await h.poll();
  assert.equal(h.location.href, 'play.html');
});

test('spectated battles do not switch and failed session reads recover', async () => {
  const h = harness([session([]), { ready: false, rooms: [] }, session([room('battle-gen9ou-2', ['Alice', 'Bob'])])]);
  await h.settle();
  await h.poll();
  await h.poll();
  assert.equal(h.location.href, 'index.html');
  assert.equal(h.title(h.row(0)), 'Alice vs. Bob');
});

test('known rooms carry across launcher page navigation', async () => {
  const saved = new Map();
  const first = harness([session([])], { saved });
  await first.settle();
  const second = harness([session([room('battle-gen9ou-3', ['Player', 'Rival'])])], { saved });
  await second.settle();
  assert.equal(second.location.href, 'play.html');
});

test('session events are dispatched; polling is 3s idle and 1s on play or while searching', async () => {
  const idle = harness([session([])]);
  await idle.settle();
  assert.equal(idle.events[0].type, 'showdown-session');
  assert.equal(idle.timers[0].delay, 3000);
  const play = harness([session([])], { onPlay: true });
  await play.settle();
  assert.equal(play.timers[0].delay, 1000);
  const searching = harness([session([], { search: { pending: true, formats: ['gen9ou'] } })]);
  await searching.settle();
  assert.equal(searching.timers[0].delay, 1000);
});

test('rooms render as rows with titles, sub-lines, unread dots and close labels', async () => {
  const live = room('battle-gen9ou-5', ['Player', 'Rival'], { turn: 7 });
  const done = room('battle-gen9ou-6', ['Alice', 'Bob'], { ended: true });
  const lobby = chat('lobby', 'Lobby', { unread: true });
  const tb = chat('teambuilder', 'Teambuilder', { kind: 'teambuilder' });
  const h = harness([session([live, done, lobby, tb])]);
  await h.settle();
  assert.equal(h.rows().length, 3, 'the Teambuilder room is its tab, not a row');
  assert.equal(h.title(h.row(0)), 'vs. Rival');
  assert.equal(h.sub(h.row(0)), 'Gen 9 OU · Turn 7');
  assert.ok(h.row(0).has('nav-item--live'));
  assert.equal(h.title(h.row(1)), 'Alice vs. Bob');
  assert.equal(h.sub(h.row(1)), 'Gen 9 OU · Finished');
  assert.ok(!h.row(1).has('nav-item--live'));
  assert.equal(h.sub(h.row(2)), undefined);
  assert.ok(h.main(h.row(2)).children.some((c) => c.has('nav-unread')));
  assert.ok(!h.main(h.row(1)).children.some((c) => c.has('nav-unread')));
  assert.equal(h.close(h.row(2)).getAttribute('aria-label'), 'Close Lobby');
  assert.equal(h.close(h.row(0)).getAttribute('aria-label'), 'Close vs. Rival');
  assert.equal(h.nav.account.hidden, false);
  assert.equal(h.nav.me.textContent, 'Player');
  assert.equal(h.nav['sign-in'].hidden, true);
});

test('guest accounts show a sign-in link that logs in and opens the client', async () => {
  const h = harness([session([], { me: 'Guest 123', named: false })]);
  await h.settle();
  assert.equal(h.nav['sign-in'].hidden, false);
  const event = h.nav['sign-in'].click();
  await h.settle();
  assert.equal(event.prevented, true);
  assert.deepEqual(h.calls, [{ action: 'login', args: {} }]);
  assert.equal(h.location.href, 'play.html');
});

test('rows are reused when nothing changed and rebuilt when something did', async () => {
  const h = harness([session([chat('lobby', 'Lobby')]), session([chat('lobby', 'Lobby')]), session([chat('lobby', 'Lobby', { unread: true })])]);
  await h.settle();
  const first = h.row(0);
  await h.poll();
  assert.equal(h.row(0), first);
  await h.poll();
  assert.notEqual(h.row(0), first);
});

test('only the current room is marked on play, and none elsewhere', async () => {
  const rooms = [chat('lobby', 'Lobby'), chat('help', 'Help')];
  const play = harness([session(rooms, { current: 'help' })], { onPlay: true });
  await play.settle();
  assert.deepEqual(play.rows().map((r) => r.getAttribute('aria-current')), [null, 'page']);
  const other = harness([session(rooms, { current: 'help' })]);
  await other.settle();
  assert.deepEqual(other.rows().map((r) => r.getAttribute('aria-current')), [null, null]);
});

test('the Battle tab is always shown, marks the main menu and carries its unread dot', async () => {
  const rooms = [chat('lobby', 'Lobby')];
  const menu = harness([session(rooms, { current: '' })], { onPlay: true });
  await menu.settle();
  assert.equal(menu.tab('Battle').getAttribute('aria-current'), 'page');
  assert.equal(menu.tab('Battle').children.length, 1, 'tabs cannot be closed');
  assert.equal(menu.row(0).getAttribute('aria-current'), null);

  const inRoom = harness([session(rooms, { current: 'lobby' })], { onPlay: true });
  await inRoom.settle();
  assert.equal(inRoom.tab('Battle').getAttribute('aria-current'), null);

  const offPlay = harness([session(rooms, { current: '' })]);
  await offPlay.settle();
  assert.equal(offPlay.tab('Battle').getAttribute('aria-current'), null, 'nothing is current off play');

  const notReady = harness([{ ready: false, rooms: [] }]);
  await notReady.settle();
  assert.ok(notReady.tab('Battle'), 'shown before the client is ready');

  const unread = harness([session(rooms, { current: 'lobby', menuUnread: true })]);
  await unread.settle();
  assert.ok(unread.main(unread.tab('Battle')).children.some((c) => c.has('nav-unread')));
});

test('the Battle tab focuses the main menu and opens play', async () => {
  const h = harness([session([])]);
  await h.settle();
  h.main(h.tab('Battle')).click();
  await h.settle();
  assert.deepEqual(h.calls, [{ action: 'show-menu', args: { tab: 'battle' } }]);
  assert.equal(h.location.href, 'play.html');
});

test('the Teambuilder tab is always shown and opens its room', async () => {
  const closed = harness([session([])]);
  await closed.settle();
  assert.equal(closed.tab('Teambuilder').children.length, 1, 'tabs cannot be closed');
  closed.main(closed.tab('Teambuilder')).click();
  await closed.settle();
  assert.deepEqual(closed.calls, [{ action: 'join', args: { room: 'teambuilder' } }]);
  assert.equal(closed.location.href, 'play.html');

  const tb = chat('teambuilder', 'Teambuilder', { kind: 'teambuilder' });
  const open = harness([session([tb], { current: 'teambuilder' })], { onPlay: true });
  await open.settle();
  assert.equal(open.tab('Teambuilder').getAttribute('aria-current'), 'page');
  assert.equal(open.tab('Battle').getAttribute('aria-current'), null);
  assert.equal(open.rows().length, 0);
});

test('the Community tab is always shown, opens its menu view and marks it current', async () => {
  const h = harness([session([])]);
  await h.settle();
  h.main(h.tab('Community')).click();
  await h.settle();
  assert.deepEqual(h.calls, [{ action: 'show-menu', args: { tab: 'community' } }]);
  assert.equal(h.location.href, 'play.html');

  const menu = harness([session([], { menuTab: 'community' })], { onPlay: true });
  await menu.settle();
  assert.equal(menu.tab('Community').getAttribute('aria-current'), 'page');
  assert.equal(menu.tab('Battle').getAttribute('aria-current'), null);

  const list = harness([session([], { current: 'rooms' })], { onPlay: true });
  await list.settle();
  assert.equal(list.tab('Community').getAttribute('aria-current'), 'page', 'the room list belongs to Community');
  assert.equal(list.tab('Battle').getAttribute('aria-current'), null);
});

test('tabs keep their order and open rooms nest under the tab they belong to', async () => {
  const h = harness([session([
    chat('lobby', 'Lobby'), chat('ladder', 'Ladder', { kind: 'ladder' }), chat('battles', 'Battles', { kind: 'battles' }),
    chat('tournaments', 'Tournaments'), room('battle-gen9ou-8', ['Alice', 'Bob']), chat('teambuilder', 'Teambuilder', { kind: 'teambuilder' }),
  ])]);
  await h.settle();
  assert.deepEqual(h.nav.rooms.children.map((r) => h.title(r)),
    ['Battle', 'Ladder', 'Battles', 'Tournaments', 'Alice vs. Bob', 'Teambuilder', 'Community', 'Lobby']);
});

test('clicking a row or Join a room focuses and opens play', async () => {
  const off = harness([session([chat('lobby', 'Lobby')])]);
  await off.settle();
  off.main(off.row(0)).click();
  await off.settle();
  assert.deepEqual(off.calls, [{ action: 'focus-room', args: { room: 'lobby' } }]);
  assert.equal(off.location.href, 'play.html');

  const on = harness([session([chat('lobby', 'Lobby')], { current: 'lobby' })], { onPlay: true });
  await on.settle();
  on.location.href = 'unchanged';
  on.main(on.row(0)).click();
  await on.settle();
  assert.deepEqual(on.calls, [{ action: 'focus-room', args: { room: 'lobby' } }]);
  assert.equal(on.location.href, 'unchanged', 'already on play: no navigation');

  const join = harness([session([])]);
  await join.settle();
  const button = join.tab('Community').children[1];
  assert.equal(button.getAttribute('aria-label'), 'Join a room');
  button.click();
  await join.settle();
  assert.deepEqual(join.calls, [{ action: 'join', args: { room: 'rooms' } }]);
  assert.equal(join.location.href, 'play.html');
});

test('close sends leave-room without triggering the row click', async () => {
  const h = harness([session([chat('lobby', 'Lobby')])]);
  await h.settle();
  const event = h.close(h.row(0)).click();
  await h.settle();
  assert.equal(event.stopped, true);
  assert.deepEqual(h.calls, [{ action: 'leave-room', args: { room: 'lobby' } }]);
});

test('close answered needs-client opens play so the popup is seen', async () => {
  const h = harness([session([room('battle-gen9ou-7', ['Player', 'Rival'])])], { act: async () => 'needs-client' });
  await h.settle();
  h.close(h.row(0)).click();
  await h.settle();
  assert.equal(h.location.href, 'play.html');
});

test('close answered false changes nothing', async () => {
  const h = harness([session([chat('lobby', 'Lobby')], { current: 'lobby' })], { onPlay: true, act: async () => false });
  await h.settle();
  h.location.href = 'unchanged';
  h.close(h.row(0)).click();
  await h.settle();
  assert.equal(h.location.href, 'unchanged');
});

test('close answered true re-polls and leaves play only when no rooms remain', async () => {
  const empty = harness([session([chat('lobby', 'Lobby')], { current: 'lobby' }), session([])], { onPlay: true });
  await empty.settle();
  empty.close(empty.row(0)).click();
  await empty.settle();
  assert.equal(empty.location.href, 'index.html');

  const left = harness([
    session([chat('lobby', 'Lobby'), chat('help', 'Help')], { current: 'lobby' }),
    session([chat('help', 'Help')], { current: 'help' }),
  ], { onPlay: true });
  await left.settle();
  left.close(left.row(0)).click();
  await left.settle();
  assert.equal(left.location.href, 'play.html');
  assert.equal(left.title(left.row(0)), 'Help');

  const elsewhere = harness([session([chat('lobby', 'Lobby')]), session([])]);
  await elsewhere.settle();
  elsewhere.close(elsewhere.row(0)).click();
  await elsewhere.settle();
  assert.equal(elsewhere.location.href, 'index.html');
  assert.equal(elsewhere.rows().length, 0);
});
