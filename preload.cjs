'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  isElectron: true,
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    addOffline: name => ipcRenderer.invoke('accounts:addOffline', name),
    msLogin: () => ipcRenderer.invoke('accounts:msLogin'),
    remove: id => ipcRenderer.invoke('accounts:remove', id),
    select: id => ipcRenderer.invoke('accounts:select', id),
    setSkin: (id, variant) => ipcRenderer.invoke('accounts:setSkin', { id, variant })
  },
  onMsProgress(cb) {
    const sub = (_e, d) => cb(d);
    ipcRenderer.on('ms:progress', sub);
    return () => ipcRenderer.removeListener('ms:progress', sub);
  },
  versions: { list: () => ipcRenderer.invoke('versions:list') },
  profiles: { list: () => ipcRenderer.invoke('profiles:list') },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: patch => ipcRenderer.invoke('settings:set', patch)
  },
  java: {
    status: () => ipcRenderer.invoke('java:status'),
    ensure: mcVersion => ipcRenderer.invoke('java:ensure', mcVersion)
  },
  game: {
    launch: opts => ipcRenderer.invoke('game:launch', opts),
    kill: () => ipcRenderer.invoke('game:kill'),
    dir: () => ipcRenderer.invoke('gameDir')
  },
  mods: {
    search: q => ipcRenderer.invoke('mods:search', q),
    install: project => ipcRenderer.invoke('mods:install', project),
    installPack: () => ipcRenderer.invoke('mods:installPack'),
    list: () => ipcRenderer.invoke('mods:list'),
    toggle: (file, enable) => ipcRenderer.invoke('mods:toggle', { file, enable }),
    remove: file => ipcRenderer.invoke('mods:remove', file)
  },
  keybinds: {
    list: () => ipcRenderer.invoke('keybinds:list'),
    save: name => ipcRenderer.invoke('keybinds:save', name),
    apply: name => ipcRenderer.invoke('keybinds:apply', name),
    remove: name => ipcRenderer.invoke('keybinds:remove', name),
    currentCount: () => ipcRenderer.invoke('keybinds:currentCount')
  },
  shots: {
    list: () => ipcRenderer.invoke('shots:list'),
    open: name => ipcRenderer.invoke('shots:open', name)
  },
  shell: { open: which => ipcRenderer.invoke('shell:openPath', which) },
  updates: { check: () => ipcRenderer.invoke('update:check') },
  onProgress(cb) {
    const sub = (_e, data) => cb(data);
    ipcRenderer.on('game:progress', sub);
    return () => ipcRenderer.removeListener('game:progress', sub);
  },
  win: {
    min: () => ipcRenderer.send('win:min'),
    max: () => ipcRenderer.send('win:max'),
    close: () => ipcRenderer.send('win:close')
  }
};

contextBridge.exposeInMainWorld('fantasy', api);
