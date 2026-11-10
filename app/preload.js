'use strict';

// Launcher pages only. The Showdown client view never gets a preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  showClient: (bounds) => ipcRenderer.send('client:show', bounds),
  hideClient: () => ipcRenderer.send('client:hide'),
  reloadClient: () => ipcRenderer.invoke('client:reload'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  openLogs: () => ipcRenderer.invoke('settings:open-logs'),
  signOutShowdown: () => ipcRenderer.invoke('settings:sign-out'),
  resetLauncher: () => ipcRenderer.invoke('settings:reset'),
  getTheme: () => ipcRenderer.invoke('settings:get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('settings:set-theme', theme),
  getSession: () => ipcRenderer.invoke('showdown:session'),
  getShowdown: () => ipcRenderer.invoke('showdown:snapshot'),
  showdown: (action, args = {}) => ipcRenderer.invoke('showdown:action', action, args),
  getReplayNotes: () => ipcRenderer.invoke('replays:list'),
  saveReplayNote: (note) => ipcRenderer.invoke('replays:save', note),
  deleteReplayNote: (id) => ipcRenderer.invoke('replays:delete', id),
  openReplayNote: (id) => ipcRenderer.invoke('replays:open', id),
  getReplayDraft: () => ipcRenderer.invoke('replays:draft'),
  confirmDiscardReplayNote: () => ipcRenderer.invoke('replays:confirm-discard'),
  setReplayNoteDirty: (dirty) => ipcRenderer.send('replays:dirty', dirty),
});
