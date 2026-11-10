'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { allowRequest } = require('../app/practice-view');

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
