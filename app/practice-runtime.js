'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const PRESETS = Object.freeze({ quiet: 1, balanced: 2, full: 8 });
const ERRORS = Object.freeze({
  missing: 'Practice runtime is not installed.',
  start: 'Practice could not start. Stop and try again.',
  exited: 'Practice stopped unexpectedly. Start a new session to try again.',
  timeout: 'Practice took too long to start. Stop and try again.',
  client: 'The local battle client failed. Start a new session to try again.',
});

function childEnvironment(node = false) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (node) env.ELECTRON_RUN_AS_NODE = '1';
  env.PYTHONUTF8 = '1';
  env.OMP_NUM_THREADS = '1';
  env.MKL_NUM_THREADS = '1';
  return env;
}

class PracticeRuntime extends EventEmitter {
  constructor({ root, scripts, node = process.execPath, spawnChild = spawn, timeoutMs = 45000 }) {
    super();
    this.root = root;
    this.scripts = scripts;
    this.node = node;
    this.spawnChild = spawnChild;
    this.timeoutMs = timeoutMs;
    this.children = new Set();
    this.generation = 0;
    this.state = 'idle';
    this.error = '';
    this.preset = 'full';
    this.connection = null;
    this.battle = null;
    this.timer = null;
  }

  installed() {
    return ['python/python.exe', 'server/dist/server/index.js', 'client/practice-client.html', 'laplace/models/value_net.pt']
      .every(file => fs.existsSync(path.join(this.root, file)));
  }

  status() {
    return { installed: this.installed(), state: this.state, error: this.error,
      preset: this.preset, battle: this.battle };
  }

  changed() { this.emit('change', this.status()); }

  start(preset) {
    if (!Object.hasOwn(PRESETS, preset)) return { ok: false, error: 'Choose a supported computation setting.' };
    if (this.children.size || this.state === 'starting' || this.state === 'ready') {
      return { ok: false, error: 'Stop the current practice session before starting another.' };
    }
    if (!this.installed()) return { ok: false, error: ERRORS.missing };
    const generation = ++this.generation;
    this.preset = preset;
    this.state = 'starting';
    this.error = '';
    this.battle = null;
    this.connection = { token: crypto.randomBytes(32).toString('hex'), human: 'Player', bot: 'Laplace', port: null };
    this.changed();
    this.timer = setTimeout(() => this.fail('timeout', generation), this.timeoutMs);
    this.timer.unref?.();
    const server = this.launch(this.node, [path.join(this.scripts, 'server.cjs'), '--server-root',
      path.join(this.root, 'server'), '--port', '0', '--token', this.connection.token], true, generation);
    if (server) this.readLines(server, generation, (event) => {
      if (event.type !== 'ready' || this.connection.port !== null) return;
      if (!Number.isInteger(event.port) || event.port < 1024 || event.port > 65535) return this.fail('start', generation);
      this.connection.port = event.port;
      const bot = this.launch(path.join(this.root, 'python/python.exe'), ['-I', '-B', path.join(this.scripts, 'runner.py'),
        '--port', String(event.port), '--token', this.connection.token,
        '--bot', this.connection.bot, '--human', this.connection.human,
        '--threads', String(PRESETS[preset])], false, generation);
      if (bot) this.readLines(bot, generation, event => this.botEvent(event, generation));
    });
    return { ok: true };
  }

  launch(executable, args, node, generation) {
    let child;
    try {
      child = this.spawnChild(executable, args, { cwd: this.root, windowsHide: true,
        env: childEnvironment(node), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { this.fail('start', generation); return null; }
    this.children.add(child);
    if (child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Best effort on this OS. */ }
    }
    // Drain diagnostics without copying battle state or paths into launcher logs.
    child.stderr?.on('data', () => {});
    child.stdin?.on('error', () => {});
    child.once('error', () => { this.children.delete(child); this.fail('start', generation); });
    child.once('exit', () => { this.children.delete(child); this.fail('exited', generation); this.changed(); });
    return child;
  }

  readLines(child, generation, callback) {
    let buffer = '';
    child.stdout.on('data', data => {
      if (generation !== this.generation) return;
      buffer += data.toString('utf8');
      if (buffer.length > 65536) return this.fail('start', generation);
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event && typeof event === 'object') callback(event);
        if (generation !== this.generation) return;
      }
    });
  }

  botEvent(event, generation) {
    if (event.type === 'error') return this.fail('start', generation);
    if (event.type === 'ready' && this.state === 'starting') {
      if (event.protocol !== 1 || event.bot !== this.connection.bot || event.human !== this.connection.human ||
          event.format !== 'gen9randombattle' || event.threads !== PRESETS[this.preset] ||
          event.determinizations !== 8 || event.searchMs !== 150) return this.fail('start', generation);
      clearTimeout(this.timer);
      this.state = 'ready';
      this.changed();
      this.emit('ready', { ...this.connection });
      return;
    }
    if (this.state !== 'ready' || !/^battle-gen9randombattle-\d{1,16}(?:-[a-z0-9]{1,32}pw)?$/.test(event.room || '')) return;
    if (!['battle', 'thinking', 'turn', 'end'].includes(event.type)) return;
    const previous = this.battle?.room === event.room ? this.battle : {};
    this.battle = { ...previous, room: event.room, thinking: event.type === 'thinking',
      finished: event.type === 'end' };
    if (Number.isInteger(event.turn) && event.turn >= 0 && event.turn <= 10000) this.battle.turn = event.turn;
    if (Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && event.elapsedMs < 3600000) this.battle.elapsedMs = Math.round(event.elapsedMs);
    if (event.type === 'end' && ['win', 'loss', 'tie'].includes(event.result)) this.battle.result = event.result;
    this.changed();
  }

  fail(code, generation) {
    if (generation !== this.generation) return;
    this.stop();
    this.state = 'failed';
    this.error = ERRORS[code] || ERRORS.start;
    this.changed();
    this.emit('failure', code);
  }

  clientFailed(token) {
    if (this.connection?.token === token) this.fail('client', this.generation);
  }

  stop() {
    ++this.generation;
    clearTimeout(this.timer);
    for (const child of this.children) {
      // Both subprocesses are configured without subprocess pools.
      child.kill();
    }
    this.connection = null;
    this.battle = null;
    this.state = 'idle';
    this.error = '';
    this.changed();
    return { ok: true };
  }
}

module.exports = { PracticeRuntime, PRESETS, childEnvironment };
