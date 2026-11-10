'use strict';

// The Showdown rail item appears only while something is open in the client, and a live
// battle takes over its label. play.html always shows it. Other pages can listen for the
// "showdown-session" event instead of polling again.
(() => {
  const item = document.querySelector('[data-nav="showdown"]');
  if (!item || !window.desktop) return;
  const label = item.querySelector('.nav-label');
  const hint = item.querySelector('.nav-hint');
  const onPlay = item.getAttribute('aria-current') === 'page';

  function matchup(room, me) {
    const [p1, p2] = room.players;
    if (me && p1 === me && p2) return `vs. ${p2}`;
    if (me && p2 === me && p1) return `vs. ${p1}`;
    return p1 && p2 ? `${p1} vs. ${p2}` : room.title;
  }

  function render(session) {
    const live = session.rooms.filter((r) => r.battle && !r.ended);
    item.hidden = !onPlay && session.rooms.length === 0;
    item.classList.toggle('nav-item--live', live.length > 0);
    if (live.length === 1) {
      label.textContent = `Battle · ${matchup(live[0], session.me)}`;
      hint.textContent = '';
      item.title = `${live[0].format} · ${matchup(live[0], session.me)}`;
    } else if (live.length > 1) {
      label.textContent = 'Battles';
      hint.textContent = String(live.length);
      item.title = `${live.length} battles in progress`;
    } else {
      label.textContent = 'Showdown';
      hint.textContent = session.rooms.length ? String(session.rooms.length) : '';
      item.title = session.rooms.map((r) => r.title).join(', ');
    }
  }

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

  async function update() {
    let session;
    try {
      session = await window.desktop.getSession();
    } catch {
      session = { ready: false, rooms: [] };
    }
    render(session);
    if (session.ready && battleStarted(session) && !onPlay) {
      location.href = 'play.html';
      return;
    }
    document.dispatchEvent(new CustomEvent('showdown-session', { detail: session }));
    const searching = session.search && (session.search.pending || session.search.formats.length > 0);
    setTimeout(update, searching ? 1000 : 3000);
  }

  update();
})();
