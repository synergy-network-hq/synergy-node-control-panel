import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { openHelpWindow } from '../lib/helpWindow';
import { checkForUpdate, downloadAndInstallUpdate } from '../lib/appUpdater';

const APP_VERSION = '2.1.8';

function Layout({ children }) {
  const location = useLocation();
  const onHelpRoute = location.pathname === '/help';
  const onSettingsRoute = location.pathname === '/settings';
  const [updateStatus, setUpdateStatus] = useState('');
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [availableVersion, setAvailableVersion] = useState('');
  const [installing, setInstalling] = useState(false);

  // Check for updates on mount and every 30 minutes
  useEffect(() => {
    const doCheck = async () => {
      const result = await checkForUpdate();
      if (result.available) {
        setUpdateAvailable(true);
        setAvailableVersion(result.version || '');
      }
    };
    doCheck();
    const interval = setInterval(doCheck, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const onCheckUpdates = async () => {
    if (updateAvailable) {
      // Update is available — start the install process
      setInstalling(true);
      setUpdateStatus(`Installing update ${availableVersion}...`);
      const result = await downloadAndInstallUpdate();
      setUpdateStatus(result.message);
      setInstalling(false);
      if (result.status === 'installed') {
        setUpdateAvailable(false);
      }
    } else {
      // No update known yet — do a manual check
      setCheckingUpdates(true);
      setUpdateStatus('Checking for updates...');
      const result = await checkForUpdate();
      if (result.available) {
        setUpdateAvailable(true);
        setAvailableVersion(result.version || '');
        setUpdateStatus(`Update ${result.version} is available!`);
      } else if (result.error) {
        setUpdateStatus(result.error);
      } else {
        setUpdateStatus('You are on the latest version.');
      }
      setCheckingUpdates(false);
    }
  };

  const updateButtonLabel = () => {
    if (installing) return 'Installing...';
    if (checkingUpdates) return 'Checking...';
    if (updateAvailable) return `Update Available${availableVersion ? ` (${availableVersion})` : ''}`;
    return 'Check for Updates';
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <div className="header-brand">
            <div className="logo-container">
              <img
                src="/snrg.gif"
                alt="Synergy Logo"
                className="logo-icon-bg"
              />
              <span className="brand-title">Synergy Network</span>
            </div>
          </div>

          <div className="header-right-controls">
            <Link className="btn-header" to={onSettingsRoute ? '/' : '/settings'}>
              {onSettingsRoute ? 'Dashboard' : 'Settings'}
            </Link>
            <button
              className={`btn-header btn-update${updateAvailable ? ' btn-update-available' : ''}`}
              onClick={onCheckUpdates}
              disabled={checkingUpdates || installing}
              title={updateAvailable ? `Update to ${availableVersion}` : 'Check for software updates'}
            >
              {updateAvailable && !installing ? (
                <svg
                  className="update-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              ) : null}
              {updateButtonLabel()}
            </button>
            <button className="btn-header btn-help" onClick={openHelpWindow}>
              {onHelpRoute ? 'Help Window' : 'Help'}
            </button>
          </div>
        </div>
      </header>
      <main className="app-main">{children}</main>
      <footer className="app-footer">
        {updateStatus ? <span>{updateStatus}</span> : null}
        <span className="footer-copyright">&copy; 2026 Synergy Blockchain Labs Inc. All rights reserved.</span>
        <span className="footer-version">Control Center v{APP_VERSION}</span>
      </footer>
    </div>
  );
}

export default Layout;
