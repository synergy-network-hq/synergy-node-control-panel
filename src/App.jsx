import { useEffect, useState } from 'react';
import Layout from './components/Layout';
import NetworkMonitorNodePage from './components/NetworkMonitorNodePage';
import TestnetNodeDetail from './components/TestnetNodeDetail';
import HelpArticlesPage from './components/HelpArticlesPage';
import StartupLoadingScreen from './components/StartupLoadingScreen';
import TestnetJarvisSetup from './components/TestnetJarvisSetup';
import TestnetDashboard from './components/TestnetDashboard';
import SettingsPage from './components/SettingsPageCompact';
import ControlPanelConnectivityPage from './components/control-panel/ControlPanelConnectivityPage';
import ControlPanelFeaturePage from './components/control-panel/ControlPanelFeaturePage';
import ControlPanelLogsPage from './components/control-panel/ControlPanelLogsPage';
import ControlPanelRewardsPage from './components/control-panel/ControlPanelRewardsPage';
import { ControlPanelProvider } from './components/control-panel/ControlPanelProvider';
import NodeSyncGateModal from './components/control-panel/NodeSyncGateModal';
import { FEATURE_ROUTES } from './components/control-panel/controlPanelFeatureScreens';
import { Navigate, Route, Routes } from 'react-router-dom';
import { fetchTestnetLiveStatus, fetchTestnetState } from './lib/testnetPageData';
import { useDeveloperMode } from './lib/developerMode';

const SPLASH_DURATION_MS = 4800;
const SPLASH_FADE_OUT_MS = 720;
const POST_SPLASH_FADE_IN_DELAY_MS = 80;
const SETUP_DEFERRED_SESSION_KEY = 'snrg.setup.deferred';
const SETUP_SYNC_GATE_SESSION_KEY = 'snrg.setup.syncGateNodeId';

function setupNodeIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  return String(
    payload.syncNodeId
      || payload.nodeId
      || payload.node?.id
      || '',
  ).trim();
}

function DeveloperOnlyRoute({ children }) {
  const [developerModeEnabled] = useDeveloperMode();
  if (!developerModeEnabled) {
    return <Navigate to="/settings?developer=required" replace />;
  }
  return children;
}

function IdentityRoute() {
  const [developerModeEnabled] = useDeveloperMode();
  if (!developerModeEnabled) {
    return <Navigate to="/security" replace />;
  }
  return <ControlPanelFeaturePage screenKey="identity" />;
}

