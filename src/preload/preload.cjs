const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dexpad', {
  getState: () => ipcRenderer.invoke('dexpad:get-state'),
  getProfiles: () => ipcRenderer.invoke('dexpad:get-profiles'),
  switchProfile: (id) => ipcRenderer.invoke('dexpad:switch-profile', id),
  createProfile: (name) => ipcRenderer.invoke('dexpad:create-profile', name),
  setStartup: (enabled) => ipcRenderer.invoke('dexpad:set-startup', enabled),
  setWallpaperMode: (enabled) => ipcRenderer.invoke('dexpad:set-wallpaper-mode', enabled),
  setState: (state) => ipcRenderer.invoke('dexpad:set-state', state),
  saveCards: (cards) => ipcRenderer.invoke('dexpad:save-cards', cards),
  saveWorkspace: (workspace) => ipcRenderer.invoke('dexpad:save-workspace', workspace),
  saveWorkspaceSync: (workspace) => ipcRenderer.sendSync('dexpad:save-workspace-sync', workspace),
  openWorkspace: () => ipcRenderer.invoke('dexpad:open-workspace'),
  refreshWallpaper: () => ipcRenderer.invoke('dexpad:refresh-wallpaper'),
  openUrl: (url) => ipcRenderer.invoke('dexpad:open-url', url),
  onStateUpdated: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('dexpad:state-updated', listener);
    return () => ipcRenderer.removeListener('dexpad:state-updated', listener);
  }
});
