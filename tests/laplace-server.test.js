'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { createInterface } = require('node:readline');
const test = require('node:test');
const { localConfig, parseOptions, restrictListener } = require('../scripts/laplace/server.cjs');

const token = 'a'.repeat(32);
const root = path.resolve('runtime-server');
const endpoint = `/showdown/websocket?token=${token}`;

test('practice server requires a fixed root, a local port and a session token', () => {
  assert.deepEqual(parseOptions(['--server-root', root, '--port', '0', '--token', token]), {
    root, port: 0, token,
  });
  for (const [rootValue, port, tokenValue] of [
    ['relative', '1024', token], [root, '1e3', token], [root, '65536', token],
    [root, '8000', 'bad'],
  ]) {
    assert.throws(() => parseOptions(['--server-root', rootValue, '--port', port, '--token', tokenValue]));
  }
  const config = localConfig(8000);
  assert.equal(config.bindaddress, '127.0.0.1');
  assert.equal(config.subprocesses, 0);
  assert.equal(config.noNetRequests, true);
  assert.equal(config.nofswriting, true);
  assert.equal(config.repl, false);
});

test('practice listener forwards only authenticated raw WebSocket upgrades', async t => {
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 204 No Content\r\n\r\n'));
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  restrictListener(server, token);
  const { port } = server.address();

  function request(url, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: url, headers }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
  }
  const upgrade = { Connection: 'upgrade', Upgrade: 'websocket' };
  assert.equal(await request('/'), 404);
  assert.equal(await request(endpoint), 404);
  assert.equal(await request('/showdown/websocket', upgrade), 403);
  assert.equal(await request(endpoint, { ...upgrade, Host: `localhost:${port}` }), 403);
  assert.equal(await request(endpoint, upgrade), 204);
});

test('staged Showdown server accepts a practice guest and exits when the parent pipe closes', {
  skip: !process.env.LAPLACE_TEST_SERVER_ROOT,
  timeout: 30_000,
}, async t => {
  const launcher = path.resolve(__dirname, '../scripts/laplace/server.cjs');
  const child = spawn(process.execPath, [launcher, '--server-root', process.env.LAPLACE_TEST_SERVER_ROOT,
    '--port', '0', '--token', token], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
  });
  let diagnostics = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk; });
  const output = createInterface({ input: child.stdout });
  const ready = await Promise.race([
    once(output, 'line').then(([line]) => JSON.parse(line)),
    exited.then(([code]) => { throw new Error(`Server exited (${code}) before ready.\n${diagnostics}`); }),
  ]);
  assert.equal(ready.type, 'ready');
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);

  const base = `127.0.0.1:${ready.port}`;
  const page = await fetch(`http://${base}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 404);

  const socket = new WebSocket(`ws://${base}${endpoint}`);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Guest login timed out.\n${diagnostics}`)), 5000);
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`Practice socket failed.\n${diagnostics}`));
    }, { once: true });
    socket.addEventListener('message', ({ data }) => {
      if (data.includes('|challstr|')) socket.send('|/trn DesktopGuest,0,');
      if (data.includes('|updateuser| DesktopGuest|1|')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
});
