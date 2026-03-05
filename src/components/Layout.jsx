import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { openHelpWindow } from '../lib/helpWindow';

const APP_VERSION = '2.4.1';

function Layout({ children }) {
  const location = useLocation();
  const onHelpRoute = location.pathname === '/help';
  const onSettingsRoute = location.pathname === '/settings';
  const onSXCPRoute = location.pathname === '/sxcp';

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
            <Link className="btn-header" to={onSXCPRoute ? '/' : '/sxcp'}>
              {onSXCPRoute ? 'Monitor' : 'SXCP'}
            </Link>
            <Link className="btn-header" to={onSettingsRoute ? '/' : '/settings'}>
              {onSettingsRoute ? 'Dashboard' : 'Settings'}
            </Link>
            <button className="btn-header btn-help" onClick={openHelpWindow}>
              {onHelpRoute ? 'Help Window' : 'Help'}
            </button>
          </div>
        </div>
      </header>
      <main className="app-main">{children}</main>
      <footer className="app-footer">
        <span className="footer-copyright">&copy; 2026 Synergy Blockchain Labs Inc. All rights reserved.</span>
        <span className="footer-version">Control Center v{APP_VERSION}</span>
      </footer>
    </div>
  );
}

export default Layout;
