'use strict';

// Reads state from, and sends a fixed set of actions to, the official client's page.
// The functions below are serialized and run inside play.pokemonshowdown.com, so they may
// only use that page's globals (app, Storage, BattleFormats, Dex). Arguments are passed
// as JSON, never spliced into code as strings.

const { net } = require('electron');

const SHOWDOWN = 'https://play.pokemonshowdown.com/';
const ID = /^[a-z0-9]{1,80}$/;
const ROOM_ID = /^[a-z0-9-]{1,80}$/;
const SPRITE = /^sprites\/[a-z0-9-]+\/[a-z0-9-]+$/;
const RATINGS_TTL = 2 * 60 * 1000;

const isId = (value) => typeof value === 'string' && ID.test(value);

/* eslint-disable no-undef -- these run in the Showdown page */
function readClient() {
  if (!window.app || !app.rooms || !app.rooms[''] || !window.BattleFormats || !window.Storage) {
    return { ready: false };
  }
  const text = (el) => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
  const sprite = (set) => {
    try {
      const d = Dex.getTeambuilderSpriteData(set);
      return d.spriteDir + '/' + d.spriteid;
    } catch (e) {
      return null;
    }
  };
  const teams = (Storage.teams || []).map((t, index) => {
    let sets = [];
    try {
      sets = Storage.unpackTeam(t.team) || [];
    } catch (e) {}
    return { index, name: t.name, format: t.format, sprites: sets.slice(0, 6).map(sprite) };
  });
  const rd = app.roomsData || {};
  const news = [...document.querySelectorAll('.newsentry')].slice(0, 3).map((n) => {
    const paras = [...n.querySelectorAll('p')];
    const byline = paras.length > 1 ? paras.pop() : null;
    return {
      id: n.dataset.newsid,
      date: Number(n.dataset.date),
      title: text(n.querySelector('h4')),
      text: paras.map(text).join(' '),
      author: text(byline && byline.querySelector('strong')),
    };
  });
  return {
    ready: true,
    connected: !app.isDisconnected,
    user: { name: app.user.get('name'), userid: app.user.get('userid'), registered: !!app.user.get('registered') },
    counts: { users: rd.userCount, battles: rd.battleCount },
    currentFormat: app.rooms[''].curFormat,
    formats: Object.values(BattleFormats)
      .filter((f) => f.searchShow)
      .map((f) => ({ id: f.id, name: f.name, section: f.section, presetTeam: !!f.team })),
    teams,
    news,
    rooms: (rd.chat || []).map((r) => ({ title: r.title, desc: r.desc, users: r.userCount, section: r.section })),
  };
}

// Open rooms for the rail and the Home "return to battle" banner. Cheap enough to poll.
function readSession() {
  if (!window.app || !app.rooms || !app.user) return null;
  const me = app.user.get('name');
  const rooms = Object.keys(app.rooms)
    .filter((id) => id && id !== 'rooms')
    .map((id) => {
      const room = app.rooms[id];
      const battle = room.battle;
      return {
        id,
        title: room.title || id,
        battle: id.startsWith('battle-'),
        players: battle ? [battle.p1 && battle.p1.name, battle.p2 && battle.p2.name] : [],
        format: battle ? battle.tier : '',
        ended: Boolean(battle && battle.ended),
      };
    });
  const menu = app.rooms[''];
  const searching = menu && menu.searching;
  return {
    me,
    rooms,
    current: app.curRoom ? app.curRoom.id : '',
    connected: !app.isDisconnected,
    // "pending" covers the client's short delay between sending the team and /search.
    search: {
      pending: Boolean(menu && menu.$('.mainmenu p.cancel').length),
      formats: (Array.isArray(searching) ? searching : searching ? [searching] : []).map((s) => s.format || s),
    },
    popups: app.popups ? app.popups.length : 0,
  };
}

// Drives the main menu's own search form so login prompts, team checks and cancel all
// behave exactly as if the user had clicked Battle! in the client.
function search(format, teamIndex) {
  const menu = app.rooms[''];
  app.focusRoom('');
  const $form = menu.$('.mainmenu button.big[name=search]').closest('form');
  if (!$form.length) return false;
  $form.find('button[name=format]').replaceWith(menu.renderFormats(format));
  $form.find('button[name=team]').replaceWith(menu.renderTeams(format, teamIndex));
  // renderTeams coerces an empty index to 0. Preserve "no team selected" so
  // the client's own search handler can show its missing-team prompt.
  if (teamIndex === null && !BattleFormats[format].team) {
    $form.find('button[name=team]').val('');
  }
  const popups = app.popups.length;
  menu.search(null, $form.find('button.big')[0]);
  // A popup means the client needs the user (login, missing team) before it can search.
  return app.popups.length > popups ? 'needs-client' : true;
}

