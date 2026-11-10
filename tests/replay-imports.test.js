'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Replays, serializeStore, MAX_NOTES, MAX_FILE_BYTES } = require('../app/replays');
const { ReplayImports } = require('../app/replay-imports');

const OLD = '2025-01-02T00:00:00.000Z';
const NEW = '2026-01-02T00:00:00.000Z';

function note(index, overrides = {}) {
  return {
    id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    url: `https://replay.pokemonshowdown.com/gen9ou-${index}`,
    title: `Note ${index}`, format: 'gen9ou', notes: 'Turn 12 — 雨', createdAt: OLD, updatedAt: NEW,
    ...overrides,
  };
}

function fixture(t, fileSystem = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-import-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const store = new Replays(profile, fileSystem);
  const imports = new ReplayImports(store);
  const backup = path.join(root, 'backup.json');
  const writeBackup = (notes) => fs.writeFileSync(backup, JSON.stringify({ version: 1, notes }));
  const preview = (notes) => {
    writeBackup(notes);
    const result = imports.previewFile(backup);
    assert.equal(result.ok, true, result.error);
    return result.preview;
  };
  return { store, imports, backup, preview, root };
}

test('an exported backup restores saved fields, dates and the exact private replay URL', (t) => {
  const { store, imports, backup, root } = fixture(t);
  const sourceDir = path.join(root, 'source');
  fs.mkdirSync(sourceDir);
  const source = new Replays(sourceDir);
  const url = `${note(1).url}-secretpw`;
  assert.equal(source.save({ url, title: 'Private review', notes: 'Turn 12 — 雨' }).ok, true);
  assert.equal(source.exportTo(backup).ok, true);
  const result = imports.previewFile(backup);
  assert.equal(result.ok, true);
  const { preview } = result;
  assert.equal(preview.filename, 'backup.json');
  assert.deepEqual(preview.counts, { added: 1, unchanged: 0, conflicts: 0 });
  assert.equal(preview.currentCount, 0);
  assert.equal(fs.existsSync(store.file), false);

  // The visible preview and the source file can change without altering the reviewed snapshot.
  preview.entries[0].incoming.title = 'Changed display';
  fs.writeFileSync(backup, 'changed file');
  const committed = imports.commit(preview.token, []);
  assert.deepEqual(committed, {
    ok: true, added: 1, replaced: 0, unchanged: 0, kept: 0, notes: source.list().notes, canUndo: true,
  });
  assert.deepEqual(store.list(), source.list());
  assert.equal(store.list().notes[0].url, url);
  assert.equal(imports.commit(preview.token, []).ok, false);
  assert.deepEqual(imports.undo(), { ok: true, notes: [], canUndo: false });
  assert.deepEqual(store.list(), { ok: true, notes: [] });
});

test('import compares saved content by exact URL and applies only explicit conflict choices', (t) => {
  const { store, imports, preview } = fixture(t);
  const local = [note(1), note(2), note(3), note(4)];
  const before = Buffer.from(`{ "notes":${JSON.stringify(local)}, "version":1 }`);
  fs.writeFileSync(store.file, before);
  const same = { ...local[0], id: note(10).id, updatedAt: OLD };
  const replace = { ...local[1], id: note(11).id, format: 'gen9uu', updatedAt: OLD };
  const keep = { ...local[2], id: note(12).id, notes: 'Different backup notes' };
  const differentPrivateUrl = { ...note(5), id: local[0].id, url: `${local[0].url}-otherpw` };
  const { token, entries, counts, currentCount } = preview([same, replace, keep, differentPrivateUrl]);
  assert.deepEqual(counts, { added: 1, unchanged: 1, conflicts: 2 });
  assert.equal(currentCount, 4);
  assert.deepEqual(entries.map((entry) => entry.status), ['same', 'conflict', 'conflict', 'new']);
  assert.deepEqual(entries[1].existing, local[1]);
  assert.equal(entries[3].existing, null);

  for (const choices of [
    null,
    [{ key: replace.id, action: 'replace' }],
    [{ key: replace.id, action: 'replace' }, { key: replace.id, action: 'keep' }],
    [{ key: replace.id, action: 'replace' }, { key: same.id, action: 'keep' }],
    [{ key: replace.id, action: 'replace' }, { key: differentPrivateUrl.id, action: 'keep' }],
    [{ key: replace.id, action: 'replace' }, { key: keep.id, action: 'merge' }],
  ]) {
    assert.equal(imports.commit(token, choices).ok, false);
    assert.deepEqual(fs.readFileSync(store.file), before);
  }
  const result = imports.commit(token, [{ key: replace.id, action: 'replace' }, { key: keep.id, action: 'keep' }]);
  const { notes, ...summary } = result;
  assert.deepEqual(summary, { ok: true, added: 1, replaced: 1, unchanged: 1, kept: 1, canUndo: true });
  assert.deepEqual(store.list().notes, notes);
  const regenerated = notes.find((item) => item.url === differentPrivateUrl.url);
  assert.notEqual(regenerated.id, differentPrivateUrl.id);
  assert.deepEqual(regenerated, { ...differentPrivateUrl, id: regenerated.id });
  assert.deepEqual(notes.slice(1), [local[0], { ...replace, id: local[1].id }, local[2], local[3]]);
  assert.deepEqual(imports.undo(), { ok: true, notes: local, canUndo: false });
  assert.deepEqual(fs.readFileSync(store.file), before);
});

