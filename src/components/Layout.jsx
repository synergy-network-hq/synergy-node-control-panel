import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { openHelpWindow } from '../lib/helpWindow';
import { checkForUpdate, downloadAndInstallUpdate, installDownloadedUpdate, onUpdaterEvent } from '../lib/appUpdater';
import { getVersion } from '../lib/desktopClient';
import { brandLogoSrc } from '../lib/runtimeAssets';
import { SNRGButton } from '../styles/SNRGButton';

const UPDATE_POLL_MS = 30 * 60 * 1000;

function updateButtonLabel(updateState) {
  switch (updateState.status) {
    case 'checking':
      return 'Checking...';
    case 'available':
      return `Update to ${updateState.version}`;
    case 'downloading':
      return `Downloading ${updateState.percent ? Math.round(updateState.percent) + '%' : '...'}`;
    case 'ready':
      return 'Restart to Update';
    case 'installing':
      return 'Restarting...';
    default:
      return 'Check for Updates';
  }
}

function Layout({ children }) {
  const location = useLocation();
  const onSettingsRoute = location.pathname === '/settings';
  const onDashboardRoute = location.pathname === '/';

  const [appVersion, setAppVersion] = useState('');
  const [updateState, setUpdateState] = useState({
    status: 'idle',
    message: 'No update check has been run yet.',
    version: '',
    percent: 0,
  });
  const footerStatusMessage =
    updateState.status === 'available'
      ? `Release ${updateState.version} available`
      : updateState.status === 'downloading'
        ? `Downloading update ${updateState.version}... ${Math.round(updateState.percent || 0)}%`
        : updateState.status === 'ready'
          ? `Update ${updateState.version} ready — restart to apply`
          : updateState.message;

  useEffect(() => {
    let disposed = false;

    const loadVersion = async () => {
      try {
        const version = await getVersion();
        if (!disposed) {
          setAppVersion(version);
        }
      } catch (error) {
        if (!disposed) {
          setAppVersion('unknown');
        }
      }
    };

    const runCheck = async (silent = false) => {
      if (!disposed) {
        setUpdateState((previous) => ({
          ...previous,
          status: 'checking',
          message: silent && previous.message ? previous.message : 'Checking for updates...',
        }));
      }

      const result = await checkForUpdate();
      if (disposed) return;

      if (result?.error) {
        setUpdateState({
          status: 'error',
          message: result.error,
          version: '',
        });
        return;
      }

      if (result?.available) {
        setUpdateState({
          status: 'available',
          message: `Update ${result.version} is ready to download and install.`,
          version: result.version || '',
        });
        return;
      }

      setUpdateState({
        status: 'up_to_date',
        message: 'You are running the latest published version.',
        version: '',
      });
    };

    // Listen for native updater events from main process
    const unsubProgress = onUpdaterEvent('download-progress', (data) => {
      if (!disposed) {
        setUpdateState((previous) => ({
          ...previous,
          status: 'downloading',
          message: `Downloading update...`,
          percent: data?.percent || 0,
        }));
      }
    });

    const unsubDownloaded = onUpdaterEvent('update-downloaded', (data) => {
      if (!disposed) {
        setUpdateState((previous) => ({
          ...previous,
          status: 'ready',
          message: `Update ${data?.version || previous.version} downloaded. Restart to apply.`,
          version: data?.version || previous.version,
        }));
      }
    });

    const unsubError = onUpdaterEvent('error', (data) => {
      if (!disposed) {
        setUpdateState((previous) => ({
          ...previous,
          status: 'error',
          message: data?.message || 'Update failed.',
        }));
      }
    });

    loadVersion();
    runCheck(true);

    const interval = window.setInterval(() => {
      runCheck(true);
    }, UPDATE_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      unsubProgress();
      unsubDownloaded();
      unsubError();
    };
  }, []);

  const handleUpdateAction = async () => {
    if (updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'installing') {
      return;
    }

    // If update is downloaded and ready, install it
    if (updateState.status === 'ready') {
      setUpdateState((previous) => ({
        ...previous,
        status: 'installing',
        message: 'Restarting to apply update...',
      }));
      await installDownloadedUpdate();
      return;
    }

    let targetVersion = updateState.version;

    if (updateState.status !== 'available') {
      const result = await checkForUpdate();
      if (result?.error) {
        setUpdateState({
          status: 'error',
          message: result.error,
          version: '',
        });
        return;
      }

      if (!result?.available) {
        setUpdateState({
          status: 'up_to_date',
          message: 'You are running the latest published version.',
          version: '',
        });
        return;
      }

      targetVersion = result.version || '';
      setUpdateState({
        status: 'available',
        message: `Release ${targetVersion} is ready to download.`,
        version: targetVersion,
      });
      return;
    }

    // Download the update
    setUpdateState((previous) => ({
      ...previous,
      status: 'downloading',
      message: `Downloading update ${previous.version}...`,
      percent: 0,
    }));

    const result = await downloadAndInstallUpdate();

    if (result.status === 'manual') {
      setUpdateState((previous) => ({
        ...previous,
        status: 'available',
        message: result.message,
      }));
    } else if (result.status === 'up_to_date') {
      setUpdateState({
        status: 'up_to_date',
        message: result.message,
        version: '',
      });
    } else if (result.status === 'error') {
      setUpdateState({
        status: 'error',
        message: result.message,
        version: '',
      });
    }
    // 'downloading' status is handled by the updater events above
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <div className="header-brand">
            <div className="logo-container">
              <img
                src={brandLogoSrc}
                alt="Synergy Logo"
                className="logo-icon-bg"
              />
              <div className="brand-stack brand-stack-single">
                <span className="brand-title brand-title-network">Synergy Network</span>
              </div>
            </div>
          </div>

          <div className="header-right-controls">
            <SNRGButton
              as={Link}
              to="/"
              variant="blue"
              size="sm"
              className={`header-grid-btn ${onDashboardRoute ? 'header-grid-active' : ''}`}
            >
              Dashboard
            </SNRGButton>
            <SNRGButton
              variant="cyan"
              size="sm"
              className="header-grid-btn header-grid-help"
              onClick={openHelpWindow}
            >
              Help
            </SNRGButton>
            <SNRGButton
              as={Link}
              to="/settings"
              variant="blue"
              size="sm"
              className={`header-grid-btn ${onSettingsRoute ? 'header-grid-active' : ''}`}
            >
              Settings
            </SNRGButton>
            <SNRGButton
              variant="blue"
              size="sm"
              className={`header-grid-btn header-grid-update header-grid-update-${updateState.status}`}
              onClick={handleUpdateAction}
              disabled={updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'installing'}
              title={updateState.message}
            >
              {updateButtonLabel(updateState)}
            </SNRGButton>
          </div>
        </div>
      </header>
      <main className="app-main">{children}</main>
      <footer className="app-footer">
        <span className="footer-copyright">&copy; 2026 Synergy Blockchain Labs Inc. All rights reserved.</span>
        <span className={`footer-status footer-status-${updateState.status}`}>{footerStatusMessage}</span>
        <span className="footer-version">Synergy Node Control Panel v{appVersion || '...'}</span>
      </footer>
    </div>
  );
}

export default Layout;
