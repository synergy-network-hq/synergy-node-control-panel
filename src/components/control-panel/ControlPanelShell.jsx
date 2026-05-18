import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  installDownloadedUpdate,
  onUpdaterEvent,
} from '../../lib/appUpdater';
import { getVersion } from '../../lib/desktopClient';
import { controlPanelBannerSrc } from '../../lib/runtimeAssets';
import { useDeveloperMode } from '../../lib/developerMode';
import { useControlPanel } from './ControlPanelProvider';
import {
  formatTimestamp,
  nodeRuntimeLabel,
} from './controlPanelModel';
import DeveloperTerminalDock from './DeveloperTerminalDock';
import { ModeSwitcher } from './ControlPanelShared';
import {
  getFeatureScreenByPathname,
} from './controlPanelFeatureScreens';
import {
  isActivityPathname,
  isNodePathname,
  navGroupsForView,
} from './routeRegistry';

const UPDATE_POLL_MS = 30 * 60 * 1000;
const SETUP_UNAVAILABLE_MESSAGE = 'Genesis setup is only available during the initial setup flow before a node exists on this machine. This control panel is already managing a configured node. I can help with diagnostics, validator readiness, rewards, connectivity, or maintenance instead.';

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
  const featureScreen = getFeatureScreenByPathname(pathname);
  if (featureScreen) {
    return {
      title: featureScreen.title,
      description: featureScreen.modeCopy?.[viewMode] || featureScreen.description,
      jarvis: featureScreen.jarvis,
    };
  }

  if (pathname.startsWith('/connectivity')) {
    return {
      title: viewMode === 'basic' ? 'Connections' : viewMode === 'advanced' ? 'Connectivity' : 'P2P',
      description: viewMode === 'basic'
        ? 'See who your node is talking to and whether the network path looks healthy.'
        : 'Inspect mesh reachability, peer routing, and bootstrap health.',
      jarvis: viewMode === 'basic'
        ? 'This map turns peer traffic into something readable. Focus on whether the node is connected, catching up, or needs attention.'
        : 'This page is where I will eventually explain peer health, route traffic, and trigger reconnect actions for you.',
    };
  }

  if (isActivityPathname(pathname)) {
    return {
      title: viewMode === 'basic' ? 'Activity' : viewMode === 'advanced' ? 'Logs' : 'Runtime Logs',
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
      title: viewMode === 'basic' ? 'Rewards + Stake' : viewMode === 'advanced' ? 'Rewards + Stake' : 'Rewards + Ledger',
      description: viewMode === 'basic'
        ? 'Wallet, stake, rewards, and payout status for this node.'
        : 'Validator wallet, staking, payout history, and economics telemetry.',
      jarvis: viewMode === 'basic'
        ? 'This page explains wallet, stake, and rewards in plain language so operators can tell whether the node is funded, participating, and getting paid.'
        : 'This is the economics surface for validator income, staking state, pending rewards, and payout trends.',
    };
  }

  if (isNodePathname(pathname)) {
    return {
      title: selectedNode?.display_label || (viewMode === 'basic' ? 'My Node' : viewMode === 'advanced' ? 'Node Details' : 'Validator Detail'),
      description: viewMode === 'basic'
        ? 'Health, readiness, runtime controls, and plain-language status for this node.'
        : 'Identity, readiness, configuration, topology, and operator controls for the selected node.',
      jarvis: viewMode === 'basic'
        ? 'This page is tuned for simple operator decisions: is the node healthy, is it ready, and what should happen next. Wallet and staking controls live on Rewards.'
        : 'This is the node runtime surface. Wallet, stake, unstake, and withdraw controls are intentionally kept on Rewards.',
    };
  }

  if (pathname.startsWith('/settings')) {
    return {
      title: 'Settings',
      description: 'Machine-level controls, environment preferences, and controlled operations live here.',
      jarvis: viewMode === 'basic'
        ? 'This page keeps maintenance safe and guided.'
        : 'This is the local operations surface for workspace visibility, machine checks, and action history.',
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

function CurrentNodeCard({ node, nodeLive, onOpen }) {
  if (!node) {
    return (
      <section className="cp-current-node-card is-empty" aria-label="Current node">
        <span className="cp-eyebrow">Current Node</span>
        <strong>No node configured</strong>
        <p>Complete initial setup to manage a local node on this machine.</p>
      </section>
    );
  }

  const syncGap = Number(nodeLive?.sync_gap);
  const peerCount = Number(nodeLive?.local_peer_count);

  return (
    <section className="cp-current-node-card" aria-label="Current node">
      <div className="cp-current-node-head">
        <span className="cp-eyebrow">Current Node</span>
        <span className={joinClasses('cp-node-health-dot', `tone-${nodeRuntimeLabel(nodeLive).toLowerCase().includes('offline') ? 'bad' : 'good'}`)}></span>
      </div>
      <strong>{node.display_label || node.role_display_name || node.id}</strong>
      <p>{node.role_display_name || node.role_id || 'Validator'} · {nodeRuntimeLabel(nodeLive)}</p>
      <div className="cp-current-node-meta">
        <span>Sync {Number.isFinite(syncGap) ? `${syncGap} gap` : 'pending'}</span>
        <span>{Number.isFinite(peerCount) ? `${peerCount} peers` : 'Peers pending'}</span>
      </div>
      <button type="button" className="cp-current-node-link" onClick={onOpen}>
        Open Node
      </button>
    </section>
  );
}

export default function ControlPanelShell({ children, onLaunchSetup }) {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    error,
    lastUpdatedAt,
    nodes,
    selectedNode,
    selectedNodeLive,
    setSelectedNodeId,
    setViewMode,
    viewMode,
  } = useControlPanel();

  const [developerModeEnabled] = useDeveloperMode();
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
    document.querySelector('.cp-main-content')?.scrollTo({ top: 0, left: 0 });
    document.querySelector('.cp-sidebar')?.scrollTo({ top: 0, left: 0 });
  }, [location.pathname]);

  useEffect(() => {
    if (!developerModeEnabled && viewMode === 'developer') {
      setViewMode('advanced');
      navigate('/', { replace: true });
    }
  }, [developerModeEnabled, navigate, setViewMode, viewMode]);

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
    const featureHit = FEATURE_SCREEN_GROUPS
      .flatMap((group) => featureNavItemsForGroup(group.id))
      .find((screen) => (
        normalized.includes(screen.label.toLowerCase())
        || normalized.includes(screen.key.toLowerCase())
        || normalized.includes(screen.title.toLowerCase().split(' ')[0])
      ));

    if (/open setup|start setup|setup wizard/.test(normalized)) {
      pushJarvisMessage('assistant', SETUP_UNAVAILABLE_MESSAGE);
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

    if (featureHit) {
      pushJarvisMessage('assistant', `Opening ${featureHit.title}.`);
      navigate(featureHit.path);
      return;
    }

    if (/node|health|details/.test(normalized) && selectedNode) {
      pushJarvisMessage('assistant', `Opening ${selectedNode.display_label || 'the selected node'} so you can inspect its runtime, readiness, topology, and recent events.`);
      navigate('/node');
      return;
    }

    if (/restart|reboot|rejoin|sync|stop|wipe|kill|pause signing|restore snapshot|apply config/.test(normalized)) {
      pushJarvisMessage('assistant', 'Finding: this request may affect uptime or local state. Evidence: risky node actions must use the normal page controls and confirmations. Recommended next step: open the related page, review the visible warning, and confirm there.');
      return;
    }

    if (/terminal/.test(normalized)) {
      pushJarvisMessage('assistant', 'Opening the developer dock is the fastest way to work from a real terminal session.');
      return;
    }

    pushJarvisMessage('assistant', meta.jarvis);
  };

  const navigationGroups = navGroupsForView(viewMode, developerModeEnabled).map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      disabled: item.key === 'details' && !defaultNode,
    })),
  }));

  const isNavigationItemActive = (item) => {
    if (item.key === 'dashboard') {
      return location.pathname === '/';
    }

    if (item.key === 'details') {
      return isNodePathname(location.pathname);
    }

    if (item.key === 'activity' || item.key === 'logs') {
      return isActivityPathname(location.pathname);
    }

    return item.to !== '/' && location.pathname.startsWith(item.to);
  };

  const hasFooterUpdateState = ['checking', 'available', 'downloading', 'ready', 'installing', 'error'].includes(updateState.status);
  const footerMessage = hasFooterUpdateState ? updateState.message : error;
  const shellStatusMessage = footerMessage || `Last updated ${lastUpdatedAt ? formatTimestamp(lastUpdatedAt) : 'moments ago'}`;
  const currentYear = new Date().getFullYear();

  return (
    <div className="cp-shell-frame" data-cp-mode={viewMode}>
      <div className="cp-shell" data-cp-mode={viewMode}>
        <aside className="cp-sidebar">
          <div className="cp-sidebar-brand">
            <img src={controlPanelBannerSrc} alt="Synergy Network Node Control Panel" className="cp-sidebar-brand-image" />
          </div>

          <CurrentNodeCard
            node={defaultNode}
            nodeLive={selectedNodeLive}
            onOpen={() => {
              if (defaultNode) {
                setSelectedNodeId(defaultNode.id);
              }
              navigate('/node');
            }}
          />

          <nav className="cp-sidebar-nav" aria-label="Primary">
            {navigationGroups.map((group) => (
              <div key={group.id} className="cp-nav-group" data-layout={group.layout}>
                <span className="cp-nav-group-label">{group.label}</span>
                {group.items.map((item) => (
                  item.disabled ? (
                    <button
                      key={item.key}
                      type="button"
                      className="cp-nav-link is-disabled"
                      disabled
                    >
                      <span className="material-icons" aria-hidden="true">{item.icon}</span>
                      <span>{item.label}</span>
                    </button>
                  ) : (
                    <NavLink
                      key={item.key}
                      to={item.to}
                      end={item.end}
                      onClick={() => {
                        if (item.key === 'details' && defaultNode) {
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
              </div>
            ))}
          </nav>

          <div className="cp-sidebar-footer">
            <div className="cp-sidebar-mode-panel">
              <span className="cp-eyebrow cp-sidebar-footer-label">Views</span>
              <ModeSwitcher mode={viewMode} onChange={setViewMode} compact allowDeveloper={developerModeEnabled} />
            </div>
          </div>
        </aside>

        <div className="cp-main-shell">
          <header className="cp-topbar">
            <div className="cp-topbar-copy">
              <div className="cp-topbar-statusbar">
                <div className="cp-topbar-statuscopy">
                  <span className="cp-eyebrow">Environment</span>
                  <strong>Testnet</strong>
                </div>
                <div className="cp-topbar-statuscopy">
                  <span className="cp-eyebrow">Selected Node</span>
                  <strong>{selectedNode?.display_label || 'None selected'}</strong>
                </div>
                <div className="cp-topbar-statuscopy">
                  <span className="cp-eyebrow">Health</span>
                  <strong>{selectedNode ? nodeRuntimeLabel(selectedNodeLive) : 'No node'}</strong>
                </div>
                <div className="cp-topbar-statuscopy">
                  <span className="cp-eyebrow">Peers</span>
                  <strong>{Number.isFinite(Number(selectedNodeLive?.local_peer_count)) ? Number(selectedNodeLive.local_peer_count) : '—'}</strong>
                </div>
              </div>
            </div>

            <div className="cp-topbar-actions">
              <button type="button" className="cp-icon-button" aria-label="Open Settings" onClick={() => navigate('/settings')}>
                <span className="material-icons" aria-hidden="true">settings</span>
              </button>
              <button type="button" className="cp-icon-button" aria-label="Open Help" onClick={() => navigate('/help')}>
                <span className="material-icons" aria-hidden="true">help</span>
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
              <button type="button" className="cp-update-button cp-wallet-button" onClick={() => navigate('/rewards')}>
                Rewards
              </button>
            </div>
          </header>

          <main className="cp-main-content">
            <section className="cp-page-frame">
              {children}
            </section>
          </main>

          <DeveloperTerminalDock />
        </div>
      </div>

      <footer className="cp-app-footer">
        <span className="cp-app-footer-left">© {currentYear} Synergy Network. All rights reserved.</span>
        <span className="cp-app-footer-center">{shellStatusMessage}</span>
        <span className="cp-app-footer-right">{appVersion ? `Control Panel v${appVersion}` : 'Control Panel version not reported'}</span>
      </footer>

      <button
        type="button"
        className="cp-floating-jarvis-launcher"
        aria-expanded={jarvisOpen}
        aria-label="Open Jarvis node assistant"
        onClick={() => setJarvisOpen((current) => !current)}
      >
        <span className="material-icons" aria-hidden="true">smart_toy</span>
        <i aria-hidden="true"></i>
      </button>

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
            setJarvisInput('Summarize node health');
          }}
          >
            Summarize health
          </button>
          <button type="button" className="cp-chip cp-chip-button" onClick={() => {
            setJarvisInput('Diagnose peers');
          }}
          >
            Diagnose peers
          </button>
          <button type="button" className="cp-chip cp-chip-button" onClick={() => {
            setJarvisInput('Explain this page');
          }}
          >
            Explain this page
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
