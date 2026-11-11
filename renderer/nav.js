'use strict';

// Rail: one row per room open in the Showdown client, so the launcher owns navigation.
// Other pages can listen for the "showdown-session" event instead of polling again.
(() => {
  const $ = (name) => document.querySelector(`[data-nav="${name}"]`);
  const list = $('rooms');
  if (!list || !window.desktop) return;
  const onPlay = !!document.body && document.body.dataset.page === 'play';
  const desktop = window.desktop;

  const svg = (d, extra = '') => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"${extra}>${d}</svg>`;
  const round = ' stroke-linejoin="round"';
  const ICONS = {
    battle: svg('<path d="M5 3.5v9l7-4.5z"/>', round),
    chat: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>', round),
    teambuilder: svg('<path d="M3 13l.5-3L10.5 3l2.5 2.5L6 12.5z"/>', round),
    other: svg('<rect x="3" y="3" width="10" height="10" rx="1.5"/>'),
    x: svg('<path d="M4 4l8 8M12 4l-8 8"/>', ' stroke-linecap="round"'),
  };

  function matchup(room, me) {
    const [p1, p2] = room.players;
    if (me && p1 === me && p2) return `vs. ${p2}`;
    if (me && p2 === me && p1) return `vs. ${p1}`;
    return p1 && p2 ? `${p1} vs. ${p2}` : room.title;
  }

  function roomSub(room) {
    if (!room.battle) return '';
    const state = room.ended ? 'Finished' : Number.isInteger(room.turn) ? `Turn ${room.turn}` : '';
    return [room.format, state].filter(Boolean).join(' · ');
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(html, className) {
    const node = make('span', className);
    node.innerHTML = html; // fixed markup above, never session data
    return node;
  }

  function go(page) {
    if (!(onPlay && page === 'play.html')) location.href = page;
  }

  // focus-room and leave-room answer 'needs-client' when the client shows its own popup
  // (such as a forfeit confirmation); the user has to see it, so we go to play.html.
  async function act(action, args) {
    try {
      return await desktop.showdown(action, args);
    } catch {
      return false;
    }
  }

  async function focusRoom(id) {
    await act('focus-room', { room: id });
    if (onPlay) pollNow();
    else go('play.html');
  }

  async function closeRoom(id) {
    const result = await act('leave-room', { room: id });
    if (result === 'needs-client') {
      go('play.html');
    } else if (result === true) {
      const session = await pollNow();
      if (onPlay && session && session.ready && session.rooms.length === 0) location.href = 'index.html';
    }
    return result;
  }

  // Fixed rail tabs. Each one says how to reach its view in the client.
  const TABS = {
    battle: { title: 'Battle', kind: 'battle', action: 'focus-room', args: { room: '' } },
    teambuilder: { title: 'Teambuilder', kind: 'teambuilder', action: 'join', args: { room: 'teambuilder' } },
  };

  async function openTab(name) {
    await act(TABS[name].action, TABS[name].args);
    if (onPlay) pollNow();
    else go('play.html');
  }

  function row({ title, sub, kind, live, unread, current, id, closable, tab }) {
    const node = make('div', `nav-item ${tab ? 'nav-tab' : 'nav-room'}${live ? ' nav-item--live' : ''}`);
    node.title = sub ? `${title} · ${sub}` : title;
    if (current) node.setAttribute('aria-current', 'page');
    const main = make('button', 'nav-room-main');
    main.type = 'button';
    main.append(icon(ICONS[kind] || ICONS.other, 'nav-room-icon'));
    const text = make('span', 'nav-room-text');
    text.append(make('span', 'nav-room-title nav-label', title));
    if (sub) text.append(make('span', 'nav-room-sub', sub));
    main.append(text);
    if (unread) {
      const dot = make('span', 'nav-unread');
      dot.title = 'New activity';
      main.append(dot);
    }
    main.addEventListener('click', () => (tab ? openTab(tab) : focusRoom(id)));
    node.append(main);
    if (closable) {
      const close = make('button', 'rail-icon-btn nav-close');
      close.type = 'button';
      close.setAttribute('aria-label', `Close ${title}`);
      close.title = `Close ${title}`;
      close.append(icon(ICONS.x));
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeRoom(id);
      });
      node.append(close);
    }
    return node;
  }

  let lastKey = null;

  function render(session) {
    const rooms = session.rooms;
    const current = typeof session.current === 'string' ? session.current : '';
    const me = session.me || '';
    const menuCurrent = current === '' || current === 'rooms';
    const tabRow = (tab, isCurrent, unread) => ({
      title: TABS[tab].title, kind: TABS[tab].kind, tab, unread, current: onPlay && isCurrent,
    });
    const roomRow = (r) => ({
      title: r.battle ? matchup(r, me) : r.title, sub: roomSub(r), kind: r.battle ? 'battle' : r.kind,
      live: !!r.battle && !r.ended, unread: !!r.unread, id: r.id, closable: true,
      current: onPlay && r.id === current,
    });
    // The Teambuilder tab stands in for its room, so it never gets a row of its own.
    const rows = [
      tabRow('battle', menuCurrent, !!session.menuUnread),
      tabRow('teambuilder', current === 'teambuilder', rooms.some((r) => r.id === 'teambuilder' && r.unread)),
      ...rooms.filter((r) => r.id !== 'teambuilder').map(roomRow),
    ];
    // Rebuild only on change so hover and focus survive each poll.
    const key = JSON.stringify([rows, !!session.ready, me, !!session.named]);
    if (key === lastKey) return;
    lastKey = key;
    list.replaceChildren(...rows.map(row));
    const box = $('account');
    if (box) {
      box.hidden = !session.ready || !me;
      $('me').textContent = me;
      $('sign-in').hidden = !!session.named;
    }
  }

  $('showdown').addEventListener('click', (event) => {
    event.preventDefault();
    focusRoom('');
  });
  $('join').addEventListener('click', async () => {
    await act('join', { room: 'rooms' });
    if (onPlay) pollNow();
    else go('play.html');
  });
  $('sign-in').addEventListener('click', async (event) => {
    event.preventDefault();
    await act('login', {});
    go('play.html');
  });

  // Keep the baseline across launcher pages; a battle can start during navigation.
  let known = null;
  let knownMe = '';
  const knownKey = 'showdown.knownRooms';

  function savedRooms(me) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(knownKey));
      if (saved && saved.me === me && Array.isArray(saved.ids)) {
        return new Set(saved.ids.filter((id) => typeof id === 'string'));
      }
    } catch {}
    return null;
  }

  function saveRooms(me) {
    try {
      sessionStorage.setItem(knownKey, JSON.stringify({ me, ids: [...known].slice(-100) }));
    } catch {}
  }

  function battleStarted(session) {
    const mine = session.rooms.filter((r) => r.battle && !r.ended && session.me && r.players.includes(session.me));
    if (known === null || knownMe !== session.me) {
      knownMe = session.me;
      known = savedRooms(knownMe);
      if (known === null) {
        // An unresolved battle can have been created just before this first poll.
        known = new Set(session.rooms
          .filter((r) => !r.battle || r.ended || (r.players.length === 2 && r.players.every(Boolean)))
          .map((r) => r.id));
        saveRooms(knownMe);
        return false;
      }
    }
    const started = mine.some((r) => !known.has(r.id));
    // A battle room is created before its player names arrive. Wait to classify it
    // so an early poll cannot suppress the later player match.
    session.rooms.forEach((r) => {
      if (!r.battle || r.ended || (r.players.length === 2 && r.players.every(Boolean))) known.add(r.id);
    });
    saveRooms(knownMe);
    return started;
  }

  let timer = null;
  let inflight = null;

  // Resolves with the session just read; overlapping calls share one read.
  function pollNow() {
    clearTimeout(timer);
    if (!inflight) inflight = update().finally(() => { inflight = null; });
    return inflight;
  }

  async function update() {
    let session;
    try {
      session = await desktop.getSession();
    } catch {
      session = null;
    }
    if (!session || !Array.isArray(session.rooms)) session = { ready: false, rooms: [] };
    render(session);
    if (session.ready && battleStarted(session) && !onPlay) {
      location.href = 'play.html';
      return session;
    }
    document.dispatchEvent(new CustomEvent('showdown-session', { detail: session }));
    const searching = session.search && (session.search.pending || session.search.formats.length > 0);
    timer = setTimeout(pollNow, onPlay || searching ? 1000 : 3000);
    return session;
  }

  window.showdownNav = { matchup, closeRoom, pollNow };
  pollNow();
})();
