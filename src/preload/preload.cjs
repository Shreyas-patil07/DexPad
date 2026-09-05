const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dexpad', {
  getState: () => ipcRenderer.invoke('dexpad:get-state'),
  setState: (state) => ipcRenderer.invoke('dexpad:set-state', state),
  openWorkspace: () => ipcRenderer.invoke('dexpad:open-workspace'),
  openUrl: (url) => ipcRenderer.invoke('dexpad:open-url', url)
});
