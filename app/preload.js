'use strict';

// Launcher pages only. The Showdown client view never gets a preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  showClient: (bounds) => ipcRenderer.send('client:show', bounds),
  hideClient: () => ipcRenderer.send('client:hide'),
  reloadClient: () => ipcRenderer.send('client:reload'),
  getTheme: () => ipcRenderer.invoke('settings:get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('settings:set-theme', theme),
  getSession: () => ipcRenderer.invoke('showdown:session'),
  getShowdown: () => ipcRenderer.invoke('showdown:snapshot'),
  showdown: (action, args = {}) => ipcRenderer.invoke('showdown:action', action, args),
});
