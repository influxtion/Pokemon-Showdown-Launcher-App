'use strict';

const fs = require('node:fs');
const path = require('node:path');

const THEMES = new Set(['system', 'light', 'dark']);
const DEFAULTS = Object.freeze({ theme: 'system' });

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object' && THEMES.has(raw.theme)) out.theme = raw.theme;
  return out;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.values = this.load();
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { ...DEFAULTS };
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      // Keep the unreadable file for inspection instead of silently overwriting it later.
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {}
      return { ...DEFAULTS };
    }
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    const next = sanitize({ ...this.values, [key]: value });
    if (next[key] !== value) return false;
    // Write to a temp file and rename so a failed write never truncates the old settings.
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    this.values = next;
    return true;
  }
}

module.exports = { Settings, THEMES };
