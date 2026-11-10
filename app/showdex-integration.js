'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SHOWDEX_SCHEME = 'showdex';
const SHOWDEX_ENTRY_URL = 'showdex://assets/main.js';
const SHOWDOWN_ORIGIN = 'https://play.pokemonshowdown.com';
const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'showdex');
const DIST_DIR = path.join(VENDOR_DIR, 'dist');
const MANIFEST_FILE = path.join(VENDOR_DIR, 'manifest.json');
const PINNED_COMMIT = '165abdb05ad08c5b286f71e21cc1907852efd76f';
const PINNED_VERSION = '1.4.2';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Call before app.whenReady(), once alongside any other custom scheme registration.
function registerShowdexScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: SHOWDEX_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }]);
}

class ShowdexIntegration {
  constructor(options = {}) {
    this.distDir = options.distDir || DIST_DIR;
    this.manifestFile = options.manifestFile || MANIFEST_FILE;
    this.registered = false;
    this.manifest = null;
  }

  bundleInfo() {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'));
      if (manifest.commit !== PINNED_COMMIT || manifest.version !== PINNED_VERSION ||
        manifest.resourceProtocol !== SHOWDEX_SCHEME || manifest.resourcePrefix !== 'assets' ||
        !manifest.assets || typeof manifest.assets !== 'object' || Array.isArray(manifest.assets) ||
        !manifest.assets['main.js']) throw new Error('Invalid pinned Showdex manifest');
      for (const [name, expected] of Object.entries(manifest.assets)) {
        if (!SAFE_NAME.test(name) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid asset record');
        const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(this.distDir, name))).digest('hex');
        if (actual !== expected) throw new Error(`Showdex asset mismatch: ${name}`);
      }
    } catch (error) {
      this.manifest = null;
      return { installed: false, invalid: fs.existsSync(path.join(this.distDir, 'main.js')),
        version: PINNED_VERSION, error: error.message };
    }
    this.manifest = manifest;
    return { installed: true, version: PINNED_VERSION, error: '' };
  }

  // Register only on the persistent Showdown session, after app.whenReady().
  async registerAssets(session) {
    const info = this.bundleInfo();
    if (!info.installed) return info;
    if (this.registered) return info;
    if (await session.protocol.isProtocolHandled(SHOWDEX_SCHEME)) throw new Error('Showdex scheme already handled');
    session.protocol.handle(SHOWDEX_SCHEME, (request) => this.serveAsset(request));
    this.registered = true;
    return info;
  }

  serveAsset(request) {
    if (!this.manifest) return new Response(null, { status: 503 });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    let referrerOrigin = '';
    try { referrerOrigin = new URL(request.referrer).origin; } catch {}
    if (request.initiatorOrigin !== SHOWDOWN_ORIGIN &&
      (request.initiatorOrigin || referrerOrigin !== SHOWDOWN_ORIGIN)) return new Response(null, { status: 403 });
    let url;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 400 }); }
    if (url.protocol !== `${SHOWDEX_SCHEME}:` || url.hostname !== 'assets' || url.search || url.hash ||
      !/^\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.pathname)) return new Response(null, { status: 404 });
    const name = url.pathname.slice(1);
    if (!Object.hasOwn(this.manifest.assets, name)) return new Response(null, { status: 404 });
    const file = path.join(this.distDir, name);
    const headers = {
      'Access-Control-Allow-Origin': SHOWDOWN_ORIGIN,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store',
      'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
    };
    try {
      const bytes = fs.readFileSync(file);
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== this.manifest.assets[name]) return new Response(null, { status: 404 });
      return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
}

module.exports = { ShowdexIntegration, registerShowdexScheme, SHOWDEX_SCHEME, SHOWDEX_ENTRY_URL };
