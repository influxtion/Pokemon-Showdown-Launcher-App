'use strict';

// Reads state from, and sends a fixed set of actions to, the official client's page.
// The functions below are serialized and run inside play.pokemonshowdown.com, so they may
// only use that page's globals (app, Storage, BattleFormats, Dex). Arguments are passed
// as JSON, never spliced into code as strings.

const { net } = require('electron');

const SHOWDOWN = 'https://play.pokemonshowdown.com/';
const ID = /^[a-z0-9]{1,80}$/;
const ROOM_ID = /^[a-z0-9-]{1,80}$/;
const BATTLE_FORMAT = /^battle-([a-z0-9]{1,60})-\d/;
const ROOM_KINDS = ['battle', 'chat', 'teambuilder', 'ladder', 'battles'];
const SPRITE = /^sprites\/[a-z0-9-]+\/[a-z0-9-]+$/;
const RATINGS_TTL = 2 * 60 * 1000;
const FRIENDS_TTL = 30 * 1000;
const FRIENDS_FAILURE_TTL = 5 * 1000;
const FRIENDS_TIMEOUT = 4500;

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
// It also decides whether the launcher may replace the client's own header and tabs: the
// "sd-launcher-shell" class (see client-shell.css) is set only after a complete read by a
// client that still has the room controls the rail drives. If Showdown changes, the class
// is withdrawn and the client's own navigation comes back.
function readSession() {
  const root = window.document && document.documentElement;
  const setShell = (on) => { if (root && root.classList) root.classList.toggle('sd-launcher-shell', on); };
  try {
    if (!window.app || !app.rooms || !app.user) {
      setShell(false);
      return null;
    }
    const capable = Boolean(root && root.classList && app.curRoom && document.getElementById('header') &&
      ['updateLayout', 'focusRoom', 'leaveRoom', 'joinRoom', 'addPopup'].every((name) => typeof app[name] === 'function'));
    const me = app.user.get('name');
    const kinds = ['battle', 'chat', 'teambuilder', 'ladder', 'battles'];
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
          kind: kinds.includes(room.type) ? room.type : 'other',
          turn: battle ? battle.turn : null,
          unread: Boolean(room.notifications),
        };
      });
    const menu = app.rooms[''];
    const searching = menu && menu.searching;
    const state = {
      me,
      named: Boolean(app.user.get('named')),
      menuUnread: Boolean(menu && menu.notifications),
      menuTab: root && root.classList && root.classList.contains('sd-menu-community') ? 'community' : 'battle',
      rooms,
      current: app.curRoom ? app.curRoom.id : '',
      connected: !app.isDisconnected,
      // "pending" covers the client's short delay between sending the team and /search.
      search: {
        pending: Boolean(menu && menu.$('.mainmenu p.cancel').length),
        formats: (Array.isArray(searching) ? searching : searching ? [searching] : []).map((s) => s.format || s),
      },
      popups: app.popups ? app.popups.length : 0,
      shell: capable,
    };
    // The rail replaces the client's tabs, so show one room at a time. This is a runtime
    // flag only; the user's saved layout preference is left alone.
    if (capable && !app.singlePanelMode) {
      app.singlePanelMode = true;
      app.updateLayout();
    }
    setShell(capable);
    return state;
  } catch (error) {
    setShell(false);
    return null;
  }
}

// The server's /cmd friends response is structured data, unlike the /friends HTML page.
function readFriends(expectedUserid, timeout) {
  if (!window.app || !app.user || !app.user.get('registered') ||
      app.user.get('userid') !== expectedUserid || app.isDisconnected ||
      window.__SD_FRIENDS_TIMED_OUT ||
      typeof app.once !== 'function' || typeof app.off !== 'function' || typeof app.send !== 'function') return null;
  return new Promise((resolve) => {
    let finished = false;
    let timer;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      app.off('response:friends', onResponse);
      resolve(app.user.get('userid') === expectedUserid ? value : null);
    };
    const onResponse = (value) => finish(value);
    app.once('response:friends', onResponse);
    timer = setTimeout(() => {
      // A late untagged reply could otherwise be mistaken for the next account's list.
      window.__SD_FRIENDS_TIMED_OUT = true;
      finish(null);
    }, timeout);
    try { app.send('/cmd friends'); } catch { finish(null); }
  });
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