function cancelSearch() {
  app.rooms[''].cancelSearch();
  return true;
}

function challenge(name, format) {
  app.focusRoom('');
  app.rooms[''].challenge(name, format);
  return true;
}

function join(roomid) {
  app.joinRoom(roomid);
  app.focusRoom(roomid);
  return true;
}

function login() {
  app.addPopup(LoginPopup);
  return true;
}

function friends() {
  app.focusRoom('');
  app.send('/friends');
  return true;
}

function loadShowdex(entry) {
  if (window.__SHOWDOWN_DESKTOP_SHOWDEX || window.__SD_SHOWDEX_REQUESTED) return true;
  window.__SD_SHOWDEX_REQUESTED = true;
  window.__SHOWDOWN_DESKTOP_SHOWDEX = { state: 'loading', version: '1.4.2' };
  let attempts = 0;
  const fail = () => { window.__SHOWDOWN_DESKTOP_SHOWDEX = { state: 'failed', version: '1.4.2' }; };
  const start = () => {
    if (!window.Dex || typeof Dex.gen !== 'number' || typeof Dex.forGen !== 'function' ||
        !window.app || typeof app.receive !== 'function') {
      if (++attempts >= 60) { fail(); return; }
      setTimeout(start, 1000);
      return;
    }
    const script = document.createElement('script');
    script.crossOrigin = 'anonymous';
    script.src = entry;
    script.onerror = fail;
    document.head.append(script);
    setTimeout(() => {
      if (window.__SHOWDOWN_DESKTOP_SHOWDEX.state === 'loading') fail();
    }, 60000);
  };
  start();
  return true;
}

function readShowdex() {
  const state = window.__SHOWDOWN_DESKTOP_SHOWDEX;
  // The pinned bootstrap sets this only after render; closing its room does not unload it.
  if (state && state.version === '1.4.2' && state.state === 'loaded') return 'loaded';
  return state && state.state === 'failed' ? 'failed' : 'loading';
}
/* eslint-enable no-undef */

