'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'out', 'showdex-source');
const STAGING = path.join(ROOT, 'out', 'showdex-source-archive');
const VENDOR = path.join(ROOT, 'vendor', 'showdex');
const DIST = path.join(VENDOR, 'dist');
const MANIFEST = path.join(VENDOR, 'manifest.json');
const UPSTREAM = 'https://github.com/doshidak/showdex.git';
const COMMIT = '165abdb05ad08c5b286f71e21cc1907852efd76f';
const VERSION = '1.4.2';
const BUILD_DATE = '1A000000000';
const UUID = '4f7f1e80-1008-4f00-a7c1-113311331133';
const RECORD = process.argv.includes('--record');

function run(command, args, cwd = ROOT, quiet = false) {
  if (command === 'corepack' && process.platform === 'win32') {
    args = [path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js'), ...args];
    command = process.execPath;
  }
  const result = spawnSync(command, args, {
    cwd,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`);
  }
  return quiet ? result.stdout.trim() : '';
}

function removeInside(base, target) {
  const resolvedBase = fs.realpathSync.native(base);
  const resolvedTarget = fs.existsSync(target) ? fs.realpathSync.native(target) : path.resolve(target);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe removal path');
  fs.rmSync(target, { recursive: true, force: true });
}

function patchSource() {
  run('git', ['restore', '--', 'src/main.ts', '.env'], SOURCE);
  const patch = path.join(VENDOR, 'patches', 'desktop-ready.patch');
  run('git', ['apply', '--check', patch], SOURCE);
  run('git', ['apply', patch], SOURCE);

  const envFile = path.join(SOURCE, '.env');
  for (const [key, value] of Object.entries({
    STANDALONE_RESOURCE_PROTOCOL: 'showdex',
    STANDALONE_RESOURCE_PREFIX: 'assets',
    UUID_STANDALONE_NAMESPACE: UUID,
  })) {
    const text = fs.readFileSync(envFile, 'utf8');
    const updated = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}='${value}'`);
    if (updated === text && !text.includes(`${key}='${value}'`)) throw new Error(`Missing ${key} in upstream .env`);
    fs.writeFileSync(envFile, updated);
  }
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function archiveSource() {
  removeInside(path.join(ROOT, 'out'), STAGING);
  fs.mkdirSync(STAGING, { recursive: true });
  const files = run('git', ['ls-files'], SOURCE, true).split(/\r?\n/).filter(Boolean);
  for (const name of files) {
    const from = path.join(SOURCE, name);
    const to = path.join(STAGING, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  // .env is intentionally absent from git ls-files in some upstream checkouts.
  fs.copyFileSync(path.join(SOURCE, '.env'), path.join(STAGING, '.env'));
  fs.copyFileSync(path.join(VENDOR, 'patches', 'desktop-ready.patch'), path.join(STAGING, 'DESKTOP-PATCH.patch'));
  fs.writeFileSync(path.join(STAGING, 'DESKTOP-BUILD.json'), JSON.stringify({
    upstream: UPSTREAM, commit: COMMIT, version: VERSION, buildDate: BUILD_DATE,
    standaloneResourceProtocol: 'showdex', standaloneResourcePrefix: 'assets',
    uuidStandaloneNamespace: UUID,
  }, null, 2) + '\n');
  run('tar', ['-czf', path.join(DIST, 'showdex-source.tar.gz'), '-C', STAGING, '.']);
  removeInside(path.join(ROOT, 'out'), STAGING);
}

function main() {
  fs.mkdirSync(path.dirname(SOURCE), { recursive: true });
  if (!fs.existsSync(path.join(SOURCE, '.git'))) {
    run('git', ['clone', '--depth', '1', '--branch', `v${VERSION}`, UPSTREAM, SOURCE]);
  }
  const actual = run('git', ['rev-parse', 'HEAD'], SOURCE, true);
  if (actual !== COMMIT) throw new Error(`Unexpected Showdex commit: ${actual}`);
  patchSource();
  run('corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], SOURCE);
  run('corepack', ['pnpm', 'exec', 'cross-env', 'NODE_ENV=production', 'BUILD_TARGET=standalone',
    'PROD_ANALYZE_BUNDLES=false', `BUILD_DATE=${BUILD_DATE}`, 'node', '--conditions=production', './scripts/build.js'], SOURCE);

  const built = path.join(SOURCE, 'dist', 'standalone');
  const assets = Object.fromEntries(fs.readdirSync(built, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'main.js.map')
    .map((entry) => [entry.name, sha(path.join(built, entry.name))])
    .sort(([a], [b]) => a.localeCompare(b)));
  if (!assets['main.js']) throw new Error('Showdex did not produce main.js');
  const manifest = { source: UPSTREAM, commit: COMMIT, version: VERSION, buildDate: BUILD_DATE,
    uuidStandaloneNamespace: UUID, resourceProtocol: 'showdex', resourcePrefix: 'assets', assets };
  if (RECORD) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  else if (JSON.stringify(JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))) !== JSON.stringify(manifest)) {
    throw new Error('Showdex build differs from the pinned asset manifest');
  }

  removeInside(VENDOR, DIST);
  fs.mkdirSync(DIST, { recursive: true });
  for (const name of Object.keys(assets)) fs.copyFileSync(path.join(built, name), path.join(DIST, name));
  archiveSource();
  process.stdout.write(`Verified Showdex ${VERSION}: ${Object.keys(assets).length} assets; ${assets['main.js']} main.js\n`);
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
