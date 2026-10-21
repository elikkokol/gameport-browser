'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = ['state', 'network', 'focus-url', 'open-settings'];

contextBridge.exposeInMainWorld('api', {
  newTab: (url) => call('tab:new', url),
  closeTab: (id) => call('tab:close', id),
  activateTab: (id) => call('tab:activate', id),
  muteTab: (id) => call('tab:mute', id),
  nav: (action) => call('nav', action),
  navigate: (input) => call('navigate', input),
  toggleMedia: () => call('media:toggle'),
  overlay: (open) => call('overlay', open),
  getNetwork: () => call('network:get'),
  getSettings: () => call('settings:get'),
  saveSettings: (cfg) => call('settings:save', cfg),
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {};
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  }
});
