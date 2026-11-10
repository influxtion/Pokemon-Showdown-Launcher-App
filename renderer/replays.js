'use strict';

(() => {
  const desktop = window.desktop;
  const $ = (id) => document.getElementById(id);
  const ui = {
    export: $('export-replays'), exportStatus: $('export-status'),
    add: $('add-replay'), search: $('replay-search'), filter: $('replay-format-filter'),
    list: $('replay-list'), count: $('replay-count'), listEmpty: $('replay-list-empty'),
    detailEmpty: $('replay-detail-empty'), editor: $('replay-editor'), error: $('replay-error'),
    form: $('replay-form'), title: $('note-title'), format: $('note-format'),
    url: $('note-url'), body: $('note-body'), titleCount: $('title-count'),
    bodyCount: $('body-count'), titleError: $('title-error'), formatError: $('format-error'),
    urlError: $('url-error'),
    meta: $('replay-meta'), created: $('note-created'), updated: $('note-updated'),
    status: $('note-status'), save: $('save-note'), delete: $('delete-note'), open: $('open-replay'),
  };
  const draftKey = 'replayNote.editorDraft';
  let notes = [];
  let selectedId = null;
  let editing = false;
  let pending = false;
  let baseline = null;
  let dirty = false;
  let loaded = false;
  let imports = null;
  let review = null;

  const resultError = (result, fallback) =>
    result && typeof result.error === 'string' && result.error ? result.error : fallback;
  const call = async (method, ...args) => {
    if (!desktop || typeof desktop[method] !== 'function') throw new Error('Replay notes are unavailable.');
    return desktop[method](...args);
  };
  const dateText = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  };
  const shortDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  };
  const fields = () => ({
    id: selectedId, title: ui.title.value, format: ui.format.value,
    url: ui.url.value, notes: ui.body.value,
  });
  const setStatus = (message) => { ui.status.textContent = message; };
  const setError = (message, existingId = null) => {
    ui.error.replaceChildren();
    ui.error.hidden = !message;
    if (!message) return;
    const span = document.createElement('span');
    span.textContent = message;
    ui.error.append(span);
    if (existingId && notes.some((note) => note.id === existingId)) {
      const button = document.createElement('button');
      button.className = 'btn';
      button.type = 'button';
      button.textContent = 'Open saved note';
      button.addEventListener('click', () => selectNote(existingId));
      ui.error.append(button);
    }
  };
  const setPending = (value, action = 'Saving…') => {
    pending = value;
    [ui.title, ui.format, ui.url, ui.body].forEach((field) => { field.disabled = value; });
    ui.save.disabled = value;
    ui.delete.disabled = value || !selectedId;
    ui.open.disabled = value || !selectedId;
    ui.add.disabled = value;
    ui.export.disabled = value || !notes.length;
    imports?.setBusy(value);
    review?.updateButton();
    if (value) setStatus(action);
    else if (editing) updateDirty();
  };
  const storeDraft = () => {
    try {
      if (dirty) sessionStorage.setItem(draftKey, JSON.stringify(fields()));
      else sessionStorage.removeItem(draftKey);
    } catch {}
  };
  const updateDirty = () => {
    if (!editing || !baseline) dirty = false;
    else {
      const current = fields();
      dirty = ['id', 'title', 'format', 'url', 'notes'].some((key) => current[key] !== baseline[key]);
    }
    storeDraft();
    if (desktop && typeof desktop.setReplayNoteDirty === 'function') desktop.setReplayNoteDirty(dirty);
    imports?.setBusy(pending);
    review?.updateButton();
    if (!pending) setStatus(dirty ? 'Unsaved changes' : (selectedId ? 'Saved' : ''));
    ui.titleCount.textContent = `${ui.title.value.length} / 120`;
    ui.bodyCount.textContent = `${ui.body.value.length} / 5000`;
  };
  const readDraft = () => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey));
      if (!draft || typeof draft !== 'object') return null;
      if (!['title', 'format', 'url', 'notes'].every((key) => typeof draft[key] === 'string')) return null;
      return {
        id: typeof draft.id === 'string' ? draft.id : null,
        title: draft.title.slice(0, 120), format: draft.format.slice(0, 80),
        url: draft.url.slice(0, 300), notes: draft.notes.slice(0, 5000),
      };
    } catch { return null; }
  };
  const showEditor = (data, original = null) => {
    selectedId = original ? original.id : null;
    editing = true;
    ui.editor.hidden = false;
    ui.detailEmpty.hidden = true;
    ui.title.value = data.title || '';
    ui.format.value = data.format || '';
    ui.url.value = data.url || '';
    ui.url.readOnly = Boolean(original);
    ui.body.value = data.notes || '';
    ui.meta.hidden = !original;
    if (original) {
      ui.created.textContent = dateText(original.createdAt);
      ui.updated.textContent = dateText(original.updatedAt);
    }
    ui.delete.disabled = !original;
    ui.open.disabled = !original;
    ui.title.removeAttribute('aria-invalid');
    ui.format.removeAttribute('aria-invalid');
    ui.url.removeAttribute('aria-invalid');
    ui.titleError.textContent = '';
    ui.formatError.textContent = '';
    ui.urlError.textContent = '';
    setError('');
    baseline = original
      ? { id: original.id, title: original.title.replace(/[\r\n]/g, ''), format: original.format,
          url: original.url, notes: original.notes.replace(/\r\n?/g, '\n') }
      : { id: null, title: '', format: '', url: '', notes: '' };
    updateDirty();
    renderList();
  };
  const showEmpty = (message) => {
    selectedId = null;
    editing = false;
    baseline = null;
    ui.editor.hidden = true;
    ui.detailEmpty.hidden = false;
    ui.detailEmpty.textContent = message;
    updateDirty();
    renderList();
  };
  const confirmDiscard = async () => {
    if (!dirty) return true;
    try { return Boolean(await call('confirmDiscardReplayNote')); }
    catch (error) { setError(error.message || 'Could not confirm discarding changes.'); return false; }
  };
  const selectNote = async (id) => {
    if (pending || (editing && id === selectedId)) return;
    const note = notes.find((item) => item.id === id);
    if (!note || !(await confirmDiscard())) return;
    showEditor(note, note);
  };
  const addReplay = async (prefill = null) => {
    if (pending || !(await confirmDiscard())) return;
    showEditor({ title: prefill?.title || '', format: prefill?.format || '',
      url: prefill?.url || '', notes: '' });
    ui.url.focus();
  };
  const renderFormats = () => {
    const prior = ui.filter.value;
    const formats = [...new Set(notes.map((note) => note.format).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    ui.filter.replaceChildren(new Option('All formats', ''));
    formats.forEach((format) => ui.filter.add(new Option(format, format)));
    ui.filter.value = formats.includes(prior) ? prior : '';
  };
  const renderList = () => {
    ui.export.disabled = pending || !notes.length;
    const query = ui.search.value.trim().toLocaleLowerCase();
    const format = ui.filter.value;
    const matches = notes.filter((note) => (!format || note.format === format) &&
      (!query || [note.title, note.format, note.notes].some((part) =>
        part.toLocaleLowerCase().includes(query))));
    ui.count.textContent = `${notes.length} saved${matches.length !== notes.length ? ` · ${matches.length} shown` : ''}`;
    ui.list.replaceChildren();
    matches.forEach((note) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'note-item';
      if (note.id === selectedId) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => selectNote(note.id));
      const title = document.createElement('span');
      title.className = 'note-item-title';
      title.textContent = note.title;
      const meta = document.createElement('span');
      meta.className = 'note-item-meta';
      if (note.format) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = note.format;
        meta.append(tag);
      }
      const date = document.createElement('span');
      date.className = 'num';
      date.textContent = shortDate(note.updatedAt);
      meta.append(date);
      const snippet = document.createElement('span');
      snippet.className = 'note-item-snippet';
      snippet.textContent = note.notes || note.url;
      button.append(title, meta, snippet);
      li.append(button);
      ui.list.append(li);
    });
    ui.listEmpty.hidden = matches.length > 0;
    ui.listEmpty.textContent = notes.length ? 'No notes match your search.' : 'No replay notes yet. Add a replay to start.';
  };
  const validate = () => {
    let valid = true;
    const title = ui.title.value.trim();
    const format = ui.format.value.trim();
    const url = ui.url.value.trim();
    ui.titleError.textContent = title ? '' : 'Enter a title.';
    ui.title.setAttribute('aria-invalid', String(!title));
    if (!title) { valid = false; ui.title.focus(); }
    const formatValid = /^[a-z0-9]{0,80}$/.test(format);
    ui.formatError.textContent = formatValid ? '' : 'Use lowercase letters and numbers.';
    ui.format.setAttribute('aria-invalid', String(!formatValid));
    if (!formatValid) { valid = false; if (title) ui.format.focus(); }
    let urlValid = false;
    try {
      const parsed = new URL(url);
      const replayId = parsed.pathname.slice(1).replace(/\/$/, '');
      urlValid = ['http:', 'https:'].includes(parsed.protocol) &&
        parsed.hostname === 'replay.pokemonshowdown.com' && !parsed.port &&
        !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
        /^([a-z0-9]+)-[0-9]+(?:-[a-z0-9]+pw)?$/.test(replayId);
    } catch {}
    ui.urlError.textContent = !url ? 'Paste a replay link.' :
      urlValid ? '' : 'Enter a valid Pokémon Showdown replay link.';
    ui.url.setAttribute('aria-invalid', String(!urlValid));
    if (!urlValid) { valid = false; if (title) ui.url.focus(); }
    return valid;
  };
  const save = async (event) => {
    event.preventDefault();
    if (pending || !validate()) return;
    setError('');
    setPending(true);
    try {
      const input = fields();
      const result = await call('saveReplayNote', {
        ...(selectedId ? { id: selectedId } : {}),
        title: input.title.trim(), format: input.format.trim(),
        url: input.url.trim(), notes: input.notes,
      });
      if (!result || !result.ok || !result.note) {
        setError(resultError(result, 'Could not save the note.'), result?.existingId);
        return;
      }
      notes = [result.note, ...notes.filter((note) => note.id !== result.note.id)]
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      renderFormats();
      showEditor(result.note, result.note);
      setStatus('Saved');
      await imports.refreshUndo();
    } catch (error) {
      setError(error.message || 'Could not save the note.');
    } finally { setPending(false); }
  };
  const remove = async () => {
    if (pending || !selectedId) return;
    setError('');
    setPending(true, 'Deleting…');
    try {
      const result = await call('deleteReplayNote', selectedId);
      if (result?.cancelled) return;
      if (!result?.ok) { setError(resultError(result, 'Could not delete the note.')); return; }
      const removedId = selectedId;
      notes = notes.filter((note) => note.id !== removedId);
      renderFormats();
      if (notes.length) showEditor(notes[0], notes[0]);
      else showEmpty('No replay notes yet. Choose Add replay to start.');
      await imports.refreshUndo();
    } catch (error) { setError(error.message || 'Could not delete the note.'); }
    finally { setPending(false); }
  };
  const openReplay = async () => {
    if (pending || !selectedId) return;
    setError('');
    try {
      const result = await call('openReplayNote', selectedId);
      if (!result?.ok) setError(resultError(result, 'Could not open the replay.'));
    } catch (error) { setError(error.message || 'Could not open the replay.'); }
  };
  const exportNotes = async () => {
    if (pending || !notes.length) return;
    setError('');
    ui.exportStatus.hidden = true;
    setPending(true, 'Exporting…');
    try {
      const result = await call('exportReplayNotes');
      if (result?.cancelled) return;
      if (!result?.ok) { setError(resultError(result, 'Could not export replay notes.')); return; }
      ui.exportStatus.textContent = `Exported ${result.count} saved ${result.count === 1 ? 'note' : 'notes'}.` +
        (dirty ? ' Unsaved changes were not included.' : '');
      ui.exportStatus.hidden = false;
    } catch (error) { setError(error.message || 'Could not export replay notes.'); }
    finally { setPending(false); }
  };
  const init = async () => {
    try {
      const result = await call('getReplayNotes');
      if (!result?.ok || !Array.isArray(result.notes)) {
        throw new Error(resultError(result, 'Could not load replay notes.'));
      }
      notes = result.notes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      renderFormats();
      const params = new URLSearchParams(location.search);
      const requestedId = params.get('review') || params.get('id');
      const wantsDraft = !review.active && params.get('draft') === '1';
      const stored = readDraft();
      let prefill = null;
      let draftError = '';
      if (wantsDraft) {
        try {
          const draftResult = await call('getReplayDraft');
          if (draftResult?.ok) prefill = draftResult.draft;
          else draftError = resultError(draftResult, 'Could not prepare a replay note.');
        } catch (error) { draftError = error.message || 'Could not prepare a replay note.'; }
      }
      if (stored && wantsDraft) {
        // Keep an existing unsaved edit unless the user explicitly discards it.
        const restore = stored.id && notes.find((note) => note.id === stored.id);
        showEditor(stored, restore || null);
        if (await confirmDiscard()) showEditor(prefill || {});
      } else if (stored) {
        const original = stored.id && notes.find((note) => note.id === stored.id);
        showEditor(stored, original || null);
      } else if (wantsDraft) showEditor(prefill || {});
      else if (requestedId && notes.some((note) => note.id === requestedId)) {
        const note = notes.find((item) => item.id === requestedId);
        showEditor(note, note);
      } else if (review.active) showEmpty('This saved replay note was not found. Return to notes to choose another replay.');
      else if (notes.length) showEditor(notes[0], notes[0]);
      else showEmpty('No replay notes yet. Choose Add replay to start.');
      renderList();
      if (draftError) setError(draftError);
      loaded = true;
      await imports.refreshUndo();
      await review.start();
    } catch (error) {
      ui.count.textContent = 'Could not load';
      ui.listEmpty.hidden = false;
      ui.listEmpty.textContent = 'Replay notes could not be loaded.';
      ui.editor.hidden = true;
      ui.detailEmpty.hidden = false;
      ui.detailEmpty.textContent = 'Replay notes could not be loaded.';
      ui.add.disabled = true;
      dirty = Boolean(readDraft());
      if (desktop && typeof desktop.setReplayNoteDirty === 'function') desktop.setReplayNoteDirty(dirty);
      setError(error.message || 'Could not load replay notes.');
      review.fail('Replay notes could not be loaded. Your saved file was not changed.');
    }
  };

  review = new window.ReplayReviewUI({ call, selectedId: () => selectedId, isBusy: () => pending, showError: setError });
  imports = new window.ReplayImportUI({
    call, isReady: () => loaded, isDirty: () => dirty, isBusy: () => pending, setBusy: setPending, showError: setError,
    onApplied(result, message) {
      notes = result.notes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const selected = notes.find((note) => note.id === selectedId) || notes[0];
      ui.search.value = '';
      ui.filter.value = '';
      renderFormats();
      if (selected) showEditor(selected, selected);
      else showEmpty('No replay notes yet. Choose Add replay or Import notes to start.');
      ui.exportStatus.textContent = message;
      ui.exportStatus.hidden = false;
    },
  });

  ui.add.addEventListener('click', () => addReplay());
  ui.export.addEventListener('click', exportNotes);
  ui.search.addEventListener('input', renderList);
  ui.filter.addEventListener('change', renderList);
  ui.form.addEventListener('submit', save);
  ui.delete.addEventListener('click', remove);
  ui.open.addEventListener('click', openReplay);
  document.addEventListener('keydown', (event) => {
    if (document.getElementById('import-dialog').open) return;
    if (event.isComposing || event.altKey) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'f') {
      if (review.active) return;
      event.preventDefault();
      ui.search.focus();
      ui.search.select();
    } else if (command && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (editing && !pending) ui.form.requestSubmit();
    } else if (event.key === 'Escape' && event.target === ui.search) {
      event.preventDefault();
      ui.search.value = '';
      renderList();
    }
  });
  [ui.title, ui.format, ui.url, ui.body].forEach((field) => field.addEventListener('input', () => {
    ui.exportStatus.hidden = true;
    setError('');
    if (field === ui.title) { ui.title.removeAttribute('aria-invalid'); ui.titleError.textContent = ''; }
    if (field === ui.format) { ui.format.removeAttribute('aria-invalid'); ui.formatError.textContent = ''; }
    if (field === ui.url) { ui.url.removeAttribute('aria-invalid'); ui.urlError.textContent = ''; }
    updateDirty();
  }));
  init();
})();
