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

  // Battles already known when this page loaded. Only a battle that appears later, with
  // the user as a player, means a search or challenge just turned into a game.
  let known = null;

  function battleStarted(session) {
    const mine = session.rooms.filter((r) => r.battle && !r.ended && session.me && r.players.includes(session.me));
    if (known === null) {
      known = new Set(session.rooms.map((r) => r.id));
      return false;
    }
    const started = mine.some((r) => !known.has(r.id));
    session.rooms.forEach((r) => known.add(r.id));
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
