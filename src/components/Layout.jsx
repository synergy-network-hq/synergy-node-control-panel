import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { openHelpWindow } from '../lib/helpWindow';
import { checkForUpdate, downloadAndInstallUpdate, relaunchApp } from '../lib/appUpdater';
import { getVersion } from '../lib/desktopClient';
import { brandLogoSrc } from '../lib/runtimeAssets';

const UPDATE_POLL_MS = 30 * 60 * 1000;

function updateButtonLabel(updateState) {
  switch (updateState.status) {
    case 'checking':
      return 'Checking...';
    case 'available':
      return `Open ${updateState.version}`;
    case 'installing':
      return 'Opening...';
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
  const footerStatusMessage =
    updateState.status === 'available' ? `Release ${updateState.version} available` : updateState.message;

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
    }

    if (!window.confirm(`Open the release page for Synergy Devnet Control Panel ${targetVersion}?`)) {
      return;
    }

    setUpdateState((previous) => ({
      ...previous,
      status: 'installing',
      message: `Opening release ${previous.version}...`,
    }));

    const result = await downloadAndInstallUpdate();
    if (result.status === 'up_to_date') {
      setUpdateState({
        status: 'up_to_date',
        message: result.message,
        version: '',
      });
      return;
    }

    if (result.status === 'manual') {
      setUpdateState((previous) => ({
        ...previous,
        status: 'available',
        message: result.message,
      }));
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
            <Link className={`btn-header btn-header-nav ${onTransactionsRoute ? 'btn-header-active' : ''}`} to="/test-transactions">
              Test Transactions
            </Link>
            <Link className={`btn-header btn-header-nav ${onBreakStuffRoute ? 'btn-header-active' : ''}`} to="/break-stuff">
              Resilience Drills
            </Link>
            <Link className={`btn-header btn-header-nav ${onSXCPRoute ? 'btn-header-active' : ''}`} to={onSXCPRoute ? '/' : '/sxcp'}>
              {onSXCPRoute ? 'Monitor' : 'SXCP'}
            </Link>
            <button
              className={`btn-header btn-header-nav btn-update btn-update-${updateState.status}`}
              onClick={handleUpdateAction}
              disabled={updateState.status === 'checking' || updateState.status === 'installing'}
              title={updateState.message}
            >
              {updateButtonLabel(updateState)}
            </button>
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
        <span className={`footer-status footer-status-${updateState.status}`}>{footerStatusMessage}</span>
        <span className="footer-version">Synergy Devnet Control Panel v{appVersion || '...'}</span>
      </footer>
    </div>
  );
}

export default Layout;
