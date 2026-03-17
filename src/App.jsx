import { useEffect, useState } from 'react';
import Layout from './components/Layout';
import NetworkMonitorNodePage from './components/NetworkMonitorNodePage';
import HelpArticlesPage from './components/HelpArticlesPage';
import SettingsPage from './components/SettingsPage';
import StartupLoadingScreen from './components/StartupLoadingScreen';
import TestnetBetaJarvisSetup from './components/TestnetBetaJarvisSetup';
import TestnetBetaDashboard from './components/TestnetBetaDashboard';
import { Navigate, Route, Routes } from 'react-router-dom';
import { invoke } from './lib/desktopClient';

const SPLASH_DURATION_MS = 4800;
const SPLASH_FADE_OUT_MS = 720;
const POST_SPLASH_FADE_IN_DELAY_MS = 80;
const SETUP_DEFERRED_SESSION_KEY = 'snrg.setup.deferred';

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
        const state = await invoke('testbeta_get_state');
        const isComplete = Array.isArray(state?.nodes) && state.nodes.length > 0;
        setSetupComplete(isComplete);
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
        const state = await invoke('testbeta_get_state');
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

  const handleSetupComplete = () => {
    setManualSetupActive(false);
    setSetupComplete(true);
    setSetupStateReady(true);
    setSetupDeferred(false);
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(SETUP_DEFERRED_SESSION_KEY);
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
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(SETUP_DEFERRED_SESSION_KEY);
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
    nextScreen = <TestnetBetaJarvisSetup onComplete={handleSetupComplete} onDefer={handleSetupDeferred} />;
  } else {
    nextScreen = (
      <Layout>
        <Routes>
          <Route path="/" element={<TestnetBetaDashboard onLaunchSetup={handleLaunchSetup} />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/node/:nodeSlotId" element={<NetworkMonitorNodePage />} />
          <Route path="/help" element={<HelpArticlesPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    );
  }

  return (
    <div className={`app-post-splash ${postSplashVisible ? 'is-visible' : ''}`}>
      {nextScreen}
    </div>
  );
}

export default App;
