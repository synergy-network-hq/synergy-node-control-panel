function setupTerminalIpc(ipcMain, terminalManager) {
  ipcMain.handle('desktop:open-terminal-session', (_event, options = {}) =>
    terminalManager.openSession(options),
  );
  ipcMain.handle('desktop:write-terminal-input', (_event, payload = {}) =>
    terminalManager.writeInput(payload.sessionId, payload.input),
  );
  ipcMain.handle('desktop:resize-terminal', (_event, payload = {}) =>
    terminalManager.resizeSession(payload.sessionId, payload.cols, payload.rows),
  );
  ipcMain.handle('desktop:close-terminal-session', (_event, sessionId) =>
    terminalManager.closeSession(String(sessionId)),
  );
  ipcMain.handle('desktop:list-terminal-sessions', () =>
    terminalManager.listSessions(),
  );
}

module.exports = {
  setupTerminalIpc,
};

