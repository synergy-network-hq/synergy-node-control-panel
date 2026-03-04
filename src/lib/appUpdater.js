import { check } from '@tauri-apps/plugin-updater';

// Try to import relaunch — if plugin-process isn't available, fall back gracefully.
let relaunchApp = null;
try {
  const processModule = await import('@tauri-apps/plugin-process');
  relaunchApp = processModule.relaunch;
} catch (_) {
  // plugin-process not installed; relaunch will require manual app restart
}

function normalizeUpdateError(error) {
  const text = String(error ?? '').trim();
  const lower = text.toLowerCase();

  if (
    lower.includes('updater is not configured')
    || lower.includes('empty endpoints')
    || lower.includes('endpoints')
    || lower.includes('pubkey')
  ) {
    return 'Updater is not configured yet. Configure updater endpoints + signing pubkey in tauri.conf.json, then rebuild.';
  }

  if (lower.includes('network') || lower.includes('timed out') || lower.includes('timeout')) {
    return 'Update check failed due to network/timeout. Verify internet access and updater endpoint availability.';
  }

  return `Update check failed: ${text || 'unknown error'}`;
}

/**
 * Check if an update is available without installing it.
 * Returns { available: boolean, version?: string, currentVersion?: string, error?: string }
 */
export async function checkForUpdate() {
  try {
    const update = await check();
    if (!update) {
      return { available: false };
    }
    return {
      available: true,
      version: update.version,
      currentVersion: update.currentVersion,
    };
  } catch (error) {
    return { available: false, error: normalizeUpdateError(error) };
  }
}

/**
 * Download and install an available update, then relaunch the app.
 * Returns { status: string, message: string }
 */
export async function downloadAndInstallUpdate() {
  try {
    const update = await check();
    if (!update) {
      return { status: 'up_to_date', message: 'No updates available. You are on the latest version.' };
    }

    await update.downloadAndInstall();

    // Relaunch the app to apply the update
    try {
      if (relaunchApp) await relaunchApp();
    } catch (_) {
      // relaunch may not return (or may not be available)
    }

    return {
      status: 'installed',
      message: `Update ${update.version} installed. The app will restart momentarily.`,
    };
  } catch (error) {
    return { status: 'error', message: normalizeUpdateError(error) };
  }
}

/**
 * Legacy combined check-and-install function (kept for compatibility).
 */
export async function checkAndInstallAppUpdate() {
  try {
    const update = await check();
    if (!update) {
      return { status: 'up_to_date', message: 'No updates available. You are on the latest version.' };
    }

    const confirmInstall = window.confirm(
      `Update available: ${update.currentVersion} -> ${update.version}\n\nInstall now?`
    );
    if (!confirmInstall) {
      await update.close();
      return {
        status: 'cancelled',
        message: `Update ${update.version} is available but installation was cancelled.`,
      };
    }

    await update.downloadAndInstall();

    try {
      if (relaunchApp) await relaunchApp();
    } catch (_) {
      // relaunch may not return (or may not be available)
    }

    return {
      status: 'installed',
      message: `Update ${update.version} installed. Restart the app to run the new version.`,
    };
  } catch (error) {
    return { status: 'error', message: normalizeUpdateError(error) };
  }
}
