'use strict';

// Home hub. Reads state from the hidden Showdown client and sends it actions; the
// battle itself always happens in the client on the Play screen.

const $ = (id) => document.getElementById(id);
const els = {
  account: $('account'),
  heroFormat: $('hero-format'),
  heroSub: $('hero-sub'),
  heroStats: $('hero-stats'),
  format: $('format'),
  team: $('team'),
  battle: $('battle'),
  challengeToggle: $('challenge-toggle'),
  challengeForm: $('challenge-form'),
  challengeUser: $('challenge-user'),
  teamGrid: $('team-grid'),
  teamName: $('team-name'),
  tileTeams: $('tile-teams'),
  tileBattles: $('tile-battles'),
  news: $('news'),
  rooms: $('rooms'),
  friends: $('friends'),
};

let state = { ready: false };
// Session polling is the freshest source for connection state. Until the first
// usable session arrives, show loading rather than claiming the socket is lost.
let sessionReady = false;
let sessionConnected = false;
let formatsKey = '';
let teamsKey = '';
let searching = false;
let searchRequested = false;
let lastPopups = null;
let searchClickedAt = 0;
// When the current search began, for the elapsed timer on the button.
let searchSince = 0;

function tickSearch() {
  if (!searchSince) return;
  const seconds = Math.floor((Date.now() - searchSince) / 1000);
  els.battle.querySelector('.search-time').textContent =
    `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
setInterval(tickSearch, 1000);

// Per-viewer conveniences only; the page works without them.
const prefs = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function num(n) {
  return n === null || n === undefined ? '–' : n.toLocaleString('en-US');
}

function toPlay() {
  location.href = 'play.html';
}

// Most actions open something in the client, so they switch to it. Background actions
// (search, cancel) only switch when the client needs the user, such as a login prompt.
async function act(action, args, { show = true } = {}) {
  const result = await window.desktop.showdown(action, args);
  if (result === 'needs-client' || (result && show)) toPlay();
  return result;
}

function currentFormat() {
  return state.formats.find((f) => f.id === els.format.value) || null;
}

function teamsFor(formatId) {
  return state.teams.filter((t) => t.format === formatId);
}

function renderFormats() {
  const key = state.formats.map((f) => f.id).join();
  if (key === formatsKey) return;
  formatsKey = key;

  const wanted = els.format.value || prefs.get('hub.format') || state.currentFormat;
  els.format.replaceChildren();
  const groups = new Map();
  for (const f of state.formats) {
    if (!groups.has(f.section)) {
      const group = el('optgroup');
      group.label = f.section || 'Other';
      groups.set(f.section, group);
      els.format.append(group);
    }
    const option = el('option', null, f.name);
    option.value = f.id;
    groups.get(f.section).append(option);
  }
  if (state.formats.some((f) => f.id === wanted)) els.format.value = wanted;
  els.format.disabled = false;
  teamsKey = '';
}

function renderTeams() {
  const format = currentFormat();
  const key = `${format && format.id}|${state.teams.map((t) => `${t.index}:${t.name}:${t.format}`).join()}`;
  if (key === teamsKey) return;
  teamsKey = key;

  els.team.replaceChildren();
  if (!format) return;
  if (format.presetTeam) {
    els.team.append(el('option', null, 'Team is provided'));
    els.team.disabled = true;
    return;
  }
  const matching = teamsFor(format.id);
  const others = state.teams.filter((t) => t.format !== format.id);
  const add = (parent, t) => {
    const option = el('option', null, t.name || 'Untitled team');
    option.value = String(t.index);
    parent.append(option);
  };
  if (!state.teams.length) {
    els.team.append(el('option', null, 'No teams yet'));
    els.team.disabled = true;
    return;
  }
  matching.forEach((t) => add(els.team, t));
  if (others.length) {
    const group = el('optgroup');
    group.label = 'Other formats';
    others.forEach((t) => add(group, t));
    els.team.append(group);
  }
  const saved = prefs.get(`hub.team.${format.id}`);
  if (saved && state.teams.some((t) => String(t.index) === saved)) els.team.value = saved;
  els.team.disabled = false;
}

function selectedTeam() {
  const format = currentFormat();
  if (!format || format.presetTeam || els.team.disabled) return null;
  return state.teams.find((t) => String(t.index) === els.team.value) || null;
}

function renderHero() {
  const format = currentFormat();
  els.heroFormat.textContent = format ? format.name : 'Pokémon Showdown';

  const rating = format && state.ratings && state.ratings[format.id];
  if (!state.user.registered) {
    els.heroSub.textContent = 'Playing as a guest. Sign in on Showdown to keep a ladder rating.';
  } else if (rating) {
    els.heroSub.textContent = `Ladder rating ${rating}`;
  } else {
    els.heroSub.textContent = 'Unrated in this format';
  }

  els.heroStats.replaceChildren(
    el('strong', 'num', num(state.counts.users)), document.createTextNode(' online'), el('br'),
    el('strong', 'num', num(state.counts.battles)), document.createTextNode(' battles'),
  );

  const team = selectedTeam();
  // Rebuild only when the team changes, so the searching animation is not restarted.
  const gridKey = format && format.presetTeam ? 'preset' : team ? team.sprites.join() : 'none';
  if (els.teamGrid.dataset.key !== gridKey) {
    els.teamGrid.dataset.key = gridKey;
    els.teamGrid.replaceChildren();
    for (let i = 0; i < 6; i++) {
      const src = team && team.sprites[i];
      if (src) {
        const img = el('img');
        img.src = src;
        img.alt = '';
        els.teamGrid.append(img);
      } else {
        els.teamGrid.append(el('span', 'hero-team-slot', format && format.presetTeam ? '?' : ''));
      }
    }
  }
  els.teamName.textContent = format && format.presetTeam ? 'Random team' : team ? team.name || 'Untitled team' : 'No team selected';

  const needsTeam = format && !format.presetTeam && !team;
  els.battle.disabled = searching || !format || !sessionReady || !sessionConnected;
  if (searching && !searchSince) searchSince = Date.now();
  if (!searching) searchSince = 0;
  els.battle.classList.toggle('is-searching', searching);
  els.battle.querySelector('.battle-label').textContent = searching ? 'Searching' : 'Battle!';
  els.battle.setAttribute('aria-label', searching ? 'Searching for an opponent' : 'Battle!');
  $('hero-kicker').textContent = searching ? 'Searching for an opponent' : 'Ready to battle';
  els.battle.closest('.hero').classList.toggle('is-searching', searching);
  tickSearch();
  els.battle.title = needsTeam ? 'Build or import a team for this format first' : '';
  $('cancel-search').hidden = !searching;
  els.format.disabled = searching || !state.formats.length;
  if (searching) els.challengeForm.hidden = true;
  els.challengeToggle.hidden = searching || !els.challengeForm.hidden;
  els.challengeToggle.disabled = !format || !sessionReady || !sessionConnected;
  els.challengeUser.disabled = !sessionReady || !sessionConnected;
  const challengeSubmit = els.challengeForm.querySelector('[type="submit"]');
  if (challengeSubmit) challengeSubmit.disabled = !sessionReady || !sessionConnected;
}

function renderNews() {
  if (!state.news.length) {
    els.news.replaceChildren(el('div', 'empty', 'No news loaded yet.'));
    return;
  }
  els.news.replaceChildren(...state.news.map((n) => {
    const card = el('a', 'news-card');
    card.href = n.id ? `https://pokemonshowdown.com/news/${n.id}` : 'https://pokemonshowdown.com/news';
    const date = n.date ? new Date(n.date * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    card.append(
      el('span', 'news-meta', [n.author, date].filter(Boolean).join(' · ')),
      el('span', 'news-title', n.title),
      el('span', 'news-text', n.text),
    );
    return card;
  }));
}