test('malformed, unsupported, oversized and non-regular backups are rejected', (t) => {
  const { store, imports, backup, root } = fixture(t);
  assert.equal(imports.previewFile('relative.json').ok, false);
  assert.equal(imports.previewFile(backup).ok, false);
  assert.equal(imports.previewFile(root).ok, false);
  for (const invalid of [
    '{',
    JSON.stringify({ version: 2, notes: [] }),
    JSON.stringify({ version: 1, notes: [], extra: true }),
    JSON.stringify({ version: 1, notes: {} }),
    ...[
      [note(1), note(2, { id: note(1).id })],
      [note(1), note(2, { url: note(1).url })],
      [note(1, { id: [note(1).id] })],
      [note(1, { url: `${note(1).url}?secret` })],
      [note(1, { url: `${note(1).url}/` })],
      [note(1, { createdAt: 'yesterday' })],
      [note(1, { createdAt: NEW, updatedAt: OLD })],
      [note(1, { notes: 'x'.repeat(5001) })],
      [note(1, { title: ' ' })],
      [note(1, { extra: 'field' })],
      Array.from({ length: MAX_NOTES + 1 }, (_, index) => note(index)),
    ].map((notes) => JSON.stringify({ version: 1, notes })),
    Buffer.concat([Buffer.from('{"version":1,"notes":['), Buffer.from([0xc0, 0xaf]), Buffer.from(']}')]),
  ]) {
    fs.writeFileSync(backup, invalid);
    const result = imports.previewFile(backup);
    assert.equal(result.ok, false);
    assert.equal(result.error.includes(root), false);
  }
  fs.truncateSync(backup, MAX_FILE_BYTES + 1);
  assert.match(imports.previewFile(backup).error, /8 MiB/);
  assert.equal(fs.existsSync(store.file), false);
});

test('empty or identical backups and kept conflicts leave the previous undo intact', (t) => {
  const { store, imports, preview } = fixture(t);
  const empty = preview([]);
  assert.equal(imports.commit(empty.token, []).canUndo, false);
  assert.equal(fs.existsSync(store.file), false);

  const added = preview([note(1)]);
  assert.equal(imports.commit(added.token, []).canUndo, true);
  const before = fs.readFileSync(store.file);
  for (const [notes, decisions] of [
    [[], []],
    [[note(1, { id: note(2).id })], []],
    [[note(1, { title: 'Different' })], [{ key: note(1).id, action: 'keep' }]],
  ]) {
    const noOp = preview(notes);
    const result = imports.commit(noOp.token, decisions);
    assert.equal(result.ok, true);
    assert.equal(result.canUndo, true);
    assert.deepEqual(fs.readFileSync(store.file), before);
  }
  assert.deepEqual(imports.status(), { ok: true, canUndo: true });
  assert.deepEqual(new ReplayImports(store).status(), { ok: true, canUndo: false });
  assert.equal(imports.undo().ok, true);
  assert.equal(imports.undo().ok, false);
});

test('a fresh preview supersedes previous tokens, and cancel and reset release their state', (t) => {
  const { store, imports, preview } = fixture(t);
  const first = preview([note(1)]);
  const second = preview([note(2)]);
  assert.deepEqual(imports.cancel(first.token), { ok: true });
  assert.equal(imports.commit(first.token, []).ok, false);
  assert.equal(imports.commit(second.token, []).ok, true);
  const third = preview([note(3)]);
  assert.deepEqual(imports.cancel(third.token), { ok: true });
  assert.equal(imports.commit(third.token, []).ok, false);
  const fourth = preview([note(4)]);
  imports.reset();
  assert.equal(imports.commit(fourth.token, []).ok, false);
  assert.equal(imports.undo().ok, false);
  assert.deepEqual(store.list().notes, [note(2)]);
});

