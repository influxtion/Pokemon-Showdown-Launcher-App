'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createService } = require('../scripts/bots/service.cjs');
const { HostedPractice, serviceUrl } = require('../app/hosted-practice');
const { WebSocket, WebSocketServer } = require('ws');
const http = require('node:http');

const key = 'a'.repeat(64);
class Runtime extends EventEmitter {
  state = 'idle';
  stopped = false;
  status() { return { installed: true, state: this.state, opponent: this.opponent,
    opponents: [{ id: 'laplace', name: 'Laplace', available: true }, { id: 'foulplay', name: 'Foul Play', available: true }], battle: null }; }
  async start(options) { this.opponent = options.opponent; this.state = 'ready'; return { ok: true }; }
  stop() { this.stopped = true; this.state = 'idle'; }
}
async function fixture(t, extra = {}) {
  const runtimes = [];
  const service = createService({ key, clientRoot: '/absent', maxSessions: 1,
    createRuntime: () => { const runtime = new Runtime(); runtimes.push(runtime); return runtime; }, ...extra });
  const origin = await service.listen();
  t.after(() => service.close());
  const request = (route, method = 'GET', body, auth = key, headers = {}) => fetch(`${origin}${route}`, {
    method, headers: { Authorization: `Bearer ${auth}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { service, origin, request, runtimes };
}

test('service authenticates creation, bounds capacity and validates bot options before spawning', async t => {
  const { request, service, runtimes } = await fixture(t);
  assert.equal((await request('/v1/bots', 'GET', undefined, 'wrong')).status, 401);
  assert.equal((await request('/v1/bots', 'GET', undefined, key, { Origin: 'https://attacker.invalid' })).status, 403);
  for (const options of [null, { opponent: 'arbitrary', preset: 'full' }, { opponent: 'foulplay', preset: 'full', path: 'run.py' }]) {
    assert.equal((await request('/v1/sessions', 'POST', options)).status, 400);
  }
  assert.equal(runtimes.length, 0);
  const response = await request('/v1/sessions', 'POST', { opponent: 'foulplay', preset: 'balanced' });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal((await request('/v1/sessions', 'POST', { opponent: 'laplace', preset: 'full' })).status, 429);
  const status = await (await request(`/v1/sessions/${id}`)).json();
  assert.equal(status.opponent, 'foulplay');
  assert(!JSON.stringify(status).includes(id));
  assert.equal((await request(`/v1/sessions/${id}`, 'DELETE')).status, 200);
  assert.equal(service.sessions.size, 0);
  assert(runtimes[0].stopped);
  assert.equal((await request(`/v1/sessions/${id}`)).status, 404);
});

test('abandoned starts and sessions expire and release their children', async t => {
  let time = 0;
  const { service, request, runtimes } = await fixture(t, { now: () => time, startupMs: 100, idleMs: 200, lifetimeMs: 300 });
  const create = async () => (await (await request('/v1/sessions', 'POST', { opponent: 'laplace', preset: 'quiet' })).json()).id;
  await create();
  time = 101;
  service.sweep();
  assert(runtimes[0].stopped);
  const id = await create();
  service.sessions.get(id).connected = true;
  time = 302;
  service.sweep();
  assert(runtimes[1].stopped);
  const next = await create();
  service.sessions.get(next).connected = true;
  time = 603;
  await request(`/v1/sessions/${next}`);
  service.sweep();
  assert(runtimes[2].stopped);
});

test('session websocket uses its own loopback server and closes on DELETE', async t => {
  const upstreamServer = http.createServer();
  const upstream = new WebSocketServer({ server: upstreamServer });
  await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.close(); upstreamServer.close(); });
  let observed;
  upstream.on('connection', (socket, request) => {
    observed = request.url;
    socket.send('ready');
    socket.on('message', data => socket.send(data.toString()));
  });
  const { request, origin, service } = await fixture(t);
  const { id } = await (await request('/v1/sessions', 'POST', { opponent: 'laplace', preset: 'quiet' })).json();
  service.sessions.get(id).runtime.connection = { port: upstreamServer.address().port, token: 'b'.repeat(64) };
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/s/${id}/websocket`, { origin });
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once('message', resolve); socket.once('error', reject); });
  assert.equal(observed, `/showdown/websocket?token=${'b'.repeat(64)}`);
  const echoed = new Promise(resolve => socket.once('message', data => resolve(data.toString())));
  socket.send('|/choose move 1');
  assert.equal(await echoed, '|/choose move 1');
  const closed = new Promise(resolve => socket.once('close', resolve));
  await request(`/v1/sessions/${id}`, 'DELETE');
  await closed;
});

test('hosted runtime cancels an in-flight create and deletes the late session', async t => {
  let complete;
  const deleted = [];
  const runtime = new HostedPractice({ url: 'http://127.0.0.1:8787', key, intervalMs: 60000,
    fetcher: async (url, options) => {
      if (options.method === 'POST') return new Promise(resolve => { complete = () => resolve({ ok: true, text: async () => JSON.stringify({ id: 'c'.repeat(64) }) }); });
      if (options.method === 'DELETE') deleted.push(url);
      return { ok: true, text: async () => JSON.stringify({ opponents: [] }) };
    } });
  t.after(() => runtime.dispose());
  const start = runtime.start({ opponent: 'laplace', preset: 'full' });
  await runtime.stop();
  complete();
  assert.equal((await start).cancelled, true);
  assert.equal(deleted.length, 1);
  assert.equal(runtime.status().state, 'idle');
});

test('hosted endpoint accepts HTTPS or IPv4 loopback only', () => {
  assert.equal(serviceUrl('https://bots.example.org'), 'https://bots.example.org');
  for (const url of ['http://bots.example.org', 'https://user:pass@bots.example.org', 'https://bots.example.org/path', 'file:///x', 'https://bots.example.org/?secret=x']) assert.throws(() => serviceUrl(url));
});
