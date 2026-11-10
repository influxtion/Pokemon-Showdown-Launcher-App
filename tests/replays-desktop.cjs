'use strict';

// Isolated replay-notes smoke test. Uses real launcher IPC and a temporary profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, session, shell } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-replays-test-'));
const storeFile = path.join(profile, 'replays.json');
const rendererDir = path.join(__dirname, '..', 'renderer');
const captures = path.join(__dirname, '..', 'out', 'desktop-smoke');
const privateUrl = 'https://replay.pokemonshowdown.com/gen9ou-1234567890-abcdefpw';
const secondUrl = 'https://replay.pokemonshowdown.com/gen9randombattle-987654321';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.setPath('userData', profile);

async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) });
  });
  const opened = [];
  const dialogs = [];
  let dialogResponse = 0;
  shell.openExternal = async (url) => { opened.push(url); };
  dialog.showMessageBox = async (_window, options) => {
    dialogs.push(options);
    return { response: dialogResponse, checkboxChecked: false };
  };

  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length, 'launcher window');
  const win = BrowserWindow.getAllWindows()[0];
  const renderer = win.webContents;
  await until(() => !renderer.isLoading(), 'initial page');
  const client = win.contentView.children[0].webContents;
  assert.equal(await client.executeJavaScript('typeof window.desktop'), 'undefined');

  const run = (code) => renderer.executeJavaScript(code);
  const load = async (file) => {
    await win.loadFile(path.join(rendererDir, file));
    await until(() => !renderer.isLoading() && renderer.getURL().endsWith(file), file);
  };
  const notes = async () => {
    const result = await run('window.desktop.getReplayNotes()');
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.notes;
  };
  const fill = async (id, value) => {
    await run(`(() => {
      const input = document.getElementById(${JSON.stringify(id)});
      const setter = Object.getOwnPropertyDescriptor(
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  };
  const click = (id) => run(`document.getElementById(${JSON.stringify(id)}).click()`);
  const add = async (title, url, format, body) => {
    await click('add-replay');
    await until(() => run("!document.getElementById('replay-editor').hidden"), 'new editor');
    await fill('note-title', title);
    await fill('note-url', url);
    await fill('note-format', format);
    await fill('note-body', body);
    await click('save-note');
  };

  await load('replays.html');
  await until(() => run("document.getElementById('replay-list-empty').hidden === false"), 'empty replay notes');
  assert.equal((await notes()).length, 0);
  assert.equal(opened.length, 0);

  await add('First private replay', privateUrl, 'gen9ou', 'Pivot on turn 12.');
  await until(async () => (await notes()).length === 1, 'first note saved');
  let saved = (await notes())[0];
  assert.equal(saved.url, privateUrl, 'private replay token preserved');
  assert.equal(saved.notes, 'Pivot on turn 12.');
  assert.equal(opened.length, 0, 'save does not open replay');
  assert.equal(await run("document.getElementById('note-url').readOnly"), true);

  // Reload verifies that the editor and list read from the on-disk store.
  renderer.reload();
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('replays.html'), 'reload replay notes');
  await until(() => run("document.getElementById('replay-list').children.length === 1"), 'persisted list');
  assert.equal(await run("document.getElementById('note-title').value"), 'First private replay');
  assert.equal(await run("document.getElementById('note-url').value"), privateUrl);

  await fill('note-body', 'Pivot on turn 12. Preserve the weather setter.');
  await click('save-note');
  await until(async () => (await notes())[0].notes.includes('Preserve the weather setter.'), 'edited note saved');
  saved = (await notes())[0];
  assert.equal(saved.id.length, 36);

  await add('Random battle review', secondUrl, 'gen9randombattle', 'Early switch was risky.');
  await until(async () => (await notes()).length === 2, 'second note saved');

  // The Play action opens a fresh editor when no battle is current, even with notes saved.
  await load('play.html');
  await run("document.querySelector('a[href=\"replays.html?draft=1\"]').click()");
  await until(() => renderer.getURL().includes('replays.html?draft=1'), 'Play to replay draft');
  await until(() => run("!document.getElementById('replay-editor').hidden"), 'blank draft editor');
  assert.equal(await run("document.getElementById('note-title').value"), '');
  assert.equal(await run("document.getElementById('note-url').value"), '');
  assert.equal(await run("document.getElementById('replay-list').children.length"), 2);
  assert.equal(opened.length, 0);

  // Home's recent-note link targets the actual saved ID.
  await load('index.html');
  await until(() => run("!document.getElementById('recent-replays-section').hidden"), 'Home recent notes');
  const recentLink = await run("Array.from(document.querySelectorAll('#recent-replays a')).find(a => a.textContent.includes('First private replay')).getAttribute('href')");
  assert.equal(recentLink, `replays.html?id=${saved.id}`);
  await run("Array.from(document.querySelectorAll('#recent-replays a')).find(a => a.textContent.includes('First private replay')).click()");
  await until(() => renderer.getURL().includes(`replays.html?id=${saved.id}`), 'Home recent-note navigation');
  await until(() => run("document.getElementById('note-title').value === 'First private replay'"), 'Home note selected');

  // A simulated current battle supplies only a title and format; its room ID is not an uploaded replay URL.
  await client.executeJavaScript(`window.__testSends = [];
    window.app = {
      rooms: {
        '': { searching: false, $: () => ({length: 0}) },
        'battle-gen9ou-1234567890': {
          title: 'Battle', battle: {
            p1: {name: 'Alpha'}, p2: {name: 'Beta'}, tier: '[Gen 9] OU', ended: false
          }
        }
      },
      user: {get: (key) => key === 'name' ? 'Tester' : ''},
      curRoom: {id: 'battle-gen9ou-1234567890'},
      isDisconnected: false, popups: [],
      send: (...args) => window.__testSends.push(args)
    }; 0`);
  const battleDraft = await run('window.desktop.getReplayDraft()');
  assert.deepEqual(battleDraft, { ok: true, draft: { title: 'Alpha vs. Beta', format: 'gen9ou', url: '' } });
  await load('play.html');
  await run("document.querySelector('a[href=\"replays.html?draft=1\"]').click()");
  await until(() => renderer.getURL().includes('replays.html?draft=1'), 'battle draft navigation');
  await until(() => run("document.getElementById('note-title').value === 'Alpha vs. Beta'"), 'battle title prefilled');
  assert.equal(await run("document.getElementById('note-format').value"), 'gen9ou');
  assert.equal(await run("document.getElementById('note-url').value"), '');
  assert.deepEqual(await client.executeJavaScript('window.__testSends'), []);
  assert.equal(opened.length, 0);
  await client.executeJavaScript('delete window.app; 0');

  // Closing from Home still protects an unsaved replay draft.
  await load('index.html');
  const homeCloseDialogs = dialogs.length;
  dialogResponse = 0;
  win.close();
  await until(() => dialogs.length > homeCloseDialogs, 'dirty draft close from Home');
  assert.equal(win.isDestroyed(), false);
  assert.match(renderer.getURL(), /index\.html$/);
  await run("document.querySelector('.rail a[href=\"replays.html\"]').click()");
  await until(() => renderer.getURL().endsWith('replays.html'), 'return with battle draft');
  await until(() => run("document.getElementById('note-title').value === 'Alpha vs. Beta'"), 'battle draft restored');
  dialogResponse = 1;
  await run("Array.from(document.querySelectorAll('#replay-list li')).find(li => li.textContent.includes('First private replay')).querySelector('button').click()");
  await until(() => run("document.getElementById('note-title').value === 'First private replay'"), 'discard battle draft');

  await fill('replay-search', 'weather setter');
  await until(() => run("document.getElementById('replay-list').children.length === 1"), 'note-text search');
  assert.match(await run("document.getElementById('replay-list').textContent"), /First private replay/);
  await fill('replay-search', '');
  await run("document.getElementById('replay-format-filter').value = 'gen9randombattle'; document.getElementById('replay-format-filter').dispatchEvent(new Event('change', {bubbles:true}))");
  await until(() => run("document.getElementById('replay-list').children.length === 1"), 'format filter');
  assert.match(await run("document.getElementById('replay-list').textContent"), /Random battle review/);
  await run("document.getElementById('replay-format-filter').value = ''; document.getElementById('replay-format-filter').dispatchEvent(new Event('change', {bubbles:true}))");

  // Duplicate URLs must never replace an existing note, even if the form has different text.
  await add('Duplicate attempt', privateUrl, 'gen9ou', 'Do not overwrite.');
  await until(() => run("!document.getElementById('replay-error').hidden"), 'duplicate warning');
  assert.equal((await notes()).length, 2);
  assert.equal((await notes()).find((note) => note.id === saved.id).notes, saved.notes);

  // Unsaved drafts survive page navigation, and closing requires confirmation.
  await fill('note-title', 'Unsaved draft');
  dialogResponse = 0;
  await run("document.querySelector('.rail a[href=\"index.html\"]').click()");
  await until(() => renderer.getURL().endsWith('index.html'), 'navigate Home with draft');
  await run("document.querySelector('.rail a[href=\"replays.html\"]').click()");
  await until(() => renderer.getURL().endsWith('replays.html'), 'return to replay notes');
  await until(() => run("document.getElementById('note-title').value === 'Unsaved draft'"), 'draft restored');
  const dialogsBeforeClose = dialogs.length;
  win.close();
  await until(() => dialogs.length > dialogsBeforeClose, 'discard dialog on close');
  assert.equal(win.isDestroyed(), false);
  assert.match(renderer.getURL(), /replays\.html$/);
  dialogResponse = 1;
  await until(() => run("document.getElementById('replay-list').children.length === 2"), 'saved notes after navigation');

  // Select the private note, then open only through the explicit Open replay button.
  await run(`Array.from(document.querySelectorAll('#replay-list li')).find(li => li.textContent.includes('First private replay')).querySelector('button, a').click()`);
  await until(() => run("document.getElementById('note-url').value.includes('abcdefpw')"), 'private note selected');
  assert.equal(opened.length, 0);
  await click('open-replay');
  await until(() => opened.length === 1, 'explicit replay open');
  assert.deepEqual(opened, [privateUrl]);

  dialogResponse = 0;
  await click('delete-note');
  await until(() => dialogs.some((item) => item.title === 'Delete replay note'), 'delete dialog');
  assert.equal((await notes()).length, 2, 'cancelled delete keeps note');
  dialogResponse = 1;
  await click('delete-note');
  await until(async () => (await notes()).length === 1, 'confirmed delete');
  assert.equal((await notes())[0].url, secondUrl);

  // Check both themes and both target widths; capture the actual launcher surface.
  fs.mkdirSync(captures, { recursive: true });
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  for (const [width, height] of [[1366, 768], [1024, 640]]) {
    win.setSize(width, height);
    await pause(250);
    for (const theme of ['light', 'dark']) {
      assert.equal(await run(`window.desktop.setTheme(${JSON.stringify(theme)})`), true);
      await until(() => run(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`), `${theme} theme`);
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, `${width}px horizontal overflow`);
      fs.writeFileSync(path.join(captures, `replays-${width}-${theme}.png`), (await renderer.capturePage()).toPNG());
    }
  }

  // A failed disk read during save keeps the unsaved input and its navigation draft.
  await fill('note-title', 'Keep this unsaved revision');
  const corrupted = '{ invalid replay JSON';
  fs.writeFileSync(storeFile, corrupted);
  await click('save-note');
  await until(() => run("!document.getElementById('replay-error').hidden"), 'save failure in UI');
  assert.equal(await run("document.getElementById('note-title').value"), 'Keep this unsaved revision');
  assert.equal(await run("JSON.parse(sessionStorage.getItem('replayNote.editorDraft')).title"), 'Keep this unsaved revision');
  renderer.reload();
  await until(() => !renderer.isLoading(), 'corrupt store reload');
  await until(() => run("!document.getElementById('replay-error').hidden"), 'corrupt store error in UI');
  assert.equal(await run("JSON.parse(sessionStorage.getItem('replayNote.editorDraft')).title"), 'Keep this unsaved revision');
  const failedSave = await run(`window.desktop.saveReplayNote({title:'Repair?',url:${JSON.stringify(privateUrl)},notes:'',format:'gen9ou'})`);
  assert.equal(failedSave.ok, false);
  assert.equal(fs.readFileSync(storeFile, 'utf8'), corrupted);

  console.log('PASS replay desktop smoke: CRUD, drafts, Home link, search/filter, private URL, dedup, dialogs, save failure, corrupt store, themes/layout');
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