test('corrupt and stale stores are protected before import and undo', (t) => {
  const { store, imports, backup, preview } = fixture(t);
  const stale = preview([note(1)]);
  fs.writeFileSync(store.file, '{invalid');
  assert.equal(imports.commit(stale.token, []).ok, false);
  assert.equal(imports.previewFile(backup).ok, false);
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{invalid');

  fs.writeFileSync(store.file, JSON.stringify({ version: 1, notes: [] }));
  const reviewed = preview([note(2)]);
  fs.appendFileSync(store.file, '\n');
  const outside = fs.readFileSync(store.file);
  assert.equal(imports.commit(reviewed.token, []).stale, true);
  assert.equal(imports.commit(reviewed.token, []).ok, false);
  assert.deepEqual(fs.readFileSync(store.file), outside);

  const fresh = preview([note(2)]);
  assert.equal(imports.commit(fresh.token, []).ok, true);
  assert.equal(store.save({ id: note(2).id, title: 'A later edit' }).ok, true);
  const edited = fs.readFileSync(store.file);
  assert.deepEqual(imports.status(), { ok: true, canUndo: false });
  assert.equal(imports.undo().ok, false);
  assert.deepEqual(fs.readFileSync(store.file), edited);
});

test('a concurrent write during the atomic import guard invalidates the preview', (t) => {
  let file;
  const external = JSON.stringify({ version: 1, notes: [note(4)] });
  const racingFs = Object.assign(Object.create(fs), {
    fsyncSync(fd) {
      fs.fsyncSync(fd);
      fs.writeFileSync(file, external);
    },
  });
  const { store, imports, preview } = fixture(t, racingFs);
  file = store.file;
  const { token } = preview([note(1)]);
  assert.equal(imports.commit(token, []).stale, true);
  assert.equal(imports.commit(token, []).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), external);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['replays.json']);
});

test('write failures preserve the original store and allow an import or undo retry', (t) => {
  let fail = true;
  const failingFs = Object.assign(Object.create(fs), {
    renameSync(...args) {
      if (fail) throw new Error('injected rename failure');
      return fs.renameSync(...args);
    },
  });
  const { store, imports, preview } = fixture(t, failingFs);
  const original = JSON.stringify({ version: 1, notes: [note(2)] });
  fs.writeFileSync(store.file, original);
  const { token } = preview([note(1)]);
  assert.equal(imports.commit(token, []).ok, false);
  assert.equal(fs.readFileSync(store.file, 'utf8'), original);
  assert.deepEqual(imports.status(), { ok: true, canUndo: false });
  fail = false;
  assert.equal(imports.commit(token, []).ok, true);
  const committed = fs.readFileSync(store.file);
  fail = true;
  assert.equal(imports.undo().ok, false);
  assert.deepEqual(imports.status(), { ok: true, canUndo: true });
  assert.deepEqual(fs.readFileSync(store.file), committed);
  assert.deepEqual(fs.readdirSync(path.dirname(store.file)), ['replays.json']);
  fail = false;
  assert.equal(imports.undo().ok, true);
  assert.equal(fs.readFileSync(store.file, 'utf8'), original);
});

test('import rejects merged note and byte counts above store limits', (t) => {
  const { store, imports, preview } = fixture(t);
  const originals = Array.from({ length: MAX_NOTES }, (_, index) => note(index));
  fs.writeFileSync(store.file, JSON.stringify({ version: 1, notes: originals }));
  const full = fs.readFileSync(store.file);
  const extra = preview([note(MAX_NOTES)]);
  assert.match(imports.commit(extra.token, []).error, /1,000-note limit/);
  assert.deepEqual(fs.readFileSync(store.file), full);

  const wideNotes = Array.from({ length: 560 }, (_, index) => note(index, { notes: '雨'.repeat(5000) }));
  fs.writeFileSync(store.file, JSON.stringify({ version: 1, notes: wideNotes.slice(0, 280) }));
  const wideBefore = fs.readFileSync(store.file);
  const wide = preview(wideNotes.slice(280));
  assert.match(imports.commit(wide.token, []).error, /too large/);
  assert.deepEqual(fs.readFileSync(store.file), wideBefore);
});

test('undo restores a compact store whose pretty JSON would exceed the byte limit', (t) => {
  const { store, imports, preview } = fixture(t);
  const notes = Array.from({ length: 549 }, (_, index) => note(index, { notes: '雨'.repeat(5000) }));
  const data = { version: 1, notes };
  const compact = Buffer.from(JSON.stringify(data));
  assert.ok(compact.length <= MAX_FILE_BYTES);
  assert.ok(Buffer.byteLength(serializeStore(data)) > MAX_FILE_BYTES);
  fs.writeFileSync(store.file, compact);

  const shorter = note(0);
  const { token } = preview([shorter]);
  assert.equal(imports.commit(token, [{ key: shorter.id, action: 'replace' }]).ok, true);
  assert.equal(imports.undo().ok, true);
  assert.deepEqual(fs.readFileSync(store.file), compact);
});
