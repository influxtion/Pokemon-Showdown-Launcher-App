'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Module = require('node:module');
const path = require('node:path');

const bridgeFile = path.join(__dirname, '..', 'app', 'showdown.js');
const originalLoad = Module._load;
let ShowdownBridge;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { net: { fetch: () => { throw new Error('unexpected network request'); } } };
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ ShowdownBridge } = require(bridgeFile));
} finally {
  Module._load = originalLoad;
}

// Just enough DOM for readSession to mark the page as launcher-driven.
function fakeDocument(header = true) {
  const classes = new Set();
  return {
    documentElement: { classList: {
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    } },
    getElementById: (id) => (id === 'header' && header ? {} : null),
    shell: () => classes.has('sd-launcher-shell'),
  };
}

function fakeContents(result = true) {
  const codes = [];
  return {
    codes,
    isLoading: () => false,
    executeJavaScript: async (code) => {
      codes.push(code);
      return typeof result === 'function' ? result(code) : result;
    },
  };
}

test('snapshot bounds untrusted client data and rejects malformed fields', async () => {
  const raw = {
    ready: true,
    connected: 1,
    user: { name: 'x'.repeat(100), userid: 'bad/id', registered: false },
    counts: { users: -2, battles: '7.9' },
    currentFormat: 'bad format',
    formats: [null, { id: 'gen9ou', name: 'n'.repeat(100), section: 'Singles', presetTeam: 1 }, { id: 'bad/id' }],
    teams: [null, { index: 2, name: 'Team', format: 'gen9ou', sprites: ['sprites/home-centered/pikachu', 'https://evil.example/a', '../pikachu'] }],
    news: [null, { id: '123', date: 123, title: 'News', text: 't'.repeat(500) }],
    rooms: [null, { title: 'Lobby', users: '18', desc: 'd'.repeat(300) }],
  };
  const contents = fakeContents(raw);
  const state = await new ShowdownBridge(() => contents).snapshot();
  assert.equal(state.ready, true);
  assert.equal(state.connected, true);
  assert.equal(state.user.name.length, 40);
  assert.equal(state.user.userid, '');
  assert.deepEqual(state.counts, { users: null, battles: 7 });
  assert.equal(state.currentFormat, '');
  assert.equal(state.formats.length, 1);
  assert.equal(state.formats[0].name.length, 80);
  assert.equal(state.teams.length, 1);
  assert.deepEqual(state.teams[0].sprites, ['https://play.pokemonshowdown.com/sprites/home-centered/pikachu.png', null, null]);
  assert.equal(state.news[1].text.length, 400);
  assert.equal(state.rooms[1].desc.length, 200);
});

test('snapshot and session survive malformed client results', async () => {
  const contents = fakeContents(null);
  const bridge = new ShowdownBridge(() => contents);
  assert.deepEqual(await bridge.snapshot(), { ready: false });
  assert.deepEqual(await bridge.session(), { ready: false, rooms: [] });
  contents.executeJavaScript = async () => { throw new Error('remote script failed'); };
  assert.deepEqual(await bridge.snapshot(), { ready: false });
  assert.deepEqual(await bridge.session(), { ready: false, rooms: [] });
});

