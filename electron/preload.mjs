import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('synergyDesktop', {
  mode: 'electron',
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  getServiceConfig: () => ipcRenderer.invoke('desktop:get-service-config'),
  openHelpWindow: () => ipcRenderer.invoke('desktop:open-help-window'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  showSaveDialog: (options) => ipcRenderer.invoke('desktop:show-save-dialog', options),
  writeTextFile: (path, contents) => ipcRenderer.invoke('desktop:write-text-file', { path, contents }),
  relaunch: () => ipcRenderer.invoke('desktop:relaunch'),
});
