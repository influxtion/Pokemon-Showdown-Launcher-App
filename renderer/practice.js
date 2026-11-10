'use strict';

(() => {
  const status = document.getElementById('practice-status');
  const setup = document.getElementById('practice-setup');
  const area = document.getElementById('practice-area');
  const start = document.getElementById('practice-start');
  const stop = document.getElementById('practice-stop');
  const next = document.getElementById('practice-next');
  const message = document.getElementById('practice-message');
  const preset = document.getElementById('practice-preset');
  let busy = false;
  let polling = false;
  let actionError = '';

  function sync() {
    if (area.hidden) return;
    const bounds = area.getBoundingClientRect();
    window.desktop.showPractice({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const value = await window.desktop.getPractice();
      const running = value.state === 'ready';
      const starting = value.state === 'starting';
      setup.hidden = running || starting;
      area.hidden = !running;
      start.disabled = busy || !value.installed || starting || running;
      preset.disabled = busy;
      stop.hidden = !running && !starting;
      stop.disabled = busy && !starting;
      next.hidden = !running || !value.battle?.finished;
      next.disabled = busy;
      let text = !value.installed ? 'Runtime not installed' : starting ? 'Starting local engine…' : running ? 'Local engine ready' : value.state === 'failed' ? 'Practice failed' : 'Ready to start';
      if (running && value.clientState === 'connecting') text = 'Connecting local battle client…';
      if (running && value.battle?.thinking) text = `Laplace is thinking · turn ${value.battle.turn || 1}`;
      else if (running && value.battle?.finished) text = ({ win: 'You won', loss: 'Laplace won', tie: 'Battle tied' })[value.battle.result] || 'Battle finished';
      else if (running && value.battle?.turn) text = `Turn ${value.battle.turn} · last search ${((value.battle.elapsedMs || 0) / 1000).toFixed(1)}s`;
      if (value.clientError) text = 'Practice client failed';
      if (value.error && !value.installed) text = 'Runtime needs repair';
      status.textContent = text;
      status.className = `status status--${value.error || value.clientError ? 'err' : starting ? 'warn' : running ? 'ok' : 'off'}`;
      message.textContent = actionError || value.error || value.clientError || (!value.installed ? 'The local practice runtime is not included in this build.' : starting ? 'Starting the local server and checking the engine. This can take a moment.' : '');
      message.hidden = !message.textContent;
      sync();
    } catch {
      status.textContent = 'Practice status unavailable';
      start.disabled = true;
    } finally { polling = false; }
  }

  async function act(action) {
    busy = true;
    actionError = '';
    start.disabled = stop.disabled = next.disabled = true;
    try {
      const result = await action();
      if (!result?.ok && !result?.cancelled) {
        actionError = result?.error || 'Practice action failed.';
        message.textContent = actionError;
        message.hidden = false;
      }
    } catch {
      actionError = 'Practice action failed. Try again.';
      message.textContent = actionError;
      message.hidden = false;
    } finally { busy = false; await refresh(); }
  }
  start.addEventListener('click', () => act(() => window.desktop.startPractice(preset.value)));
  stop.addEventListener('click', () => act(() => window.desktop.stopPractice()));
  next.addEventListener('click', () => act(() => window.desktop.nextPracticeBattle()));
  new ResizeObserver(sync).observe(area);
  window.addEventListener('resize', sync);
  refresh();
  setInterval(refresh, 1000);
})();
