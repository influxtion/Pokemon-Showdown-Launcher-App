'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const THEMES = new Set(['system', 'light', 'dark']);
const START_PAGES = new Set(['home', 'showdown', 'replays']);
const DEFAULTS = Object.freeze({ theme: 'system', startPage: 'home', confirmOnClose: true, showdexEnabled: false });
const KEYS = new Set(Object.keys(DEFAULTS));

function valid(key, value) {
  if (key === 'theme') return THEMES.has(value);
  if (key === 'startPage') return START_PAGES.has(value);
  if (key === 'confirmOnClose') return typeof value === 'boolean';
  if (key === 'showdexEnabled') return typeof value === 'boolean';
  return false;
}

function parse(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid settings');
  const values = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (!KEYS.has(key) || !valid(key, value)) throw new Error('Invalid settings');
    values[key] = value;
  }
  return values;
}

class Settings {
  constructor(dir, fileSystem = fs) {
    this.file = path.join(dir, 'settings.json');
    this.fs = fileSystem;
    this.loadError = null;
    this.values = this.load();
  }

  load() {
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadError = 'Settings could not be read. Changes are disabled.';
      return { ...DEFAULTS };
    }
    try {
      return parse(text);
    } catch {
      // Keep the unreadable file for inspection instead of silently overwriting it later.
      try {
        this.fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}-${randomUUID()}`);
      } catch {
        this.loadError = 'Invalid settings could not be preserved. Changes are disabled.';
      }
      return { ...DEFAULTS };
    }
  }

  get(key) {
    return this.values[key];
  }

  snapshot() {
    return { ...this.values };
  }

  write(next) {
    if (this.loadError) throw new Error(this.loadError);
    const tmp = `${this.file}.tmp-${randomUUID()}`;
    this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      this.fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      this.fs.renameSync(tmp, this.file);
    } catch (error) {
      try { this.fs.unlinkSync(tmp); } catch {}
      throw error;
    }
    this.values = next;
  }

  set(key, value) {
    if (!KEYS.has(key) || !valid(key, value)) return false;
    this.write({ ...this.values, [key]: value });
    return true;
  }

  reset() {
    this.write({ ...DEFAULTS });
    return this.snapshot();
  }
}

module.exports = { Settings, THEMES, START_PAGES, DEFAULTS };
