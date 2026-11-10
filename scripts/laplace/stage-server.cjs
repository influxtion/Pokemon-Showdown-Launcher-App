'use strict';

// Stage reviewed code and dependencies, never the developer server's writable profile.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const source = path.resolve(process.argv[2] || '');
const revision = 'a9caa4cabe89459b00e717a47148d0f67b4451ae';
if (!process.argv[2] || execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) {
  throw new Error('Provide the pinned Showdown server checkout.');
}
const target = path.join(root, 'vendor/laplace/dist/server');
if (fs.existsSync(target)) throw new Error('Server runtime exists; preserve it before staging a replacement.');
fs.mkdirSync(target, { recursive: true });
for (const name of ['dist', 'data', 'node_modules', 'translations']) {
  fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true, dereference: false });
}
fs.mkdirSync(path.join(target, 'config'));
fs.writeFileSync(path.join(target, 'config/config.js'), "'use strict';\n// Configuration is injected by the desktop's isolated server entry point.\n");
for (const name of ['LICENSE', 'package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, name), path.join(target, name));
fs.writeFileSync(path.join(target, 'SOURCE.json'), JSON.stringify({ repository: 'https://github.com/smogon/pokemon-showdown', revision }, null, 2));
console.log('Staged local Showdown server.');
