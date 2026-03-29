const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const repoRoot = path.resolve(__dirname, '..');
const appIconPngPath = path.join(repoRoot, 'control-service', 'icons', 'icon.png');

let mainWindow = null;
let helpWindow = null;
let controlServiceProcess = null;
let controlServiceConfig = null;
const SERVICE_INVOKE_RETRY_DELAYS_MS = [0, 160, 320, 560];

function getRendererEntry(hash = '/') {
  if (process.env.ELECTRON_START_URL) {
    const url = new URL(process.env.ELECTRON_START_URL);
    url.hash = hash;
    return url.toString();
  }
  return null;
}

function getRendererIndexPath() {
  return path.join(repoRoot, 'dist', 'index.html');
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
  const cargoReleaseBinary = path.join(repoRoot, 'control-service', 'target', 'release', executable);
  if (existsSync(cargoReleaseBinary)) {
    return cargoReleaseBinary;
  }

  const stagedBinary = path.join(repoRoot, 'build', 'electron-runtime', 'control-service', executable);
  if (existsSync(stagedBinary)) {
    return stagedBinary;
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeSeedPeerListUrl(seedServer) {
  if (typeof seedServer !== 'string') {
    return null;
  }

  const trimmed = seedServer.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const [, remainder = ''] = trimmed.split('://', 2);
    return remainder.includes('/') ? trimmed : `${trimmed}/peer-list.json`;
  }

  return `http://${trimmed}/peer-list.json`;
}

async function fetchSeedPeerTargets(seedServers = []) {
  const targets = new Set();
  const failures = [];
  const inputs = Array.isArray(seedServers) ? seedServers : [];

  await Promise.all(inputs.map(async (seedServer) => {
    const url = normalizeSeedPeerListUrl(seedServer);
    if (!url) {
      return;
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`);
        return;
      }

      const payload = await response.json();
      const peers = Array.isArray(payload?.peers) ? payload.peers : [];
      peers.forEach((peer) => {
        if (typeof peer === 'string' && peer.trim()) {
          targets.add(peer.trim());
        }
      });
    } catch (error) {
      failures.push(`${url}: ${error?.message || String(error)}`);
    }
  }));

  return {
    targets: Array.from(targets).sort(),
    failures,
  };
}

async function invokeControlService(command, args = {}) {
  if (!controlServiceConfig?.baseUrl || !controlServiceConfig?.token) {
    throw new Error('control-service is not configured.');
  }

  let lastError = null;

  for (const delayMs of SERVICE_INVOKE_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const response = await fetch(`${controlServiceConfig.baseUrl}/v1/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${controlServiceConfig.token}`,
        },
        body: JSON.stringify({
          command,
          args,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(String(payload?.error || `Command failed: ${command}`));
      }

      return payload?.data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Command failed: ${command}`);
}

async function startControlService() {
  const port = await findAvailablePort();
  const token = crypto.randomBytes(24).toString('hex');
  const env = getServiceEnv();

  if (app.isPackaged) {
    console.log(`[control-service] starting packaged binary: ${getPackagedServiceBinaryPath()}`);
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
      console.log(`[control-service] starting dev binary: ${devBinary}`);
      controlServiceProcess = spawn(devBinary, ['--port', String(port), '--token', token], {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      console.log('[control-service] no dev binary found, falling back to cargo run');
      controlServiceProcess = spawn(
        'cargo',
        [
          'run',
          '--manifest-path',
          path.join(repoRoot, 'control-service', 'Cargo.toml'),
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
    icon: appIconPngPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`renderer failed to load (${errorCode}): ${errorDescription} -> ${validatedURL}`);
  });

  const rendererEntry = getRendererEntry(hash);
  if (rendererEntry) {
    await window.loadURL(rendererEntry);
  } else {
    await window.loadFile(getRendererIndexPath(), { hash });
  }
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

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  // Ensure the updater knows where to look for releases
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'synergy-network-hq',
    repo: 'synergy-node-control-panel-releases',
  });

  console.log('[auto-updater] configured: github provider -> synergy-network-hq/synergy-node-control-panel-releases');

  autoUpdater.on('update-available', (info) => {
    console.log(`[auto-updater] update available: ${info.version}`);

    if (mainWindow) {
      mainWindow.webContents.send('updater:update-available', {
        version: info.version,
        releaseDate: info.releaseDate,
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log(`[auto-updater] no update available (current: ${app.getVersion()})`);
    if (mainWindow) {
      mainWindow.webContents.send('updater:update-not-available');
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) {
      mainWindow.webContents.send('updater:download-progress', {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[auto-updater] update downloaded: ${info.version}`);
    if (mainWindow) {
      mainWindow.webContents.send('updater:update-downloaded', {
        version: info.version,
      });
    }
  });

  autoUpdater.on('error', (error) => {
    console.error(`[auto-updater] error: ${error?.message || error}`);
    if (mainWindow) {
      mainWindow.webContents.send('updater:error', {
        message: error?.message || 'Unknown update error',
      });
    }
  });
}

function setupIpc() {
  ipcMain.handle('desktop:get-version', () => app.getVersion());
  ipcMain.handle('desktop:get-service-config', () => controlServiceConfig);
  ipcMain.handle('desktop:invoke-service', async (_event, request = {}) =>
    invokeControlService(request.command, request.args || {}),
  );
  ipcMain.handle('desktop:open-help-window', () => openHelpWindow());
  ipcMain.handle('desktop:open-external', (_event, url) => shell.openExternal(url));
  ipcMain.handle('desktop:open-path', (_event, targetPath) => shell.openPath(targetPath));
  ipcMain.handle('desktop:show-save-dialog', async (_event, options) => {
    const result = await dialog.showSaveDialog(mainWindow, options);
    return result.canceled ? null : result.filePath;
  });
  ipcMain.handle('desktop:show-open-dialog', async (_event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, options);
    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
  ipcMain.handle('desktop:fetch-seed-peer-targets', async (_event, seedServers) =>
    fetchSeedPeerTargets(seedServers),
  );
  ipcMain.handle('desktop:read-text-file', async (_event, filePath) =>
    fs.readFile(filePath, 'utf8'),
  );
  ipcMain.handle('desktop:write-text-file', async (_event, { path: filePath, contents }) => {
    await fs.writeFile(filePath, contents, 'utf8');
    return true;
  });
  ipcMain.handle('desktop:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  // Auto-update IPC
  ipcMain.handle('desktop:check-for-update', async () => {
    console.log('[auto-updater] check-for-update requested by renderer');
    try {
      return await autoUpdater.checkForUpdates();
    } catch (error) {
      console.error(`[auto-updater] checkForUpdates failed: ${error.message}`);
      throw error;
    }
  });
  ipcMain.handle('desktop:download-update', async () => {
    console.log('[auto-updater] download-update requested by renderer');
    try {
      return await autoUpdater.downloadUpdate();
    } catch (error) {
      console.error(`[auto-updater] downloadUpdate failed: ${error.message}`);
      throw error;
    }
  });
  ipcMain.handle('desktop:install-update', () => {
    console.log('[auto-updater] install-update (quitAndInstall) requested by renderer');
    autoUpdater.quitAndInstall(false, true);
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
  if (process.platform === 'darwin' && existsSync(appIconPngPath)) {
    app.dock.setIcon(nativeImage.createFromPath(appIconPngPath));
  }

  await startControlService();
  setupAutoUpdater();
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
