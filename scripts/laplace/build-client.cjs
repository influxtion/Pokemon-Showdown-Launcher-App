'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const clientRevision = '49b54209ebee54ceb8fff62a5eb5bedf7efcf6dc';
const clientDataRevision = '202b6b385c2536977c60a97bf12d931c2d449586';
const workspace = path.resolve(__dirname, '../..');
const vendor = path.join(workspace, 'vendor/laplace');
const clientSource = path.join(workspace, 'out/practice-client-source');

function run(file, args, cwd, options = {}) {
  return execFileSync(file, args, { cwd, stdio: 'inherit', windowsHide: true, ...options });
}

function git(args, cwd) {
  return run('git', args, cwd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function checkRevision(source, revision) {
  if (git(['rev-parse', 'HEAD'], source) !== revision || git(['diff', '--name-only', 'HEAD', '--'], source)) {
    throw new Error(`Expected clean source at ${revision} in ${source}.`);
  }
}

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function replaceOnce(source, target, replacement) {
  if (source.split(target).length !== 2) throw new Error(`Classic client patch anchor changed: ${target}`);
  return source.replace(target, replacement);
}

function prepareSource(source, url, revision) {
  if (!fs.existsSync(path.join(source, '.git'))) {
    fs.mkdirSync(source, { recursive: true });
    run('git', ['init', '--quiet'], source);
    run('git', ['config', 'core.autocrlf', 'false'], source);
  }
  if (!git(['rev-list', '-1', '--all'], source)) {
    run('git', ['fetch', '--quiet', '--depth=1', url, revision], source);
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], source);
  }
  checkRevision(source, revision);
}

function installDependencies(source, packageName) {
  if (fs.existsSync(path.join(source, 'node_modules', packageName, 'package.json'))) return;
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/c', 'npm ci --no-audit'] : ['ci', '--no-audit'];
  run(command, args, source);
}

function buildClient() {
  prepareSource(clientSource, 'https://github.com/smogon/pokemon-showdown-client.git', clientRevision);
  // Restore the exact LF bytes even if an existing Windows clone checked out CRLF.
  const template = 'translations/en-template.ts';
  fs.writeFileSync(path.join(clientSource, template), run('git', ['show', `HEAD:${template}`], clientSource, {
    stdio: ['ignore', 'pipe', 'inherit'],
  }));
  // The browser's data generator needs current translation tooling. This checkout is
  // only a build input. Practice continues to run the Laplace-compatible simulator.
  const serverCache = path.join(clientSource, 'caches/pokemon-showdown');
  prepareSource(serverCache, 'https://github.com/smogon/pokemon-showdown.git', clientDataRevision);
  installDependencies(clientSource, '@babel/core');
  installDependencies(serverCache, 'esbuild');
  run(process.execPath, ['build', 'full', '--no-update'], clientSource);
  return stageClient();
}

