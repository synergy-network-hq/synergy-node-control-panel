import { useState } from 'react';
import { invoke, listen } from '../lib/desktopClient';

function SetupWizard({ onComplete }) {
  const [currentStep, setCurrentStep] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState(null);

  const handleInitialize = async () => {
    setIsProcessing(true);
    setError(null);
    setStatusMessage('Creating sandbox environment...');
    
    try {
      const nodeInfo = await invoke('init_node_environment');
      setStatusMessage('Environment initialized successfully!');
      setTimeout(() => {
        setCurrentStep(2);
        setIsProcessing(false);
      }, 1000);
    } catch (err) {
      setError(err);
      setIsProcessing(false);
    }
  };

  const handleInstall = async () => {
    setIsProcessing(true);
    setError(null);
    setProgress(0);
    
    // Listen for installation progress
    const unlisten = await listen('install-progress', (event) => {
      const data = event.payload;
      setProgress(data.progress);
      setStatusMessage(data.message);
    });

    try {
      await invoke('install_node_binaries');
      unlisten();
      setStatusMessage('Installation complete!');
      setTimeout(() => {
        setCurrentStep(3);
        setIsProcessing(false);
      }, 1000);
    } catch (err) {
      unlisten();
      setError(err);
      setIsProcessing(false);
    }
  };

  const handleFinish = async () => {
    setIsProcessing(true);
    try {
      const nodeInfo = await invoke('get_node_status');
      onComplete(nodeInfo);
    } catch (err) {
      setError(err);
      setIsProcessing(false);
    }
  };

  return (
    <div className="setup-wizard">
      <div className="wizard-container">
        <div className="wizard-header">
          <h2>Welcome to Synergy Devnet Control Panel</h2>
          <p>Let's set up your node environment in a few simple steps</p>
        </div>

        <div className="wizard-steps">
          <div className={`step ${currentStep >= 1 ? 'active' : ''} ${currentStep > 1 ? 'completed' : ''}`}>
            <div className="step-number">1</div>
            <div className="step-label">Initialize</div>
          </div>
          <div className="step-line"></div>
          <div className={`step ${currentStep >= 2 ? 'active' : ''} ${currentStep > 2 ? 'completed' : ''}`}>
            <div className="step-number">2</div>
            <div className="step-label">Install</div>
          </div>
          <div className="step-line"></div>
          <div className={`step ${currentStep >= 3 ? 'active' : ''}`}>
            <div className="step-number">3</div>
            <div className="step-label">Complete</div>
          </div>
        </div>

        <div className="wizard-content">
          {currentStep === 1 && (
            <div className="step-content">
              <h3>Initialize Environment</h3>
              <p>We'll create a sandboxed directory structure for your Synergy node at:</p>
              <code className="path-display">~/.synergy/node/</code>
              <p>This includes folders for binaries, configuration, logs, and data.</p>
              {error && <div className="error-message">{error}</div>}
              <button 
                className="btn btn-primary" 
                onClick={handleInitialize}
                disabled={isProcessing}
              >
                {isProcessing ? 'Initializing...' : 'Initialize Environment'}
              </button>
              {isProcessing && <p className="status-message">{statusMessage}</p>}
            </div>
          )}

          {currentStep === 2 && (
            <div className="step-content">
              <h3>Install Node Binaries</h3>
              <p>Download and install the Synergy node executable.</p>
              {isProcessing && (
                <div className="progress-section">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${progress}%` }}></div>
                  </div>
                  <p className="progress-text">{progress}%</p>
                  <p className="status-message">{statusMessage}</p>
                </div>
              )}
              {error && <div className="error-message">{error}</div>}
              {!isProcessing && progress === 0 && (
                <button 
                  className="btn btn-primary" 
                  onClick={handleInstall}
                >
                  Install Binaries
                </button>
              )}
            </div>
          )}

          {currentStep === 3 && (
            <div className="step-content">
              <h3>Setup Complete!</h3>
              <div className="success-icon">✓</div>
              <p>Your Synergy node environment is ready to use.</p>
              <p>You can now start your node and monitor its status from the dashboard.</p>
              <button 
                className="btn btn-success" 
                onClick={handleFinish}
                disabled={isProcessing}
              >
                {isProcessing ? 'Loading...' : 'Go to Dashboard'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SetupWizard;
