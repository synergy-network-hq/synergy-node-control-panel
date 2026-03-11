import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let mainWindow = null;
let helpWindow = null;
let controlServiceProcess = null;
let controlServiceConfig = null;

function getRendererEntry(hash = '/') {
  if (process.env.ELECTRON_START_URL) {
    const url = new URL(process.env.ELECTRON_START_URL);
    url.hash = hash;
    return url.toString();
  }

  const indexPath = path.join(repoRoot, 'dist', 'index.html');
  const url = new URL(`file://${indexPath}`);
  url.hash = hash;
  return url.toString();
}

async function findAvailablePort(startPort = 47891, attempts = 20) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
    if (available) {
      return port;
    }
  }

  throw new Error(`No available control-service port found starting at ${startPort}.`);
}

function getServiceEnv() {
  return {
    ...process.env,
    SYNERGY_RESOURCE_ROOT: app.isPackaged ? process.resourcesPath : repoRoot,
    SYNERGY_APP_DATA_DIR: app.getPath('userData'),
  };
}

function getPackagedServiceBinaryPath() {
  const executable = process.platform === 'win32' ? 'control-service.exe' : 'control-service';
  return path.join(process.resourcesPath, 'control-service', executable);
}

function getDevServiceBinaryPath() {
  const executable = process.platform === 'win32' ? 'control-service.exe' : 'control-service';
  const stagedBinary = path.join(repoRoot, 'build', 'electron-runtime', 'control-service', executable);
  if (existsSync(stagedBinary)) {
    return stagedBinary;
  }

  const cargoReleaseBinary = path.join(repoRoot, 'src-tauri', 'target', 'release', executable);
  if (existsSync(cargoReleaseBinary)) {
    return cargoReleaseBinary;
  }

  return null;
}

function attachProcessLogging(child) {
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(`[control-service] ${chunk}`);
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[control-service] ${chunk}`);
  });
  child.on('exit', (code, signal) => {
    console.error(`control-service exited with code=${code} signal=${signal}`);
  });
}

async function startControlService() {
  const port = await findAvailablePort();
  const token = crypto.randomBytes(24).toString('hex');
  const env = getServiceEnv();

  if (app.isPackaged) {
    controlServiceProcess = spawn(
      getPackagedServiceBinaryPath(),
      ['--port', String(port), '--token', token],
      {
        cwd: process.resourcesPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } else {
    const devBinary = getDevServiceBinaryPath();
    if (devBinary) {
      controlServiceProcess = spawn(devBinary, ['--port', String(port), '--token', token], {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      controlServiceProcess = spawn(
        'cargo',
        [
          'run',
          '--manifest-path',
          path.join(repoRoot, 'src-tauri', 'Cargo.toml'),
          '--bin',
          'control-service',
          '--',
          '--port',
          String(port),
          '--token',
          token,
        ],
        {
          cwd: repoRoot,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    }
  }

  attachProcessLogging(controlServiceProcess);
  controlServiceConfig = {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
  };

  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const response = await fetch(`${controlServiceConfig.baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until health succeeds.
    }
  }

  throw new Error('control-service failed to become healthy.');
}

async function createWindow(hash = '/') {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    show: false,
    center: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.mjs'),
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  await window.loadURL(getRendererEntry(hash));
  return window;
}

async function createMainWindow() {
  mainWindow = await createWindow('/');
}

async function openHelpWindow() {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.focus();
    return;
  }

  helpWindow = await createWindow('/help');
  helpWindow.on('closed', () => {
    helpWindow = null;
  });
}

function setupIpc() {
  ipcMain.handle('desktop:get-version', () => app.getVersion());
  ipcMain.handle('desktop:get-service-config', () => controlServiceConfig);
  ipcMain.handle('desktop:open-help-window', () => openHelpWindow());
  ipcMain.handle('desktop:open-external', (_event, url) => shell.openExternal(url));
  ipcMain.handle('desktop:show-save-dialog', async (_event, options) => {
    const result = await dialog.showSaveDialog(mainWindow, options);
    return result.canceled ? null : result.filePath;
  });
  ipcMain.handle('desktop:write-text-file', async (_event, { path: filePath, contents }) => {
    await fs.writeFile(filePath, contents, 'utf8');
    return true;
  });
  ipcMain.handle('desktop:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (controlServiceProcess) {
    controlServiceProcess.kill();
    controlServiceProcess = null;
  }
});

app.whenReady().then(async () => {
  await startControlService();
  setupIpc();
  await createMainWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
