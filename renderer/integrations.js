'use strict';

(() => {
  const status = document.getElementById('showdex-status');
  if (!status) return;
  const toggle = document.getElementById('showdex-enabled');
  const banner = document.getElementById('showdex-reload-banner');
  const reload = document.getElementById('showdex-reload');
  const settingsStatus = document.getElementById('settings-status');
  const onPlay = !toggle;
  let state = null;
  let busy = false;
  let polling = false;

  function feedback(text) {
    if (!settingsStatus) return;
    settingsStatus.textContent = text;
    settingsStatus.hidden = !text;
  }

  function label(value) {
    if (!value.installed || value.status === 'not-installed') return ['Not installed', 'off'];
    if (value.loaded && !value.enabled && value.pendingReload) return ['Loaded · reload to disable', 'ok'];
    if (!value.loaded && value.enabled && value.pendingReload) return ['Will load after reload', 'warn'];
    switch (value.status) {
      case 'loaded': return ['Loaded', 'ok'];
      case 'loading': return ['Loading…', 'warn'];
      case 'failed': return ['Failed to load', 'err'];
      case 'disabled': return ['Disabled', 'off'];
      default: return ['Status unavailable', 'err'];
    }
  }

  function render(value) {
    state = value;
    const [text, tone] = label(value);
    status.className = `status status--${tone}`;
    status.textContent = onPlay ? `Showdex: ${text}` : text;
    status.title = value.error || (value.version ? `Showdex ${value.version}` : '');
    if (toggle) {
      toggle.checked = Boolean(value.enabled);
      toggle.disabled = busy || !value.installed;
    }
    if (banner) banner.hidden = !value.pendingReload;
  }

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const value = await window.desktop.getShowdex();
      if (!value || typeof value.status !== 'string') throw new Error('Showdex status could not be checked.');
      render(value);
    } catch (error) {
      status.className = 'status status--err';
      status.textContent = onPlay ? 'Showdex: Status unavailable' : 'Status unavailable';
      status.title = error.message || '';
      if (toggle) toggle.disabled = true;
    } finally {
      polling = false;
    }
  }

  if (toggle) {
    toggle.addEventListener('change', async () => {
      if (!state || !state.installed) return;
      const wanted = toggle.checked;
      busy = true;
      toggle.disabled = true;
      try {
        const result = await window.desktop.setSetting('showdexEnabled', wanted);
        if (!result?.ok) throw new Error(result?.error || 'Showdex preference could not be saved.');
        feedback('Showdex preference saved. Reload the client to apply it.');
        await refresh();
      } catch (error) {
        toggle.checked = Boolean(state.enabled);
        feedback(error.message || 'Showdex preference could not be saved.');
      } finally {
        busy = false;
        toggle.disabled = !state?.installed;
      }
    });
  }

  if (reload) {
    reload.addEventListener('click', async () => {
      reload.disabled = true;
      try {
        const result = await window.desktop.reloadClient();
        if (result?.cancelled) feedback('Client reload cancelled. Showdex change is still pending.');
        else if (!result?.ok) throw new Error(result?.error || 'Client could not be reloaded.');
        else feedback('Client reload requested.');
      } catch (error) {
        feedback(error.message || 'Client could not be reloaded.');
      } finally {
        reload.disabled = false;
        await refresh();
      }
    });
  }

  refresh();
  setInterval(refresh, 2000);
})();
