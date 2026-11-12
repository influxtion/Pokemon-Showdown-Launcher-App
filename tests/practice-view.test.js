'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { allowRequest } = require('../app/practice-view');

test('hosted practice isolates assets and socket to the exact session', () => {
  const token = 'a'.repeat(64);
  const connection = { token, serviceOrigin: 'https://bots.example.org', clientUrl: `https://bots.example.org/s/${token}/practice-client.html`, socketUrl: `wss://bots.example.org/s/${token}/websocket` };
  const allow = (url, resourceType = 'script') => allowRequest({ url, resourceType }, '/local/client', connection);
  assert(allow(connection.clientUrl));
  assert(allow(connection.socketUrl, 'webSocket'));
  assert(allow(`https://bots.example.org/s/${token}/style/font.woff2?v=1`, 'font'));
  assert(!allow('https://bots.example.org/v1/bots'));
  assert(!allow(`https://other.example.org/s/${token}/client.js`));
  assert(!allow(`https://bots.example.org/s/${'b'.repeat(64)}/client.js`));
  assert(!allow('file:///local/client/private.js'));
  assert(!allow('ws://127.0.0.1:8000/showdown/websocket'));
});

test('practice requests stay in bundled files, authenticated loopback socket and artwork paths', () => {
  const root = path.resolve('vendor/laplace/dist/client');
  const connection = { port: 41000, token: 'a'.repeat(64) };
  const allow = (url, resourceType = 'other') => allowRequest({ url, resourceType }, root, connection);
  assert(allow(pathToFileURL(path.join(root, 'js/client.js')).href, 'script'));
  assert(!allow(pathToFileURL(path.join(root, '../python/python.exe')).href));
  assert(!allow('file://elsewhere/secrets'));
  assert(allow(`ws://127.0.0.1:41000/showdown/websocket?token=${connection.token}`, 'webSocket'));
  assert(!allow(`ws://localhost:41000/showdown/websocket?token=${connection.token}`, 'webSocket'));
  assert(!allow('ws://127.0.0.1:41000/showdown/websocket?token=wrong', 'webSocket'));
  assert(!allow('https://play.pokemonshowdown.com/js/client.js', 'script'));
  assert(allow('https://play.pokemonshowdown.com/sprites/ani/pikachu.gif', 'image'));
  assert(allow('https://play.pokemonshowdown.com/sprites/pokemonicons-sheet.png?v22', 'image'));
  assert(!allow('https://play.pokemonshowdown.com/sprites/pokemonicons-sheet.png?token=secret', 'image'));
  assert(!allow('https://play.pokemonshowdown.com/action.php', 'xhr'));
  assert(!allow('https://example.com/sprites/pikachu.png', 'image'));
});
