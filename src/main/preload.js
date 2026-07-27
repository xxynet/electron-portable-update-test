'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portableTest', {
  buildInfo: () => ipcRenderer.invoke('build-info'),
  backendStatus: () => ipcRenderer.invoke('backend-status'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, status) => callback(status)),
});
