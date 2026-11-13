'use strict';

// Keeps the native client view aligned with .client-view as the window or banner changes.
const area = document.querySelector('.client-view');

function syncClient() {
  const r = area.getBoundingClientRect();
  window.desktop.showClient({ x: r.left, y: r.top, width: r.width, height: r.height });
}

new ResizeObserver(syncClient).observe(area);
window.addEventListener('resize', syncClient);

const connectionBanner = document.getElementById('connection-banner');
const connectionMessage = document.getElementById('connection-message');
const connectionRetry = document.getElementById('connection-retry');
const roomTitle = document.getElementById('room-title');
const roomFormat = document.getElementById('room-format');
const roomStatus = document.getElementById('room-status');
const saveNote = document.getElementById('save-note');
const resultBar = document.getElementById('result-bar');
const resultMessage = document.getElementById('result-message');
const resultAgain = document.getElementById('result-again');
let resultRoom = '';
let resultFormat = '';

// Top bar names the room the client is showing.
function renderRoom(session) {
  const rooms = session.rooms || [];
  const current = typeof session.current === 'string' ? session.current : '';
  const room = rooms.find((r) => r.id === current);
  const me = session.me || '';
  let title = 'Showdown';
  let format = '';
  let status = '';
  if (session.ready && current === '') {
    title = session.menuTab === 'community' ? 'Community' : 'Battle';
  } else if (current === 'rooms') {
    title = 'Rooms';
  } else if (room && room.battle) {
    title = window.showdownNav ? window.showdownNav.matchup(room, me) : room.title;
    format = room.formatId || '';
    status = room.ended ? 'Finished' : Number.isInteger(room.turn) ? `Turn ${room.turn}` : '';
  } else if (room) {
    title = room.title;
  }
  roomTitle.textContent = title;
  roomFormat.textContent = format;
  roomFormat.hidden = !format;
  roomStatus.textContent = status;
  roomStatus.hidden = !status;
  saveNote.hidden = !(room && room.battle);

  const own = room && room.battle && room.ended && me && (room.players || []).includes(me);
  resultBar.hidden = !own;
  if (own) {
    resultRoom = room.id;
    resultFormat = room.formatId || '';
    resultMessage.textContent = `Battle finished · ${title}`;
    resultAgain.hidden = !resultFormat;
  }
}

document.addEventListener('showdown-session', (event) => {
  const session = event.detail;
  renderRoom(session);
  if (!session.ready) {
    connectionMessage.textContent = 'Connecting to Showdown…';
    connectionRetry.hidden = true;
    connectionBanner.hidden = false;
    return;
  }
  if (!session.connected) {
    connectionMessage.textContent = 'Connection to Showdown lost. Reconnecting…';
    connectionRetry.hidden = false;
    connectionBanner.hidden = false;
    return;
  }
  connectionRetry.hidden = true;
  connectionBanner.hidden = true;
});

connectionRetry.addEventListener('click', () => window.desktop.reloadClient());

document.querySelectorAll('[data-action="sounds"], [data-action="options"]').forEach((button) => {
  button.addEventListener('click', () => window.desktop.showdown(button.dataset.action, {}));
});

document.getElementById('result-close').addEventListener('click', () => {
  if (window.showdownNav) window.showdownNav.closeRoom(resultRoom);
});

// Only ever runs from this explicit click. The team is the one Home remembered for the format.
resultAgain.addEventListener('click', async () => {
  if (!resultFormat) return;
  let team = null;
  try {
    const raw = localStorage.getItem(`hub.team.${resultFormat}`);
    const saved = raw === null || raw === '' ? NaN : Number(raw);
    if (Number.isInteger(saved) && saved >= 0) team = saved;
  } catch {}
  resultAgain.disabled = true;
  let result;
  try {
    result = await window.desktop.showdown('search', { format: resultFormat, team });
  } catch {
    result = false;
  }
  resultAgain.disabled = false;
  if (result === true) location.href = 'index.html';
});
