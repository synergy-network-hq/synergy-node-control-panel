import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  installDownloadedUpdate,
  onUpdaterEvent,
} from '../../lib/appUpdater';
import { getVersion } from '../../lib/desktopClient';
import { ecosystemHeaderGifSrc } from '../../lib/runtimeAssets';
import { useControlPanel } from './ControlPanelProvider';
import {
  formatNumber,
  formatPercent,
  formatTimestamp,
  nodeRuntimeLabel,
  nodeRuntimeTone,
  nodeSyncPercent,
  statusTone,
} from './controlPanelModel';
import { ModeSwitcher, StatusPill } from './ControlPanelShared';

const UPDATE_POLL_MS = 30 * 60 * 1000;
const MAX_NODE_SLOTS = 4;

function updateButtonLabel(updateState) {
  switch (updateState.status) {
    case 'checking':
      return 'Checking';
    case 'available':
      return `Update ${updateState.version}`;
    case 'downloading':
      return `Downloading ${Math.round(updateState.percent || 0)}%`;
    case 'ready':
      return 'Restart to update';
    case 'installing':
      return 'Restarting';
    default:
      return 'Check updates';
  }
}

function pageMetaFor(pathname, viewMode, selectedNode) {
  if (pathname.startsWith('/connectivity')) {
    return {
      title: 'Connectivity',
      description: viewMode === 'basic'
        ? 'See who your node is talking to and whether the network path looks healthy.'
        : 'Inspect mesh reachability, peer routing, and bootstrap health.',
      jarvis: viewMode === 'basic'
        ? 'This map turns peer traffic into something readable. Focus on whether the node is connected, catching up, or needs attention.'
        : 'This page is where I will eventually explain peer health, route traffic, and trigger reconnect actions for you.',
    };
  }

  if (pathname.startsWith('/logs')) {
    return {
      title: 'System Logs',
      description: viewMode === 'basic'
        ? 'Jarvis distills the day into the moments that matter.'
        : 'Filter runtime events, source health, and raw developer traces.',
      jarvis: viewMode === 'basic'
        ? 'I am summarizing the important events so non-technical operators do not need to read raw terminal output.'
        : 'This is the live event stream. Expert and Developer views keep the underlying sources visible so you can trace what changed and when.',
    };
  }

  if (pathname.startsWith('/rewards')) {
    return {
      title: 'Rewards',
      description: viewMode === 'basic'
        ? 'See what this node has earned and what is still pending.'
        : 'Validator rewards, payout history, and economics telemetry.',
      jarvis: viewMode === 'basic'
        ? 'This page explains earnings in plain language so operators can tell whether the node is performing and getting paid.'
        : 'This is the economics surface for validator income, pending rewards, and payout trends.',
    };
  }

  if (pathname.startsWith('/node/')) {
    return {
      title: selectedNode?.display_label || 'Node Details',
      description: viewMode === 'basic'
        ? 'Health, rewards, and a plain-language explanation of how this node is doing.'
        : 'Identity, readiness, configuration, and operator controls for the selected node.',
      jarvis: viewMode === 'basic'
        ? 'This page is tuned for simple operator decisions: is the node healthy, is it earning, and what should happen next.'
        : 'This is the node control surface I will eventually operate directly from chat. For now the command UI is in place and the actions stay explicit.',
    };
  }

  if (pathname.startsWith('/settings')) {
    return {
      title: 'Settings',
      description: 'Machine-level controls, environment preferences, and destructive actions live here.',
      jarvis: 'Settings is still using the existing control-service surface. I have kept it accessible while the new operator workspace rolls out.',
    };
  }

  if (pathname.startsWith('/help')) {
    return {
      title: 'Documentation',
      description: 'Local help articles and operator documentation.',
      jarvis: 'Documentation stays close to the panel so new operators can learn without leaving the control surface.',
    };
  }

  return {
    title: 'Node Command Center',
    description: viewMode === 'basic'
      ? 'A friendlier view of your node, today’s activity, and the network around it.'
      : 'Synergy Network telemetry, node controls, topology, and operator insight in one workspace.',
    jarvis: viewMode === 'basic'
      ? 'I am keeping the overview approachable: simple language, clear health states, and the most important actions first.'
      : 'This is the new command center shell. Every page keeps Jarvis visible so future actions can move into guided chat instead of hidden menus.',
  };
}

function joinClasses(...values) {
  return values.filter(Boolean).join(' ');
}

