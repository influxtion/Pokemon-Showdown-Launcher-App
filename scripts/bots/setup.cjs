'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { inventory } = require('../../app/bot-integrity');
const lock = require('./lock.json');
const laplaceLock = require('../../vendor/laplace/runtime-lock.json');
const workspace = path.resolve(__dirname, '../..');
const output = path.join(workspace, 'out/bots');

function run(exe, args, cwd = workspace, capture = false) {
  return execFileSync(exe, args, { cwd, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, CARGO_BUILD_JOBS: '1', PYTHONDONTWRITEBYTECODE: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
}
function checkout(name, source) {
  const destination = path.join(output, name);
  if (!fs.existsSync(path.join(destination, '.git'))) {
    fs.mkdirSync(destination, { recursive: true });
    run('git', ['init', '--quiet'], destination);
    run('git', ['config', 'core.autocrlf', 'false'], destination);
    run('git', ['fetch', '--depth=1', source.url, source.revision], destination);
    run('git', ['checkout', '--detach', 'FETCH_HEAD'], destination);
  }
  if (run('git', ['rev-parse', 'HEAD'], destination, true).trim() !== source.revision ||
      run('git', ['diff', '--name-only', 'HEAD'], destination, true).trim()) throw new Error(`Expected pinned clean source: ${name}`);
  return destination;
}
function environment(name, python) {
  const destination = path.join(output, name);
  const executable = path.join(destination, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(executable)) run(python, ['-m', 'venv', destination]);
  return executable;
}
function pip(python, ...packages) {
  run(python, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', ...packages]);
}
async function downloadSets(source) {
  for (const [filename, entry] of [['gen9randombattle.json', lock.randomSets], ['randbats-LICENSE', lock.randomSetsLicense]]) {
    const target = path.join(source, 'fp/data/pkmn_sets_cache', filename);
    if (!fs.existsSync(target)) {
      const response = await fetch(entry.url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('Could not download random battle sets');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
        throw new Error('Random battle data changed upstream. Supply the recorded cached file or review and update lock.json.');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== entry.sha256) throw new Error('Random battle data checksum mismatch');
  }
}

async function main() {
  const { values } = parseArgs({ options: { runtime: { type: 'string' }, python: { type: 'string', default: 'python' }, 'build-linux': { type: 'boolean' } } });
  if (values['build-linux'] && process.platform !== 'linux') throw new Error('--build-linux runs inside the Linux container.');
  let root = path.resolve(values.runtime || path.join(workspace, 'vendor/laplace/dist'));
  const source = checkout('foul-play', lock.foulPlay);
  const foulPython = environment('foul-play-env', values.python);
  pip(foulPython, ...lock.foulPlayPackages);
  pip(foulPython, 'poke-engine==0.0.48', '--no-cache-dir', '--no-binary=poke-engine', '--config-settings=build-args=--features poke-engine/terastallization --no-default-features');
  await downloadSets(source);
  let laplacePython = path.join(root, 'python/python.exe');
  let laplaceSource;
  if (values['build-linux']) {
    root = path.join(output, 'runtime');
    fs.mkdirSync(root, { recursive: true });
    const { buildServer } = require('../laplace/build-server.cjs');
    const { buildClient } = require('../laplace/build-client.cjs');
    if (!fs.existsSync(path.join(root, 'server'))) buildServer(path.join(root, 'server'));
    buildClient(path.join(root, 'client'));
    laplaceSource = checkout('laplace', laplaceLock.laplace);
    const sets = 'data/random-battles/gen9/sets.json';
    fs.mkdirSync(path.dirname(path.join(laplaceSource, 'server', sets)), { recursive: true });
    fs.copyFileSync(path.join(root, 'server', sets), path.join(laplaceSource, 'server', sets));
    laplacePython = environment('laplace-env', values.python);
    pip(laplacePython, 'torch==2.12.0+cpu', '--index-url', 'https://download.pytorch.org/whl/cpu');
    pip(laplacePython, 'numpy==2.4.6', 'poke-env==0.15.0', 'websockets==16.0');
    pip(laplacePython, 'poke-engine==0.0.47', '--no-cache-dir', '--no-binary=poke-engine', '--config-settings=build-args=--features poke-engine/terastallization --no-default-features');
    // Editable metadata preserves upstream's __file__-relative model/data paths.
    pip(laplacePython, '--no-deps', '-e', laplaceSource);
  }
  if (!fs.existsSync(path.join(root, 'client/practice-client.html'))) throw new Error('Build Laplace first or pass --runtime with an existing verified runtime.');
  run(laplacePython, ['-I', '-B', path.join(workspace, 'scripts/laplace/runner.py'), '--check']);
  run(foulPython, ['-I', '-B', '-c', "import poke_engine; assert poke_engine.monte_carlo_tree_search(poke_engine.State(), 20, threads=1).total_visits > 0"]);
  const roots = [source, path.dirname(path.dirname(foulPython))];
  if (values['build-linux']) roots.push(root, laplaceSource, path.dirname(path.dirname(laplacePython)));
  const integrityFile = path.join(output, 'integrity.json');
  fs.writeFileSync(integrityFile, JSON.stringify(inventory(roots)));
  const config = { version: 1, portable: Boolean(values['build-linux']), root, laplacePython,
    foulPlayPython: foulPython, foulPlaySource: source, integrityFile };
  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  console.log('Bots prepared. Run npm start for local play, or npm run bots:serve for the hosted API.');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { checkout, downloadSets };
