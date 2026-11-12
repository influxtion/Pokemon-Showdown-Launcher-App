'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { verifyRuntime } = require('../app/practice-manifest');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'laplace');
const ADAPTER = path.join(__dirname, 'laplace');
const ADAPTER_FILES = ['runner.py', 'server.cjs'];
const CLIENT_FILES = ['practice-client.html', 'practice-client.css', 'client-bootstrap.js'];

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function fileSha(file) { return sha(fs.readFileSync(file)); }

function configuredResource({ packager }, destination) {
  const entries = [packager.config.extraResources, packager.platformSpecificBuildOptions?.extraResources].flat();
  const matches = entries.filter(entry => entry && typeof entry === 'object' && entry.to === destination);
  if (matches.length !== 1 || !matches[0].from) throw new Error(`The package must define one ${destination} resource.`);
  return path.resolve(packager.projectDir || ROOT, matches[0].from);
}

function checkedRuntime(root, failureMessage) {
  const result = verifyRuntime(root);
  if (!result.ok) throw new Error(failureMessage);
  const bytes = fs.readFileSync(path.join(root, 'manifest.json'));
  if (sha(bytes) !== result.identity) throw new Error('Practice runtime changed during verification.');
  return { manifest: JSON.parse(bytes), identity: result.identity };
}

function verifySource(manifest) {
  if (manifest.python?.lockSha256 !== fileSha(path.join(VENDOR, 'runtime-lock.json'))) {
    throw new Error('Practice runtime is out of date with runtime-lock.json. Rebuild before packaging.');
  }
  for (const name of [...ADAPTER_FILES, 'build-client.cjs']) {
    if (manifest.files[`sources/desktop-adapter/${name}`]?.sha256 !== fileSha(path.join(ADAPTER, name))) {
      throw new Error(`Practice adapter ${name} changed after the runtime build. Rebuild before packaging.`);
    }
  }
  for (const name of CLIENT_FILES) {
    const expected = fileSha(path.join(VENDOR, name));
    if (manifest.files[`sources/${name}`]?.sha256 !== expected || manifest.files[`client/${name}`]?.sha256 !== expected) {
      throw new Error(`Practice client ${name} changed after the runtime build. Rebuild before packaging.`);
    }
  }
}

function verifyAdapters(directory, manifest) {
  for (const name of ADAPTER_FILES) {
    const filename = path.join(directory, name);
    if (!fs.existsSync(filename) || !fs.lstatSync(filename).isFile() ||
        manifest.files[`sources/desktop-adapter/${name}`]?.sha256 !== fileSha(filename)) {
      throw new Error(`Practice adapter ${name} is missing or differs from the verified runtime source.`);
    }
  }
}

async function verifyPracticePackage(context) {
  const root = configuredResource(context, 'practice');
  const { manifest, identity } = checkedRuntime(root,
    'Build and verify the local runtime with npm run build:practice before packaging.');
  verifySource(manifest);
  verifyAdapters(configuredResource(context, 'practice-adapter'), manifest);
  console.log(`Practice runtime verified for packaging: ${identity}`);
}

async function verifyCopiedPracticePackage(context) {
  const resources = path.join(context.appOutDir, 'resources');
  const { manifest, identity } = checkedRuntime(path.join(resources, 'practice'),
    'The copied Practice runtime failed integrity verification.');
  const sourceManifest = path.join(configuredResource(context, 'practice'), 'manifest.json');
  if (identity !== fileSha(sourceManifest)) throw new Error('Copied Practice runtime differs from the configured source.');
  verifySource(manifest);
  const adapters = path.join(resources, 'practice-adapter');
  verifyAdapters(adapters, manifest);
  if (fs.readdirSync(adapters).length !== ADAPTER_FILES.length) throw new Error('Copied Practice adapter has unexpected files.');
  console.log(`Copied Practice runtime and adapters verified: ${identity}`);
}

module.exports = verifyPracticePackage;
module.exports.verifyCopiedPracticePackage = verifyCopiedPracticePackage;