// Battle and Community are two views of the one main menu room; client-shell.css filters it.
function showMenu(tab) {
  document.documentElement.classList.toggle('sd-menu-community', tab === 'community');
  app.focusRoom('');
  return true;
}

function focusRoom(roomid) {
  if (!app.rooms[roomid]) return false;
  app.focusRoom(roomid);
  return true;
}

// Goes through the client's own leave path, so a player's live battle still gets the
// forfeit confirmation rather than being closed from outside.
function leaveRoom(roomid) {
  if (!app.rooms[roomid]) return true;
  return app.leaveRoom(roomid) ? true : 'needs-client';
}

function openSounds() {
  app.addPopup(SoundsPopup);
  return true;
}

function openOptions() {
  app.addPopup(OptionsPopup);
  return true;
}

function editTeam(index, name, format) {
  app.joinRoom('teambuilder');
  app.focusRoom('teambuilder');
  const room = app.rooms.teambuilder;
  // Keep unfinished set/import edits intact; the user can return to the list normally.
  if (!room || room.curTeam || room.exportMode || typeof room.edit !== 'function' || index === null) return true;
  const team = Storage.teams && Storage.teams[index];
  // Home is polled: a deletion or reorder may have changed what this index refers to.
  if (team && typeof team.name === 'string' && team.name.slice(0, 80) === name && team.format === format) room.edit(index);
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

// Turns the client's format picker into a centered modal (styled in client-battle.css).
// The popup itself stays the client's own, so search, stars and selection keep working;
// this only adds a header and a backdrop that closes it, so a click beside the modal
// cannot also press whatever sits behind it, such as the Battle button.
function installFormatModal() {
  if (window.__SD_FORMAT_MODAL || !document.body) return true;
  window.__SD_FORMAT_MODAL = true;
  const enhance = (popup) => {
    if (popup.classList.contains('sd-format-modal') || !popup.querySelector('span[name="formats"]')) return;
    if (!document.documentElement.classList.contains('sd-launcher-shell')) return;
    popup.classList.add('sd-format-modal');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');
    popup.setAttribute('aria-label', 'Choose a format');
    const head = document.createElement('div');
    head.className = 'sd-modal-head';
    const title = document.createElement('h2');
    title.textContent = 'Choose a format';
    const close = document.createElement('button');
    close.type = 'button';
    close.name = 'close'; // the popup's own button dispatch calls its close()
    close.className = 'sd-modal-close';
    close.setAttribute('aria-label', 'Close');
    head.append(title, close);
    popup.prepend(head);
    // The client re-renders only span[name=formats] (found with find()), so wrapping it is safe.
    const formats = popup.querySelector('span[name="formats"]');
    const body = document.createElement('div');
    body.className = 'sd-modal-body';
    formats.before(body);
    body.append(formats);
    const backdrop = document.createElement('div');
    backdrop.className = 'sd-modal-backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.app && typeof app.closePopup === 'function') app.closePopup();
    });
    popup.before(backdrop);
    popup.__sdBackdrop = backdrop;
  };
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && node.classList.contains('ps-popup')) enhance(node);
      }
      for (const node of record.removedNodes) {
        if (node.__sdBackdrop) node.__sdBackdrop.remove();
      }
    }
  }).observe(document.body, { childList: true });
  return true;
}

