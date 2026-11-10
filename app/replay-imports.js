'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateStore, serializeStore, MAX_NOTES, MAX_FILE_BYTES } = require('./replays');

const STALE_PREVIEW = { ok: false, stale: true, error: 'Replay notes changed on disk. Choose the backup again.' };

function readBackup(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    return { ok: false, error: 'Choose a replay notes backup file.' };
  }
  const oversized = { ok: false, error: 'Replay notes backups must be 8 MiB or smaller.' };
  let fd;
  let bytes;
  try {
    if (!fs.statSync(file).isFile()) return { ok: false, error: 'Choose a regular backup file.' };
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, error: 'Choose a regular backup file.' };
    if (stat.size > MAX_FILE_BYTES) return oversized;

    // Bound the read even if the file grows after the size check.
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > MAX_FILE_BYTES) return oversized;
    bytes = buffer.subarray(0, length);
  } catch {
    return { ok: false, error: 'The replay notes backup could not be read.' };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  try {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (validateStore(data)) return { ok: true, data };
    if (Number.isInteger(data?.version) && data.version !== 1) {
      return { ok: false, error: 'This replay notes backup version is unsupported.' };
    }
  } catch {}
  return { ok: false, error: 'The replay notes backup is invalid. Choose a file exported from Replay notes.' };
}

function sameBytes(left, right) {
  return left === null ? right === null : right !== null && left.equals(right);
}

function sameContent(left, right) {
  return left.title === right.title && left.format === right.format && left.notes === right.notes;
}

function conflictChoices(choices, entries, conflictCount) {
  if (!Array.isArray(choices) || choices.length !== conflictCount) return null;
  const conflicts = new Set(entries.filter((entry) => entry.status === 'conflict').map((entry) => entry.key));
  const decisions = new Map();
  for (const choice of choices) {
    if (!conflicts.delete(choice?.key) || (choice.action !== 'keep' && choice.action !== 'replace')) return null;
    decisions.set(choice.key, choice.action);
  }
  return decisions;
}

class ReplayImports {
  #pending;
  #previous;

  constructor(store) {
    this.store = store;
  }

  previewFile(file) {
    this.#pending = undefined;
    const backup = readBackup(file);
    if (!backup.ok) return backup;
    const current = this.store.read();
    if (!current.ok) return { ok: false, error: current.error };

    const existingByUrl = new Map(current.data.notes.map((note) => [note.url, note]));
    const counts = { added: 0, unchanged: 0, conflicts: 0 };
    const entries = backup.data.notes.map((incoming) => {
      const existing = existingByUrl.get(incoming.url) ?? null;
      let status;
      if (!existing) {
        status = 'new';
        counts.added++;
      } else if (sameContent(existing, incoming)) {
        status = 'same';
        counts.unchanged++;
      } else {
        status = 'conflict';
        counts.conflicts++;
      }
      return { key: incoming.id, status, incoming, existing };
    });
    const preview = {
      token: randomUUID(), filename: path.basename(file), entries, counts,
      currentCount: current.data.notes.length,
    };
    this.#pending = { preview, bytes: current.bytes };
    return { ok: true, preview: structuredClone(preview) };
  }

  commit(token, choices) {
    const pending = this.#pending;
    if (!pending || token !== pending.preview.token) {
      return { ok: false, error: 'Choose a replay notes backup to review first.' };
    }
    const { entries, counts } = pending.preview;
    const decisions = conflictChoices(choices, entries, counts.conflicts);
    if (!decisions) return { ok: false, error: 'Choose how to handle every conflicting note.' };

    const current = this.store.read();
    if (!current.ok) return { ok: false, error: current.error };
    if (!sameBytes(current.bytes, pending.bytes)) {
      this.#pending = undefined;
      return { ...STALE_PREVIEW };
    }
    if (current.data.notes.length + counts.added > MAX_NOTES) {
      return { ok: false, error: 'This import would exceed the 1,000-note limit.' };
    }

    const newNotes = [];
    const replacements = new Map();
    const currentIds = new Set(current.data.notes.map((note) => note.id));
    const reservedIds = new Set([...currentIds, ...entries.map((entry) => entry.key)]);
    for (const { key, status, incoming, existing } of entries) {
      if (status === 'new') {
        let id = key;
        if (currentIds.has(id)) {
          do { id = randomUUID(); } while (reservedIds.has(id));
          reservedIds.add(id);
        }
        newNotes.push({ ...incoming, id });
      } else if (decisions.get(key) === 'replace') {
        replacements.set(existing.id, { ...incoming, id: existing.id });
      }
    }

    let notes = current.data.notes;
    let canUndo = !!this.#previous && sameBytes(current.bytes, this.#previous.after);
    if (newNotes.length || replacements.size) {
      notes = [...newNotes, ...notes.map((note) => replacements.get(note.id) ?? note)];
      const next = { version: 1, notes };
      if (!validateStore(next)) return { ok: false, error: 'The merged replay notes are invalid.' };
      const after = Buffer.from(serializeStore(next));
      if (after.length > MAX_FILE_BYTES) return { ok: false, error: 'The merged replay notes file would be too large.' };
      const saved = this.store.write(next, current.bytes);
      if (saved.stale) {
        this.#pending = undefined;
        return { ...STALE_PREVIEW };
      }
      if (!saved.ok) return saved;
      this.#previous = { before: current, after };
      canUndo = true;
    }

    this.#pending = undefined;
    return {
      ok: true, added: newNotes.length, replaced: replacements.size, unchanged: counts.unchanged,
      kept: counts.conflicts - replacements.size, notes: structuredClone(notes), canUndo,
    };
  }

  cancel(token) {
    if (this.#pending?.preview.token === token) this.#pending = undefined;
    return { ok: true };
  }

  status() {
    if (!this.#previous) return { ok: true, canUndo: false };
    const current = this.store.read();
    return { ok: true, canUndo: current.ok && sameBytes(current.bytes, this.#previous.after) };
  }

  undo() {
    if (!this.#previous) return { ok: false, error: 'There is no replay notes import to undo.' };
    const { before, after } = this.#previous;
    const current = this.store.read();
    if (!current.ok) return { ok: false, error: current.error };
    if (!sameBytes(current.bytes, after)) {
      return { ok: false, error: 'Replay notes changed after the import. Undo is unavailable.' };
    }
    const saved = this.store.write(before.data, current.bytes, before.bytes);
    if (!saved.ok) return saved;
    this.#previous = undefined;
    this.#pending = undefined;
    return { ok: true, notes: structuredClone(before.data.notes), canUndo: false };
  }

  reset() {
    this.#pending = undefined;
    this.#previous = undefined;
  }
}

module.exports = { ReplayImports };
