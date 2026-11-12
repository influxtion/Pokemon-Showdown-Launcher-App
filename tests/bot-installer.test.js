'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BotInstaller } = require('../app/bot-installer');
const { readBotConfig, runtimeOptions } = require('../app/bot-config');
const { PracticeRuntime } = require('../app/practice-runtime');

function fixture(t, platform = 'linux') {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-installer-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const children = [];
  const installer = new BotInstaller({ workspace, node: '/node', platform, spawnChild: (exe, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    Object.assign(child, { exe, args, options });
    children.push(child);
    return child;
  } });
  return { workspace, installer, children };
}

test('installer runs fixed setup for one allowlisted bot and reports progress', async t => {
  const { workspace, installer, children } = fixture(t);
  assert.equal(installer.install('../evil').ok, false);
  assert.equal(children.length, 0);
  let installed = null;
  installer.on('installed', bot => { installed = bot; });
  assert.equal(installer.install('foulplay').ok, true);
  assert.equal(installer.install('laplace').ok, false, 'one install at a time');
  const [child] = children;
  assert.equal(child.exe, '/node');
  assert.deepEqual(child.args, [path.join(workspace, 'scripts/bots/setup.cjs'), '--bot', 'foulplay', '--build-linux', '--python', 'python3']);
  assert.equal(child.options.env.ELECTRON_RUN_AS_NODE, '1');
  child.stdout.emit('data', Buffer.from('Fetching Foul Play…\nBuilding the Foul'));
  assert.equal(installer.status().line, 'Fetching Foul Play…');
  child.stdout.emit('data', Buffer.from(' Play search engine…\n'));
  assert.equal(installer.status().line, 'Building the Foul Play search engine…');
  child.emit('close', 0);
  assert.equal(installer.status().state, 'done');
  assert.equal(installed, 'foulplay');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(fs.readFileSync(path.join(workspace, 'out/bots/install.log'), 'utf8'), /search engine/);
});

test('installer reports the last error line and resets after cancel', async t => {
  const { installer, children } = fixture(t, 'win32');
  installer.install('laplace');
  assert.deepEqual(children[0].args.slice(1), ['--bot', 'laplace']);
  children[0].stderr.emit('data', Buffer.from('Laplace needs the Windows practice runtime.\n'));
  children[0].emit('close', 1);
  assert.equal(installer.status().state, 'failed');
  assert.match(installer.status().error, /Laplace install failed: Laplace needs the Windows practice runtime/);
  installer.install('laplace');
  assert.equal(installer.cancel().ok, true);
  children[1].emit('close', null);
  assert.equal(installer.status().state, 'idle');
  assert.equal(installer.cancel().ok, false);
  await new Promise(resolve => setTimeout(resolve, 20));
});

test('bot config allows either opponent alone and runtime gates the missing one', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['runtime', 'foul-env', 'foul-src']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'integrity.json'), '{}');
  const file = path.join(root, 'config.json');
  const write = extra => fs.writeFileSync(file, JSON.stringify({ version: 1, portable: true,
    root: path.join(root, 'runtime'), integrityFile: path.join(root, 'integrity.json'), ...extra }));
  write({});
  assert.throws(() => readBotConfig(file), /no opponent/);
  write({ foulPlayPython: path.join(root, 'foul-env') });
  assert.throws(() => readBotConfig(file), /foulPlaySource/);
  write({ foulPlayPython: path.join(root, 'foul-env'), foulPlaySource: path.join(root, 'foul-src') });
  const options = runtimeOptions(readBotConfig(file), root);
  assert.equal(options.laplace, false);
  assert.equal(options.foulPlay.python, path.join(root, 'foul-env'));
  const runtime = new PracticeRuntime({ ...options, verify: () => ({ promise: Promise.resolve({ ok: true }), cancel() {} }), spawnChild: () => { throw new Error('unexpected'); } });
  runtime.installed = () => true;
  assert.deepEqual(runtime.status().opponents.map(bot => bot.available), [false, true]);
  assert.equal((await runtime.start({ opponent: 'laplace', preset: 'quiet' })).ok, false);
});