function App() {
  const [progress, setProgress] = useState(0);
  const [splashPhase, setSplashPhase] = useState('showing');
  const [setupComplete, setSetupComplete] = useState(false);
  const [setupStateReady, setSetupStateReady] = useState(false);
  const [postSplashVisible, setPostSplashVisible] = useState(false);
  const [manualSetupActive, setManualSetupActive] = useState(false);
  const [setupDeferred, setSetupDeferred] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.sessionStorage.getItem(SETUP_DEFERRED_SESSION_KEY) === '1';
  });
  const [pendingSyncNodeId, setPendingSyncNodeId] = useState(() => {
    if (typeof window === 'undefined') {
      return '';
    }
    return window.sessionStorage.getItem(SETUP_SYNC_GATE_SESSION_KEY) || '';
  });

  useEffect(() => {
    let raf = null;
    let fadeTimer = null;
    const start = performance.now();

    const tick = (timestamp) => {
      const elapsed = timestamp - start;
      const ratio = Math.min(elapsed / SPLASH_DURATION_MS, 1);
      setProgress(Math.round(ratio * 100));
      if (ratio < 1) {
        raf = window.requestAnimationFrame(tick);
      } else {
        setSplashPhase('fading');
        fadeTimer = window.setTimeout(() => {
          setSplashPhase('hidden');
        }, SPLASH_FADE_OUT_MS);
      }
    };

    raf = window.requestAnimationFrame(tick);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      if (fadeTimer) window.clearTimeout(fadeTimer);
    };
  }, []);

  useEffect(() => {
    if (splashPhase !== 'hidden') {
      setPostSplashVisible(false);
      return;
    }

    const resolveSetupState = async () => {
      try {
        const state = await fetchTestnetState({ force: true });
        const isComplete = Array.isArray(state?.nodes) && state.nodes.length > 0;
        setSetupComplete(isComplete);
        if (isComplete) {
          void fetchTestnetLiveStatus({ force: true });
        }
        if (isComplete && typeof window !== 'undefined') {
          window.sessionStorage.removeItem(SETUP_DEFERRED_SESSION_KEY);
          setSetupDeferred(false);
        }
      } catch (error) {
        setSetupComplete(false);
      } finally {
        setSetupStateReady(true);
      }
    };

    resolveSetupState();
  }, [splashPhase]);

  useEffect(() => {
    if (splashPhase !== 'hidden' || !setupStateReady || setupComplete || manualSetupActive) {
      return undefined;
    }

    const intervalId = window.setInterval(async () => {
      try {
        const state = await fetchTestnetState({ force: true });
        if (Array.isArray(state?.nodes) && state.nodes.length > 0) {
          setSetupComplete(true);
          setSetupStateReady(true);
          if (typeof window !== 'undefined') {
            window.sessionStorage.removeItem(SETUP_DEFERRED_SESSION_KEY);
          }
          setSetupDeferred(false);
        }
      } catch {
        // Keep the user in setup until the status endpoint is reachable again.
      }
    }, 3000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [manualSetupActive, setupComplete, setupStateReady, splashPhase]);

  useEffect(() => {
    if (splashPhase !== 'hidden') {
      return;
    }

    const timer = window.setTimeout(() => {
      setPostSplashVisible(true);
    }, POST_SPLASH_FADE_IN_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [splashPhase]);

  const handleSetupComplete = (payload = {}) => {
    const syncNodeId = setupNodeIdFromPayload(payload);
    setManualSetupActive(false);
    setSetupComplete(true);
    setSetupStateReady(true);
    setSetupDeferred(false);
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(SETUP_DEFERRED_SESSION_KEY);
      if (syncNodeId) {
        window.sessionStorage.setItem(SETUP_SYNC_GATE_SESSION_KEY, syncNodeId);
      }
    }
    if (syncNodeId) {
      setPendingSyncNodeId(syncNodeId);
    }
  };

  const handleSetupDeferred = () => {
    setManualSetupActive(false);
    setSetupDeferred(true);
    setSetupStateReady(true);
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(SETUP_DEFERRED_SESSION_KEY, '1');
    }
  };

  const handleLaunchSetup = () => {
    setManualSetupActive(true);
    setSetupComplete(false);
    setSetupStateReady(true);
    setSetupDeferred(false);
    setPendingSyncNodeId('');
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(SETUP_DEFERRED_SESSION_KEY);
      window.sessionStorage.removeItem(SETUP_SYNC_GATE_SESSION_KEY);
    }
  };

  const handleSyncGateComplete = () => {
    setPendingSyncNodeId('');
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(SETUP_SYNC_GATE_SESSION_KEY);
    }
  };

  if (splashPhase !== 'hidden') {
    return <StartupLoadingScreen progress={progress} phase={splashPhase} />;
  }

  let nextScreen = null;

  if (!setupStateReady) {
    nextScreen = (
      <section className="wizard-shell">
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Checking setup state...</p>
        </div>
      </section>
    );
  } else if (manualSetupActive || (!setupComplete && !setupDeferred)) {
    nextScreen = <TestnetJarvisSetup onComplete={handleSetupComplete} onDefer={handleSetupDeferred} />;
  } else {
    nextScreen = (
      <ControlPanelProvider>
        <NodeSyncGateModal nodeId={pendingSyncNodeId} onComplete={handleSyncGateComplete} />
        <Layout onLaunchSetup={handleLaunchSetup}>
          <Routes>
            <Route path="/" element={<TestnetDashboard onLaunchSetup={handleLaunchSetup} />} />
            <Route path="/activity" element={<ControlPanelLogsPage />} />
            <Route path="/connectivity" element={<ControlPanelConnectivityPage />} />
            <Route path="/logs" element={<ControlPanelLogsPage />} />
            <Route path="/rewards" element={<ControlPanelRewardsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {FEATURE_ROUTES.map((screen) => (
              <Route
                key={screen.key}
                path={screen.path}
                element={screen.key === 'identity'
                  ? <IdentityRoute />
                  : screen.developerOnly
                    ? (
                      <DeveloperOnlyRoute>
                        <ControlPanelFeaturePage screenKey={screen.key} />
                      </DeveloperOnlyRoute>
                    )
                    : <ControlPanelFeaturePage screenKey={screen.key} />}
              />
            ))}
            <Route path="/node" element={<TestnetNodeDetail />} />
            <Route path="/node/:nodeId" element={<Navigate to="/node" replace />} />
            <Route path="/fleet" element={<Navigate to="/" replace />} />
            <Route path="/monitor/:nodeSlotId" element={<NetworkMonitorNodePage />} />
            <Route path="/help" element={<HelpArticlesPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </ControlPanelProvider>
    );
  }

  return (
    <div className={`app-post-splash ${postSplashVisible ? 'is-visible' : ''}`}>
      {nextScreen}
    </div>
  );
}

export default App;
