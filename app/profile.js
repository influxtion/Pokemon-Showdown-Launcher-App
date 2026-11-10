'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROFILE_ENV = 'SHOWDOWN_DESKTOP_USER_DATA';
const PROFILE_NAME = 'showdown-desktop';

// Run before app.whenReady(). Keep packaged and development profiles at the same path.
function configureProfile(app) {
  const requested = process.env[PROFILE_ENV];
  if (requested !== undefined) {
    if (!requested || !path.isAbsolute(requested)) {
      throw new Error(`${PROFILE_ENV} must be an absolute directory path.`);
    }
    const target = path.resolve(requested);
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
    return target;
  }

  const current = app.getPath('userData');
  const defaultPath = path.join(app.getPath('appData'), app.getName());
  if (path.normalize(current).toLowerCase() !== path.normalize(defaultPath).toLowerCase()) {
    return current;
  }
  const stable = path.join(app.getPath('appData'), PROFILE_NAME);
  fs.mkdirSync(stable, { recursive: true });
  app.setPath('userData', stable);
  return stable;
}

module.exports = { configureProfile };
