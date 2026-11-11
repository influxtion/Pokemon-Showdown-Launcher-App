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
  const opponent = document.getElementById('practice-opponent');
  const description = document.getElementById('practice-opponent-description');
  const location = document.getElementById('practice-location');
  let busy = false;
  let polling = false;
  let actionError = '';
  let selectionInitialized = false;

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
      if ((!selectionInitialized || running || starting) && ['laplace', 'foulplay'].includes(value.opponent)) {
        opponent.value = value.opponent;
        if (['quiet', 'balanced', 'full'].includes(value.preset)) preset.value = value.preset;
        selectionInitialized = true;
      }
      const choices = value.opponents || [{ id: 'laplace', name: 'Laplace', available: value.installed }];
      const selected = choices.find(bot => bot.id === opponent.value);
      for (const option of opponent.options) {
        const bot = choices.find(bot => bot.id === option.value);
        option.textContent = `${bot?.name || (option.value === 'foulplay' ? 'Foul Play' : 'Laplace')}${bot?.available ? '' : ' · not installed'}`;
      }
      description.textContent = selected?.description || '';
      location.textContent = value.hosted ? 'Battles run on the configured battle server. An internet connection is required.' : 'The engine and battle server run on this computer. Pokémon artwork needs an internet connection.';
      const name = value.opponent === 'foulplay' ? 'Foul Play' : 'Laplace';
      const recovery = Boolean(value.battle && (value.battle.searchFallbacks || value.battle.rejectedChoices || value.battle.defaultChoices));
      setup.hidden = running || starting;
      area.hidden = !running;
      start.disabled = busy || !value.installed || !selected?.available || starting || running;
      opponent.disabled = busy || starting || running;
      preset.disabled = busy;
      stop.hidden = !running && !starting;
      stop.disabled = busy && !starting;
      next.hidden = !running || !value.battle?.finished;
      next.disabled = busy;
      let text = !value.installed ? 'Bots unavailable' : starting ? `Starting ${name}…` : running ? `${name} ready` : value.state === 'failed' ? 'Practice failed' : 'Ready to play';
      if (running && value.clientState === 'connecting') text = 'Connecting battle client…';
      if (running && value.battle?.thinking) text = `${name} is thinking · turn ${value.battle.turn || 1}`;
      else if (running && value.battle?.finished) text = ({ win: 'You won', loss: `${name} won`, tie: 'Battle tied' })[value.battle.result] || 'Battle finished';
      else if (running && value.battle?.turn) text = `Turn ${value.battle.turn} · last search ${((value.battle.elapsedMs || 0) / 1000).toFixed(1)}s`;
      if (value.clientError) text = 'Practice client failed';
      if (value.error && !value.installed) text = value.hosted ? 'Battle service unavailable' : 'Runtime needs repair';
      status.textContent = text;
      status.className = `status status--${value.error || value.clientError ? 'err' : starting || recovery ? 'warn' : running ? 'ok' : 'off'}`;
      message.textContent = actionError || value.error || value.clientError || (!value.installed ? 'The battle runtime is not available.' : starting ? 'Preparing the battle server and checking the engine. This can take a moment.' : recovery ? `${name} retried or recovered a move in this game.` : !selected?.available && !running ? 'This opponent is not installed on the battle server.' : '');
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
  opponent.addEventListener('change', () => { selectionInitialized = true; refresh(); });
  start.addEventListener('click', () => act(() => window.desktop.startPractice({ opponent: opponent.value, preset: preset.value })));
  stop.addEventListener('click', () => act(() => window.desktop.stopPractice()));
  next.addEventListener('click', () => act(() => window.desktop.nextPracticeBattle()));
  new ResizeObserver(sync).observe(area);
  window.addEventListener('resize', sync);
  refresh();
  setInterval(refresh, 1000);
})();