test('session reads connection state and sanitizes room data', async () => {
  let layouts = 0;
  const app = {
    isDisconnected: true,
    user: { get: (key) => key === 'name' ? 'Player' : key === 'named' },
    rooms: {
      '': { searching: [{ format: 'gen9ou' }], $: () => ({ length: 1 }), notifications: { pm: {} } },
      'battle-gen9ou-1': { type: 'battle', title: 'Battle', notifications: null,
        battle: { p1: { name: 'Player' }, p2: { name: 'Rival' }, tier: 'Gen 9 OU', ended: false, turn: 7 } },
      lobby: { type: 'chat', title: 'Lobby', notifications: { msg: {} } },
      'view-thing': { type: 'html', title: 'Thing' },
    },
    curRoom: { id: 'battle-gen9ou-1' },
    popups: [{}],
    updateLayout: () => { layouts += 1; },
    focusRoom() {}, leaveRoom() {}, joinRoom() {}, addPopup() {},
  };
  const document = fakeDocument();
  const contents = fakeContents((code) => vm.runInNewContext(code, { window: { app, document }, app, document }));
  const state = await new ShowdownBridge(() => contents).session();
  assert.equal(state.ready, true);
  assert.equal(state.connected, false);
  assert.equal(state.search.pending, true);
  assert.deepEqual(Array.from(state.search.formats), ['gen9ou']);
  assert.equal(state.rooms[0].id, 'battle-gen9ou-1');
  assert.deepEqual(Array.from(state.rooms[0].players), ['Player', 'Rival']);
  assert.equal(state.named, true);
  assert.equal(state.menuUnread, true);
  assert.deepEqual(Array.from(state.rooms, (r) => [r.kind, r.turn, r.unread, r.formatId]),
    [['battle', 7, false, 'gen9ou'], ['chat', null, true, ''], ['other', null, false, '']]);
  // One room at a time is a runtime flag, applied once per client load.
  assert.equal(app.singlePanelMode, true);
  assert.equal(state.shell, true);
  assert.equal(document.shell(), true);
  await new ShowdownBridge(() => contents).session();
  assert.equal(layouts, 1);

  contents.executeJavaScript = async () => ({ rooms: [null, { id: 'bad/room' }, { id: 'battle-1', players: ['p'.repeat(100), 44], title: 'x'.repeat(100) }], current: 'bad/room', search: { formats: ['ok', 'bad/id'] }, popups: -1 });
  const cleaned = await new ShowdownBridge(() => contents).session();
  assert.equal(cleaned.connected, false);
  assert.equal(cleaned.current, '');
  assert.equal(cleaned.rooms.length, 1);
  assert.deepEqual(cleaned.rooms[0].players, ['p'.repeat(40), '']);
  assert.deepEqual(cleaned.search.formats, ['ok']);
  assert.deepEqual([cleaned.rooms[0].kind, cleaned.rooms[0].turn, cleaned.rooms[0].formatId, cleaned.named], ['other', null, '', false]);
  assert.equal(cleaned.popups, 0);
});

test('the menu tab is set through show-menu, reported by the session and validated', async () => {
  const focused = [];
  const app = {
    user: { get: () => 'Player' }, rooms: { '': { $: () => ({ length: 0 }) } }, curRoom: { id: '' }, singlePanelMode: true,
    focusRoom: (id) => focused.push(id), updateLayout() {}, leaveRoom() {}, joinRoom() {}, addPopup() {},
  };
  const document = fakeDocument();
  const contents = fakeContents((code) => vm.runInNewContext(code, { window: { app, document }, app, document }));
  const bridge = new ShowdownBridge(() => contents);
  assert.equal((await bridge.session()).menuTab, 'battle');
  assert.equal(await bridge.act('show-menu', { tab: 'community' }), true);
  assert.equal((await bridge.session()).menuTab, 'community');
  assert.equal(await bridge.act('show-menu', { tab: 'battle' }), true);
  assert.equal((await bridge.session()).menuTab, 'battle');
  assert.deepEqual(focused, ['', '']);

  const count = contents.codes.length;
  for (const tab of ['teambuilder', '', 1, null, undefined]) assert.equal(await bridge.act('show-menu', { tab }), false);
  assert.equal(contents.codes.length, count);

  contents.executeJavaScript = async () => ({ rooms: [], menuTab: 'bad' });
  assert.equal((await bridge.session()).menuTab, 'battle');
});

