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
  showOpenDialog: (options) => ipcRenderer.invoke('desktop:show-open-dialog', options),
  fetchSeedPeerTargets: (seedServers) =>
    ipcRenderer.invoke('desktop:fetch-seed-peer-targets', seedServers),
  readTextFile: (path) => ipcRenderer.invoke('desktop:read-text-file', path),
  writeTextFile: (path, contents) =>
    ipcRenderer.invoke('desktop:write-text-file', { path, contents }),
  relaunch: () => ipcRenderer.invoke('desktop:relaunch'),
  openTerminalSession: (options) => ipcRenderer.invoke('desktop:open-terminal-session', options),
  writeTerminalInput: (sessionId, input) =>
    ipcRenderer.invoke('desktop:write-terminal-input', { sessionId, input }),
  resizeTerminal: (sessionId, cols, rows) =>
    ipcRenderer.invoke('desktop:resize-terminal', { sessionId, cols, rows }),
  closeTerminalSession: (sessionId) =>
    ipcRenderer.invoke('desktop:close-terminal-session', sessionId),
  listTerminalSessions: () =>
    ipcRenderer.invoke('desktop:list-terminal-sessions'),
  resolvePeerTopology: (input) =>
    ipcRenderer.invoke('desktop:resolve-peer-topology', input),

  // Auto-update
  checkForUpdate: () => ipcRenderer.invoke('desktop:check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  onUpdaterEvent: (channel, callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onTerminalOutput: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:output', listener);
    return () => ipcRenderer.removeListener('terminal:output', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  onTerminalAudit: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:audit', listener);
    return () => ipcRenderer.removeListener('terminal:audit', listener);
  },
});