// Rebuilds the Teambuilder's team list into the launcher's layout (styled in
// client-teambuilder.css): a header with the list's actions and search, folder chips, team
// cards grouped by format, and a storage notice. It only moves, labels and adds elements
// around the client's own markup after each render. Buttons keep their name and value, so
// the client's click dispatch, drag and drop and search still drive everything.
function installTeamsView() {
  if (window.__SD_TEAMS_VIEW || !document.body) return true;
  window.__SD_TEAMS_VIEW = true;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => el('i', `fa ${name}`);
  const relabel = (button, faIcon, text) => {
    if (!button) return null;
    button.replaceChildren(icon(faIcon), document.createTextNode(` ${text}`));
    return button;
  };
  // "[Gen 9] OU" -> ["Gen 9", "OU"]; unknown IDs fall back to "gen9foo" -> ["Gen 9", "FOO"].
  const formatParts = (id) => {
    const name = (window.BattleFormats && BattleFormats[id] && BattleFormats[id].name) || '';
    let m = /^\[Gen (\d+)\]\s*(.*)$/.exec(name);
    if (m) return [`Gen ${m[1]}`, m[2]];
    m = /^gen(\d+)(.*)$/.exec(id || '');
    if (m) return [`Gen ${m[1]}`, m[2].toUpperCase()];
    return [name || id || 'Other', ''];
  };
  const formatOf = (team) => (team && team.format) || 'gen9';
  const teamCount = (value) => {
    const teams = (window.Storage && Storage.teams) || [];
    if (value === 'all') return teams.length;
    if (value.endsWith('/')) return teams.filter((t) => (t.folder || '') === value.slice(0, -1)).length;
    return teams.filter((t) => formatOf(t) === value).length;
  };

  function newTeamIn(format) {
    const room = window.app && app.rooms && app.rooms.teambuilder;
    if (!room || typeof room.newTop !== 'function') return;
    const previous = room.curFolder;
    room.curFolder = format; // createTeam reads the format from the current folder
    try {
      room.newTop('team');
    } finally {
      room.curFolder = previous;
    }
  }

  function decorateCard(li, team) {
    const card = li.querySelector(':scope > .team');
    const parts = formatParts(formatOf(team));
    card.prepend(el('span', 'sd-tb-badge', parts.filter(Boolean).join(' ')));
    const capacity = (team && team.capacity) || 6;
    const icons = card.querySelector(':scope > small');
    if (icons && capacity <= 6) {
      const have = icons.querySelectorAll(':scope > .picon').length;
      for (let i = have; i < capacity; i++) icons.append(el('span', 'sd-tb-slot'));
    }
    const mons = team && team.team ? team.team.split(']').length : 0;
    const foot = el('span', 'sd-tb-foot');
    foot.append(el('span', 'sd-tb-saved', 'Saved locally'), el('span', 'sd-tb-size', `${mons} / ${capacity} Pokémon`));
    card.append(foot);
    const del = li.querySelector(':scope > button[name="delete"]');
    if (del) {
      del.title = 'Delete';
      del.setAttribute('aria-label', 'Delete');
    }
  }

  function buildHead(room, pane) {
    const head = el('div', 'sd-tb-head');
    const titles = el('div', 'sd-tb-titles');
    const headings = pane.querySelectorAll(':scope > h2');
    const h2 = headings[headings.length - 1];
    let title = 'Your teams';
    if (room.curFolder && h2) {
      const copy = h2.cloneNode(true);
      copy.querySelectorAll('button, small').forEach((n) => n.remove());
      title = copy.textContent.trim();
      if (!room.curFolder.endsWith('/')) title = formatParts(room.curFolder).filter(Boolean).join(' ');
    }
    titles.append(el('h1', '', title), el('p', '', 'Build, organize and back up teams for every format.'));
    const actions = el('div', 'sd-tb-actions');
    if (h2) h2.querySelectorAll('button').forEach((b) => actions.append(b));
    if (!room.curFolder) {
      const importButton = el('button', 'button');
      importButton.name = 'import';
      actions.append(relabel(importButton, 'fa-upload', 'Import'));
    }
    const box = relabel(pane.querySelector('button[name="newTop"][value="box"]'), 'fa-archive', 'New box');
    const team = relabel(pane.querySelector('button[name="newTop"][value="team"]'), 'fa-plus', 'New team');
    if (box) actions.append(box);
    if (team) actions.append(team);
    const search = el('label', 'sd-tb-search');
    const input = pane.querySelector('#teamSearchBar');
    if (input) {
      input.placeholder = 'Search teams or Pokémon';
      search.append(input, el('kbd', '', 'Ctrl K'));
    }
    head.append(titles, actions, search);
    return head;
  }

  function buildBanner(room, pane) {
    const banner = el('div', 'sd-tb-banner');
    const text = el('div', 'sd-tb-banner-text');
    text.append(el('strong', '', 'Your teams live in this app\'s local storage'),
      el('span', '', 'Clearing cookies or localStorage deletes them. Back up first, or sign in to sync to the server.'));
    const actions = el('div', 'sd-tb-banner-actions');
    const uploaded = pane.querySelector('button[name="send"][value="/teams"]');
    if (uploaded) {
      uploaded.className = 'sd-tb-link';
      uploaded.textContent = 'View uploaded teams';
      actions.append(uploaded);
    }
    const backup = relabel(pane.querySelector('button[name="backup"]'), 'fa-download',
      room.curFolder ? 'Back up this folder' : 'Backup / Restore');
    if (backup) actions.append(backup);
    banner.append(el('span', 'sd-tb-banner-icon'), text, actions);
    return banner;
  }

  function renderList(root, pane) {
    const list = pane.querySelector(':scope > ul.teamlist');
    if (!list || list.dataset.sd) return;
    list.dataset.sd = '1';
    const room = window.app && app.rooms && app.rooms.teambuilder;
    if (!room || !window.Storage) return;
    // While searching, the old head still holds the focused search box. The client's
    // re-render looks it up by ID and finds that one first, so take the focus from it.
    const active = document.activeElement;
    const typing = active && active.id === 'teamSearchBar' && !pane.contains(active);
    const caret = typing ? active.selectionStart : 0;
    root.querySelectorAll(':scope > .sd-tb-head').forEach((n) => n.remove());
    root.prepend(buildHead(room, pane));
    const input = root.querySelector(':scope > .sd-tb-head #teamSearchBar');
    if (typing && input) {
      input.focus();
      input.setSelectionRange(caret, caret);
    }

    const groups = new Map();
    for (const li of [...list.children]) {
      const card = li.querySelector(':scope > .team');
      if (!card) continue;
      const team = Storage.teams[Number(card.dataset.value)];
      const format = formatOf(team);
      if (!groups.has(format)) {
        const section = el('section', 'sd-tb-group');
        section.append(el('h3', '', formatParts(format).filter(Boolean).join(' · ')));
        const grid = el('ul', 'teamlist sd-tb-grid');
        grid.dataset.sd = '1';
        section.append(grid);
        groups.set(format, { section, grid });
      }
      decorateCard(li, team);
      groups.get(format).grid.append(li);
    }
    const wrap = el('div', 'sd-tb-groups');
    for (const [format, { section, grid }] of groups) {
      if (room.curFolder && room.curFolder !== format) {
        wrap.append(section);
        continue;
      }
      const li = el('li', 'sd-tb-new');
      const add = el('button', 'sd-tb-new-btn');
      add.type = 'button';
      add.append(el('span', 'sd-tb-new-plus'), el('span', '', `New ${formatParts(format).filter(Boolean).join(' ')} team`));
      add.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        newTeamIn(format);
      });
      li.append(add);
      grid.append(li);
      wrap.append(section);
    }
    list.after(wrap);
    pane.append(buildBanner(room, pane));
  }

  function renderFolders(pane) {
    const list = pane.querySelector('.folderlist');
    if (!list || list.dataset.sd) return;
    list.dataset.sd = '1';
    for (const chip of list.querySelectorAll('.selectFolder')) {
      const value = chip.dataset.value || '';
      if (value === '+' || value === '++') continue;
      if (value === '/') chip.replaceChildren(document.createTextNode('No folder'));
      if (value !== 'all' && !value.endsWith('/')) {
        // Format folders are labelled without their generation, which the hidden group
        // headings used to give; spell it out on the chip.
        chip.querySelectorAll(':scope > i').forEach((n) => n.remove());
        chip.replaceChildren(document.createTextNode(formatParts(value).filter(Boolean).join(' ')));
      }
      chip.append(el('span', 'sd-tb-count', String(teamCount(value))));
    }
  }

  const update = () => {
    if (!document.documentElement.classList.contains('sd-launcher-shell')) return;
    const root = document.getElementById('room-teambuilder');
    if (!root) return;
    const folders = root.querySelector(':scope > .folderpane');
    const pane = root.querySelector(':scope > .teampane');
    if (!folders || !pane) return;
    try {
      renderFolders(folders);
      renderList(root, pane);
    } catch (e) {} // the client's own list stays usable if this ever fails
  };
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
    const input = document.querySelector('#room-teambuilder .sd-tb-head #teamSearchBar');
    if (!input || !input.offsetParent) return;
    event.preventDefault();
    input.focus();
    input.select();
  }, true);
  update();
  return true;
}

