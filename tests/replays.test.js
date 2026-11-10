'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Replays, normalizeReplayUrl } = require('../app/replays');

const PUBLIC = 'https://replay.pokemonshowdown.com/gen9ou-1234567890';
const PRIVATE = 'https://replay.pokemonshowdown.com/gen8freeforallrandombattle-1321272651-9qajdjltki94lplgx6op2cc27d3x6bepw';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-replays-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('replay URL validation preserves the private access suffix', () => {
  assert.equal(normalizeReplayUrl(PRIVATE), PRIVATE);
  assert.equal(normalizeReplayUrl(`http://replay.pokemonshowdown.com/gen9ou-1234567890/`), PUBLIC);
  for (const url of [
    'https://evil.example/gen9ou-1234567890',
    'https://replay.pokemonshowdown.com.evil.example/gen9ou-1234567890',
    'https://name@replay.pokemonshowdown.com/gen9ou-1234567890',
    `${PUBLIC}?tracking=1`, `${PUBLIC}#private`, `${PUBLIC}?`, `${PUBLIC}#`,
    `${PUBLIC}/more`, 'file:///gen9ou-1234567890',
    'https:\\replay.pokemonshowdown.com\\gen9ou-1234567890',
    'https://replay.pokemonshowdown.com/search.json',
  ]) assert.equal(normalizeReplayUrl(url), null, url);
});

test('save, edit, delete and restart preserve notes and immutable URLs', (t) => {
  const dir = fixture(t);
  const store = new Replays(dir);
  assert.deepEqual(store.list(), { ok: true, notes: [] });
  const first = store.save({ url: PRIVATE, title: '  Close finish  ', notes: 'Turn 4', format: '' });
  assert.equal(first.ok, true);
  assert.equal(first.note.url, PRIVATE);
  assert.equal(first.note.title, 'Close finish');
  assert.equal(first.note.format, 'gen8freeforallrandombattle');
  assert.equal(store.get(first.note.id).notes, 'Turn 4');
  const duplicate = store.save({ url: PRIVATE, title: 'Duplicate', notes: '' });
  assert.deepEqual(duplicate, {
    ok: false, error: 'A note for this replay already exists.', existingId: first.note.id,
  });
  assert.equal(store.save({ id: first.note.id, url: PUBLIC, title: 'Change URL', notes: '' }).ok, false);
  const edited = store.save({ id: first.note.id, title: 'Close finish revised', notes: 'Turn 5' });
  assert.equal(edited.ok, true);
  assert.equal(edited.note.createdAt, first.note.createdAt);
  assert.equal(edited.note.notes, 'Turn 5');
  assert.equal(new Replays(dir).list().notes[0].title, 'Close finish revised');
  assert.deepEqual(store.delete(first.note.id), { ok: true });
  assert.equal(new Replays(dir).get(first.note.id), null);
  assert.deepEqual(new Replays(dir).list(), { ok: true, notes: [] });
});

test('input validation rejects oversized and malformed fields', (t) => {
  const store = new Replays(fixture(t));
  for (const input of [
    { url: PUBLIC, title: '', notes: '' },
    { url: PUBLIC, title: 'x'.repeat(121), notes: '' },
    { url: PUBLIC, title: 'Valid', notes: 'x'.repeat(5001) },
    { url: PUBLIC, title: 'Valid', notes: '', format: 'Gen9 OU' },
    { url: PUBLIC, title: 'Valid', notes: '', format: 'x'.repeat(81) },
    { url: `https://replay.pokemonshowdown.com/${'x'.repeat(81)}-1234`, title: 'Valid' },
  ]) assert.equal(store.save(input).ok, false);
  assert.deepEqual(store.list(), { ok: true, notes: [] });
  assert.equal(store.delete('bad').ok, false);
  assert.equal(store.get('bad'), null);
});

test('editing with a clock earlier than the saved timestamp remains valid', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'replays.json');
  const store = new Replays(dir);
  const saved = store.save({ url: PUBLIC, title: 'Original' });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.notes[0].createdAt = '2999-01-01T00:00:00.000Z';
  data.notes[0].updatedAt = '2999-01-02T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(data));
  const edited = store.save({ id: saved.note.id, title: 'Changed' });
  assert.equal(edited.ok, true);
  assert.equal(edited.note.updatedAt, '2999-01-02T00:00:00.000Z');
  assert.equal(new Replays(dir).get(saved.note.id).title, 'Changed');
});

test('corrupt file blocks writes without destroying original bytes', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'replays.json');
  fs.writeFileSync(file, '{broken');
  const store = new Replays(dir);
  assert.equal(store.list().ok, false);
  assert.equal(store.save({ url: PUBLIC, title: 'Test' }).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal(store.get('00000000-0000-0000-0000-000000000000'), null);
});

test('invalid schema and duplicate saved URLs block further writes', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'replays.json');
  const store = new Replays(dir);
  const saved = store.save({ url: PUBLIC, title: 'Test' });
  assert.equal(saved.ok, true);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.notes.push({ ...saved.note, id: '00000000-0000-0000-0000-000000000001' });
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(store.list().ok, false);
  assert.equal(store.delete(saved.note.id).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).notes.length, 2);
});

test('invalid saved timestamp or ID blocks reads and writes', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'replays.json');
  const store = new Replays(dir);
  const saved = store.save({ url: PUBLIC, title: 'Test' });
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const patch of [{ updatedAt: 'yesterday' }, { id: '../bad' }, { createdAt: '2999-01-01T00:00:00.000Z' }]) {
    const data = structuredClone(original);
    Object.assign(data.notes[0], patch);
    const bytes = JSON.stringify(data);
    fs.writeFileSync(file, bytes);
    assert.equal(store.list().ok, false);
    assert.equal(store.save({ id: saved.note.id, title: 'Changed' }).ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});

