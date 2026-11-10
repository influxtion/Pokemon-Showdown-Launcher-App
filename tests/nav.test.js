'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'nav.js'), 'utf8');

function session(rooms, me = 'Player') {
  return { ready: true, connected: true, me, rooms, search: { pending: false, formats: [] }, popups: 0 };
}

function room(id, players = ['', '']) {
  return { id, title: 'Battle', battle: true, players, format: 'Gen 9 OU', ended: false };
}

function harness(states, saved = new Map()) {
  const timers = [];
  const events = [];
  const label = { textContent: '' };
  const hint = { textContent: '' };
  const item = {
    hidden: false,
    title: '',
    getAttribute: () => null,
    querySelector: (selector) => selector === '.nav-label' ? label : hint,
    classList: { toggle: () => {} },
  };
  const location = { href: 'index.html' };
  const document = {
    querySelector: () => item,
    dispatchEvent: (event) => events.push(event),
  };
  const storage = {
    getItem: (key) => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value),
  };
  const window = { desktop: { getSession: async () => states.shift() } };
  vm.runInNewContext(source, {
    window,
    document,
    sessionStorage: storage,
    location,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
  });
  return {
    location, label, hint, item, events, timers, saved,
    async settle() { await new Promise((resolve) => setImmediate(resolve)); },
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
  assert.equal(h.label.textContent, 'Battle · vs. Rival');
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
  assert.equal(h.label.textContent, 'Battle · Alice vs. Bob');
});

test('known rooms carry across launcher page navigation', async () => {
  const saved = new Map();
  const first = harness([session([])], saved);
  await first.settle();
  const second = harness([session([room('battle-gen9ou-3', ['Player', 'Rival'])])], saved);
  await second.settle();
  assert.equal(second.location.href, 'play.html');
});