// Lays the Teambuilder's team editor out as the launcher's design (client-teambuilder.css):
// a header with the team's actions and a card per set. Like installTeamsView it only moves,
// labels and adds elements around the client's own markup after each render, so every
// input and button keeps the client's handlers. The client has three editor modes, read
// from its markup: "team" (all sets), "set" (one set with the search pane) and "export".
function installTeamEditor() {
  if (window.__SD_TEAM_EDITOR || !document.body) return true;
  window.__SD_TEAM_EDITOR = true;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => el('i', `fa ${name}`);
  const getRoom = () => window.app && app.rooms && app.rooms.teambuilder;
  const statName = (id) => (window.BattleStatNames && BattleStatNames[id]) || id;
  // Writes only on change, so the observer that called us settles instead of looping.
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  function buildHead(wrapper, room, mode) {
    const pad = wrapper.querySelector(':scope > .pad');
    if (!pad || pad.querySelector(':scope > .sd-te-head')) return;
    const head = el('div', 'sd-te-head');
    const back = pad.querySelector(':scope > button[name="back"]');
    if (back) {
      back.replaceChildren(icon('fa-chevron-left'));
      back.title = mode === 'set' ? 'Back to team' : 'Back to teams';
      back.setAttribute('aria-label', back.title);
      head.append(back);
    }
    const name = pad.querySelector(':scope > input.teamnameedit');
    if (name) {
      const label = el('label', 'sd-te-name');
      label.append(name, icon('fa-pencil'));
      head.append(label);
    } else {
      head.append(el('h1', 'sd-te-title', room.curTeam.name || 'Untitled'));
    }
    const actions = el('div', 'sd-te-actions');
    const format = pad.querySelector('button.teambuilderformatselect');
    const validate = pad.querySelector('button[name="validate"]');
    if (format) actions.append(format);
    if (validate) actions.append(validate);
    for (const button of pad.querySelectorAll(':scope > button[name="import"], :scope > button[name="saveImport"]')) {
      actions.append(button);
    }
    const primary = actions.querySelector('button[name="import"]');
    if (primary) primary.classList.add('sd-te-primary');
    head.append(actions);
    pad.prepend(head);
  }

  function natureText(set) {
    const nature = set.nature || 'Serious';
    const data = window.BattleNatures && BattleNatures[nature];
    const effect = data && data.plus ? `+${statName(data.plus)} −${statName(data.minus)}` : 'Neutral';
    return [nature, effect];
  }

  function decorateSet(li, room) {
    const set = room.curSetList && room.curSetList[Number(li.getAttribute('value'))];
    const chart = li.querySelector(':scope > .setchart');
    if (!set || !chart) return;
    const team = room.curTeam;
    const format = team.format || '';
    const usesEVs = team.gen > 2 && !format.includes('letsgo') && !format.includes('champions');

    if (!li.dataset.sd) {
      li.dataset.sd = '1';
      if (set.species) {
        const meta = el('div', 'sd-te-meta');
        meta.append(el('span', 'sd-te-chips'));
        const nickname = li.querySelector(':scope > .setchart-nickname');
        if (nickname) meta.append(nickname);
        li.append(meta, el('div', 'sd-te-rule'));
      }
      const itemIcon = li.querySelector('.setrow-icons .itemicon');
      const itemCell = li.querySelector('.setcell-item');
      if (itemIcon && itemCell) itemCell.prepend(itemIcon);
      const stats = li.querySelector('.setcol-stats');
      if (stats) {
        stats.append(el('span', 'sd-te-evleft'));
        if (usesEVs) {
          const nature = el('button', 'sd-te-nature');
          nature.type = 'button';
          nature.name = 'stats'; // opens the client's stat form, like the stats panel
          stats.append(nature);
        }
      }
    }

    // The client draws the sprite as the chart's background; the card shows it in its box.
    const sprite = li.querySelector('.setcell-sprite');
    if (sprite && sprite.style.backgroundImage !== chart.style.backgroundImage) {
      sprite.style.backgroundImage = chart.style.backgroundImage;
      sprite.style.backgroundSize = chart.style.backgroundSize;
    }
    if (sprite) sprite.classList.toggle('pixelated', chart.classList.contains('pixelated'));

    const chips = li.querySelector('.sd-te-chips');
    if (chips) {
      const species = team.dex.species.get(set.species);
      const types = species.types || [];
      const tera = team.gen === 9 && !format.includes('champions') ?
        (set.teraType || species.requiredTeraType || types[0] || '') : '';
      const key = `${types.join(',')}|${tera}`;
      if (chips.dataset.key !== key) {
        chips.dataset.key = key;
        chips.replaceChildren(...types.map((type) => el('span', `sd-te-type sd-t-${type}`, type)));
        if (tera) chips.append(el('span', `sd-te-tera sd-t-${tera}`, `Tera ${tera}`));
      }
    }

    const left = li.querySelector('.sd-te-evleft');
    if (left) {
      let text = '';
      if (usesEVs && !room.ignoreEVLimits) {
        const total = Object.values(set.evs || {}).reduce((sum, ev) => sum + (Number(ev) || 0), 0);
        text = total > 510 ? `${total - 510} over` : `${Math.max(508 - total, 0)} left`;
      }
      setText(left, text);
    }
    const nature = li.querySelector('.sd-te-nature');
    if (nature) {
      const [name, effect] = natureText(set);
      if (nature.dataset.key !== `${name}|${effect}`) {
        nature.dataset.key = `${name}|${effect}`;
        nature.replaceChildren(el('span', '', 'Nature'), el('strong', '', name), el('span', 'sd-te-effect', effect));
      }
    }

    // Stat rows are re-rendered as markup on each change; restyle the fresh ones.
    for (const row of li.querySelectorAll('.setstats .statrow:not(.statrow-head):not([data-sd])')) {
      row.dataset.sd = '1';
      const bar = row.querySelector('.statgraph span');
      if (bar) bar.style.width = `${Math.min(100, (parseFloat(bar.style.width) || 0) / 75 * 100)}%`;
      const mark = row.querySelector('small');
      if (mark) row.classList.add(mark.textContent === '+' ? 'sd-plus' : 'sd-minus');
      const ev = row.querySelector('em');
      if (ev && !ev.textContent) {
        ev.textContent = '0';
        row.classList.add('sd-zero');
      }
    }
  }

  let watched = null;
  const update = () => {
    if (!document.documentElement.classList.contains('sd-launcher-shell')) return;
    const root = document.getElementById('room-teambuilder');
    if (!root) return;
    if (watched !== root) {
      // Sprite and stat updates change inline styles only; watch those inside the room.
      watched = root;
      new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['style'], subtree: true });
    }
    const room = getRoom();
    const wrapper = root.querySelector(':scope > .teamwrapper');
    if (!room || !room.curTeam || !wrapper) return;
    const mode = wrapper.querySelector(':scope > .teambar') ? 'set' :
      wrapper.querySelector(':scope > .teamedit') ? 'export' : 'team';
    if (wrapper.dataset.sdMode !== mode) wrapper.dataset.sdMode = mode;
    try {
      buildHead(wrapper, room, mode);
      for (const li of wrapper.querySelectorAll('.teamchart > li[value]')) decorateSet(li, room);
    } catch (e) {} // the client's own editor stays usable if this ever fails
  };
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  update();
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
    named: Boolean(raw.named),
    menuUnread: Boolean(raw.menuUnread),
    menuTab: raw.menuTab === 'community' ? 'community' : 'battle',
    shell: Boolean(raw.shell),
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
        formatId: (BATTLE_FORMAT.exec(r.id) || [])[1] || '',
        ended: Boolean(r.ended),
        kind: ROOM_KINDS.includes(r.kind) ? r.kind : 'other',
        turn: r.battle && Number.isSafeInteger(r.turn) && r.turn >= 0 && r.turn < 10000 ? r.turn : null,
        unread: Boolean(r.unread),
      })),
  };
}

