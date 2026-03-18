import { getVersion, openExternal, relaunchApp as relaunchDesktopApp } from './desktopClient';

const RELEASES_API_LATEST = 'https://api.github.com/repos/synergy-network-hq/synergy-node-control-panel-releases/releases/latest';
const RELEASES_PAGE = 'https://github.com/synergy-network-hq/synergy-node-control-panel-releases/releases/latest';

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
    headers: {
      Accept: 'application/vnd.github+json',
    },
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

  return {
    available: true,
    version: latestVersion,
    currentVersion,
  };
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
    return 'Updater is not configured yet. Publish the latest installers to GitHub releases and rebuild the Electron desktop package.';
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
  await relaunchDesktopApp();
}

/**
 * Check if an update is available without installing it.
 * Returns { available: boolean, version?: string, currentVersion?: string, error?: string }
 */
export async function checkForUpdate() {
  try {
    return await checkForPublishedUpdate();
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
    const update = await checkForPublishedUpdate();
    if (!update?.available) {
      return { status: 'up_to_date', message: 'No updates available. You are on the latest version.' };
    }

    await openExternal(RELEASES_PAGE);

    return {
      status: 'manual',
      message: `Opened the latest release page for ${update.version}. Download the installer package for your platform.`,
    };
  } catch (error) {
    return { status: 'error', message: normalizeUpdateError(error) };
  }
}

/**
 * Legacy combined check-and-install function (kept for compatibility).
 */
export async function checkAndInstallAppUpdate() {
  return downloadAndInstallUpdate();
}