export default function ControlPanelShell({ children, onLaunchSetup }) {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    error,
    lastUpdatedAt,
    liveStatus,
    networkStats,
    nodeLiveById,
    nodes,
    refresh,
    selectedNode,
    selectedNodeLive,
    setSelectedNodeId,
    setViewMode,
    viewMode,
  } = useControlPanel();

  const [appVersion, setAppVersion] = useState('');
  const [jarvisOpen, setJarvisOpen] = useState(false);
  const [jarvisInput, setJarvisInput] = useState('');
  const [jarvisThread, setJarvisThread] = useState([]);
  const [updateState, setUpdateState] = useState({
    status: 'idle',
    message: 'No update check has been run yet.',
    version: '',
    percent: 0,
  });

  const meta = useMemo(
    () => pageMetaFor(location.pathname, viewMode, selectedNode),
    [location.pathname, selectedNode, viewMode],
  );
  const defaultNode = selectedNode || nodes[0] || null;

  useEffect(() => {
    let disposed = false;

    const loadVersion = async () => {
      try {
        const version = await getVersion();
        if (!disposed) {
          setAppVersion(version);
        }
      } catch {
        if (!disposed) {
          setAppVersion('unknown');
        }
      }
    };

    const runCheck = async (silent = false) => {
      if (!disposed && !silent) {
        setUpdateState((previous) => ({
          ...previous,
          status: 'checking',
          message: 'Checking for updates...',
        }));
      }

      const result = await checkForUpdate();
      if (disposed) {
        return;
      }

      if (result?.error) {
        if (!silent) {
          setUpdateState({
            status: 'error',
            message: result.error,
            version: '',
            percent: 0,
          });
        }
        return;
      }

      if (result?.available) {
        setUpdateState({
          status: 'available',
          message: `Update ${result.version} is ready to download.`,
          version: result.version || '',
          percent: 0,
        });
        return;
      }

      setUpdateState({
        status: 'up_to_date',
        message: 'You are running the latest published version.',
        version: '',
        percent: 0,
      });
    };

    const unsubAvailable = onUpdaterEvent('update-available', (data) => {
      if (!disposed) {
        setUpdateState((previous) => ({
          ...previous,
          status: 'available',
          message: `Update ${data?.version || previous.version} found.`,
          version: data?.version || previous.version || '',
        }));
      }
    });

    const unsubProgress = onUpdaterEvent('download-progress', (data) => {
      if (!disposed) {
        setUpdateState((previous) => ({
          ...previous,
          status: 'downloading',
          message: 'Downloading update...',
          percent: data?.percent || 0,
        }));
      }
    });

    const unsubDownloaded = onUpdaterEvent('update-downloaded', (data) => {
      if (!disposed) {
        setUpdateState((previous) => ({
          ...previous,
          status: 'ready',
          message: `Update ${data?.version || previous.version} is ready to apply.`,
          version: data?.version || previous.version || '',
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
    void runCheck(true);

    const intervalId = window.setInterval(() => {
      void runCheck(true);
    }, UPDATE_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      unsubAvailable();
      unsubProgress();
      unsubDownloaded();
      unsubError();
    };
  }, []);

  const handleUpdateAction = async () => {
    if (updateState.status === 'downloading' || updateState.status === 'installing' || updateState.status === 'checking') {
      return;
    }

    if (updateState.status === 'ready') {
      setUpdateState((previous) => ({
        ...previous,
        status: 'installing',
        message: 'Restarting to apply the update...',
      }));
      await installDownloadedUpdate();
      return;
    }

    setUpdateState((previous) => ({
      ...previous,
      status: 'downloading',
      message: 'Downloading update...',
      percent: 0,
    }));

    const result = await downloadAndInstallUpdate();
    if (result?.status === 'error') {
      setUpdateState({
        status: 'error',
        message: result.message,
        version: updateState.version,
        percent: 0,
      });
    }
  };

  const pushJarvisMessage = (sender, text) => {
    setJarvisThread((current) => [
      ...current,
      {
        id: `${sender}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        sender,
        text,
      },
    ]);
  };

  const handleJarvisSubmit = (event) => {
    event.preventDefault();
    const value = jarvisInput.trim();
    if (!value) {
      return;
    }

    pushJarvisMessage('user', value);
    setJarvisInput('');
    setJarvisOpen(true);

    const normalized = value.toLowerCase();

    if (/genesis[\s-]*setup|open setup|start setup|setup wizard/.test(normalized)) {
      pushJarvisMessage('assistant', 'Opening the Jarvis setup flow now.');
      if (typeof onLaunchSetup === 'function') {
        onLaunchSetup();
      }
      return;
    }

    if (/connect|peer|topology|map/.test(normalized)) {
      pushJarvisMessage('assistant', 'Opening the connectivity view so you can inspect peer health and topology.');
      navigate('/connectivity');
      return;
    }

    if (/reward|earning|payout/.test(normalized)) {
      pushJarvisMessage('assistant', 'Opening the rewards workspace so you can inspect validator earnings and pending payouts.');
      navigate('/rewards');
      return;
    }

    if (/log|event|warning|error/.test(normalized)) {
      pushJarvisMessage('assistant', 'Opening the log workspace. Basic mode will keep the language simple, while Developer mode keeps the raw trail.');
      navigate('/logs');
      return;
    }

    if (/node|health|wallet|details/.test(normalized) && selectedNode) {
      pushJarvisMessage('assistant', `Opening ${selectedNode.display_label || 'the selected node'} so you can work from its control surface.`);
      navigate(`/node/${selectedNode.id}`);
      return;
    }

    if (/restart|reboot|rejoin|sync/.test(normalized)) {
      pushJarvisMessage('assistant', 'Jarvis control execution is staged in this redesign. The direct action buttons are live today, and the chat hooks are now in place for the next upgrade.');
      return;
    }

    if (/terminal/.test(normalized)) {
      pushJarvisMessage('assistant', 'The on-demand terminal is available inside Jarvis setup right now. A panel-wide terminal drawer is planned next.');
      return;
    }

    pushJarvisMessage('assistant', meta.jarvis);
  };

  const navigationItems = [
    { to: '/', label: 'Dashboard', icon: 'space_dashboard', end: true },
    { to: defaultNode ? `/node/${defaultNode.id}` : '', label: 'Node Details', icon: 'dns', disabled: !defaultNode },
    { to: '/connectivity', label: 'Connectivity', icon: 'hub' },
    { to: '/logs', label: 'System Logs', icon: 'receipt_long' },
    { to: '/rewards', label: 'Rewards', icon: 'savings' },
    { to: '/help', label: 'Documentation', icon: 'menu_book', disabled: true },
  ];

  const isNavigationItemActive = (item) => {
    if (item.label === 'Dashboard') {
      return location.pathname === '/';
    }

    if (item.label === 'Node Details') {
      return location.pathname.startsWith('/node/');
    }

    return item.to !== '/' && location.pathname.startsWith(item.to);
  };

  const networkChipTone = networkStats.publicRpcOnline ? 'good' : 'warn';
  const syncPercent = selectedNode ? nodeSyncPercent(selectedNodeLive, liveStatus) : 0;
  const syncLabel = selectedNode
    ? (syncPercent >= 99.5 ? 'Synced' : `Syncing ${formatPercent(syncPercent, 0)}`)
    : `${formatNumber(networkStats.runningNodes)} active`;

  const hasFooterUpdateState = ['checking', 'available', 'downloading', 'ready', 'installing', 'error'].includes(updateState.status);
  const footerMessage = hasFooterUpdateState ? updateState.message : error;
  const shellStatusMessage = footerMessage || `Last updated ${lastUpdatedAt ? formatTimestamp(lastUpdatedAt) : 'moments ago'}`;
  const nodeSlots = Array.from({ length: MAX_NODE_SLOTS }, (_, index) => nodes[index] || null);
  const currentYear = new Date().getFullYear();

  const handleNodeSlotClick = (node) => {
    if (!node) {
      if (typeof onLaunchSetup === 'function') {
        onLaunchSetup();
      }
      return;
    }

    setSelectedNodeId(node.id);
    navigate(`/node/${node.id}`);
  };

  return (
    <div className="cp-shell-frame">
      <div className="cp-shell">
        <aside className="cp-sidebar">
          <div className="cp-sidebar-brand">
            <div className="cp-sidebar-brand-copy">
              <strong>
                Node Operator
                <br />
                Control Panel
              </strong>
              <div className="cp-sidebar-brand-badges">
                <StatusPill tone={networkChipTone} live>
                  Network {networkStats.publicRpcOnline ? 'healthy' : 'checking'}
                </StatusPill>
                <StatusPill tone={selectedNode ? statusTone(syncLabel) : 'neutral'}>
                  {syncLabel}
                </StatusPill>
              </div>
            </div>
          </div>

          <nav className="cp-sidebar-nav" aria-label="Primary">
            {navigationItems.map((item) => (
              item.disabled ? (
                <button
                  key={item.label}
                  type="button"
                  className="cp-nav-link is-disabled"
                  disabled
                >
                  <span className="material-icons" aria-hidden="true">{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              ) : (
                <NavLink
                  key={item.label}
                  to={item.to}
                  end={item.end}
                  onClick={() => {
                    if (item.label === 'Node Details' && defaultNode) {
                      setSelectedNodeId(defaultNode.id);
                    }
                  }}
                  className={joinClasses('cp-nav-link', isNavigationItemActive(item) && 'is-active')}
                >
                  <span className="material-icons" aria-hidden="true">{item.icon}</span>
                  <span>{item.label}</span>
                </NavLink>
              )
            ))}
          </nav>

          <div className="cp-sidebar-slots">
            <span className="cp-eyebrow">Node Slots</span>
            <div className="cp-node-slot-grid">
              {nodeSlots.map((node, index) => {
                const nodeLive = node ? nodeLiveById[node.id] || null : null;
                return (
                  <button
                    key={node?.id || `empty-slot-${index}`}
                    type="button"
                    className={joinClasses(
                      'cp-node-slot',
                      node ? 'is-filled' : 'is-empty',
                      node && selectedNode?.id === node.id && 'is-selected',
                    )}
                    onClick={() => handleNodeSlotClick(node)}
                  >
                    {node ? (
                      <>
                        <strong>{node.display_label || node.role_display_name || `Node ${index + 1}`}</strong>
                        <span>{node.public_host || node.workspace_directory || 'Configured workspace'}</span>
                        <small>{nodeRuntimeLabel(nodeLive)}</small>
                      </>
                    ) : (
                      <>
                        <strong>+ Setup a New Node</strong>
                        <span>Provision another Synergy node workspace</span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="cp-sidebar-footer">
            <button
              type="button"
              className="cp-sidebar-jarvis"
              onClick={() => setJarvisOpen((current) => !current)}
            >
              <span className="material-icons" aria-hidden="true">smart_toy</span>
              <div>
                <strong>Ask Jarvis</strong>
              </div>
            </button>
            <div className="cp-sidebar-mode-panel">
              <span className="cp-eyebrow cp-sidebar-footer-label">Views</span>
              <ModeSwitcher mode={viewMode} onChange={setViewMode} compact />
            </div>
          </div>
        </aside>

        <div className="cp-main-shell">
          <header className="cp-topbar">
            <div className="cp-topbar-copy">
              <img src={ecosystemHeaderGifSrc} alt="Synergy ecosystem" className="cp-topbar-gif" />
            </div>

            <div className="cp-topbar-actions">
              <button type="button" className="cp-icon-button" onClick={() => void refresh()}>
                <span className="material-icons" aria-hidden="true">refresh</span>
              </button>
              <button type="button" className="cp-icon-button" onClick={() => navigate('/settings')}>
                <span className="material-icons" aria-hidden="true">settings</span>
              </button>
              <button
                type="button"
                className="cp-update-button"
                onClick={handleUpdateAction}
                disabled={updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'installing'}
                title={updateState.message}
              >
                {updateButtonLabel(updateState)}
              </button>
              <button type="button" className="cp-update-button cp-wallet-button" disabled>
                Connect Wallet
              </button>
            </div>
          </header>

          <main className="cp-main-content">
            <section className="cp-page-frame">
              {children}
            </section>
          </main>
        </div>
      </div>

      <footer className="cp-app-footer">
        <span className="cp-app-footer-left">© {currentYear} Synergy Network. All rights reserved.</span>
        <span className="cp-app-footer-center">{shellStatusMessage}</span>
        <span className="cp-app-footer-right">{appVersion ? `Control Panel v${appVersion}` : 'Control Panel version unavailable'}</span>
      </footer>

      <aside className={`cp-jarvis-drawer ${jarvisOpen ? 'is-open' : ''}`}>
        <div className="cp-jarvis-drawer-head">
          <div>
            <span className="cp-eyebrow">Jarvis</span>
            <h3>{meta.title}</h3>
          </div>
          <button type="button" className="cp-icon-button" onClick={() => setJarvisOpen(false)}>
            <span className="material-icons" aria-hidden="true">close</span>
          </button>
        </div>

        <div className="cp-jarvis-thread">
          <article className="cp-jarvis-message is-assistant">
            <span>Jarvis</span>
            <p>{meta.jarvis}</p>
          </article>

          {jarvisThread.map((message) => (
            <article key={message.id} className={`cp-jarvis-message ${message.sender === 'assistant' ? 'is-assistant' : 'is-user'}`}>
              <span>{message.sender === 'assistant' ? 'Jarvis' : 'You'}</span>
              <p>{message.text}</p>
            </article>
          ))}
        </div>

        <div className="cp-chip-row">
          <button type="button" className="cp-chip cp-chip-button" onClick={() => {
            setJarvisInput('Explain this page');
          }}
          >
            Explain this page
          </button>
          <button type="button" className="cp-chip cp-chip-button" onClick={() => {
            setJarvisInput('Open connectivity');
          }}
          >
            Open connectivity
          </button>
          <button type="button" className="cp-chip cp-chip-button" onClick={() => {
            setJarvisInput('Genesis setup');
          }}
          >
            Genesis setup
          </button>
        </div>

        <form className="cp-jarvis-form" onSubmit={handleJarvisSubmit}>
          <textarea
            value={jarvisInput}
            onChange={(event) => setJarvisInput(event.target.value)}
            rows={3}
            placeholder="Ask Jarvis where to go next or what this page means."
          />
          <button type="submit" className="cp-jarvis-send">Send</button>
        </form>
      </aside>
    </div>
  );
}
