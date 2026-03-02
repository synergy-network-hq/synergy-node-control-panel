import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Layout from './components/Layout';
import NetworkMonitorDashboard from './components/NetworkMonitorDashboard';
import NetworkMonitorNodePage from './components/NetworkMonitorNodePage';
import HelpArticlesPage from './components/HelpArticlesPage';
import OperatorConfigurationPage from './components/OperatorConfigurationPage';
import InitialSetupWizard from './components/InitialSetupWizard';
import StartupLoadingScreen from './components/StartupLoadingScreen';
import { Navigate, Route, Routes } from 'react-router-dom';

const SPLASH_DURATION_MS = 6000;
const SPLASH_FADE_OUT_MS = 800;
const POST_SPLASH_FADE_IN_DELAY_MS = 60;

function App() {
  const [progress, setProgress] = useState(0);
  const [splashPhase, setSplashPhase] = useState('showing');
  const [setupComplete, setSetupComplete] = useState(false);
  const [setupStateReady, setSetupStateReady] = useState(false);
  const [postSplashVisible, setPostSplashVisible] = useState(false);

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
        await invoke('monitor_initialize_workspace');
        await invoke('monitor_apply_eight_machine_topology');
        const setupStatus = await invoke('monitor_get_setup_status');
        setSetupComplete(Boolean(setupStatus?.completed));
      } catch (error) {
        setSetupComplete(false);
      } finally {
        setSetupStateReady(true);
      }
    };

    resolveSetupState();
  }, [splashPhase]);

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
    setSetupComplete(true);
    setSetupStateReady(true);
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
  } else if (!setupComplete) {
    nextScreen = <InitialSetupWizard onComplete={handleSetupComplete} />;
  } else {
    nextScreen = (
      <Layout>
        <Routes>
          <Route path="/" element={<NetworkMonitorDashboard />} />
          <Route path="/settings" element={<OperatorConfigurationPage />} />
          <Route path="/node/:machineId" element={<NetworkMonitorNodePage />} />
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
