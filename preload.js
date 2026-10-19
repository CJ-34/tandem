'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  setTheme: (theme) => ipcRenderer.send('app:theme', theme),
  drives: () => ipcRenderer.invoke('fs:drives'),
  list: (dir) => ipcRenderer.invoke('fs:list', dir),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  existing: (paths) => ipcRenderer.invoke('fs:existing', paths),
  transfer: (opts) => ipcRenderer.invoke('fs:transfer', opts),
  cancel: (id) => ipcRenderer.send('op:cancel', id),
  onProgress: (cb) => ipcRenderer.on('op:progress', (_e, p) => cb(p)),
  trash: (paths) => ipcRenderer.invoke('fs:trash', paths),
  mkdir: (dir, name) => ipcRenderer.invoke('fs:mkdir', dir, name),
  mkfile: (dir, name) => ipcRenderer.invoke('fs:mkfile', dir, name),
  rename: (from, name) => ipcRenderer.invoke('fs:rename', from, name),
  dirSize: (p) => ipcRenderer.invoke('fs:dirsize', p),
  preview: (p, maxText) => ipcRenderer.invoke('fs:preview', p, maxText),
  watch: (key, dir) => ipcRenderer.send('fs:watch', key, dir),
  onChanged: (cb) => ipcRenderer.on('fs:changed', (_e, key) => cb(key)),
  clipRead: () => ipcRenderer.invoke('clip:read'),
  clipWrite: (paths, cut) => ipcRenderer.invoke('clip:write', paths, cut),
  clipClear: () => ipcRenderer.invoke('clip:clear'),
  open: (p) => ipcRenderer.invoke('shell:open', p),
  reveal: (p) => ipcRenderer.send('shell:reveal', p),
  onFocus: (cb) => ipcRenderer.on('window-focus', () => cb()),
});
