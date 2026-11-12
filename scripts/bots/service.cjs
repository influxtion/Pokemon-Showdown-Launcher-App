'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const { PracticeRuntime } = require('../../app/practice-runtime');
const { readBotConfig, runtimeOptions } = require('../../app/bot-config');
const { serviceUrl } = require('../../app/hosted-practice');

const workspace = path.resolve(__dirname, '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.gif': 'image/gif', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

function createService({ createRuntime, clientRoot, key, origin, maxSessions = 2, idleMs = 300000,
  lifetimeMs = 3600000, startupMs = 120000, now = Date.now }) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('Set a battle service access key of at least 32 characters.');
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 16) throw new Error('Invalid session limit');
  if (origin) origin = serviceUrl(origin);
  const sessions = new Map();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
  let localOrigin;
  let closing = false;
  function validHost(request) {
    const expected = new URL(origin || localOrigin);
    return request.headers.host === expected.host && (!request.headers.origin || request.headers.origin === expected.origin);
  }
  function authorized(request) {
    const supplied = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${key}`);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }
  function json(response, code, value) {
    response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(JSON.stringify(value));
  }
  function remove(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    for (const socket of session.sockets) socket.terminate();
    session.runtime.stop();
  }
  async function body(request) {
    let buffer = '';
    for await (const chunk of request) {
      buffer += chunk;
      if (buffer.length > 1024) throw new Error('Request too large');
    }
    return JSON.parse(buffer);
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (closing || !validHost(request)) return json(response, 403, { error: 'Forbidden' });
      const url = new URL(request.url, 'http://local');
      if (url.search && !(url.pathname.startsWith('/s/') && /^\?v=[a-zA-Z0-9.-]{1,32}$/.test(url.search))) return json(response, 400, { error: 'Unexpected query' });
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
      if (url.pathname.startsWith('/v1/') && !authorized(request)) return json(response, 401, { error: 'Unauthorized' });
      if (request.method === 'GET' && url.pathname === '/v1/bots') {
        const runtime = createRuntime();
        return json(response, 200, { opponents: runtime.status().opponents });
      }
      if (request.method === 'POST' && url.pathname === '/v1/sessions') {
        const options = await body(request);
        if (!options || !['laplace', 'foulplay'].includes(options.opponent) || !['quiet', 'balanced', 'full'].includes(options.preset) ||
            Object.keys(options).some(key => !['opponent', 'preset'].includes(key))) return json(response, 400, { error: 'Invalid battle options' });
        if (sessions.size >= maxSessions) return json(response, 429, { error: 'Capacity reached' });
        const runtime = createRuntime();
        if (!runtime.status().opponents.some(bot => bot.id === options.opponent && bot.available)) return json(response, 503, { error: 'Opponent unavailable' });
        const id = crypto.randomBytes(32).toString('hex');
        const session = { runtime, created: now(), touched: now(), sockets: new Set(), connected: false };
        sessions.set(id, session);
        // Reserve capacity before async verification. A disconnected POST expires without a client.
        Promise.resolve(runtime.start(options)).then(result => {
          if (!result.ok && sessions.get(id) === session && runtime.state !== 'failed') remove(id);
        }).catch(() => remove(id));
        return json(response, 201, { id });
      }
      const api = /^\/v1\/sessions\/([a-f0-9]{64})$/.exec(url.pathname);
      if (api) {
        const session = sessions.get(api[1]);
        if (!session) return json(response, 404, { error: 'Session expired' });
        if (request.method === 'DELETE') { remove(api[1]); return json(response, 200, { ok: true }); }
        if (request.method === 'GET') { session.touched = now(); return json(response, 200, session.runtime.status()); }
      }
      const asset = /^\/s\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
      if (request.method === 'GET' && asset) {
        const session = sessions.get(asset[1]);
        if (!session || session.runtime.state !== 'ready') return json(response, 404, { error: 'Session unavailable' });
        const name = decodeURIComponent(asset[2]);
        if (!/^[a-zA-Z0-9_./@-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) return json(response, 404, {});
        const type = MIME[path.extname(name)];
        if (!type) return json(response, 404, {});
        let data;
        if (name === 'client-bootstrap.js') data = await fs.readFile(path.join(workspace, 'vendor/laplace/client-bootstrap.js'));
        else if (name === 'practice-client.html') {
          data = (await fs.readFile(path.join(workspace, 'vendor/laplace/practice-client.html'), 'utf8'))
            .replace('<html lang="en">', `<html lang="en" data-practice-bot="${session.runtime.connection.bot}">`)
            .replace('connect-src ws://127.0.0.1:*', `connect-src ${(origin || localOrigin).replace(/^http/, 'ws')}`);
        } else {
          const file = await fs.realpath(path.join(clientRoot, name));
          const relative = path.relative(await fs.realpath(clientRoot), file);
          if (relative.startsWith('..') || path.isAbsolute(relative)) return json(response, 404, {});
          data = await fs.readFile(file);
        }
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
          'Content-Security-Policy': "frame-ancestors 'none'" });
        response.end(data);
        return;
      }
      json(response, 404, { error: 'Not found' });
    } catch { if (!response.headersSent) json(response, 400, { error: 'Invalid request' }); else response.destroy(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('upgrade', (request, socket, head) => {
    const match = /^\/s\/([a-f0-9]{64})\/websocket$/.exec(request.url);
    const session = match && sessions.get(match[1]);
    if (closing || !validHost(request) || !session || session.runtime.state !== 'ready' || session.sockets.size) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, client => {
      session.sockets.add(client);
      session.connected = true;
      session.disconnectedAt = null;
      const connection = session.runtime.connection;
      const upstream = new WebSocket(`ws://127.0.0.1:${connection.port}/showdown/websocket?token=${connection.token}`, { maxPayload: 2 ** 20 });
      let count = 0, windowStart = now();
      client.on('message', (data, binary) => {
        if (now() - windowStart > 1000) { count = 0; windowStart = now(); }
        if (binary || ++count > 40 || upstream.readyState !== WebSocket.OPEN) return client.close(1008);
        session.touched = now();
        upstream.send(data.toString());
      });
      upstream.on('message', data => { if (client.readyState === WebSocket.OPEN) client.send(data.toString()); });
      upstream.on('close', () => client.close());
      upstream.on('error', () => client.close(1011));
      client.on('error', () => upstream.terminate());
      client.on('close', () => { upstream.terminate(); session.sockets.delete(client); session.disconnectedAt = now(); });
    });
  });
  function sweep() {
    for (const [id, session] of sessions) {
      if (now() - session.created > lifetimeMs || now() - session.touched > idleMs ||
          (!session.connected && now() - session.created > startupMs) ||
          (session.disconnectedAt !== null && session.disconnectedAt !== undefined && now() - session.disconnectedAt > 10000)) remove(id);
    }
  }
  const timer = setInterval(sweep, 1000);
  timer.unref();
  return { server, sessions, sweep,
    async listen(port = 0, host = '127.0.0.1') {
      if (host !== '127.0.0.1' && !origin) throw new Error('Set BOT_SERVICE_ORIGIN before binding externally.');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      localOrigin = `http://127.0.0.1:${server.address().port}`;
      return origin || localOrigin;
    },
    async close() {
      closing = true;
      clearInterval(timer);
      for (const id of [...sessions.keys()]) remove(id);
      sockets.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function main() {
  const config = readBotConfig(process.env.SHOWDOWN_BOT_CONFIG || path.join(workspace, 'out/bots/config.json'));
  if (!config) throw new Error('Run npm run bots:setup first.');
  const options = runtimeOptions(config, workspace);
  const service = createService({ createRuntime: () => new PracticeRuntime(options), clientRoot: path.join(config.root, 'client'),
    key: process.env.BOT_SERVICE_KEY, origin: process.env.BOT_SERVICE_ORIGIN,
    maxSessions: Number(process.env.BOT_MAX_SESSIONS || 2) });
  const address = await service.listen(Number(process.env.PORT || 8787), process.env.BOT_SERVICE_HOST || '127.0.0.1');
  console.log(`Battle service listening at ${address}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close().then(() => process.exit(0)));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createService };