function renderRooms() {
  const rooms = [...state.rooms].sort((a, b) => (b.users || 0) - (a.users || 0)).slice(0, 9);
  if (!rooms.length) {
    els.rooms.replaceChildren(el('div', 'empty', 'Room list not loaded yet.'));
    return;
  }
  els.rooms.replaceChildren(...rooms.map((r) => {
    const link = el('a', 'room-card');
    link.href = '#';
    link.dataset.room = r.title.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const head = el('span', 'room-card-head');
    head.append(el('span', 'room-card-title', r.title), el('span', 'room-card-users num', `${num(r.users)} users`));
    link.append(head, el('span', 'room-card-desc', r.desc));
    return link;
  }));
}

function renderAccount() {
  if (!sessionReady) {
    els.account.className = 'status status--warn';
    els.account.textContent = 'Connecting to Showdown…';
  } else if (!sessionConnected) {
    els.account.className = 'status status--warn';
    els.account.textContent = 'Connection lost. Reconnecting…';
  } else if (state.user.registered) {
    els.account.className = 'status status--ok';
    els.account.textContent = `Signed in as ${state.user.name}`;
  } else {
    els.account.className = 'status status--off';
    els.account.textContent = 'Guest';
  }
}

function renderFriends() {
  const box = el('div', 'friends-note');
  if (state.user.registered) {
    box.append(
      el('p', null, 'Your Showdown friends list opens in the client, where you can see who is online and send challenges.'),
    );
    const button = el('button', 'btn', 'Open friends list');
    button.type = 'button';
    button.addEventListener('click', () => act('friends'));
    box.append(button);
  } else {
    box.append(el('p', null, 'Sign in to Showdown to see your friends and who is online.'));
    const button = el('button', 'btn btn-primary', 'Sign in');
    button.type = 'button';
    button.addEventListener('click', () => act('login'));
    box.append(button);
  }
  const key = state.user.registered ? 'in' : 'out';
  if (els.friends.dataset.key !== key) {
    els.friends.dataset.key = key;
    els.friends.replaceChildren(box);
  }
}

