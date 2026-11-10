'use strict';

// Real IPC/store round trips; native file dialogs are stubbed and all client requests blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-import-profile-'));
const files = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-import-files-'));
const storeFile = path.join(profile, 'replays.json');
const backupFile = path.join(files, 'review-notes.json');
const rendererDir = path.join(__dirname, '..', 'renderer');
const captures = path.join(__dirname, '..', 'out', 'desktop-smoke');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.setPath('userData', profile);

async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(80);
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const opened = [];
  shell.openExternal = async (url) => opened.push(url);
  let fileResult = { canceled: true, filePaths: [] };
  let fileDialogFails = false;
  let confirmResponse = 0;
  const fileDialogs = [];
  dialog.showOpenDialog = async (_win, options) => {
    fileDialogs.push(options);
    if (fileDialogFails) throw new Error('Injected picker failure');
    return fileResult;
  };
  dialog.showMessageBox = async () => ({ response: confirmResponse });
  const handlers = new Map();
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, handler) => { handlers.set(name, handler); register(name, handler); };
  require('../app/main');
  ipcMain.handle = register;
  await until(() => BrowserWindow.getAllWindows().length, 'launcher');
  const win = BrowserWindow.getAllWindows()[0];
  const renderer = win.webContents;
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('index.html'), 'initial Home load');
  const run = (code) => renderer.executeJavaScript(code);
  const click = (id) => run(`document.getElementById(${JSON.stringify(id)}).click()`);
  const call = (name, ...args) => run(`window.desktop[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  const load = async (file = 'replays.html') => {
    await win.loadFile(path.join(rendererDir, file));
    if (file === 'replays.html') await until(() => run("document.getElementById('replay-count').textContent.includes('saved')"), 'replay load');
  };
  const fill = (id, value) => run(`(() => { const input = document.getElementById(${JSON.stringify(id)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await load();

  for (const name of ['choose-import', 'commit-import', 'import-status', 'undo-import']) {
    assert.deepEqual(await handlers.get(`replays:${name}`)({ sender: null, senderFrame: null }), { ok: false, error: 'Access denied.' });
  }
  assert.equal(await handlers.get('replays:cancel-import')({ sender: null, senderFrame: null }), false);
  assert.equal(fileDialogs.length, 0);
  assert.equal((await call('commitReplayImport', 'forged', [])).ok, false);
  await click('import-replays');
  await until(() => run("!document.getElementById('import-replays').disabled"), 'picker cancellation');
  assert.equal(await run("document.getElementById('import-dialog').open"), false);
  assert.equal(fs.existsSync(storeFile), false);

  const first = (await call('saveReplayNote', { title: 'Local weather plan', url: 'https://replay.pokemonshowdown.com/gen9ou-101', notes: 'Keep the rain setter.' })).note;
  const second = (await call('saveReplayNote', { title: 'Private replay', url: 'https://replay.pokemonshowdown.com/gen9ou-102-secretpw', notes: 'Private review.' })).note;
  const backup = { version: 1, notes: [
    { ...first, id: randomUUID(), title: 'Imported weather plan', notes: '<img src=x onerror=alert(1)>\nUse the weather setter later.', updatedAt: '2099-01-01T00:00:00.000Z' },
    { ...second, id: randomUUID() },
    { ...first, id: second.id, title: 'New imported replay', url: 'https://replay.pokemonshowdown.com/gen9randombattle-103-newprivatepw', notes: 'New note from backup.\r\nWindows line endings.', format: 'gen9randombattle' },
  ] };
  fs.writeFileSync(backupFile, JSON.stringify(backup));
  fileResult = { canceled: false, filePaths: [backupFile] };
  await load();
  await fill('note-body', 'Unsaved text must survive');
  const draftBefore = await run("sessionStorage.getItem('replayNote.editorDraft')");
  const bytesBeforeDraft = fs.readFileSync(storeFile);
  await click('import-replays');
  await until(() => run("document.getElementById('import-dialog').open"), 'dirty import preview');
  assert.equal(await run("document.getElementById('import-apply').disabled"), true);
  assert.match(await run("document.getElementById('import-error').textContent"), /unsaved note/);
  assert.match((await call('commitReplayImport', 'any', [])).error, /unsaved/);
  await click('import-cancel');
  assert.equal(await run("sessionStorage.getItem('replayNote.editorDraft')"), draftBefore);
  assert.deepEqual(fs.readFileSync(storeFile), bytesBeforeDraft);
  await click('save-note');
  await until(() => run("document.getElementById('note-status').textContent === 'Saved'"), 'save preserved draft');
  // Match the updated private note in the input so there is exactly one conflict again.
  const existingNotes = (await call('getReplayNotes')).notes;
  const updatedSecond = existingNotes.find((note) => note.id === second.id);
  const updatedFirst = existingNotes.find((note) => note.id === first.id);
  backup.notes[1] = { ...updatedSecond, id: backup.notes[1].id };
  if (updatedFirst.notes !== first.notes) first.notes = updatedFirst.notes;
  fs.writeFileSync(backupFile, JSON.stringify(backup));
  const baseline = fs.readFileSync(storeFile);

  await click('import-replays');
  await until(() => run("document.getElementById('import-dialog').open"), 'review preview');
  assert.match(await run("document.getElementById('import-summary').textContent"), /1 new · 1 unchanged · 1 conflicting/);
  assert.equal(await run("document.getElementById('import-choice').value"), 'keep');
  assert.equal(await run("document.querySelectorAll('#import-incoming img').length"), 0, 'import text must not become markup');
  assert.match(await run("document.getElementById('import-incoming').textContent"), /<img src=x/);
  assert.equal(fileDialogs.at(-1).properties[0], 'openFile');
  assert.deepEqual(fs.readFileSync(storeFile), baseline, 'preview does not write');
  await run("document.getElementById('import-filter').value = 'conflict'; document.getElementById('import-filter').dispatchEvent(new Event('change'))");
  assert.equal(await run("document.getElementById('import-list').children.length"), 1);
  await click('import-replace-all');
  assert.equal(await run("document.getElementById('import-choice').value"), 'replace');
  await click('import-keep-all');
  assert.equal(await run("document.getElementById('import-choice').value"), 'keep');
  await run("document.getElementById('import-choice').value = 'replace'; document.getElementById('import-choice').dispatchEvent(new Event('change'))");
  assert.match(await run("document.getElementById('import-apply').textContent"), /Import 2 notes/);

  fs.mkdirSync(captures, { recursive: true });
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  for (const [width, height] of [[1366, 768], [1024, 640]]) {
    win.setSize(width, height);
    await pause(200);
    for (const theme of ['light', 'dark']) {
      await call('setTheme', theme);
      await pause(100);
      assert.equal(await run(`(() => {
        const modal = document.getElementById('import-dialog').getBoundingClientRect();
        const apply = document.getElementById('import-apply').getBoundingClientRect();
        return modal.left >= 0 && modal.right <= innerWidth && modal.top >= 0 && modal.bottom <= innerHeight && apply.bottom <= modal.bottom;
      })()`), true, 'import controls fit viewport');
      fs.writeFileSync(path.join(captures, `replay-import-${width}-${theme}.png`), (await renderer.capturePage()).toPNG());
    }
  }
  // The validated preview is a snapshot, even if the selected file changes on disk.
  fs.writeFileSync(backupFile, '{invalid after preview');
  await click('import-apply');
  await until(() => run("!document.getElementById('import-dialog').open && !document.getElementById('undo-import').hidden"), 'import applied');
  let saved = (await call('getReplayNotes')).notes;
  assert.equal(saved.length, 3);
  assert.equal(saved.find((note) => note.id === first.id).title, 'Imported weather plan');
  assert.equal(saved.find((note) => note.url.endsWith('newprivatepw')).id !== second.id, true);
  assert.equal(saved.find((note) => note.id === second.id).url, second.url);
  assert.equal((await call('getReplayImportStatus')).canUndo, true);
  assert.deepEqual(opened, []);
  await run("Array.from(document.querySelectorAll('#replay-list button')).find(button => button.textContent.includes('New imported replay')).click()");
  assert.equal(await run("document.getElementById('note-status').textContent"), 'Saved', 'CRLF imports do not create an unsaved draft');
  assert.equal(await run("document.getElementById('undo-import').disabled"), false);

  await load('index.html');
  await load();
  await until(() => run("!document.getElementById('undo-import').hidden"), 'undo survives page navigation');
  confirmResponse = 0;
  await click('undo-import');
  await until(() => run("!document.getElementById('undo-import').disabled"), 'undo cancelled');
  assert.equal((await call('getReplayNotes')).notes.length, 3);
  confirmResponse = 1;
  await click('undo-import');
  await until(() => run("document.getElementById('undo-import').hidden"), 'undo applied');
  assert.deepEqual(fs.readFileSync(storeFile), baseline);
  assert.match(await run("document.getElementById('export-status').textContent"), /Import undone/);

  fs.writeFileSync(backupFile, JSON.stringify(backup));
  await click('import-replays');
  await until(() => run("document.getElementById('import-dialog').open"), 'second preview');
  // A concurrent store edit invalidates the preview rather than overwriting that edit.
  await call('saveReplayNote', { id: first.id, title: 'Changed during preview', notes: first.notes });
  await click('import-apply');
  await until(() => run("document.getElementById('import-error').textContent.includes('changed on disk')"), 'stale preview blocked');
  assert.equal(await run("document.getElementById('import-apply').disabled"), true);
  assert.equal((await call('getReplayNotes')).notes.length, 2);
  await click('import-cancel');
  await click('import-replays');
  await until(() => run("document.getElementById('import-dialog').open"), 'fresh retry preview');
  await click('import-apply');
  await until(() => run("!document.getElementById('import-dialog').open"), 'default keep import');
  saved = (await call('getReplayNotes')).notes;
  assert.equal(saved.find((note) => note.id === first.id).title, 'Changed during preview');
  await fill('note-title', 'Edit after import');
  assert.equal(await run("document.getElementById('undo-import').disabled"), true);
  assert.match((await call('undoReplayImport')).error, /unsaved/);
  await click('save-note');
  await until(() => run("document.getElementById('undo-import').hidden"), 'saved edit invalidates undo');
  assert.equal((await call('getReplayImportStatus')).canUndo, false);

  fs.writeFileSync(backupFile, '{invalid');
  const beforeInvalid = fs.readFileSync(storeFile);
  await click('import-replays');
  await until(() => run("document.getElementById('replay-error').textContent.includes('invalid')"), 'invalid file error');
  assert.deepEqual(fs.readFileSync(storeFile), beforeInvalid);
  fileDialogFails = true;
  assert.equal((await call('chooseReplayImport')).ok, false);
  fileDialogFails = false;
  fileResult = { canceled: true, filePaths: [] };
  assert.deepEqual(await call('chooseReplayImport'), { ok: true, cancelled: true });
  assert.equal((await call('commitReplayImport', 'forged', [])).ok, false);
  assert.deepEqual(opened, []);

  await fill('note-body', 'Protect draft even when saved data becomes unreadable');
  const retainedDraft = await run("sessionStorage.getItem('replayNote.editorDraft')");
  fs.writeFileSync(storeFile, '{broken store');
  await win.loadFile(path.join(rendererDir, 'replays.html'));
  await until(() => run("document.getElementById('replay-count').textContent === 'Could not load'"), 'corrupt store view');
  assert.equal(await run("document.getElementById('import-replays').disabled"), true);
  await click('import-replays');
  assert.equal(await run("sessionStorage.getItem('replayNote.editorDraft')"), retainedDraft);

  fs.rmSync(files, { recursive: true, force: true });
  console.log('PASS replay import desktop: preview, safe text, conflicts, merge, private links, drafts, undo, stale snapshots, dialogs, IPC guards, themes/layout');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