test('only allowlisted actions with valid arguments reach the client', async () => {
  const contents = fakeContents(true);
  const bridge = new ShowdownBridge(() => contents);
  assert.equal(await bridge.act('send', { text: '/forfeit' }), false);
  assert.equal(await bridge.act('search', { format: 'gen9ou', team: -1 }), false);
  assert.equal(await bridge.act('search', { format: 'gen9ou', team: 1.5 }), false);
  assert.equal(await bridge.act('search', { format: 'gen9ou', team: '0' }), false);
  assert.equal(await bridge.act('search', { format: 'bad/id', team: null }), false);
  assert.equal(await bridge.act('challenge', { user: 'A\nB', format: 'gen9ou' }), false);
  assert.equal(await bridge.act('challenge', { user: 'Rival', format: 'bad/id' }), false);
  assert.equal(await bridge.act('join', { room: 'battle-1);app.send("/forfeit")' }), false);
  for (const team of [-1, 0.5, '0', undefined, 10000]) {
    assert.equal(await bridge.act('edit-team', { team, name: 'Team', format: 'gen9ou' }), false);
  }
  assert.equal(await bridge.act('edit-team', { team: 0, name: 'x'.repeat(81), format: 'gen9ou' }), false);
  assert.equal(await bridge.act('edit-team', { team: 0, name: 'Team', format: 'bad/id' }), false);
  for (const room of [undefined, null, 5, 'bad/room', 'x'.repeat(81)]) {
    assert.equal(await bridge.act('focus-room', { room }), false);
    assert.equal(await bridge.act('leave-room', { room }), false);
  }
  assert.equal(await bridge.act('leave-room', { room: '' }), false);
  assert.equal(await bridge.act('leave-room', { room: 'rooms' }), false);
  assert.equal(contents.codes.length, 0);
  assert.equal(await bridge.act('challenge', { user: 'Rival', format: 'gen9ou' }), true);
  assert.match(contents.codes[0], /\("Rival", "gen9ou"\)$/);
  assert.equal(await bridge.act('search', { format: 'gen9ou', team: null }), true);
  assert.match(contents.codes[1], /\("gen9ou", null\)$/);
});

test('team shortcut opens the selected team and preserves existing edits or stale selections', async () => {
  const opened = [];
  const joined = [];
  const room = { edit: (index) => opened.push(index) };
  const Storage = { teams: [{ name: 'First', format: 'gen9ou' }, { name: 'Second', format: 'gen9uu' }] };
  const app = { rooms: { teambuilder: room }, joinRoom: (id) => joined.push(id), focusRoom: () => {} };
  const contents = fakeContents((code) => vm.runInNewContext(code, { app, Storage }));
  const bridge = new ShowdownBridge(() => contents);
  const target = { team: 1, name: 'Second', format: 'gen9uu' };
  assert.equal(await bridge.act('edit-team', target), true);
  assert.deepEqual(opened, [1]);
  room.curTeam = Storage.teams[0];
  await bridge.act('edit-team', target);
  room.curTeam = null;
  room.exportMode = true;
  await bridge.act('edit-team', target);
  room.exportMode = false;
  Storage.teams.reverse();
  await bridge.act('edit-team', target);
  await bridge.act('edit-team', { team: 9, name: 'Missing', format: '' });
  await bridge.act('edit-team', { team: null });
  assert.deepEqual(opened, [1], 'existing edits, imports, reordered/missing teams and no selection remain untouched');
  assert.deepEqual(joined, Array(6).fill('teambuilder'));
});

test('missing team stays empty when the old client renders its team control', async () => {
  const teamButton = { value: '0' };
  const form = {
    length: 1,
    find(selector) {
      if (selector === 'button[name=team]') return { replaceWith: () => {}, val: (value) => { if (value !== undefined) teamButton.value = value; return teamButton.value; } };
      if (selector === 'button[name=format]') return { replaceWith: () => {} };
      if (selector === 'button.big') return [{ id: 'battle' }];
      return null;
    },
  };
  const menu = {
    $: () => ({ closest: () => form }),
    renderFormats: () => '<button name="format">Gen 9 OU</button>',
    renderTeams: () => '<button name="team" value="0">Team</button>',
    search: () => { assert.equal(teamButton.value, ''); },
  };
  const app = { rooms: { '': menu }, focusRoom: () => {}, popups: [] };
  const contents = fakeContents((code) => vm.runInNewContext(code, { app, BattleFormats: { gen9ou: { team: false } } }));
  assert.equal(await new ShowdownBridge(() => contents).act('search', { format: 'gen9ou', team: null }), true);
});

