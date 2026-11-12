'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PracticeRuntime, childEnvironment } = require('../app/practice-runtime');

function fixture() {
  const children = [];
  const runtime = new PracticeRuntime({ root: '/runtime', scripts: '/scripts',
    verify: () => ({ promise: Promise.resolve({ ok: true }), cancel() {} }), spawnChild: (exe, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => { child.killed = true; };
    child.line = event => child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    Object.assign(child, { exe, args, options });
    children.push(child);
    return child;
  } });
  runtime.installed = () => true;
  return { runtime, children };
}

test('opponent selection stays allowlisted and Foul Play uses its own runner and readiness contract', async () => {
  const { runtime, children } = fixture();
  assert.equal((await runtime.start({ opponent: 'foulplay', preset: 'balanced' })).ok, false);
  runtime.foulPlay = { python: '/foul/python', runner: '/foul/runner.py', source: '/foul/source' };
  assert.equal((await runtime.start({ opponent: '../runner', preset: 'balanced' })).ok, false);
  assert.equal((await runtime.start({ opponent: 'foulplay', preset: 'balanced' })).ok, true);
  children[0].line({ type: 'ready', port: 41000 });
  assert.equal(children[1].exe, '/foul/python');
  assert(children[1].args.includes('/foul/source'));
  assert.equal(runtime.connection.bot, 'FoulPlay');
  children[1].line({ type: 'ready', protocol: 1, opponent: 'foulplay', bot: 'FoulPlay', human: 'Player',
    format: 'gen9randombattle', threads: 2, searchMs: 100 });
  assert.equal(runtime.state, 'ready');
  assert.equal(runtime.status().opponent, 'foulplay');
  runtime.stop();
});

test('practice starts server before bot and only signals ready after authenticated bot readiness', async () => {
  const { runtime, children } = fixture();
  assert.equal((await runtime.start('arbitrary')).ok, false);
  assert.equal((await runtime.start('balanced')).ok, true);
  assert.equal(children.length, 1);
  assert.equal(runtime.state, 'starting');
  children[0].line({ type: 'ready', port: 41000 });
  assert.equal(children.length, 2);
  assert(children[1].args.includes('--token'));
  const connection = { ...runtime.connection };
  children[1].line({ type: 'ready', protocol: 1, bot: connection.bot, human: connection.human,
    format: 'gen9randombattle', threads: 2, determinizations: 8, searchMs: 150 });
  assert.equal(runtime.state, 'ready');
  assert.equal((await runtime.start('full')).ok, false);
  assert.equal(JSON.stringify(runtime.status()).includes(connection.token), false);
  children[1].line({ type: 'thinking', room: 'battle-gen9randombattle-1', turn: 2 });
  assert.equal(runtime.battle.thinking, true);
  children[1].line({ type: 'end', room: 'battle-gen9randombattle-1', result: 'win' });
  assert.equal(runtime.battle.result, 'win');
  runtime.stop();
  assert(children.every(child => child.killed));
});

test('practice failure stops sibling processes and ignores stale generation events', async () => {
  const { runtime, children } = fixture();
  await runtime.start('quiet');
  const old = children[0];
  old.line({ type: 'ready', port: 41001 });
  children[1].emit('error', new Error('private filesystem path'));
  assert.equal(runtime.state, 'failed');
  assert(old.killed);
  assert(!runtime.error.includes('filesystem'));
  old.line({ type: 'ready', port: 41002 });
  assert.equal(children.length, 2);
  runtime.stop();
});

test('practice rejects malformed readiness and unbounded child output', async () => {
  for (const message of [{ type: 'ready', port: 80 }, { type: 'ready', port: '41000' }]) {
    const { runtime, children } = fixture();
    await runtime.start('full');
    children[0].line(message);
    assert.equal(runtime.state, 'failed');
  }
  const { runtime, children } = fixture();
  await runtime.start('full');
  children[0].stdout.emit('data', Buffer.alloc(65537, 'a'));
  assert.equal(runtime.state, 'failed');
});

test('practice child environment excludes inherited account and Python settings', () => {
  const original = process.env.SHOWDOWN_PASSWORD;
  process.env.SHOWDOWN_PASSWORD = 'must-not-propagate';
  try {
    const env = childEnvironment(true);
    assert.equal(env.SHOWDOWN_PASSWORD, undefined);
    assert.equal(env.PYTHONPATH, undefined);
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  } finally {
    if (original === undefined) delete process.env.SHOWDOWN_PASSWORD;
    else process.env.SHOWDOWN_PASSWORD = original;
  }
});

test('terminal client failures stop only their matching runtime session', async () => {
  const { runtime, children } = fixture();
  await runtime.start('full');
  const token = runtime.connection.token;
  runtime.clientFailed('stale token');
  assert.equal(runtime.state, 'starting');
  runtime.clientFailed(token);
  assert.equal(runtime.state, 'failed');
  assert.match(runtime.error, /battle client failed/);
  assert(children[0].killed);
});

test('integrity verification fails closed and cancellation never launches children', async () => {
  const { runtime, children } = fixture();
  runtime.verify = () => ({ promise: Promise.resolve({ ok: false }), cancel() {} });
  assert.equal((await runtime.start('full')).ok, false);
  assert.equal(runtime.state, 'failed');
  assert.equal(children.length, 0);
  let resolve;
  runtime.verify = () => ({ promise: new Promise(done => { resolve = done; }), cancel: () => resolve({ ok: false }) });
  const pending = runtime.start('full');
  assert.equal(runtime.state, 'starting');
  runtime.stop();
  assert.equal((await pending).cancelled, true);
  assert.equal(children.length, 0);
});

test('move recovery counts are bounded, cumulative, and reset for a new battle', async () => {
  const { runtime, children } = fixture();
  await runtime.start('full');
  children[0].line({ type: 'ready', port: 41000 });
  const bot = children[1];
  bot.line({ type: 'ready', protocol: 1, bot: 'Laplace', human: 'Player',
    format: 'gen9randombattle', threads: 8, determinizations: 8, searchMs: 150 });
  const room = 'battle-gen9randombattle-1';
  bot.line({ type: 'battle', room });
  bot.line({ type: 'turn', room, turn: 1, fallback: true });
  const recovery = { type: 'recovery', room, kind: 'rejected-choice', rejectedChoices: 2, defaultChoices: 1 };
  bot.line(recovery);
  bot.line(recovery);
  bot.line({ ...recovery, rejectedChoices: 1, defaultChoices: 0 });
  bot.line({ ...recovery, rejectedChoices: 10001 });
  bot.line({ ...recovery, room: 'battle-gen9randombattle-999', defaultChoices: 99 });
  assert.equal(runtime.battle.searchFallbacks, 1);
  assert.equal(runtime.battle.rejectedChoices, 2);
  assert.equal(runtime.battle.defaultChoices, 1);
  bot.line({ type: 'end', room, result: 'loss' });
  assert.equal(runtime.battle.defaultChoices, 1);
  bot.line({ type: 'battle', room: 'battle-gen9randombattle-2' });
  assert.equal(runtime.battle.searchFallbacks, undefined);
  assert.equal(runtime.battle.rejectedChoices, undefined);
  runtime.stop();
});
