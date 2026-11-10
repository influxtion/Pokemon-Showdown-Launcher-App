'use strict';

const { Socket } = require('node:net');
const { parseArgs } = require('node:util');
const path = require('node:path');

const LOOPBACK = '127.0.0.1';

function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      'server-root': { type: 'string' },
      port: { type: 'string' },
      token: { type: 'string' },
    },
  });
  const port = Number(values.port);
  if (!values['server-root'] || !path.isAbsolute(values['server-root']) ||
      !/^\d{1,5}$/.test(values.port) || port > 65535 ||
      !/^[a-f0-9]{32,128}$/.test(values.token)) {
    throw new Error('Invalid practice server options.');
  }
  return { root: values['server-root'], port, token: values.token };
}

function localConfig(port) {
  return {
    bindaddress: LOOPBACK,
    port,
    lazysockets: true,
    subprocesses: 0,
    ssl: null,
    nofswriting: true,
    noNetRequests: true,
    noguestsecurity: true,
    noipchecks: true,
    nothrottle: true,
    loginserver: `http://${LOOPBACK}/`,
    remoteladder: false,
    repl: false,
    watchconfig: false,
    usesqlite: false,
    crashguard: false,
    backdoor: false,
    logchat: false,
    logladderip: false,
    loguserstats: 0,
    reportjoins: false,
    reportbattles: false,
    reportbattlejoins: false,
  };
}

function restrictListener(server, token) {
  const emit = server.emit;
  server.emit = function (event, ...args) {
    if (event === 'request') {
      const [, response] = args;
      response.writeHead(404, { Connection: 'close' }).end();
      return true;
    }
    if (event === 'upgrade') {
      const [request, socket] = args;
      const address = server.address();
      if (socket.remoteAddress !== LOOPBACK || request.headers.host !== `${LOOPBACK}:${address?.port}` ||
          request.url !== `/showdown/websocket?token=${token}`) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return true;
      }
    }
    return emit.call(this, event, ...args);
  };
}

async function start({ root, port, token }) {
  // Incoming sockets are accepted by Node; only outgoing TCP and fetch use these methods.
  const outboundDisabled = () => new Error('Outbound connections are disabled in practice.');
  Socket.prototype.connect = () => { throw outboundDisabled(); };
  globalThis.fetch = async () => { throw outboundDisabled(); };

  // Use the staged config placeholder as a module key. The file is never executed or changed.
  const configPath = require.resolve(path.join(root, 'config', 'config.js'));
  require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: localConfig(port) };
  const fromServer = name => require(path.join(root, 'dist', 'server', name));
  fromServer('config-loader.js');

  // The upstream version probe spawns git and touches an index in the server log directory.
  fromServer('monitor.js').Monitor.version = async () => undefined;
  const { LoginServer } = fromServer('loginserver.js');
  LoginServer.disabled = true;
  LoginServer.instantRequest = async () => [null, outboundDisabled()];

  await fromServer('index.js').readyPromise;
  clearInterval(globalThis.Rooms.global.reportUserStatsInterval);
  const { Sockets, PM } = fromServer('sockets.js');
  Sockets.listen(port, LOOPBACK, { network: 0 });
  const server = PM.masterWorker.stream.server;
  restrictListener(server, token);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      if (address?.address !== LOOPBACK || (port && address.port !== port)) {
        server.close();
        reject(new Error('Unexpected practice listener address.'));
        return;
      }
      resolve(address.port);
    });
  });
}

if (require.main === module) {
  // Upstream writes startup diagnostics with console.log. Reserve stdout for the protocol.
  console.log = console.error;
  // The launcher keeps this pipe open. Its closure also handles abrupt launcher exit.
  process.stdin.once('end', () => process.exit(0));
  process.stdin.once('error', () => process.exit(0));
  process.stdin.resume();
  Promise.resolve().then(() => start(parseOptions(process.argv.slice(2)))).then(port => {
    process.stdout.write(`${JSON.stringify({ type: 'ready', port })}\n`);
  }).catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { parseOptions, localConfig, restrictListener };