function stageClient() {
  const upstream = path.join(clientSource, 'play.pokemonshowdown.com');
  const output = path.join(vendor, 'dist/client');
  fs.mkdirSync(output, { recursive: true });
  const shell = fs.readFileSync(path.join(vendor, 'practice-client.html'), 'utf8');
  for (const [, asset] of shell.matchAll(/(?:src|href)="((?:js|data|style)\/[^"?]+)"/g)) {
    copy(path.join(upstream, asset), path.join(output, asset));
  }
  copy(path.join(upstream, 'style/battle-log.css'), path.join(output, 'style/battle-log.css'));
  copy(path.join(upstream, 'style/fonts'), path.join(output, 'style/fonts'));
  for (const css of ['style/battle.css', 'style/oldclient.css']) {
    const cssSource = fs.readFileSync(path.join(upstream, css), 'utf8');
    for (const [, asset] of cssSource.matchAll(/url\(\.\.\/(fx\/[^)]+)\)/g)) {
      copy(path.join(upstream, asset), path.join(output, asset));
    }
  }
  for (const entry of ['pokemonshowdownbeta.png', 'pokemonshowdownbeta@2x.png']) {
    copy(path.join(upstream, entry), path.join(output, entry));
  }
  copy(path.join(clientSource, 'LICENSE'), path.join(output, 'LICENSE'));
  for (const entry of ['practice-client.html', 'client-bootstrap.js', 'practice-client.css']) {
    copy(path.join(vendor, entry), path.join(output, entry));
  }

  const appFile = path.join(output, 'js/oldclient/client.js');
  let app = fs.readFileSync(appFile, 'utf8');
  const socketConstructor = 'var constructSocket = function () {';
  app = replaceOnce(app, socketConstructor, `${socketConstructor}\n\t\t\t\tif (Config.practiceSocketUrl) return new WebSocket(Config.practiceSocketUrl);`);
  app = replaceOnce(app, 'this.socket.readyState !== SockJS.OPEN',
    'this.socket.readyState !== (Config.practiceSocketUrl ? WebSocket.OPEN : SockJS.OPEN)');
  const appLoaded = 'Storage.whenAppLoaded.load(this);';
  app = replaceOnce(app, appLoaded, `${appLoaded}\n\t\t\tif (Config.practiceSocketUrl) return this.initializeConnection();`);
  for (const call of ["this.addRoom('rooms', null, true);", "this.addRoom('lobby', null, true);", "app.send('/autojoin');"]) {
    app = replaceOnce(app, call, `if (!Config.practiceSocketUrl) ${call}`);
  }
  fs.writeFileSync(appFile, app);

  const topbarFile = path.join(output, 'js/oldclient/client-topbar.js');
  const topbar = fs.readFileSync(topbarFile, 'utf8');
  const logo = "' + Dex.resourcePrefix + 'pokemonshowdownbeta";
  if (topbar.split(logo).length !== 3) throw new Error('Classic client logo anchor changed.');
  fs.writeFileSync(topbarFile, topbar.replaceAll(logo, 'pokemonshowdownbeta'));

  const battleFile = path.join(output, 'js/oldclient/client-battle.js');
  let battle = fs.readFileSync(battleFile, 'utf8');
  const closeAfterForfeit = "buf += ' Are you sure?</p><p><label class=\"checkbox\"><input type=\"checkbox\" name=\"closeroom\" checked /> Close after forfeiting</label></p>';";
  battle = replaceOnce(battle, closeAfterForfeit,
    `if (Config.practiceSocketUrl) buf += ' Are you sure?</p>';\n\t\t\t\telse ${closeAfterForfeit}`);
  battle = replaceOnce(battle, "if (this.gameType === 'battle' && this.room.battle && !this.room.battle.rated)",
    "if (!Config.practiceSocketUrl && this.gameType === 'battle' && this.room.battle && !this.room.battle.rated)");
  const closeRoom = "if (this.$('input[name=closeroom]')[0].checked)";
  battle = replaceOnce(battle, closeRoom, "if (!Config.practiceSocketUrl && this.$('input[name=closeroom]')[0].checked)");
  const chatLabel = '</i> Chat';
  if (battle.split(chatLabel).length !== 3) throw new Error('Classic battle log label anchor changed.');
  fs.writeFileSync(battleFile, battle.replaceAll(chatLabel, '</i> Battle log'));

  const storageFile = path.join(output, 'js/oldclient/storage.js');
  let storage = fs.readFileSync(storageFile, 'utf8');
  const testClient = 'Storage.initTestClient = function () {';
  storage = replaceOnce(storage, testClient, `${testClient}
\tif (Config.practiceSocketUrl) {
\t\tthis.whenTeamsLoaded.load();
\t\tthis.whenPrefsLoaded.load();
\t\treturn;
\t}`);
  fs.writeFileSync(storageFile, storage);
  return output;
}

if (require.main === module) {
  console.log(`Built practice client at ${buildClient()}`);
}

module.exports = { buildClient, stageClient };
