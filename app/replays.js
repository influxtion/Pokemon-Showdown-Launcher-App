'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_NOTES = 1000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAT = /^[a-z0-9]{0,80}$/;
const REPLAY_ID = /^([a-z0-9]+)-[0-9]+(?:-[a-z0-9]+pw)?$/;

function normalizeReplayUrl(value) {
  if (typeof value !== 'string' || value.length > 300 || !value.trim() || /[?#\\\x00-\x1f]/.test(value)) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.hostname !== 'replay.pokemonshowdown.com' || url.port ||
      url.username || url.password || url.search || url.hash) return null;
  const replayId = url.pathname.slice(1).replace(/\/$/, '');
  if (!REPLAY_ID.test(replayId)) return null;
  return `https://replay.pokemonshowdown.com/${replayId}`;
}

function validText(value, max, required = false) {
  return typeof value === 'string' && value.length <= max && (!required || !!value.trim());
}

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function validNote(note) {
  if (!note || typeof note !== 'object' || Array.isArray(note)) return false;
  const keys = Object.keys(note).sort();
  if (keys.join(',') !== 'createdAt,format,id,notes,title,updatedAt,url') return false;
  return UUID.test(note.id) && normalizeReplayUrl(note.url) === note.url &&
    validText(note.title, 120, true) && validText(note.notes, 5000) &&
    typeof note.format === 'string' && FORMAT.test(note.format) &&
    validTimestamp(note.createdAt) && validTimestamp(note.updatedAt) &&
    note.updatedAt >= note.createdAt;
}

function validateStore(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).sort().join(',') !== 'notes,version' ||
      data.version !== 1 || !Array.isArray(data.notes) || data.notes.length > MAX_NOTES) return false;
  const ids = new Set();
  const urls = new Set();
  for (const note of data.notes) {
    if (!validNote(note) || ids.has(note.id) || urls.has(note.url)) return false;
    ids.add(note.id);
    urls.add(note.url);
  }
  return true;
}

class Replays {
  constructor(dir, fileSystem = fs) {
    this.file = path.join(dir, 'replays.json');
    this.fs = fileSystem;
  }

