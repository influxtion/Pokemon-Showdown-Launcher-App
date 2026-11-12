'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const BOTS = Object.freeze({ laplace: 'Laplace', foulplay: 'Foul Play' });
const MAX_LINE = 200;

// Runs the development setup script for one opponent. The renderer only ever picks
// an allowlisted bot id; the script, arguments and output directory are fixed here.
class BotInstaller extends EventEmitter {
  constructor({ workspace, node = process.execPath, platform = process.platform, spawnChild = spawn }) {
    super();
    this.workspace = workspace;
    this.node = node;
    this.platform = platform;
    this.spawnChild = spawnChild;
    this.child = null;
    this.value = { state: 'idle', bot: null, line: '', error: '' };
  }

  status() { return { ...this.value }; }

  set(value) {
    this.value = { ...this.value, ...value };
    this.emit('change', this.status());
  }

  arguments(bot) {
    const args = [path.join(this.workspace, 'scripts/bots/setup.cjs'), '--bot', bot];
    // Linux has no packaged Windows runtime, so the simulator, client and engines build locally.
    if (this.platform === 'linux') args.push('--build-linux', '--python', 'python3');
    return args;
  }

  install(bot) {
    if (!Object.hasOwn(BOTS, bot)) return { ok: false, error: 'Choose a supported opponent.' };
    if (this.child) return { ok: false, error: 'Another opponent is already installing.' };
    const output = path.join(this.workspace, 'out/bots');
    let log;
    try {
      fs.mkdirSync(output, { recursive: true });
      log = fs.createWriteStream(path.join(output, 'install.log'));
      log.on('error', () => {}); // The log is a convenience; never fail the install over it.
    } catch { return { ok: false, error: 'Could not prepare the install folder.' }; }
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0' };
    let child;
    try {
      // Own process group so Cancel also stops git, pip and compiler children.
      child = this.spawnChild(this.node, this.arguments(bot), { cwd: this.workspace, env, windowsHide: true,
        detached: this.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      log.end();
      return { ok: false, error: `${BOTS[bot]} could not start installing.` };
    }
    this.child = child;
    this.cancelled = false;
    this.set({ state: 'installing', bot, line: `Installing ${BOTS[bot]}…`, error: '' });
    let lastError = '';
    const read = (stream, isError) => {
      let buffer = '';
      stream?.on('data', data => {
        log.write(data);
        buffer += data.toString('utf8');
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop().slice(-4096);
        for (const raw of lines) {
          const line = raw.trim().slice(0, MAX_LINE);
          if (!line) continue;
          if (isError) lastError = line;
          else if (this.child === child) this.set({ line });
        }
      });
    };
    read(child.stdout, false);
    read(child.stderr, true);
    const finish = code => {
      if (this.child !== child) return;
      this.child = null;
      log.end();
      if (this.cancelled) this.set({ state: 'idle', bot: null, line: '', error: '' });
      else if (code === 0) {
        this.set({ state: 'done', line: `${BOTS[bot]} installed.`, error: '' });
        this.emit('installed', bot);
      } else {
        this.set({ state: 'failed', line: '', error: `${BOTS[bot]} install failed${lastError ? `: ${lastError}` : '.'} Details are in out/bots/install.log.` });
      }
    };
    child.once('error', () => finish(-1));
    child.once('close', finish);
    return { ok: true };
  }

  cancel() {
    if (!this.child) return { ok: false };
    this.cancelled = true;
    const { pid } = this.child;
    try {
      if (this.platform === 'win32' && pid) this.spawnChild('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else if (pid) process.kill(-pid, 'SIGTERM');
      else this.child.kill();
    } catch { this.child.kill(); }
    return { ok: true };
  }
}

module.exports = { BotInstaller, BOTS };
