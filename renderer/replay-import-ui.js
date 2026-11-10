'use strict';

// Review state is local; the main process owns the validated snapshot and write decisions.
window.ReplayImportUI = class ReplayImportUI {
  constructor(hooks) {
    this.hooks = hooks;
    this.preview = null;
    this.selected = null;
    this.choices = new Map();
    this.canUndo = false;
    this.applying = false;
    this.ui = Object.fromEntries([
      'dialog', 'filename', 'summary', 'error', 'filter', 'bulk', 'keep-all', 'replace-all',
      'list', 'empty', 'comparison', 'url', 'choice-field', 'choice', 'entry-status',
      'existing', 'incoming', 'effect', 'cancel', 'apply',
    ].map((name) => [name, document.getElementById(`import-${name}`)]));
    this.openButton = document.getElementById('import-replays');
    this.undoButton = document.getElementById('undo-import');
    this.openButton.addEventListener('click', () => this.open());
    this.undoButton.addEventListener('click', () => this.undo());
    this.ui.cancel.addEventListener('click', () => this.close());
    this.ui.dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(); });
    this.ui.filter.addEventListener('change', () => this.renderList());
    this.ui.choice.addEventListener('change', () => {
      if (this.applying || !this.choices.has(this.selected)) return;
      this.choices.set(this.selected, this.ui.choice.value);
      this.renderList();
    });
    this.ui['keep-all'].addEventListener('click', () => this.chooseAll('keep'));
    this.ui['replace-all'].addEventListener('click', () => this.chooseAll('replace'));
    this.ui.apply.addEventListener('click', () => this.apply());
  }

  setBusy(busy) {
    this.openButton.disabled = busy || !this.hooks.isReady();
    this.undoButton.disabled = busy || !this.canUndo || this.hooks.isDirty();
  }

  async refreshUndo() {
    try {
      const result = await this.hooks.call('getReplayImportStatus');
      this.canUndo = Boolean(result?.ok && result.canUndo);
    } catch { this.canUndo = false; }
    this.undoButton.hidden = !this.canUndo;
    this.setBusy(this.hooks.isBusy());
  }

  error(message) {
    this.ui.error.textContent = message;
    this.ui.error.hidden = !message;
  }

  async open() {
    if (this.hooks.isBusy() || !this.hooks.isReady()) return;
    this.hooks.setBusy(true, 'Opening import…');
    this.hooks.showError('');
    try {
      const result = await this.hooks.call('chooseReplayImport');
      if (result?.cancelled) return;
      if (!result?.ok || !result.preview) {
        this.hooks.showError(result?.error || 'Could not read the import file.');
        return;
      }
      this.preview = result.preview;
      this.choices = new Map(this.preview.entries.filter((entry) => entry.status === 'conflict')
        .map((entry) => [entry.key, 'keep']));
      this.selected = null;
      this.ui.filter.value = 'all';
      this.ui.filename.textContent = this.preview.filename;
      const { added, unchanged, conflicts } = this.preview.counts;
      this.ui.summary.textContent = `${added} new · ${unchanged} unchanged · ${conflicts} conflicting`;
      this.ui.bulk.hidden = !conflicts;
      this.error(this.hooks.isDirty() ? 'Your unsaved note is kept. Cancel this preview and save it before importing.' : '');
      this.renderList();
      this.ui.dialog.showModal();
      this.ui.cancel.focus();
    } catch {
      this.hooks.showError('Could not open the import preview. Try again.');
    } finally { this.hooks.setBusy(false); }
  }

  chooseAll(action) {
    if (this.applying) return;
    for (const key of this.choices.keys()) this.choices.set(key, action);
    this.renderList();
  }

  entryLabel(entry) {
    if (entry.status === 'new') return 'New note';
    if (entry.status === 'same') return 'Unchanged · skipped';
    return this.choices.get(entry.key) === 'replace' ? 'Conflict · use imported' : 'Conflict · keep existing';
  }

  renderList() {
    const entries = this.preview.entries.filter((entry) => this.ui.filter.value === 'all' || entry.status === this.ui.filter.value);
    if (!entries.some((entry) => entry.key === this.selected)) this.selected = entries[0]?.key || null;
    this.ui.list.replaceChildren();
    for (const entry of entries) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'note-item';
      button.disabled = this.applying;
      if (entry.key === this.selected) button.setAttribute('aria-current', 'true');
      const title = document.createElement('span');
      title.className = 'note-item-title';
      title.textContent = entry.incoming.title;
      const state = document.createElement('span');
      state.className = 'note-item-snippet';
      state.textContent = this.entryLabel(entry);
      button.append(title, state);
      button.addEventListener('click', () => { this.selected = entry.key; this.renderList(); });
      li.append(button);
      this.ui.list.append(li);
    }
    this.renderComparison(entries.find((entry) => entry.key === this.selected));
    const replaced = [...this.choices.values()].filter((action) => action === 'replace').length;
    const added = this.preview.counts.added;
    const overLimit = this.preview.currentCount + added > 1000;
    this.ui.effect.textContent = overLimit
      ? 'This import exceeds the 1,000-note limit. No notes will be changed.'
      : `Add ${added} · Replace ${replaced} · Keep ${this.preview.currentCount - replaced} existing. No unrelated notes are removed.`;
    this.ui.apply.textContent = added + replaced ? `Import ${added + replaced} ${added + replaced === 1 ? 'note' : 'notes'}` : 'Nothing to import';
    this.ui.apply.disabled = this.applying || this.preview.stale || this.hooks.isDirty() || overLimit || added + replaced === 0;
  }

  renderVersion(container, note) {
    container.replaceChildren();
    if (!note) { container.textContent = 'No existing note for this replay.'; return; }
    const title = document.createElement('p');
    title.className = 'import-version-title';
    title.textContent = note.title;
    const meta = document.createElement('p');
    meta.className = 'import-version-meta';
    meta.textContent = `${note.format || 'No format'} · Edited ${new Date(note.updatedAt).toLocaleString()}`;
    const body = document.createElement('pre');
    body.className = 'import-version-notes';
    body.textContent = note.notes || '(No notes)';
    container.append(title, meta, body);
  }

  renderComparison(entry) {
    this.ui.empty.hidden = Boolean(entry);
    this.ui.comparison.hidden = !entry;
    if (!entry) return;
    this.ui.url.textContent = entry.incoming.url;
    this.ui['choice-field'].hidden = entry.status !== 'conflict';
    this.ui.choice.value = this.choices.get(entry.key) || 'keep';
    this.ui['entry-status'].textContent = entry.status === 'same'
      ? 'The title, format and notes match. Your existing ID and dates will be kept.'
      : entry.status === 'new' ? 'This note will be added with its saved dates and full replay link.'
        : 'Choosing the imported version replaces the title, format, notes and saved dates for this replay.';
    this.renderVersion(this.ui.existing, entry.existing);
    this.renderVersion(this.ui.incoming, entry.incoming);
  }

  close() {
    if (this.applying) return;
    if (this.preview) this.hooks.call('cancelReplayImport', this.preview.token).catch(() => {});
    this.preview = null;
    this.ui.dialog.close();
    this.openButton.focus();
  }

  async apply() {
    if (!this.preview || this.applying || this.ui.apply.disabled) return;
    this.applying = true;
    this.hooks.setBusy(true, 'Importing…');
    this.error('');
    this.setReviewBusy(true);
    try {
      const choices = [...this.choices].map(([key, action]) => ({ key, action }));
      const result = await this.hooks.call('commitReplayImport', this.preview.token, choices);
      if (!result?.ok) {
        this.error(result?.error || 'Could not import notes. Your existing notes were kept.');
        if (result?.stale) this.preview.stale = true;
        return;
      }
      this.preview = null;
      this.ui.dialog.close();
      this.hooks.onApplied(result, `Imported ${result.added} new and replaced ${result.replaced}. Kept ${result.kept} conflicting and skipped ${result.unchanged} unchanged notes.`);
      this.openButton.focus();
    } catch { this.error('Could not import notes. Close this preview and check your saved notes before trying again.'); }
    finally {
      this.applying = false;
      this.hooks.setBusy(false);
      this.setReviewBusy(false);
      await this.refreshUndo();
    }
  }

  setReviewBusy(busy) {
    for (const key of ['cancel', 'filter', 'choice', 'keep-all', 'replace-all']) this.ui[key].disabled = busy;
    if (this.preview) {
      this.renderList();
      if (this.preview.stale) this.ui.apply.disabled = true;
    }
  }

  async undo() {
    if (this.hooks.isBusy() || this.hooks.isDirty() || !this.canUndo) return;
    this.hooks.setBusy(true, 'Undoing import…');
    this.hooks.showError('');
    try {
      const result = await this.hooks.call('undoReplayImport');
      if (result?.cancelled) return;
      if (!result?.ok) { this.hooks.showError(result?.error || 'Could not undo the import.'); return; }
      this.hooks.onApplied(result, 'Import undone. Your previous saved notes are restored.');
    } catch { this.hooks.showError('Could not undo the import. Check your saved notes before trying again.'); }
    finally { this.hooks.setBusy(false); await this.refreshUndo(); }
  }
};
