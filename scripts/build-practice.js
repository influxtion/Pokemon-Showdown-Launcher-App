'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { buildServer } = require('./laplace/build-server.cjs');
const { buildClient, clientRevision, clientDataRevision } = require('./laplace/build-client.cjs');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor/laplace');
const CACHE = path.join(ROOT, 'out/laplace');
const LOCK = JSON.parse(fs.readFileSync(path.join(VENDOR, 'runtime-lock.json'), 'utf8'));

function run(executable, args, options = {}) {
  return execFileSync(executable, args, { cwd: ROOT, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options });
}

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function insideWorkspace(target) {
  const existing = fs.existsSync(target) ? fs.realpathSync(target) : path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  const relative = path.relative(fs.realpathSync(ROOT), existing);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Build path must stay inside the workspace.');
  return existing;
}

async function bootstrapPython() {
  fs.mkdirSync(CACHE, { recursive: true });
  insideWorkspace(CACHE);
  const archive = path.join(CACHE, LOCK.python.filename);
  if (!fs.existsSync(archive) || sha(archive) !== LOCK.python.sha256) {
    const response = await fetch(LOCK.python.url);
    if (!response.ok) throw new Error('Python runtime download failed.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== LOCK.python.sha256) throw new Error('Python runtime checksum mismatch.');
    fs.writeFileSync(`${archive}.tmp`, bytes);
    fs.renameSync(`${archive}.tmp`, archive);
  }
  const directory = fs.mkdtempSync(path.join(CACHE, 'bootstrap-'));
  insideWorkspace(directory);
  try {
    run('tar', ['-xzf', archive, '-C', directory]);
    const executable = path.join(directory, 'python/python.exe');
    run(executable, ['-I', '-B', '-c', `import sys; assert sys.version_info[:3] == (${LOCK.python.version.split('.').join(',')})`]);
    return { directory, executable };
  } catch (error) {
    insideWorkspace(directory);
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function prepareLaplace() {
  const source = path.join(ROOT, 'out/laplace-source');
  fs.mkdirSync(source, { recursive: true });
  const git = args => run('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  if (!fs.existsSync(path.join(source, '.git'))) {
    git(['init', '--quiet']);
    git(['config', 'core.autocrlf', 'false']);
  }
  if (!git(['rev-list', '-1', '--all'])) {
    git(['fetch', '--quiet', '--depth=1', LOCK.laplace.url, LOCK.laplace.revision]);
    git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  }
  if (git(['rev-parse', 'HEAD']) !== LOCK.laplace.revision || git(['status', '--porcelain', '-uno'])) {
    throw new Error('Laplace build source differs from the pinned revision.');
  }
  return source;
}

function inventory(directory) {
  const files = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Runtime contains an unexpected symbolic link.');
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) {
        const file = path.join(directory, name);
        files[name] = { sha256: sha(file), size: fs.statSync(file).size };
      } else throw new Error('Runtime contains an unsupported file type.');
    }
  }
  visit('');
  return files;
}

function preserveSources(pending, laplaceSource) {
  const sourceDir = path.join(pending, 'sources');
  fs.mkdirSync(sourceDir);
  for (const [name, source] of [
    ['laplace', laplaceSource], ['showdown-client', path.join(ROOT, 'out/practice-client-source')],
    ['showdown-server', path.join(ROOT, 'out/laplace-server-source')],
    ['showdown-client-data', path.join(ROOT, 'out/practice-client-source/caches/pokemon-showdown')],
  ]) run('git', ['-C', source, 'archive', '--format=tar', '--output', path.join(sourceDir, `${name}.tar`), 'HEAD']);
  fs.copyFileSync(__filename, path.join(sourceDir, 'build-practice.js'));
  fs.cpSync(path.join(ROOT, 'scripts/laplace'), path.join(sourceDir, 'desktop-adapter'), { recursive: true,
    filter: file => !file.includes('__pycache__') && !file.endsWith('.pyc') });
  for (const file of fs.readdirSync(VENDOR)) {
    const source = path.join(VENDOR, file);
    if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(sourceDir, file));
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Practice runtime build currently supports Windows x64.');
  if (process.argv.slice(2).some(argument => argument !== '--stage-only')) throw new Error('Usage: node scripts/build-practice.js [--stage-only]');
  const stageOnly = process.argv.includes('--stage-only');
  let keepPending = false;
  const pending = path.join(VENDOR, `pending-${Date.now()}`);
  insideWorkspace(pending);
  const bootstrap = await bootstrapPython();
  try {
    const source = prepareLaplace();
    console.log('Building the isolated Python engine runtime…');
    run(bootstrap.executable, ['-I', '-B', path.join(ROOT, 'scripts/laplace/build-python.py'), '--output', pending, '--source', source]);
    console.log('Building the local simulator…');
    const server = buildServer(path.join(pending, 'server'));
    const sets = 'data/random-battles/gen9/sets.json';
    const targetSets = path.join(pending, 'laplace/server', sets);
    fs.mkdirSync(path.dirname(targetSets), { recursive: true });
    fs.copyFileSync(path.join(pending, 'server', sets), targetSets);
    console.log('Building the sandboxed battle client…');
    buildClient(path.join(pending, 'client'));
    preserveSources(pending, source);
    const python = path.join(pending, 'python/python.exe');
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      PATH: path.join(process.env.SystemRoot, 'System32'), PYTHONUTF8: '1' };
    run(python, ['-I', '-B', path.join(ROOT, 'scripts/laplace/runner.py'), '--check'], { env });
    const manifest = { version: 2, platform: 'win32', arch: 'x64', laplace: LOCK.laplace,
      python: JSON.parse(fs.readFileSync(path.join(pending, 'python-build.json'), 'utf8')),
      server, client: { revision: clientRevision, dataRevision: clientDataRevision }, files: inventory(pending) };
    fs.writeFileSync(path.join(pending, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const { verifyRuntime } = require('../app/practice-manifest');
    const verification = verifyRuntime(pending);
    if (!verification.ok) throw new Error(verification.error);
    if (stageOnly) {
      keepPending = true;
      console.log(`Verified candidate retained at ${pending}; manifest ${verification.identity}`);
      return;
    }
    const dist = path.join(VENDOR, 'dist');
    const previous = path.join(CACHE, `previous-runtime-${Date.now()}`);
    insideWorkspace(pending);
    insideWorkspace(previous);
    if (fs.existsSync(dist)) { insideWorkspace(dist); fs.renameSync(dist, previous); }
    try { fs.renameSync(pending, dist); } catch (error) {
      if (fs.existsSync(previous) && !fs.existsSync(dist)) fs.renameSync(previous, dist);
      throw error;
    }
    console.log(`Built and verified Practice runtime: ${Object.keys(manifest.files).length} files; manifest ${verification.identity}`);
  } finally {
    insideWorkspace(bootstrap.directory);
    fs.rmSync(bootstrap.directory, { recursive: true, force: true });
    if (!keepPending && fs.existsSync(pending)) {
      insideWorkspace(pending);
      fs.rmSync(pending, { recursive: true, force: true });
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { inventory, insideWorkspace };