test('rooms are focused and left through the client, keeping its forfeit confirmation', async () => {
  const calls = [];
  const app = {
    rooms: { '': {}, lobby: {}, 'battle-gen9ou-1': {} },
    popups: [],
    focusRoom: (id) => calls.push(['focus', id]),
    // The client refuses to leave a player's live battle and shows its own popup instead.
    leaveRoom: (id) => { calls.push(['leave', id]); return id !== 'battle-gen9ou-1'; },
    addPopup: (popup) => calls.push(['popup', popup]),
  };
  const contents = fakeContents((code) => vm.runInNewContext(code, { app, SoundsPopup: 'sounds', OptionsPopup: 'options' }));
  const bridge = new ShowdownBridge(() => contents);
  assert.equal(await bridge.act('focus-room', { room: '' }), true);
  assert.equal(await bridge.act('focus-room', { room: 'lobby' }), true);
  assert.equal(await bridge.act('focus-room', { room: 'gone' }), false);
  assert.equal(await bridge.act('leave-room', { room: 'lobby' }), true);
  assert.equal(await bridge.act('leave-room', { room: 'battle-gen9ou-1' }), 'needs-client');
  assert.equal(await bridge.act('leave-room', { room: 'gone' }), true);
  assert.equal(await bridge.act('sounds', {}), true);
  assert.equal(await bridge.act('options', {}), true);
  assert.deepEqual(calls, [['focus', ''], ['focus', 'lobby'], ['leave', 'lobby'], ['leave', 'battle-gen9ou-1'],
    ['popup', 'sounds'], ['popup', 'options']]);
});

test('the client keeps its own header unless a full read confirms the launcher can drive rooms', async () => {
  const make = () => ({
    user: { get: (key) => key === 'name' ? 'Player' : false },
    rooms: { '': { $: () => ({ length: 0 }) }, lobby: { type: 'chat', title: 'Lobby' } },
    curRoom: { id: 'lobby' },
    popups: [],
    updateLayout() {}, focusRoom() {}, leaveRoom() {}, joinRoom() {}, addPopup() {},
  });
  const read = async (app, document) => {
    const contents = fakeContents((code) => vm.runInNewContext(code, { window: { app, document }, app, document }));
    return new ShowdownBridge(() => contents).session();
  };

  const document = fakeDocument();
  let app = make();
  assert.equal((await read(app, document)).shell, true);
  assert.equal(document.shell(), true);

  // A room control disappears: rooms are still listed, but the client's tabs must return.
  app = make();
  delete app.leaveRoom;
  const degraded = await read(app, document);
  assert.equal(degraded.ready, true);
  assert.equal(degraded.shell, false);
  assert.equal(degraded.rooms.length, 1);
  assert.equal(document.shell(), false);
  assert.equal(app.singlePanelMode, undefined);

  // The header element is gone or renamed.
  const noHeader = fakeDocument(false);
  assert.equal((await read(make(), noHeader)).shell, false);
  assert.equal(noHeader.shell(), false);

  // The read itself breaks part-way: withdraw the class set by an earlier good read.
  assert.equal((await read(make(), document)).shell, true);
  app = make();
  app.user.get = () => { throw new Error('client changed'); };
  assert.deepEqual(await read(app, document), { ready: false, rooms: [] });
  assert.equal(document.shell(), false);

  // The client is not there at all.
  assert.equal((await read(make(), document)).shell, true);
  assert.deepEqual(await read(undefined, document), { ready: false, rooms: [] });
  assert.equal(document.shell(), false);
});
