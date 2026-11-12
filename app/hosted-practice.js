'use strict';

const { EventEmitter } = require('node:events');

function serviceUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new Error('Battle service requires an HTTPS origin (or HTTP on 127.0.0.1).');
  }
  return url.origin;
}

class HostedPractice extends EventEmitter {
  constructor({ url, key, fetcher = fetch, intervalMs = 1000 }) {
    super();
    this.origin = serviceUrl(url);
    this.key = key;
    this.fetcher = fetcher;
    this.generation = 0;
    this.session = null;
    this.battle = null;
    this.value = { installed: false, state: 'idle', opponents: [], error: '', hosted: true };
    this.timer = setInterval(() => this.refresh(), intervalMs);
    this.timer.unref();
    this.refresh();
  }

  status() { return { ...this.value, battle: this.battle }; }
  changed() { this.emit('change', this.status()); }

  async request(route, method = 'GET', body) {
    const response = await this.fetcher(`${this.origin}${route}`, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${this.key || ''}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Battle server is full. Try again shortly.' : 'Battle service unavailable. Check its address and access key.');
    const raw = await response.text();
    if (raw.length > 65536) throw new Error('Invalid battle service response.');
    return JSON.parse(raw);
  }

  async refresh() {
    if (this.polling || this.creating) return;
    this.polling = true;
    const generation = this.generation;
    try {
      if (!this.session) {
        const catalog = await this.request('/v1/bots');
        if (generation !== this.generation) return;
        this.value.opponents = catalog.opponents;
        this.value.installed = catalog.opponents?.some(bot => bot.available) === true;
        if (this.value.state === 'idle') this.value.error = '';
      } else {
        const value = await this.request(`/v1/sessions/${this.session}`);
        if (generation !== this.generation) return;
        this.battle = value.battle;
        this.value = { ...this.value, state: value.state, error: value.error || '', preset: value.preset, opponent: value.opponent };
        if (value.state === 'ready' && !this.connection) {
          this.connection = { token: this.session, human: 'Player', bot: value.opponent === 'foulplay' ? 'FoulPlay' : 'Laplace',
            clientUrl: `${this.origin}/s/${this.session}/practice-client.html`,
            serviceOrigin: this.origin,
            socketUrl: `${this.origin.replace(/^http/, 'ws')}/s/${this.session}/websocket` };
          this.emit('ready', this.connection);
        }
        if (value.state === 'failed') { this.emit('failure', 'start'); await this.release(); }
      }
      this.changed();
    } catch (error) {
      if (generation !== this.generation) return;
      this.value.error = error.message;
      this.value.installed = false;
      if (this.session) {
        this.value.state = 'failed';
        this.emit('failure', 'connection');
        await this.release();
      }
      this.changed();
    } finally { this.polling = false; }
  }

  async start(options) {
    if (this.session || this.creating) return { ok: false, error: 'Stop the current session first.' };
    if (typeof options === 'string') options = { opponent: 'laplace', preset: options };
    if (!options || !['laplace', 'foulplay'].includes(options.opponent) || !['quiet', 'balanced', 'full'].includes(options.preset)) return { ok: false, error: 'Choose an opponent and computation setting.' };
    const generation = ++this.generation;
    this.creating = true;
    this.value = { ...this.value, state: 'starting', error: '', ...options };
    this.battle = null;
    this.changed();
    try {
      const value = await this.request('/v1/sessions', 'POST', options);
      if (!/^[a-f0-9]{64}$/.test(value.id)) throw new Error('Invalid battle session.');
      if (generation !== this.generation) {
        await this.request(`/v1/sessions/${value.id}`, 'DELETE').catch(() => {});
        return { ok: false, cancelled: true };
      }
      this.session = value.id;
      return { ok: true };
    } catch (error) {
      if (generation === this.generation) { this.value.state = 'failed'; this.value.error = error.message; this.changed(); }
      return { ok: false, error: error.message };
    } finally { this.creating = false; }
  }

  async release() {
    const id = this.session;
    this.session = null;
    this.connection = null;
    if (id) await this.request(`/v1/sessions/${id}`, 'DELETE').catch(() => {});
  }

  stop() {
    ++this.generation;
    const releasing = this.release();
    this.battle = null;
    this.value.state = 'idle';
    this.value.error = '';
    this.changed();
    return releasing.then(() => ({ ok: true }));
  }

  clientFailed(token) {
    if (this.connection?.token !== token) return;
    this.stop();
    this.value.state = 'failed';
    this.value.error = 'The battle client disconnected. Start a new session.';
    this.changed();
  }

  dispose() { clearInterval(this.timer); return this.stop(); }
}

module.exports = { HostedPractice, serviceUrl };
