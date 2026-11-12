'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyInWorker } = require('./practice-verification');
const { verifyInventory } = require('./bot-integrity');

// Operator-controlled file, never a renderer-supplied path. Generated inputs stay outside Git.
function readBotConfig(filename) {
  if (!fs.existsSync(filename)) return null;
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (config.version !== 1) throw new Error('Unsupported bot configuration');
  for (const name of ['root', 'laplacePython', 'foulPlayPython', 'foulPlaySource', 'integrityFile']) {
    if (typeof config[name] !== 'string' || !path.isAbsolute(config[name]) || !fs.existsSync(config[name])) {
      throw new Error(`Missing bot configuration input: ${name}`);
    }
  }
  return config;
}

function runtimeOptions(config, workspace) {
  return {
    root: config.root,
    scripts: path.join(workspace, 'scripts/laplace'),
    python: config.laplacePython,
    ...(config.portable ? { installed: () => fs.existsSync(config.integrityFile) } : {}),
    verify: root => {
      const controller = new AbortController();
      const base = config.portable ? null : verifyInWorker(root);
      return { cancel() { controller.abort(); base?.cancel(); },
        promise: (async () => ({ ok: (!base || (await base.promise).ok) &&
          await verifyInventory(config.integrityFile, controller.signal) }))() };
    },
    foulPlay: { python: config.foulPlayPython, source: config.foulPlaySource,
      runner: path.join(workspace, 'scripts/bots/foulplay.py') },
  };
}

module.exports = { readBotConfig, runtimeOptions };
