'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { inspectRuntime } = require('./practice-manifest');
const { verifyInWorker } = require('./practice-verification');

const PRESETS = Object.freeze({ quiet: 1, balanced: 2, full: 8 });
const ERRORS = Object.freeze({
  missing: 'Practice runtime is not installed.',
  start: 'Practice could not start. Stop and try again.',
  exited: 'Practice stopped unexpectedly. Start a new session to try again.',
  timeout: 'Practice took too long to start. Stop and try again.',
  client: 'The battle client failed. Start a new session to try again.',
  integrity: 'Practice runtime failed its integrity check. Rebuild or reinstall the practice runtime.',
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
  constructor({ root, scripts, node = process.execPath, spawnChild = spawn, verify = verifyInWorker, timeoutMs = 120000, foulPlay = null, python = null, installed = null, laplace = true }) {
    super();
    this.root = root;
    this.scripts = scripts;
    this.node = node;
    this.python = python || path.join(root, 'python/python.exe');
    this.foulPlay = foulPlay;
    this.laplace = laplace;
    this.inspectInstalled = installed;
    this.opponent = 'laplace';
    this.spawnChild = spawnChild;
    this.timeoutMs = timeoutMs;
    this.verify = verify;
    this.verification = null;
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
    if (this.inspectInstalled) return this.inspectInstalled();
    return inspectRuntime(this.root).ok;
  }

  status() {
    const inspection = this.inspectInstalled ? { ok: this.installed() } : inspectRuntime(this.root);
    return { installed: this.installed(), state: this.state, opponent: this.opponent,
      opponents: [
        { id: 'laplace', name: 'Laplace', available: this.installed() && this.laplace, description: 'Search guided by a trained value model.' },
        { id: 'foulplay', name: 'Foul Play', available: this.installed() && Boolean(this.foulPlay), description: 'Monte Carlo search over possible opposing teams.' },
      ],
      error: this.error || (inspection.code === 'invalid' ? 'Practice runtime needs repair. Rebuild or reinstall it.' : ''),
      preset: this.preset, battle: this.battle };
  }

  changed() { this.emit('change', this.status()); }

  async start(preset) {
    const opponent = typeof preset === 'object' && preset !== null ? preset.opponent : 'laplace';
    preset = typeof preset === 'object' && preset !== null ? preset.preset : preset;
    if (!['laplace', 'foulplay'].includes(opponent) || (opponent === 'foulplay' && !this.foulPlay) || (opponent === 'laplace' && !this.laplace)) {
      return { ok: false, error: 'This opponent is not installed on the battle server.' };
    }
    if (!Object.hasOwn(PRESETS, preset)) return { ok: false, error: 'Choose a supported computation setting.' };
    if (this.children.size || this.state === 'starting' || this.state === 'ready') {
      return { ok: false, error: 'Stop the current practice session before starting another.' };
    }
    if (!this.installed()) return { ok: false, error: ERRORS.missing };
    const generation = ++this.generation;
    this.preset = preset;
    this.opponent = opponent;
    this.state = 'starting';
    this.error = '';
    this.battle = null;
    this.connection = { token: crypto.randomBytes(32).toString('hex'), human: 'Player', bot: opponent === 'laplace' ? 'Laplace' : 'FoulPlay', port: null };
    this.changed();
    this.timer = setTimeout(() => this.fail('timeout', generation), this.timeoutMs);
    this.timer.unref?.();
    let result;
    try {
      this.verification = this.verify(this.root);
      result = await this.verification.promise;
    } catch { result = { ok: false }; }
    if (generation !== this.generation) return { ok: false, cancelled: true };
    this.verification = null;
    if (!result.ok) {
      this.fail('integrity', generation);
      return { ok: false, error: ERRORS.integrity };
    }
    const server = this.launch(this.node, [path.join(this.scripts, 'server.cjs'), '--server-root',
      path.join(this.root, 'server'), '--port', '0', '--token', this.connection.token], true, generation);
    if (server) this.readLines(server, generation, (event) => {
      if (event.type !== 'ready' || this.connection.port !== null) return;
      if (!Number.isInteger(event.port) || event.port < 1024 || event.port > 65535) return this.fail('start', generation);
      this.connection.port = event.port;
      const spec = opponent === 'foulplay' ? this.foulPlay : null;
      const bot = this.launch(spec?.python || this.python, ['-I', '-B', spec?.runner || path.join(this.scripts, 'runner.py'),
        ...(spec ? ['--source', spec.source] : []),
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
          (this.opponent === 'laplace' && (event.determinizations !== 8 || event.searchMs !== 150)) ||
          (this.opponent === 'foulplay' && (event.opponent !== 'foulplay' || event.searchMs !== 100))) return this.fail('start', generation);
      clearTimeout(this.timer);
      this.state = 'ready';
      this.changed();
      this.emit('ready', { ...this.connection });
      return;
    }
    if (this.state !== 'ready' || !/^battle-gen9randombattle-\d{1,16}(?:-[a-z0-9]{1,32}pw)?$/.test(event.room || '')) return;
    if (event.type === 'recovery') {
      if (this.battle?.room !== event.room || !['rejected-choice', 'default-choice'].includes(event.kind) ||
          ![event.rejectedChoices, event.defaultChoices].every(value => Number.isInteger(value) && value >= 0 && value <= 10000)) return;
      this.battle = { ...this.battle,
        rejectedChoices: Math.max(this.battle.rejectedChoices || 0, event.rejectedChoices),
        defaultChoices: Math.max(this.battle.defaultChoices || 0, event.defaultChoices) };
      this.changed();
      return;
    }
    if (!['battle', 'thinking', 'turn', 'end'].includes(event.type)) return;
    const previous = this.battle?.room === event.room ? this.battle : {};
    this.battle = { ...previous, room: event.room, thinking: event.type === 'thinking',
      finished: event.type === 'end' };
    if (Number.isInteger(event.turn) && event.turn >= 0 && event.turn <= 10000) this.battle.turn = event.turn;
    if (Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && event.elapsedMs < 3600000) this.battle.elapsedMs = Math.round(event.elapsedMs);
    if (event.type === 'turn' && event.fallback === true) this.battle.searchFallbacks = Math.min(10000, (previous.searchFallbacks || 0) + 1);
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
    this.verification?.cancel();
    this.verification = null;
    clearTimeout(this.timer);
    for (const child of this.children) {
      // Both subprocesses are configured without subprocess pools.
      child.stdin?.end?.();
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
