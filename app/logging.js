'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only fixed event names and numeric codes enter logs; no URLs, names or page text.
class Logger {
  constructor(dir) {
    this.dir = path.join(dir, 'logs');
    this.file = path.join(this.dir, 'desktop.log');
  }

  write(event, code) {
    if (!/^[a-z-]{1,60}$/.test(event)) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 1024 * 1024) {
        const previous = path.join(this.dir, 'desktop.previous.log');
        fs.rmSync(previous, { force: true });
        fs.renameSync(this.file, previous);
      }
      fs.appendFileSync(this.file, `${new Date().toISOString()} ${event}${Number.isSafeInteger(code) ? ` ${code}` : ''}\n`);
    } catch {}
  }
}

module.exports = { Logger };
