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
