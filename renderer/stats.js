'use strict';

// Stats page. Reads the signed-in user's public ladder record through the Showdown bridge.

(() => {
  const $ = (id) => document.getElementById(id);
  const head = $('stats-head');
  const body = $('stats-body');
  const filter = $('stats-filter');

  let state = { ready: false };
  let sort = { key: 'games', dir: -1 };
  let renderedKey = '';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const num = (n) => n.toLocaleString('en-US');
  const pct = (wins, games) => (games ? `${Math.round((wins / games) * 100)}%` : '–');

  function rows() {
    // Formats no longer on the ladder have no display name, so show a readable ID.
    const name = (id) => (state.formats.find((f) => f.id === id) || {}).name
      || id.replace(/^gen([1-9])(.+)$/, '[Gen $1] $2');
    const playable = new Set(state.formats.map((f) => f.id));
    return Object.entries(state.stats || {}).map(([id, r]) => {
      const games = r.wins + r.losses;
      return { id, name: name(id), ...r, games, rate: games ? r.wins / games : -1, playable: playable.has(id) };
    });
  }

  function figure(label, value, note) {
    const cell = el('div', 'stats-figure');
    cell.append(el('span', 'stats-figure-label', label), el('strong', 'num', value), el('span', 'stats-figure-note', note));
    return cell;
  }

  function renderHead(all) {
    const played = all.filter((r) => r.games);
    const wins = played.reduce((n, r) => n + r.wins, 0);
    const games = played.reduce((n, r) => n + r.games, 0);
    const best = all.reduce((top, r) => (r.elo > top.elo ? r : top));
    const most = played.reduce((top, r) => (!top || r.games > top.games ? r : top), null);
    const title = el('div', 'stats-title');
    title.append(el('span', 'hero-kicker', 'Ladder record'), el('h2', null, state.user.name));
    const figures = el('div', 'stats-figures');
    figures.append(
      figure('Battles', num(games), `${num(wins)} won · ${num(games - wins)} lost`),
      figure('Win rate', pct(wins, games), `across ${played.length} format${played.length === 1 ? '' : 's'}`),
      figure('Highest rating', String(best.elo), best.name),
      figure('Most played', most ? num(most.games) : '–', most ? most.name : 'No games yet'),
    );
    head.replaceChildren(title, figures);
    head.hidden = false;
  }

  const columns = [
    ['Format', 'name', ''],
    ['Rating', 'elo', 'col-num'],
    ['Win rate', 'rate', 'col-rate'],
    ['Wins', 'wins', 'col-num'],
    ['Losses', 'losses', 'col-num'],
    ['Battles', 'games', 'col-num'],
    ['GXE', 'gxe', 'col-num'],
  ];

  function renderTable(all) {
    const query = filter.value.trim().toLowerCase();
    const list = all.filter((r) => !query || r.name.toLowerCase().includes(query) || r.id.includes(query));
    list.sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      const order = typeof x === 'string' ? x.localeCompare(y) : (x ?? -1) - (y ?? -1);
      return order * sort.dir || b.games - a.games;
    });
    if (!list.length) {
      body.replaceChildren(el('div', 'empty', 'No formats match that filter.'));
      return;
    }
    const table = el('table', 'ladder');
    const headRow = el('tr');
    headRow.append(el('th', 'col-rank', '#'));
    for (const [label, key, cls] of columns) {
      const th = el('th', cls);
      const button = el('button', 'ladder-sort', label);
      button.type = 'button';
      button.dataset.sort = key;
      if (sort.key === key) {
        button.setAttribute('aria-pressed', 'true');
        button.append(el('span', 'ladder-arrow', sort.dir < 0 ? '▾' : '▴'));
        th.setAttribute('aria-sort', sort.dir < 0 ? 'descending' : 'ascending');
      }
      th.append(button);
      headRow.append(th);
    }
    headRow.append(el('th', 'col-play'));
    const thead = el('thead');
    thead.append(headRow);
    const tbody = el('tbody');
    list.forEach((r, i) => {
      const tr = el('tr');
      const rate = el('td', 'col-rate');
      if (r.games) {
        const wrap = el('div', 'record');
        const bar = el('div', 'record-bar');
        const won = el('span', 'record-won');
        won.style.width = `${(r.wins / r.games) * 100}%`;
        bar.append(won);
        wrap.append(bar, el('span', 'record-text num', pct(r.wins, r.games)));
        rate.append(wrap);
      } else {
        rate.append(el('span', 'unrated', 'No battles'));
      }
      const play = el('td', 'col-play');
      if (r.playable) {
        const button = el('button', 'btn', 'Play');
        button.type = 'button';
        button.dataset.play = r.id;
        button.setAttribute('aria-label', `Play ${r.name}`);
        play.append(button);
      }
      tr.append(
        el('td', 'col-rank num', String(i + 1)),
        el('td', 'ladder-format', r.name),
        el('td', 'col-num num ladder-elo', String(r.elo)),
        rate,
        el('td', 'col-num num', num(r.wins)),
        el('td', 'col-num num', num(r.losses)),
        el('td', 'col-num num', num(r.games)),
        el('td', 'col-num num', r.gxe === null ? '–' : `${r.gxe}%`),
        play,
      );
      tbody.append(tr);
    });
    table.append(thead, tbody);
    body.replaceChildren(table);
  }

  function render(force) {
    const key = JSON.stringify([state.ready, state.user, state.stats, state.formats && state.formats.length]);
    if (!force && key === renderedKey) return;
    renderedKey = key;
    filter.disabled = true;
    if (!state.ready) {
      head.hidden = true;
      body.replaceChildren(el('div', 'empty', 'Connecting to Showdown…'));
      return;
    }
    if (!state.user.registered) {
      head.hidden = true;
      const note = el('div', 'empty');
      note.append(el('p', null, 'Sign in on Showdown to see your ratings and win rates.'));
      const button = el('button', 'btn btn-primary', 'Sign in');
      button.type = 'button';
      button.addEventListener('click', async () => {
        if (await window.desktop.showdown('login', {})) location.href = 'play.html';
      });
      note.append(button);
      body.replaceChildren(note);
      return;
    }
    const all = rows();
    if (!all.length) {
      head.hidden = true;
      body.replaceChildren(el('div', 'empty', 'No ladder battles yet. Your ratings and win rates appear here after your first rated battle.'));
      return;
    }
    filter.disabled = false;
    renderHead(all);
    renderTable(all);
  }

  body.addEventListener('click', (event) => {
    const sortButton = event.target.closest('[data-sort]');
    if (sortButton) {
      const key = sortButton.dataset.sort;
      sort = { key, dir: sort.key === key ? -sort.dir : key === 'name' ? 1 : -1 };
      render(true);
      return;
    }
    const play = event.target.closest('[data-play]');
    if (!play) return;
    // Home reads this to preselect the format; nothing starts until Battle! is pressed there.
    try { localStorage.setItem('hub.format', play.dataset.play); } catch {}
    location.href = 'index.html';
  });

  filter.addEventListener('input', () => render(true));

  $('open-ladder').addEventListener('click', async () => {
    if (await window.desktop.showdown('join', { room: 'ladder' })) location.href = 'play.html';
  });

  async function refresh() {
    try {
      state = await window.desktop.getShowdown();
    } catch {
      state = { ready: false };
    }
    render(false);
    setTimeout(refresh, state.ready ? 10000 : 2000);
  }
  refresh();
})();
