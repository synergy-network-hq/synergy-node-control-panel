import { check } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';

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

  if (
    lower.includes('download request failed with status: 404')
    || lower.includes('404 not found')
  ) {
    return 'Updater release metadata points to a missing asset (404). Regenerate and publish latest.json with valid updater bundle URLs and signatures, then retry.';
  }

  if (
    lower.includes('invalid updater binary format')
    || lower.includes('appimage')
    || lower.includes('unsupported binary format')
  ) {
    return 'Update failed: this installation does not support in-app updates (the app was installed via .deb, not AppImage). Download and install the latest .deb package manually from the releases page.';
  }

  return `Update check failed: ${text || 'unknown error'}`;
}

/**
 * Relaunch (restart) the application immediately.
 */
export async function relaunchApp() {
  await invoke('app_relaunch');
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
 * Download and install an available update.
 * The app will need to be restarted manually to apply the update.
 * Returns { status: string, message: string }
 */
export async function downloadAndInstallUpdate() {
  try {
    const update = await check();
    if (!update) {
      return { status: 'up_to_date', message: 'No updates available. You are on the latest version.' };
    }

    await update.downloadAndInstall();

    return {
      status: 'installed',
      message: `Update ${update.version} installed. Restart the app to apply the update.`,
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

    return {
      status: 'installed',
      message: `Update ${update.version} installed. Restart the app to apply the update.`,
    };
  } catch (error) {
    return { status: 'error', message: normalizeUpdateError(error) };
  }
}