function sanitizeFriends(raw) {
  if (!Array.isArray(raw) || raw.length > 1000) return { available: false, items: [] };
  const seen = new Set();
  const items = [];
  for (const friend of raw) {
    if (!friend || typeof friend !== 'object' ||
        typeof friend.userid !== 'string' || !/^[a-z0-9]{1,18}$/.test(friend.userid) ||
        typeof friend.online !== 'boolean' ||
        !(friend.online ? ['online', 'idle', 'busy'].includes(friend.status) : friend.status === 'offline') ||
        seen.has(friend.userid)) continue;
    const name = str(friend.name, 40).replace(/[\u0000-\u001f\u007f]/g, '').trim() || friend.userid;
    seen.add(friend.userid);
    items.push({ userid: friend.userid, name, online: friend.online, status: friend.status });
  }
  return { available: raw.length === 0 || items.length > 0, items };
}

function copyFriends(value) {
  return { available: value.available, items: value.items.map((item) => ({ ...item })) };
}

class ShowdownBridge {
  constructor(getContents) {
    this.getContents = getContents;
    this.ratings = new Map();
    this.friendsCache = new Map();
    this.friendsInFlight = new Map();
    this.friendsRequest = null;
  }

  // Internal integration entry points; never accept arbitrary script URLs via IPC.
  async loadShowdex() {
    const contents = this.getContents();
    if (!contents) return false;
    try {
      return await contents.executeJavaScript(call(loadShowdex, 'showdex://assets/main.js')) === true;
    } catch { return false; }
  }

