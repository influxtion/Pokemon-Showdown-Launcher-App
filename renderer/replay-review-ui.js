'use strict';

window.ReplayReviewUI = class ReplayReviewUI {
  constructor(hooks) {
    this.hooks = hooks;
    const params = new URLSearchParams(location.search);
    this.id = params.get('review');
    this.active = params.has('review');
    this.started = false;
    this.stopped = false;
    this.timer = null;
    this.ui = Object.fromEntries(['back', 'player', 'status', 'browser', 'toggle-notes', 'reload', 'view', 'message', 'replay']
      .map((name) => [name, document.getElementById(`review-${name}`)]));
    this.ui.replay.addEventListener('click', () => {
      const id = this.hooks.selectedId();
      if (id && !this.hooks.isBusy()) location.href = `replays.html?review=${encodeURIComponent(id)}`;
    });
    if (!this.active) return;
    document.body.classList.add('review-mode');
    document.querySelector('.topbar h1').textContent = 'Review replay';
    this.ui.back.hidden = false;
    this.ui.player.hidden = false;
    this.ui.back.href = this.id ? `replays.html?id=${encodeURIComponent(this.id)}` : 'replays.html';
    this.ui.browser.addEventListener('click', async () => {
      if (!this.started || this.stopped) return;
      try {
        const result = await this.hooks.call('openReplayNote', this.id);
        if (!result?.ok) this.browserError(result?.error || 'Could not open the replay in your browser.');
      } catch { this.browserError('Could not open the replay in your browser.'); }
    });
    this.ui['toggle-notes'].addEventListener('click', () => {
      const wide = document.body.classList.toggle('review-wide');
      this.ui['toggle-notes'].textContent = wide ? 'Show notes' : 'Hide notes';
      this.ui['toggle-notes'].setAttribute('aria-expanded', String(!wide));
      if (!wide) document.getElementById('note-body').focus();
      this.syncBounds();
    });
    this.ui.reload.addEventListener('click', async () => {
      if (!this.started || this.stopped) return;
      this.ui.reload.disabled = true;
      try { this.render(await this.hooks.call('reloadReplayReview')); }
      catch { this.fail('Could not reload the replay. Try again or open it in your browser.'); }
      finally { this.ui.reload.disabled = false; }
    });
    this.observer = new ResizeObserver(() => this.syncBounds());
    this.observer.observe(this.ui.view);
    window.addEventListener('resize', () => this.syncBounds());
    window.addEventListener('pagehide', () => {
      this.stopped = true;
      clearTimeout(this.timer);
      this.observer.disconnect();
    });
  }

  updateButton() {
    this.ui.replay.disabled = this.hooks.isBusy() || !this.hooks.selectedId();
  }

  browserError(message) {
    this.hooks.showError(message);
    if (document.body.classList.contains('review-wide')) this.ui['toggle-notes'].click();
  }

  async start() {
    if (!this.active || this.started) return;
    if (!this.id || this.hooks.selectedId() !== this.id) {
      this.fail('This replay cannot be reviewed while a different draft is open. Return to notes to save or choose the saved replay.');
      return;
    }
    this.started = true;
    this.ui.reload.disabled = false;
    this.ui.browser.disabled = false;
    await this.syncBounds();
    this.poll();
  }

  fail(message) {
    if (!this.active || this.stopped) return;
    this.ui.status.textContent = 'Replay unavailable';
    this.ui.status.className = 'status status--err';
    this.ui.message.textContent = message;
  }

  render(result) {
    if (this.stopped) return;
    if (!result?.ok || result.state === 'failed') {
      this.fail(result?.error || 'Could not load the replay. Reload or open it in your browser.');
      return;
    }
    const loaded = result.state === 'loaded';
    this.ui.status.textContent = loaded ? 'Replay page loaded' : 'Loading replay…';
    this.ui.status.className = `status ${loaded ? 'status--ok' : 'status--warn'}`;
    this.ui.message.textContent = loaded ? 'The replay page is shown here.' : 'Loading the replay page…';
  }

  async syncBounds() {
    if (!this.started || this.stopped) return;
    const r = this.ui.view.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    try {
      const result = await this.hooks.call('showReplayReview', { x: r.left, y: r.top, width: r.width, height: r.height });
      this.render(result);
    } catch { this.fail('Could not display the replay. Reload or open it in your browser.'); }
  }

  async poll() {
    if (this.stopped) return;
    try { this.render(await this.hooks.call('getReplayReviewStatus')); }
    catch { this.fail('Could not read replay status. Reload or open it in your browser.'); }
    if (!this.stopped) this.timer = setTimeout(() => this.poll(), 750);
  }
};
