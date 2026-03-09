import React, { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Link, useLocation } from 'react-router-dom';
import { openHelpWindow } from '../lib/helpWindow';
import { checkForUpdate, downloadAndInstallUpdate, relaunchApp } from '../lib/appUpdater';

const UPDATE_POLL_MS = 30 * 60 * 1000;

function updateButtonLabel(updateState) {
  switch (updateState.status) {
    case 'checking':
      return 'Checking...';
    case 'available':
      return `Install ${updateState.version}`;
    case 'installing':
      return 'Installing...';
    case 'installed':
      return 'Restart Required';
    default:
      return 'Check for Updates';
  }
}

function Layout({ children }) {
  const location = useLocation();
  const onHelpRoute = location.pathname === '/help';
  const onSettingsRoute = location.pathname === '/settings';
  const onSXCPRoute = location.pathname === '/sxcp';
  const onTransactionsRoute = location.pathname === '/test-transactions';
  const onBreakStuffRoute = location.pathname === '/break-stuff';

  const [appVersion, setAppVersion] = useState('');
  const [updateState, setUpdateState] = useState({
    status: 'idle',
    message: 'No update check has been run yet.',
    version: '',
  });

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

    loadVersion();
    runCheck(true);

    const interval = window.setInterval(() => {
      runCheck(true);
    }, UPDATE_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  const handleUpdateAction = async () => {
    if (updateState.status === 'checking' || updateState.status === 'installing') {
      return;
    }

    // When update is already installed, just restart.
    if (updateState.status === 'installed') {
      await relaunchApp();
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
        message: `Update ${targetVersion} is ready to download and install.`,
        version: targetVersion,
      });
    }

    if (!window.confirm(`Install Synergy Devnet Control Panel ${targetVersion}?`)) {
      return;
    }

    setUpdateState((previous) => ({
      ...previous,
      status: 'installing',
      message: `Downloading and installing ${previous.version}...`,
    }));

    const result = await downloadAndInstallUpdate();
    if (result.status === 'installed') {
      // Auto-restart to apply the update immediately.
      await relaunchApp();
      // If relaunch is delayed, update the status so the button shows "Restart Required"
      // as a fallback in case the OS takes a moment to terminate the process.
      setUpdateState((previous) => ({
        ...previous,
        status: 'installed',
        message: result.message,
      }));
      return;
    }

    if (result.status === 'up_to_date') {
      setUpdateState({
        status: 'up_to_date',
        message: result.message,
        version: '',
      });
      return;
    }

    setUpdateState({
      status: 'error',
      message: result.message,
      version: '',
    });
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <div className="header-left-status">
            <span className={`header-status-pill header-status-${updateState.status}`}>
              {updateState.status === 'available' ? `Update ${updateState.version} available` : updateState.message}
            </span>
            <button
              className={`btn-header btn-update btn-update-${updateState.status}`}
              onClick={handleUpdateAction}
              disabled={updateState.status === 'checking' || updateState.status === 'installing'}
              title={updateState.message}
            >
              {updateButtonLabel(updateState)}
            </button>
          </div>

          <div className="header-brand">
            <div className="logo-container">
              <img
                src="/snrg.gif"
                alt="Synergy Logo"
                className="logo-icon-bg"
              />
              <div className="brand-stack brand-stack-single">
                <span className="brand-title brand-title-network">Synergy Network</span>
              </div>
            </div>
          </div>

          <div className="header-right-controls">
            <Link className={`btn-header btn-header-nav ${onTransactionsRoute ? 'btn-header-active' : ''}`} to="/test-transactions">
              Test Transactions
            </Link>
            <Link className={`btn-header btn-header-nav ${onBreakStuffRoute ? 'btn-header-active' : ''}`} to="/break-stuff">
              Resilience Drills
            </Link>
            <Link className={`btn-header btn-header-nav ${onSXCPRoute ? 'btn-header-active' : ''}`} to={onSXCPRoute ? '/' : '/sxcp'}>
              {onSXCPRoute ? 'Monitor' : 'SXCP'}
            </Link>
            <Link className={`btn-header btn-header-nav ${onSettingsRoute ? 'btn-header-active' : ''}`} to={onSettingsRoute ? '/' : '/settings'}>
              {onSettingsRoute ? 'Dashboard' : 'Operator Settings'}
            </Link>
            <button className="btn-header btn-header-nav btn-help" onClick={openHelpWindow}>
              {onHelpRoute ? 'Help Window' : 'Help'}
            </button>
          </div>
        </div>
      </header>
      <main className="app-main">{children}</main>
      <footer className="app-footer">
        <span className="footer-copyright">&copy; 2026 Synergy Blockchain Labs Inc. All rights reserved.</span>
        <span className="footer-version">Synergy Devnet Control Panel v{appVersion || '...'}</span>
      </footer>
    </div>
  );
}

export default Layout;