  async installFormatModal() {
    const contents = this.getContents();
    if (!contents) return false;
    try {
      return await contents.executeJavaScript(call(installFormatModal)) === true;
    } catch { return false; }
  }

  async installTeamEditor() {
    const contents = this.getContents();
    if (!contents) return false;
    try {
      return await contents.executeJavaScript(call(installTeamEditor)) === true;
    } catch { return false; }
  }

  async installTeamsView() {
    const contents = this.getContents();
    if (!contents) return false;
    try {
      return await contents.executeJavaScript(call(installTeamsView)) === true;
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
    if (!state.ready) return state;
    state.friends = { available: false, items: [] };
    if (state.user.registered && state.user.userid) {
      const userid = state.user.userid;
      const [ratings, friends] = await Promise.all([
        this.fetchRatings(userid),
        state.connected ? this.fetchFriends(userid) : Promise.resolve({ available: false, items: [] }),
      ]);
      state.ratings = ratings;
      state.stats = (this.ratings.get(userid) || {}).stats || {};
      state.friends = friends;
    }
    return state;
  }

  async fetchFriends(userid) {
    if (!isId(userid)) return { available: false, items: [] };
    // The response event has no request ID, so never overlap queries for different users.
    while (this.friendsRequest && this.friendsRequest.userid !== userid) await this.friendsRequest.promise;
    const cached = this.friendsCache.get(userid);
    const ttl = cached && cached.value.available ? FRIENDS_TTL : FRIENDS_FAILURE_TTL;
    if (cached && Date.now() - cached.at < ttl) return copyFriends(cached.value);
    let pending = this.friendsInFlight.get(userid);
    if (!pending) {
      pending = (async () => {
        const contents = this.getContents();
        if (!contents || contents.isLoading()) return { available: false, items: [] };
        let raw;
        try { raw = await contents.executeJavaScript(call(readFriends, userid, FRIENDS_TIMEOUT)); } catch { raw = null; }
        const value = sanitizeFriends(raw);
        this.friendsCache.set(userid, { at: Date.now(), value });
        return value;
      })();
      this.friendsInFlight.set(userid, pending);
      this.friendsRequest = { userid, promise: pending };
      pending.finally(() => {
        if (this.friendsInFlight.get(userid) === pending) this.friendsInFlight.delete(userid);
        if (this.friendsRequest?.promise === pending) this.friendsRequest = null;
      });
    }
    return copyFriends(await pending);
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
    const stats = {};
    try {
      const res = await net.fetch(`https://pokemonshowdown.com/users/${userid}.json`, { credentials: 'omit' });
      if (res.ok) {
        const data = await res.json();
        for (const [format, r] of Object.entries((data && data.ratings) || {})) {
          const elo = count(r && r.elo);
          if (!isId(format) || elo === null) continue;
          value[format] = Math.round(elo);
          const gxe = Number(r.gxe);
          stats[format] = {
            elo: Math.round(elo),
            gxe: Number.isFinite(gxe) && gxe >= 0 && gxe <= 100 ? Math.round(gxe * 10) / 10 : null,
            wins: count(r.w) || 0,
            losses: count(r.l) || 0,
          };
        }
      }
    } catch {}
    this.ratings.set(userid, { at: Date.now(), value, stats });
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
      case 'edit-team':
        if (args.team !== null && (!Number.isSafeInteger(args.team) || args.team < 0 || args.team > 9999 ||
            typeof args.name !== 'string' || args.name.length > 80 || !(args.format === '' || isId(args.format)))) return false;
        code = args.team === null ? call(editTeam, null, '', '') : call(editTeam, args.team, args.name, args.format);
        break;
      case 'focus-room':
        if (!(args.room === '' || (typeof args.room === 'string' && ROOM_ID.test(args.room)))) return false;
        code = call(focusRoom, args.room);
        break;
      case 'show-menu':
        if (args.tab !== 'battle' && args.tab !== 'community') return false;
        code = call(showMenu, args.tab);
        break;
      case 'leave-room':
        if (!(typeof args.room === 'string' && ROOM_ID.test(args.room)) || args.room === 'rooms') return false;
        code = call(leaveRoom, args.room);
        break;
      case 'sounds':
        code = call(openSounds);
        break;
      case 'options':
        code = call(openOptions);
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
