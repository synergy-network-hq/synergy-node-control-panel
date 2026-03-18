const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('synergyDesktop', {
  mode: 'electron',
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  getServiceConfig: () => ipcRenderer.invoke('desktop:get-service-config'),
  invokeService: (command, args) => ipcRenderer.invoke('desktop:invoke-service', { command, args }),
  openHelpWindow: () => ipcRenderer.invoke('desktop:open-help-window'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  openPath: (targetPath) => ipcRenderer.invoke('desktop:open-path', targetPath),
  showSaveDialog: (options) => ipcRenderer.invoke('desktop:show-save-dialog', options),
  fetchSeedPeerTargets: (seedServers) =>
    ipcRenderer.invoke('desktop:fetch-seed-peer-targets', seedServers),
  readTextFile: (path) => ipcRenderer.invoke('desktop:read-text-file', path),
  writeTextFile: (path, contents) =>
    ipcRenderer.invoke('desktop:write-text-file', { path, contents }),
  relaunch: () => ipcRenderer.invoke('desktop:relaunch'),

  // Auto-update
  checkForUpdate: () => ipcRenderer.invoke('desktop:check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  onUpdaterEvent: (channel, callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
