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
  const present = name => {
    if (typeof config[name] !== 'string' || !path.isAbsolute(config[name]) || !fs.existsSync(config[name])) {
      throw new Error(`Missing bot configuration input: ${name}`);
    }
  };
  for (const name of ['root', 'integrityFile']) present(name);
  // Each opponent is optional so one can be installed without the other.
  if (config.laplacePython !== undefined) present('laplacePython');
  if (config.foulPlayPython !== undefined || config.foulPlaySource !== undefined) {
    present('foulPlayPython');
    present('foulPlaySource');
  }
  if (!config.laplacePython && !config.foulPlayPython) throw new Error('Bot configuration installs no opponent');
  return config;
}

function runtimeOptions(config, workspace) {
  return {
    root: config.root,
    scripts: path.join(workspace, 'scripts/laplace'),
    python: config.laplacePython,
    laplace: Boolean(config.laplacePython),
    ...(config.portable ? { installed: () => fs.existsSync(config.integrityFile) } : {}),
    verify: root => {
      const controller = new AbortController();
      const base = config.portable ? null : verifyInWorker(root);
      return { cancel() { controller.abort(); base?.cancel(); },
        // A Windows Laplace-only setup records no extra files; its runtime has its own manifest.
        promise: (async () => ({ ok: (!base || (await base.promise).ok) &&
          (!config.portable && !config.foulPlayPython || await verifyInventory(config.integrityFile, controller.signal)) }))() };
    },
    foulPlay: config.foulPlayPython ? { python: config.foulPlayPython, source: config.foulPlaySource,
      runner: path.join(workspace, 'scripts/bots/foulplay.py') } : null,
  };
}

module.exports = { readBotConfig, runtimeOptions };
