'use strict';

// Runs the unpacked Windows executable with a temporary profile and blocked outbound traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { Replays } = require('../app/replays');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'out', 'windows', 'win-unpacked', 'Showdown Desktop.exe');
const OUTPUT = path.join(ROOT, 'out', 'packaging-smoke');
const VERSION = require('../package.json').version;
const INSTALLER = path.join(ROOT, 'out', 'windows', `Showdown Desktop Setup ${VERSION}-x64.exe`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close(() => resolve(selected));
    });
  });
}

function directoryBytes(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    total += entry.isDirectory() ? directoryBytes(file) : fs.statSync(file).size;
  }
  return total;
}

async function launcherTarget(debugPort, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((item) => item.type === 'page' &&
          /\/renderer\/index\.html(?:$|[?#])/.test(item.url));
        if (target?.webSocketDebuggerUrl) return target;
      }
    } catch {}
    await pause(150);
  }
  throw new Error('Launcher page did not appear on the local debugging endpoint.');
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out.')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed.')); }, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP connection closed.'));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Page evaluation failed.');
  return response.result.value;
}

async function waitForPage(cdp) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, '({ready: document.readyState, bridge: !!window.desktop, page: location.pathname})');
    if (state.ready === 'complete' && state.bridge && state.page.endsWith('/renderer/index.html')) return;
    await pause(100);
  }
  throw new Error('Launcher bridge was not ready.');
}

function workingSetBytes(pid) {
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`], { encoding: 'utf8' });
    const bytes = Number(output.trim());
    return Number.isSafeInteger(bytes) ? bytes : null;
  } catch { return null; }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Packaged smoke requires Windows.');
  assert.ok(fs.existsSync(EXE), `Build the unpacked app first: ${EXE}`);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-packaged-smoke-'));
  const debugPort = await port();
  const started = performance.now();
  const childEnv = {
    ...process.env, APPDATA: profile, LOCALAPPDATA: profile, SHOWDOWN_DESKTOP_USER_DATA: profile,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--proxy-server=http://127.0.0.1:9',
  ], {
    cwd: path.dirname(EXE),
    env: childEnv,
    stdio: 'ignore', windowsHide: false,
  });
  let cdp;
  try {
    const target = await launcherTarget(debugPort, child);
    cdp = await connect(target.webSocketDebuggerUrl);
    await waitForPage(cdp);
    const startupMs = Math.round(performance.now() - started);
    const page = await evaluate(cdp, '({title: document.title, heading: document.querySelector("h1")?.textContent?.trim() || "", path: location.pathname})');
    assert.ok(page.title && page.path.endsWith('/renderer/index.html'));
    const settings = await evaluate(cdp, 'window.desktop.getSettings()');
    assert.equal(settings.ok, true);
    assert.equal(typeof settings.settings.theme, 'string');
    const showdex = await evaluate(cdp, 'window.desktop.getShowdex()');
    assert.equal(showdex.installed, false);
    assert.equal(showdex.status, 'not-installed');
    const initial = await evaluate(cdp, 'window.desktop.getReplayNotes()');
    assert.equal(initial.ok, true);
    assert.deepEqual(initial.notes, []);
    const saved = await evaluate(cdp, 'window.desktop.saveReplayNote({url:"https://replay.pokemonshowdown.com/gen9randombattle-1234567890",title:"Packaged smoke",format:"gen9randombattle",notes:"Temporary profile only"})');
    assert.equal(saved.ok, true);
    const read = await evaluate(cdp, 'window.desktop.getReplayNotes()');
    assert.equal(read.ok, true);
    assert.equal(read.notes.length, 1);
    assert.equal(read.notes[0].id, saved.note.id);
    const capture = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUTPUT, 'home.png'), Buffer.from(capture.data, 'base64'));
    const report = {
      startupMs, page, settings: settings.settings, showdex,
      replayRoundTrip: true, profileIsTemporary: true,
      unpackedBytes: directoryBytes(path.dirname(EXE)),
      installerBytes: fs.existsSync(INSTALLER) ? fs.statSync(INSTALLER).size : null,
      mainWorkingSetBytes: workingSetBytes(child.pid),
    };
    fs.writeFileSync(path.join(OUTPUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (cdp && child.exitCode === null) {
      try {
        await evaluate(cdp, "window.desktop.setSetting('confirmOnClose', false)");
        await cdp.send('Browser.close');
      } catch {}
      for (let attempt = 0; attempt < 30 && child.exitCode === null; attempt++) await pause(100);
    }
    cdp?.close();
    if (child.pid && child.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    }
    // The launcher process has stopped. Finish the delete check using its isolated store.
    const replayStore = new Replays(profile);
    const notes = replayStore.list();
    if (notes.ok && notes.notes.length === 1) {
      assert.equal(replayStore.delete(notes.notes[0].id).ok, true);
      assert.deepEqual(replayStore.list().notes, []);
    }
    const relativeProfile = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(profile));
    if (!relativeProfile.startsWith('showdown-packaged-smoke-') || relativeProfile.includes(path.sep)) {
      throw new Error('Unexpected temporary profile path; cleanup refused.');
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.warn(`Windows retained locked test files in ${profile}`);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