function call(fn, ...args) {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`;
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function count(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function spriteUrl(path) {
  return typeof path === 'string' && SPRITE.test(path) ? `${SHOWDOWN}${path}.png` : null;
}

// Everything from the page is treated as untrusted and reduced to plain, bounded values.
function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || !raw.ready) return { ready: false };
  const list = (value) => (Array.isArray(value) ? value : []);
  const user = raw.user || {};
  return {
    ready: true,
    connected: Boolean(raw.connected),
    user: {
      name: str(user.name, 40),
      userid: isId(user.userid) ? user.userid : '',
      registered: Boolean(user.registered),
    },
    counts: { users: count(raw.counts && raw.counts.users), battles: count(raw.counts && raw.counts.battles) },
    currentFormat: isId(raw.currentFormat) ? raw.currentFormat : '',
    formats: list(raw.formats)
      .filter((f) => f && isId(f.id))
      .slice(0, 600)
      .map((f) => ({ id: f.id, name: str(f.name, 80), section: str(f.section, 60), presetTeam: Boolean(f.presetTeam) })),
    teams: list(raw.teams)
      .slice(0, 1000)
      .map((t) => ({
        index: count(t && t.index),
        name: str(t && t.name, 80),
        format: isId(t && t.format) ? t.format : '',
        sprites: list(t && t.sprites).slice(0, 6).map(spriteUrl),
      }))
      .filter((t) => t.index !== null),
    news: list(raw.news).slice(0, 3).map((n) => ({
      id: /^\d{1,8}$/.test(n && n.id) ? n.id : '',
      date: count(n && n.date),
      title: str(n && n.title, 120),
      text: str(n && n.text, 400),
      author: str(n && n.author, 40),
    })),
    rooms: list(raw.rooms).slice(0, 300).map((r) => ({
      title: str(r && r.title, 60),
      desc: str(r && r.desc, 200),
      users: count(r && r.users),
      section: str(r && r.section, 40),
    })),
  };
}

function sanitizeSession(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rooms)) return { ready: false, rooms: [] };
  return {
    ready: true,
    me: str(raw.me, 40),
    connected: Boolean(raw.connected),
    current: typeof raw.current === 'string' && ROOM_ID.test(raw.current) ? raw.current : '',
    search: {
      pending: Boolean(raw.search && raw.search.pending),
      formats: (raw.search && Array.isArray(raw.search.formats) ? raw.search.formats : []).filter(isId).slice(0, 10),
    },
    popups: count(raw.popups) || 0,
    rooms: raw.rooms
      .filter((r) => r && typeof r.id === 'string' && ROOM_ID.test(r.id))
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        title: str(r.title, 80),
        battle: Boolean(r.battle),
        players: (Array.isArray(r.players) ? r.players : []).slice(0, 2).map((p) => str(p, 40)),
        format: str(r.format, 80),
        ended: Boolean(r.ended),
      })),
  };
}

class ShowdownBridge {
  constructor(getContents) {
    this.getContents = getContents;
    this.ratings = new Map();
  }

  // Internal integration entry points; never accept arbitrary script URLs via IPC.
  async loadShowdex() {
    const contents = this.getContents();
    if (!contents) return false;
    try {
      return await contents.executeJavaScript(call(loadShowdex, 'showdex://assets/main.js')) === true;
    } catch { return false; }
  }

  async showdexStatus() {
    const contents = this.getContents();
    if (!contents || contents.isLoading()) return 'loading';
    try {
      const status = await contents.executeJavaScript(call(readShowdex));
      return ['loaded', 'loading', 'failed'].includes(status) ? status : 'failed';
    } catch { return 'failed'; }
  }

  async snapshot() {
    const contents = this.getContents();
    if (!contents || contents.isLoading()) return { ready: false };
    let state;
    try {
      state = sanitize(await contents.executeJavaScript(call(readClient)));
    } catch {
      return { ready: false };
    }
    if (state.ready && state.user.registered && state.user.userid) {
      state.ratings = await this.fetchRatings(state.user.userid);
    }
    return state;
  }

  async session() {
    const contents = this.getContents();
    if (!contents || contents.isLoading()) return { ready: false, rooms: [] };
    try {
      return sanitizeSession(await contents.executeJavaScript(call(readSession)));
    } catch {
      return { ready: false, rooms: [] };
    }
  }

  // Public profile endpoint; no credentials are sent.
  async fetchRatings(userid) {
    const cached = this.ratings.get(userid);
    if (cached && Date.now() - cached.at < RATINGS_TTL) return cached.value;
    const value = {};
    try {
      const res = await net.fetch(`https://pokemonshowdown.com/users/${userid}.json`, { credentials: 'omit' });
      if (res.ok) {
        const data = await res.json();
        for (const [format, r] of Object.entries((data && data.ratings) || {})) {
          const elo = count(r && r.elo);
          if (isId(format) && elo !== null) value[format] = Math.round(elo);
        }
      }
    } catch {}
    this.ratings.set(userid, { at: Date.now(), value });
    return value;
  }

  async act(action, args) {
    const contents = this.getContents();
    if (!contents || !args || typeof args !== 'object') return false;
    let code;
    switch (action) {
      case 'search': {
        const team = args.team === null ? null : args.team;
        if (!isId(args.format) || (team !== null && (!Number.isSafeInteger(team) || team < 0 || team > 9999))) return false;
        code = call(search, args.format, team);
        break;
      }
      case 'challenge': {
        const name = str(args.user, 18).trim();
        if (!name || /[\u0000-\u001f]/.test(name) || !isId(args.format)) return false;
        code = call(challenge, name, args.format);
        break;
      }
      case 'join':
        if (!(typeof args.room === 'string' && ROOM_ID.test(args.room))) return false;
        code = call(join, args.room);
        break;
      case 'cancel-search':
        code = call(cancelSearch);
        break;
      case 'login':
        code = call(login);
        break;
      case 'friends':
        code = call(friends);
        break;
      default:
        return false;
    }
    try {
      const result = await contents.executeJavaScript(code);
      // true: done in the background. 'needs-client': show the client so the user can respond.
      return result === true || result === 'needs-client' ? result : false;
    } catch {
      return false;
    }
  }
}

module.exports = { ShowdownBridge };