  read() {
    let bytes;
    try {
      if (this.fs.statSync(this.file).size > MAX_FILE_BYTES) {
        return { ok: false, error: 'Replay notes file is too large.' };
      }
      bytes = this.fs.readFileSync(this.file);
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: true, data: { version: 1, notes: [] }, bytes: null };
      return { ok: false, error: 'Replay notes could not be read.' };
    }
    if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: 'Replay notes file is too large.' };
    try {
      const data = JSON.parse(bytes.toString('utf8'));
      if (!validateStore(data)) return { ok: false, error: 'Replay notes file is invalid. It was not changed.' };
      return { ok: true, data, bytes };
    } catch {
      return { ok: false, error: 'Replay notes file is invalid. It was not changed.' };
    }
  }

  list() {
    const result = this.read();
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, notes: result.data.notes.map((note) => ({ ...note })) };
  }

  get(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const result = this.read();
    if (!result.ok) return null;
    const note = result.data.notes.find((item) => item.id === id);
    return note ? { ...note } : null;
  }

  save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Invalid replay note.' };
    const current = this.read();
    if (!current.ok) return { ok: false, error: current.error };
    const id = input.id;
    if (id !== undefined && (typeof id !== 'string' || !UUID.test(id))) return { ok: false, error: 'Invalid replay note ID.' };
    const previous = id && current.data.notes.find((note) => note.id === id);
    if (id && !previous) return { ok: false, error: 'Replay note was not found.' };
    const url = normalizeReplayUrl(input.url === undefined && previous ? previous.url : input.url);
    if (!url) return { ok: false, error: 'Enter a valid Pokémon Showdown replay URL.' };
    if (previous && url !== previous.url) return { ok: false, error: 'A saved replay URL cannot be changed.' };
    const duplicate = current.data.notes.find((note) => note.url === url && note.id !== id);
    if (duplicate) return { ok: false, error: 'A note for this replay already exists.', existingId: duplicate.id };
    if (!validText(input.title, 120, true)) return { ok: false, error: 'Enter a title of 1–120 characters.' };
    const notes = input.notes === undefined ? '' : input.notes;
    if (!validText(notes, 5000)) return { ok: false, error: 'Notes must be at most 5,000 characters.' };
    const format = input.format === undefined || input.format === ''
      ? new URL(url).pathname.slice(1).split('-')[0] : input.format;
    if (typeof format !== 'string' || !FORMAT.test(format)) return { ok: false, error: 'Format must use lowercase letters and numbers, up to 80 characters.' };
    if (!previous && current.data.notes.length >= MAX_NOTES) return { ok: false, error: 'Replay notes limit reached.' };
    const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) : 0)).toISOString();
    const note = {
      id: previous ? previous.id : randomUUID(), url, title: input.title.trim(), format,
      notes, createdAt: previous ? previous.createdAt : now, updatedAt: now,
    };
    const next = {
      version: 1,
      notes: previous
        ? current.data.notes.map((item) => item.id === id ? note : item)
        : [note, ...current.data.notes],
    };
    const saved = this.write(next, current.bytes);
    return saved.ok ? { ok: true, note: { ...note } } : saved;
  }

  delete(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, error: 'Invalid replay note ID.' };
    const current = this.read();
    if (!current.ok) return { ok: false, error: current.error };
    if (!current.data.notes.some((note) => note.id === id)) return { ok: false, error: 'Replay note was not found.' };
    return this.write({ version: 1, notes: current.data.notes.filter((note) => note.id !== id) }, current.bytes);
  }

  exportTo(destination) {
    const current = this.read();
    if (!current.ok) return { ok: false, error: current.error };
    let temporary;
    let fd;
    try {
      if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
        return { ok: false, error: 'Choose a file for the export.' };
      }
      // Resolve directory aliases too: an export must never replace live profile data.
      const directory = this.fs.realpathSync(path.dirname(destination));
      const profile = this.fs.realpathSync(path.dirname(this.file));
      const relative = path.relative(profile, directory);
      if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
        return { ok: false, error: 'Choose a location outside the app data folder.' };
      }
      const serialized = JSON.stringify(current.data, null, 2) + '\n';
      if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) {
        return { ok: false, error: 'Replay notes export would be too large.' };
      }
      temporary = path.join(directory, `.showdown-replays-${randomUUID()}.tmp`);
      fd = this.fs.openSync(temporary, 'wx', 0o600);
      this.fs.writeFileSync(fd, serialized);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.fs.renameSync(temporary, destination);
      temporary = undefined;
      return { ok: true, count: current.data.notes.length };
    } catch {
      return { ok: false, error: 'Could not export replay notes. Choose a writable location and try again.' };
    } finally {
      if (fd !== undefined) {
        try { this.fs.closeSync(fd); } catch {}
      }
      if (temporary) {
        try { this.fs.unlinkSync(temporary); } catch {}
      }
    }
  }

  write(data, previousBytes) {
    const serialized = JSON.stringify(data, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) return { ok: false, error: 'Replay notes file would be too large.' };
    let temporary;
    let fd;
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      temporary = `${this.file}.${randomUUID()}.tmp`;
      fd = this.fs.openSync(temporary, 'wx', 0o600);
      this.fs.writeFileSync(fd, serialized);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      const check = this.read();
      if (!check.ok || (previousBytes === null ? check.bytes !== null :
        !check.bytes || !check.bytes.equals(previousBytes))) {
        return { ok: false, error: 'Replay notes changed on disk. Reload and try again.' };
      }
      this.fs.renameSync(temporary, this.file);
      temporary = undefined;
      return { ok: true };
    } catch {
      return { ok: false, error: 'Replay notes could not be saved. Previous notes were kept.' };
    } finally {
      if (fd !== undefined) {
        try { this.fs.closeSync(fd); } catch {}
      }
      if (temporary) {
        try { this.fs.unlinkSync(temporary); } catch {}
      }
    }
  }
}

module.exports = { Replays, normalizeReplayUrl };
