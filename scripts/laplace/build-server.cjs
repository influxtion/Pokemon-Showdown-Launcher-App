'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const workspace = path.resolve(__dirname, '../..');
const source = path.join(workspace, 'out/laplace-server-source');
const vendor = path.join(workspace, 'vendor/laplace');
const repository = 'https://github.com/smogon/pokemon-showdown.git';
const revision = 'a9caa4cabe89459b00e717a47148d0f67b4451ae';

function run(file, args, cwd, options = {}) {
  return execFileSync(file, args, { cwd, stdio: 'inherit', windowsHide: true, ...options });
}

function git(args) {
  return run('git', args, source, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function npm(cwd, ...args) {
  const cli = process.env.npm_execpath;
  if (cli && path.basename(cli) === 'npm-cli.js') return run(process.execPath, [cli, ...args], cwd);
  if (process.platform === 'win32') return run('cmd.exe', ['/d', '/c', 'npm', ...args], cwd);
  return run('npm', args, cwd);
}

function prepareSource() {
  if (!fs.existsSync(path.join(source, '.git'))) {
    fs.mkdirSync(source, { recursive: true });
    git(['init', '--quiet']);
    git(['config', 'core.autocrlf', 'false']);
  }
  if (!git(['rev-list', '-1', '--all'])) {
    git(['fetch', '--quiet', '--depth=1', repository, revision]);
    git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  }
  if (git(['rev-parse', 'HEAD']) !== revision || git(['diff', '--name-only', 'HEAD', '--']) ||
      git(['ls-files', '--others', '--exclude-standard', '--', 'data', 'translations'])) {
    throw new Error(`Expected clean Showdown server source at ${revision} in ${source}.`);
  }
}

function canonicalPath(target) {
  if (fs.existsSync(target)) return fs.realpathSync(target);
  const parent = path.dirname(target);
  if (parent === target) throw new Error('Showdown server output drive is unavailable.');
  return path.join(canonicalPath(parent), path.basename(target));
}

function buildServer(target) {
  const destination = path.resolve(target);
  const relative = path.relative(canonicalPath(path.join(vendor, 'dist')), canonicalPath(destination));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Choose a staging path outside the active Practice runtime.');
  }
  if (fs.existsSync(destination)) throw new Error('Showdown server output already exists.');

  prepareSource();
  npm(source, 'ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund');
  run(process.execPath, ['build', '--force'], source);

  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.showdown-server-'));
  try {
    for (const name of ['dist', 'data', 'translations', 'LICENSE', 'package.json', 'package-lock.json']) {
      fs.cpSync(path.join(source, name), path.join(staging, name), { recursive: true });
    }
    // The compiled server uses no optional add-ons in the isolated local config.
    npm(staging, 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund');
    fs.mkdirSync(path.join(staging, 'config'));
    fs.writeFileSync(path.join(staging, 'config/config.js'),
      "'use strict';\n// Configuration is injected by the desktop's isolated server entry point.\n");
    const packageLockSha256 = createHash('sha256').update(fs.readFileSync(path.join(staging, 'package-lock.json'))).digest('hex');
    const descriptor = { repository, revision, packageLockSha256, buildNode: process.version };
    fs.writeFileSync(path.join(staging, 'SOURCE.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
    if (fs.existsSync(destination)) throw new Error('Showdown server output already exists.');
    fs.renameSync(staging, destination);
    return descriptor;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/laplace/build-server.cjs [output]');
  const target = process.argv[2] || path.join(vendor, 'pending/server');
  buildServer(target);
  console.log(`Built local Showdown server at ${path.resolve(target)}`);
}

module.exports = { buildServer };
