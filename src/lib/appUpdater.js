import { getVersion, openExternal } from './desktopClient';

const RELEASES_PAGE = 'https://github.com/synergy-network-hq/synergy-node-control-panel-releases/releases/latest';

function getBridge() {
  if (typeof window !== 'undefined' && window.synergyDesktop) {
    return window.synergyDesktop;
  }
  return null;
}

function hasNativeUpdater() {
  const bridge = getBridge();
  return !!(bridge?.checkForUpdate && bridge?.downloadUpdate && bridge?.installUpdate);
}

/**
 * Relaunch (restart) the application immediately.
 */
export async function relaunchApp() {
  const bridge = getBridge();
  if (bridge?.relaunch) {
    await bridge.relaunch();
  }
}

/**
 * Check if an update is available.
 * Returns { available: boolean, version?: string, currentVersion?: string, error?: string }
 */
export async function checkForUpdate() {
  try {
    if (hasNativeUpdater()) {
      const bridge = getBridge();
      const result = await bridge.checkForUpdate();
      const updateInfo = result?.updateInfo;
      if (updateInfo?.version) {
        const currentVersion = await getVersion();
        const isNewer = compareVersions(updateInfo.version, currentVersion) > 0;
        return {
          available: isNewer,
          version: updateInfo.version,
          currentVersion,
        };
      }
      return { available: false };
    }

    // Fallback: check GitHub releases API
    return await checkForPublishedUpdate();
  } catch (error) {
    return { available: false, error: normalizeUpdateError(error) };
  }
}

/**
 * Download and install an available update.
 * Returns { status: string, message: string }
 */
export async function downloadAndInstallUpdate() {
  try {
    if (hasNativeUpdater()) {
      const bridge = getBridge();
      await bridge.downloadUpdate();
      return {
        status: 'downloading',
        message: 'Downloading update. The app will restart automatically when ready.',
      };
    }

    // Fallback: open releases page for manual download
    await openExternal(RELEASES_PAGE);
    return {
      status: 'manual',
      message: 'Opened the releases page. Download the installer for your platform.',
    };
  } catch (error) {
    // If native updater fails (e.g. Linux deb), fall back to manual
    await openExternal(RELEASES_PAGE);
    return {
      status: 'manual',
      message: 'Auto-update is not available for this install type. Opened the releases page — download the latest installer for your platform.',
    };
  }
}

/**
 * Quit and install the downloaded update.
 */
export async function installDownloadedUpdate() {
  if (hasNativeUpdater()) {
    const bridge = getBridge();
    await bridge.installUpdate();
  }
}

/**
 * Subscribe to updater events from the main process.
 * Returns an unsubscribe function.
 */
export function onUpdaterEvent(eventName, callback) {
  const bridge = getBridge();
  if (bridge?.onUpdaterEvent) {
    return bridge.onUpdaterEvent(`updater:${eventName}`, callback);
  }
  return () => {};
}

/**
 * Legacy combined check-and-install function (kept for compatibility).
 */
export async function checkAndInstallAppUpdate() {
  return downloadAndInstallUpdate();
}

// ── Internal helpers ──

const RELEASES_API_LATEST = 'https://api.github.com/repos/synergy-network-hq/synergy-node-control-panel-releases/releases/latest';

function parseVersionParts(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '');
  return normalized.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const a = leftParts[index] || 0;
    const b = rightParts[index] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

async function checkForPublishedUpdate() {
  const currentVersion = await getVersion();
  const response = await fetch(RELEASES_API_LATEST, {
    headers: { Accept: 'application/vnd.github+json' },
  });

  if (!response.ok) {
    throw new Error(`GitHub release lookup failed with status ${response.status}`);
  }

  const release = await response.json();
  const latestVersion = String(release?.tag_name || '').replace(/^v/i, '');
  if (!latestVersion) {
    throw new Error('Latest GitHub release does not contain a version tag.');
  }

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return { available: false };
  }

  return { available: true, version: latestVersion, currentVersion };
}

function normalizeUpdateError(error) {
  const text = String(error?.message ?? error ?? '').trim();
  const lower = text.toLowerCase();

  if (lower.includes('network') || lower.includes('timed out') || lower.includes('timeout')) {
    return 'Update check failed due to network/timeout. Verify internet access.';
  }

  if (lower.includes('404') || lower.includes('not found')) {
    return 'No update metadata found. A new release may not have been published yet.';
  }

  return `Update check failed: ${text || 'unknown error'}`;
}
