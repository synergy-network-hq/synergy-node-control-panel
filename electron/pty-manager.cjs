const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');

function resolveShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function resolveShellArgs(shellPath) {
  if (process.platform === 'win32') {
    return shellPath.toLowerCase().includes('powershell')
      ? ['-NoLogo']
      : [];
  }
  const basename = path.basename(shellPath);
  return basename === 'bash' || basename === 'zsh' ? ['-l'] : [];
}

function createPtyManager({
  onOutput = () => {},
  onExit = () => {},
  onAudit = () => {},
} = {}) {
  const sessions = new Map();
  let nextId = 1;

  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown terminal session: ${sessionId}`);
    }
    return session;
  }

  function emitAudit(event) {
    onAudit({
      at: Date.now(),
      source: 'terminal',
      ...event,
    });
  }

  function openSession(options = {}) {
    const shell = resolveShell();
    const cwd = options.cwd || os.homedir();
    const cols = Number(options.cols) || 120;
    const rows = Number(options.rows) || 30;
    const sessionId = String(nextId++);
    const terminal = pty.spawn(shell, resolveShellArgs(shell), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    });

    const session = {
      id: sessionId,
      terminal,
      cwd,
      name: options.name || 'Shell',
      history: [],
      pendingInput: '',
    };

    terminal.onData((data) => {
      onOutput({
        sessionId,
        data,
      });
    });

    terminal.onExit((result) => {
      emitAudit({
        title: 'Terminal session closed',
        detail: `${session.name} exited with code ${result.exitCode}.`,
        status: result.exitCode === 0 ? 'good' : 'bad',
        code: String(result.exitCode),
        sessionId,
      });
      onExit({
        sessionId,
        ...result,
      });
      sessions.delete(sessionId);
    });

    sessions.set(sessionId, session);
    emitAudit({
      title: 'Terminal session opened',
      detail: `${session.name} started in ${cwd}.`,
      status: 'good',
      command: shell,
      sessionId,
    });

    return {
      sessionId,
      cwd,
      name: session.name,
      shell,
      cols,
      rows,
    };
  }

  function writeInput(sessionId, input) {
    const session = getSession(sessionId);
    const data = String(input || '');
    session.terminal.write(data);
    session.pendingInput += data;

    const lines = session.pendingInput.split(/\r?\n/);
    session.pendingInput = lines.pop() || '';
    lines
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((command) => {
        session.history.push({
          at: Date.now(),
          command,
        });
        if (session.history.length > 100) {
          session.history.shift();
        }
        emitAudit({
          title: 'Terminal command',
          detail: command,
          status: 'info',
          command,
          sessionId,
        });
      });

    return true;
  }

  function resizeSession(sessionId, cols, rows) {
    const session = getSession(sessionId);
    const nextCols = Math.max(40, Number(cols) || 120);
    const nextRows = Math.max(12, Number(rows) || 30);
    session.terminal.resize(nextCols, nextRows);
    return {
      sessionId,
      cols: nextCols,
      rows: nextRows,
    };
  }

  function closeSession(sessionId) {
    const session = getSession(sessionId);
    session.terminal.kill();
    return true;
  }

  function listSessions() {
    return Array.from(sessions.values()).map((session) => ({
      sessionId: session.id,
      cwd: session.cwd,
      name: session.name,
      history: session.history,
    }));
  }

  function closeAllSessions() {
    Array.from(sessions.keys()).forEach((sessionId) => {
      try {
        closeSession(sessionId);
      } catch {
        // Ignore already-closed sessions during shutdown.
      }
    });
  }

  return {
    closeAllSessions,
    closeSession,
    listSessions,
    openSession,
    resizeSession,
    writeInput,
  };
}

module.exports = {
  createPtyManager,
};

