'use strict';

// Keeps the native client view aligned with .client-view as the window or banner changes.
const area = document.querySelector('.client-view');

function syncClient() {
  const r = area.getBoundingClientRect();
  window.desktop.showClient({ x: r.left, y: r.top, width: r.width, height: r.height });
}

new ResizeObserver(syncClient).observe(area);
window.addEventListener('resize', syncClient);

document.querySelector('[data-action="reload-client"]')
  .addEventListener('click', () => window.desktop.reloadClient());

const connectionBanner = document.getElementById('connection-banner');
const connectionMessage = document.getElementById('connection-message');
const connectionRetry = document.getElementById('connection-retry');

document.addEventListener('showdown-session', (event) => {
  const session = event.detail;
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