test('unreadable existing data is not treated as an empty store', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'replays.json');
  const normal = new Replays(dir);
  assert.equal(normal.save({ url: PUBLIC, title: 'Original' }).ok, true);
  const before = fs.readFileSync(file);
  const unreadableFs = Object.assign(Object.create(fs), {
    readFileSync(target, ...args) {
      if (target === file) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return fs.readFileSync(target, ...args);
    },
  });
  const store = new Replays(dir, unreadableFs);
  assert.equal(store.list().ok, false);
  assert.equal(store.save({ url: PRIVATE, title: 'Another' }).ok, false);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('oversized file is reported and preserved', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'replays.json');
  fs.writeFileSync(file, 'x'.repeat(8 * 1024 * 1024 + 1));
  const store = new Replays(dir);
  assert.equal(store.list().error, 'Replay notes file is too large.');
  assert.equal(store.save({ url: PUBLIC, title: 'Test' }).ok, false);
  assert.equal(fs.statSync(file).size, 8 * 1024 * 1024 + 1);
});

test('failed sync keeps the previous file and removes temporary file', (t) => {
  const dir = fixture(t);
  const normal = new Replays(dir);
  const saved = normal.save({ url: PUBLIC, title: 'Original' });
  assert.equal(saved.ok, true);
  const before = fs.readFileSync(path.join(dir, 'replays.json'));
  const failingFs = Object.assign(Object.create(fs), { fsyncSync() { throw new Error('disk full'); } });
  const failing = new Replays(dir, failingFs);
  assert.equal(failing.save({ id: saved.note.id, title: 'Changed' }).ok, false);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'replays.json')), before);
  assert.equal(normal.get(saved.note.id).title, 'Original');
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('failed rename keeps the previous file and removes temporary file', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'replays.json');
  const normal = new Replays(dir);
  const saved = normal.save({ url: PUBLIC, title: 'Original' });
  const before = fs.readFileSync(file);
  const failingFs = Object.assign(Object.create(fs), { renameSync() { throw new Error('rename failed'); } });
  const result = new Replays(dir, failingFs).save({ id: saved.note.id, title: 'Changed' });
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(normal.get(saved.note.id).title, 'Original');
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('outside changes detected before replacement keep both versions intact', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'replays.json');
  const normal = new Replays(dir);
  const saved = normal.save({ url: PUBLIC, title: 'Original' });
  const external = JSON.parse(fs.readFileSync(file, 'utf8'));
  external.notes[0].title = 'Outside edit';
  const racingFs = Object.assign(Object.create(fs), {
    fsyncSync(fd) {
      fs.fsyncSync(fd);
      fs.writeFileSync(file, JSON.stringify(external));
    },
  });
  const result = new Replays(dir, racingFs).save({ id: saved.note.id, title: 'Local edit' });
  assert.equal(result.ok, false);
  assert.equal(normal.get(saved.note.id).title, 'Outside edit');
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('export preserves all saved fields and private links without changing the store', (t) => {
  const dir = fixture(t);
  const destination = path.join(fixture(t), 'notes.json');
  const store = new Replays(dir);
  assert.deepEqual(store.exportTo(destination), { ok: true, count: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination)), { version: 1, notes: [] });
  store.save({ url: PRIVATE, title: 'Private review', notes: 'Turn 12: switch — 雨' });
  store.save({ url: PUBLIC, title: 'Public review' });
  const before = fs.readFileSync(store.file);
  assert.deepEqual(store.exportTo(destination), { ok: true, count: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination)), JSON.parse(before));
  assert.deepEqual(fs.readFileSync(store.file), before);
  // The exported versioned format is readable by the same store on another profile.
  const restored = fixture(t);
  fs.copyFileSync(destination, path.join(restored, 'replays.json'));
  assert.deepEqual(new Replays(restored).list(), store.list());
});

test('export refuses corrupt data without replacing a previous export', (t) => {
  const store = new Replays(fixture(t));
  const destination = path.join(fixture(t), 'notes.json');
  fs.writeFileSync(destination, 'previous export');
  fs.writeFileSync(store.file, '{broken');
  assert.equal(store.exportTo(destination).ok, false);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'previous export');
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
});

test('export failures preserve the store and previous export and remove temporary files', (t) => {
  const dir = fixture(t);
  const output = fixture(t);
  const destination = path.join(output, 'notes.json');
  const store = new Replays(dir);
  store.save({ url: PRIVATE, title: 'Original' });
  const before = fs.readFileSync(store.file);
  fs.writeFileSync(destination, 'previous export');
  for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const failingFs = Object.assign(Object.create(fs), {
      [method]() { throw new Error('injected export failure'); },
    });
    assert.equal(new Replays(dir, failingFs).exportTo(destination).ok, false, method);
    assert.deepEqual(fs.readFileSync(store.file), before);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'previous export');
    assert.deepEqual(fs.readdirSync(output), ['notes.json']);
  }
});

test('export refuses live profile paths including directory aliases', (t) => {
  const dir = fixture(t);
  const store = new Replays(dir);
  store.save({ url: PUBLIC, title: 'Keep' });
  fs.mkdirSync(path.join(dir, 'nested'));
  const before = fs.readFileSync(store.file);
  for (const destination of [store.file, path.join(dir, 'settings.json'), path.join(dir, 'nested', 'notes.json'), 'relative.json', null]) {
    assert.equal(store.exportTo(destination).ok, false);
  }
  const alias = path.join(fixture(t), 'profile-alias');
  fs.symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(store.exportTo(path.join(alias, 'replays.json')).ok, false);
  assert.deepEqual(fs.readFileSync(store.file), before);
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
});