function render() {
  if (!state.ready) return;
  renderAccount();
  renderFormats();
  renderTeams();
  renderHero();
  els.tileTeams.textContent = state.teams.length ? `${state.teams.length} team${state.teams.length === 1 ? '' : 's'}` : 'Build and import teams';
  els.tileBattles.textContent = state.counts.battles !== null ? `${num(state.counts.battles)} live now` : 'Live battles';
  renderNews();
  renderRooms();
  renderFriends();
}

async function refresh() {
  try {
    state = await window.desktop.getShowdown();
  } catch {
    state = { ready: false };
  }
  render();
  setTimeout(refresh, state.ready ? 10000 : 2000);
}

els.format.addEventListener('change', () => {
  prefs.set('hub.format', els.format.value);
  teamsKey = '';
  renderTeams();
  renderHero();
});

els.team.addEventListener('change', () => {
  const format = currentFormat();
  if (format) prefs.set(`hub.team.${format.id}`, els.team.value);
  renderHero();
});

els.battle.addEventListener('click', () => {
  if (!sessionReady || !sessionConnected) return;
  const format = currentFormat();
  if (!format) return;
  const team = selectedTeam();
  // An empty team still goes through: the client explains what is missing.
  searching = true;
  searchRequested = true;
  searchClickedAt = Date.now();
  renderHero();
  act('search', { format: format.id, team: team ? team.index : null }, { show: false }).then((result) => {
    if (!result || result === 'needs-client') {
      searching = false;
      searchRequested = false;
      renderHero();
    }
  });
});

els.challengeToggle.addEventListener('click', () => {
  if (!sessionReady || !sessionConnected) return;
  els.challengeToggle.hidden = true;
  els.challengeForm.hidden = false;
  els.challengeUser.focus();
});

$('challenge-cancel').addEventListener('click', () => {
  els.challengeForm.hidden = true;
  els.challengeToggle.hidden = false;
});

els.challengeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!sessionReady || !sessionConnected) return;
  const user = els.challengeUser.value.trim();
  const format = currentFormat();
  if (user && format) act('challenge', { user, format: format.id });
});

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-room]');
  if (!link) return;
  event.preventDefault();
  act('join', { room: link.dataset.room });
});

// Fed by nav.js, which already polls the client's open rooms.
let liveBattle = null;
document.addEventListener('showdown-session', (event) => {
  const session = event.detail;
  sessionReady = Boolean(session.ready);
  sessionConnected = Boolean(session.ready && session.connected);
  if (state.ready) {
    renderAccount();
    renderHero();
  }
  // Search state comes from the client, so it stays right across pages and restarts.
  const active = Boolean(session.search && (session.search.pending || session.search.formats.length > 0));
  if (session.ready) {
    // A popup during a search is the server or client asking the user something.
    if (searchRequested && lastPopups !== null && session.popups > lastPopups) toPlay();
    lastPopups = session.popups;
    // A poll that left before the click reached the client would wrongly end the search.
    const settling = Date.now() - searchClickedAt < 2000;
    if (active !== searching && !(searching && settling)) {
      searching = active;
      if (!searching) searchRequested = false;
      if (state.ready) renderHero();
    }
  }
  liveBattle = session.rooms.find((r) => r.battle && !r.ended) || null;
  $('live-battle').hidden = !liveBattle;
  if (!liveBattle) return;
  const [p1, p2] = liveBattle.players;
  const opponent = session.me === p1 ? p2 : session.me === p2 ? p1 : null;
  const who = opponent ? `vs. ${opponent}` : `${p1} vs. ${p2}`;
  $('live-battle-text').textContent = `Battle in progress ${who}` + (liveBattle.format ? ` · ${liveBattle.format}` : '');
});
$('cancel-search').addEventListener('click', () => {
  act('cancel-search', {}, { show: false });
  searching = false;
  searchRequested = false;
  renderHero();
});

$('live-battle-return').addEventListener('click', () => {
  if (liveBattle) act('join', { room: liveBattle.id });
});

refresh();
