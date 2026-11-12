'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function inventory(roots) {
  const files = [];
  function visit(file) {
    const name = path.basename(file);
    if (name === '.git') return;
    if (fs.statSync(file).isDirectory()) {
      for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child));
    } else {
      files.push({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
  }
  for (const root of roots) visit(root);
  return { version: 1, roots, files };
}

async function verifyInventory(filename, signal) {
  try {
    const manifest = JSON.parse(await fs.promises.readFile(filename, { encoding: 'utf8', signal }));
    if (manifest.version !== 1 || !Array.isArray(manifest.roots) || !manifest.roots.length ||
        !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000) return false;
    const actual = [];
    async function walk(file, depth = 0) {
      if (depth > 64 || signal.aborted || actual.length > 100000) throw new Error('Invalid inventory');
      const name = path.basename(file);
      if (name === '.git') return;
      if ((await fs.promises.stat(file)).isDirectory()) {
        for (const child of await fs.promises.readdir(file)) await walk(path.join(file, child), depth + 1);
      } else actual.push(file);
    }
    for (const root of manifest.roots) { if (!path.isAbsolute(root)) return false; await walk(root); }
    const expected = manifest.files.map(file => file.path).sort();
    actual.sort();
    if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) return false;
    for (const file of manifest.files) {
      if (signal.aborted || !path.isAbsolute(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file.path, { signal })) hash.update(chunk);
      if (hash.digest('hex') !== file.sha256) return false;
    }
    return !signal.aborted;
  } catch { return false; }
}

module.exports = { inventory, verifyInventory };
