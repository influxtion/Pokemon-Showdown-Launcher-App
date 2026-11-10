'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MANIFEST = 'manifest.json';
const MAX_MANIFEST_BYTES = 8 * 1024 ** 2;
const MAX_FILES = 40000;
const MAX_TOTAL_BYTES = 4 * 1024 ** 3;
const REQUIRED = [
  'python/python.exe',
  'python/python312.dll',
  'laplace/models/value_net.pt',
  'server/dist/server/index.js',
  'client/practice-client.html',
];
const MISSING = Object.freeze({ ok: false, code: 'missing', error: 'Practice runtime is not installed.' });
const INVALID = Object.freeze({ ok: false, code: 'invalid', error: 'Practice runtime failed integrity verification.' });
const PRESENT = Object.freeze({ ok: true });

let lastInspection;

function invalid() {
  throw new Error('Invalid practice runtime');
}

function validName(name) {
  if (!name || name.length > 1024 || /[\x00-\x1f\x7f<>:"\\|?*]/.test(name)) return false;
  const segments = name.split('/');
  return segments.length <= 64 && segments.every(segment => segment.length > 0 && segment.length <= 255 &&
    !/[. ]$/.test(segment) &&
    !/^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(segment));
}

function stat(filename) {
  return fs.lstatSync(filename, { bigint: true });
}

function optionalStat(filename) {
  try {
    return stat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function exactLocation(filename) {
  return path.relative(filename, fs.realpathSync.native(filename)) === '';
}

function locate(root) {
  const requested = path.resolve(root);
  const directory = optionalStat(requested);
  if (!directory) return null;
  if (!directory.isDirectory()) invalid();
  const resolvedRoot = fs.realpathSync.native(requested);
  const filename = path.join(resolvedRoot, MANIFEST);
  const manifestStat = optionalStat(filename);
  if (!manifestStat) return null;
  if (!manifestStat.isFile() || manifestStat.size === 0n ||
      manifestStat.size > BigInt(MAX_MANIFEST_BYTES) || !exactLocation(filename)) invalid();
  return { root: resolvedRoot, filename, stat: manifestStat };
}

function withFile(filename, expected, read) {
  const fd = fs.openSync(filename, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFile(opened, expected)) invalid();
    const result = read(fd);
    if (!sameFile(fs.fstatSync(fd, { bigint: true }), expected) || !sameFile(stat(filename), expected)) invalid();
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

function readManifest(location) {
  const bytes = withFile(location.filename, location.stat, fd => {
    const contents = Buffer.allocUnsafe(Number(location.stat.size));
    let offset = 0;
    while (offset < contents.length) {
      const read = fs.readSync(fd, contents, offset, contents.length - offset, null);
      if (read === 0) invalid();
      offset += read;
    }
    return contents;
  });
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!manifest || manifest.version !== 2 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) invalid();
  const names = Object.keys(manifest.files);
  if (names.length > MAX_FILES) invalid();

  const files = new Map();
  const caseFolded = new Set([MANIFEST]);
  let totalBytes = 0;
  for (const name of names) {
    const key = name.toLowerCase();
    const entry = manifest.files[name];
    if (!validName(name) || caseFolded.has(key) || !entry ||
        typeof entry.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_TOTAL_BYTES) invalid();
    totalBytes += entry.size;
    if (totalBytes > MAX_TOTAL_BYTES) invalid();
    caseFolded.add(key);
    files.set(name, { sha256: entry.sha256.toLowerCase(), size: entry.size });
  }
  if (REQUIRED.some(name => !files.get(name)?.size)) invalid();
  return { bytes, files };
}

function inspectRuntime(root) {
  try {
    const location = locate(root);
    if (!location) return MISSING;
    if (lastInspection?.filename === location.filename && sameFile(lastInspection.stat, location.stat)) {
      return lastInspection.result;
    }
    let result = PRESENT;
    try {
      readManifest(location);
    } catch {
      result = INVALID;
    }
    lastInspection = { filename: location.filename, stat: location.stat, result };
    return result;
  } catch {
    return INVALID;
  }
}

function verifyFile(filename, fileStat, expected, buffer) {
  if (fileStat.size !== BigInt(expected.size)) invalid();
  const digest = withFile(filename, fileStat, fd => {
    const hash = createHash('sha256');
    let remaining = expected.size;
    while (remaining > 0) {
      const read = fs.readSync(fd, buffer, 0, Math.min(remaining, buffer.length), null);
      if (read === 0) invalid();
      hash.update(buffer.subarray(0, read));
      remaining -= read;
    }
    return hash.digest('hex');
  });
  if (digest !== expected.sha256) invalid();
}

function verifyTree(location, files) {
  const directories = [''];
  const buffer = Buffer.allocUnsafe(1024 ** 2);
  let entries = 0;
  while (directories.length > 0) {
    const directory = directories.pop();
    const handle = fs.opendirSync(path.join(location.root, directory));
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > MAX_FILES * 2) invalid();
        const name = directory ? `${directory}/${entry.name}` : entry.name;
        if (!validName(name)) invalid();
        const filename = path.join(location.root, name);
        const fileStat = stat(filename);
        if (name === MANIFEST) {
          if (!fileStat.isFile() || !sameFile(fileStat, location.stat)) invalid();
        } else if (fileStat.isDirectory()) {
          if (!exactLocation(filename)) invalid();
          directories.push(name);
        } else {
          const expected = files.get(name);
          if (!fileStat.isFile() || !expected || !exactLocation(filename)) invalid();
          verifyFile(filename, fileStat, expected, buffer);
          files.delete(name);
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  if (files.size || !sameFile(stat(location.filename), location.stat)) invalid();
}

function verifyRuntime(root) {
  try {
    const location = locate(root);
    if (!location) return MISSING;
    const { bytes, files } = readManifest(location);
    verifyTree(location, files);
    return { ok: true, identity: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return INVALID;
  }
}

module.exports = { inspectRuntime, verifyRuntime };
