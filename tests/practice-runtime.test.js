'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PracticeRuntime, childEnvironment } = require('../app/practice-runtime');

function fixture() {
  const children = [];
  const runtime = new PracticeRuntime({ root: '/runtime', scripts: '/scripts', spawnChild: (exe, args, options) => {
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

test('practice starts server before bot and only signals ready after authenticated bot readiness', () => {
  const { runtime, children } = fixture();
  assert.equal(runtime.start('arbitrary').ok, false);
  assert.equal(runtime.start('balanced').ok, true);
  assert.equal(children.length, 1);
  assert.equal(runtime.state, 'starting');
  children[0].line({ type: 'ready', port: 41000 });
  assert.equal(children.length, 2);
  assert(children[1].args.includes('--token'));
  const connection = { ...runtime.connection };
  children[1].line({ type: 'ready', protocol: 1, bot: connection.bot, human: connection.human,
    format: 'gen9randombattle', threads: 2, determinizations: 8, searchMs: 150 });
  assert.equal(runtime.state, 'ready');
  assert.equal(runtime.start('full').ok, false);
  assert.equal(JSON.stringify(runtime.status()).includes(connection.token), false);
  children[1].line({ type: 'thinking', room: 'battle-gen9randombattle-1', turn: 2 });
  assert.equal(runtime.battle.thinking, true);
  children[1].line({ type: 'end', room: 'battle-gen9randombattle-1', result: 'win' });
  assert.equal(runtime.battle.result, 'win');
  runtime.stop();
  assert(children.every(child => child.killed));
});

test('practice failure stops sibling processes and ignores stale generation events', () => {
  const { runtime, children } = fixture();
  runtime.start('quiet');
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

test('practice rejects malformed readiness and unbounded child output', () => {
  for (const message of [{ type: 'ready', port: 80 }, { type: 'ready', port: '41000' }]) {
    const { runtime, children } = fixture();
    runtime.start('full');
    children[0].line(message);
    assert.equal(runtime.state, 'failed');
  }
  const { runtime, children } = fixture();
  runtime.start('full');
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

test('terminal client failures stop only their matching runtime session', () => {
  const { runtime, children } = fixture();
  runtime.start('full');
  const token = runtime.connection.token;
  runtime.clientFailed('stale token');
  assert.equal(runtime.state, 'starting');
  runtime.clientFailed(token);
  assert.equal(runtime.state, 'failed');
  assert.match(runtime.error, /battle client failed/);
  assert(children[0].killed);
});
