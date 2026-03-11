import { useState, useEffect } from 'react';
import { invoke } from '../lib/desktopClient';

function NodeSetupWizard({ onComplete }) {
  const [currentStep, setCurrentStep] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState(null);

  // Step 2: Node type selection
  const [availableNodeTypes, setAvailableNodeTypes] = useState([]);
  const [selectedNodeType, setSelectedNodeType] = useState(null);
  const [customName, setCustomName] = useState('');

  // Step 3: Multi-node setup
  const [setupNodes, setSetupNodes] = useState([]);
  const [wantMoreNodes, setWantMoreNodes] = useState(false);

  useEffect(() => {
    if (currentStep === 2) {
      loadAvailableNodeTypes();
    }
  }, [currentStep]);

  const loadAvailableNodeTypes = async () => {
    try {
      const types = await invoke('get_available_node_types');
      setAvailableNodeTypes(types);
    } catch (err) {
      setError(`Failed to load node types: ${err}`);
    }
  };

  const handleInitialize = async () => {
    setIsProcessing(true);
    setError(null);
    setStatusMessage('Creating isolated control panel environment...');

    try {
      const result = await invoke('init_multi_node_environment');
      setStatusMessage(`Environment created at: ${result.control_panel_path}`);
      setTimeout(() => {
        setCurrentStep(2);
        setIsProcessing(false);
      }, 1500);
    } catch (err) {
      setError(err);
      setIsProcessing(false);
    }
  };

  const handleNodeTypeSelect = async () => {
    if (!selectedNodeType) {
      setError('Please select a node type');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setStatusMessage(`Setting up ${selectedNodeType.display_name} node...`);

    try {
      const nodeId = await invoke('setup_node', {
        nodeType: selectedNodeType.id,
        displayName: customName || null,
        setupOptions: {
          userOperated: true,
          autoStart: true,
        },
      });

      const newNode = {
        id: nodeId,
        type: selectedNodeType.display_name,
        name: customName || selectedNodeType.display_name,
      };

      setSetupNodes([...setupNodes, newNode]);
      setStatusMessage('Node configured successfully!');

      // Reload available types to check compatibility
      await loadAvailableNodeTypes();

      // Reset form
      setSelectedNodeType(null);
      setCustomName('');

      setTimeout(() => {
        setCurrentStep(3);
        setIsProcessing(false);
      }, 1000);
    } catch (err) {
      setError(err);
      setIsProcessing(false);
    }
  };

  const handleAddAnotherNode = async () => {
    setCurrentStep(2);
    setSelectedNodeType(null);
    setCustomName('');
    setError(null);
  };

  const handleFinish = async () => {
    setIsProcessing(true);
    try {
      const nodes = await invoke('get_all_nodes');
      onComplete(nodes);
    } catch (err) {
      setError(err);
      setIsProcessing(false);
    }
  };

  const compatibleTypes = availableNodeTypes.filter(t => t.compatible);
  const incompatibleTypes = availableNodeTypes.filter(t => !t.compatible);

  return (
    <div className="setup-wizard">
      <div className="wizard-container">
        <div className="wizard-header">
          <h2>Synergy Network Node Setup</h2>
          <p>Configure your node(s) in an isolated, secure environment</p>
        </div>

        <div className="wizard-steps">
          <div className={`step ${currentStep >= 1 ? 'active' : ''} ${currentStep > 1 ? 'completed' : ''}`}>
            <div className="step-number">1</div>
            <div className="step-label">Initialize</div>
          </div>
          <div className="step-line"></div>
          <div className={`step ${currentStep >= 2 ? 'active' : ''} ${currentStep > 2 ? 'completed' : ''}`}>
            <div className="step-number">2</div>
            <div className="step-label">Select Node</div>
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
              <h3>Initialize Control Panel Environment</h3>
              <p>
                We'll create an isolated environment at <code>~/.synergy/control-panel/</code> where:
              </p>
              <ul className="feature-list">
                <li>The control panel operates in its own sandbox</li>
                <li>Each node type gets its own isolated directory</li>
                <li>Node binaries, configs, and data are kept separate from your system</li>
                <li>Maximum security and isolation from your computer</li>
              </ul>
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
              <h3>Select Node Type</h3>
              {setupNodes.length > 0 && (
                <div className="setup-nodes-list">
                  <h4>Configured Nodes:</h4>
                  <ul>
                    {setupNodes.map((node, idx) => (
                      <li key={idx}>
                        {node.name} ({node.type})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p>Choose the type of node you want to run on the Synergy Network:</p>

              {compatibleTypes.length > 0 && (
                <div className="node-types-grid">
                  {compatibleTypes.map((nodeType) => (
                    <div
                      key={nodeType.id}
                      className={`node-type-card ${selectedNodeType?.id === nodeType.id ? 'selected' : ''}`}
                      onClick={() => setSelectedNodeType(nodeType)}
                    >
                      <h4>{nodeType.display_name}</h4>
                      <p className="node-description">{nodeType.description}</p>
                      <div className="compatible-badge">Compatible</div>
                    </div>
                  ))}
                </div>
              )}

              {incompatibleTypes.length > 0 && setupNodes.length > 0 && (
                <div className="incompatible-section">
                  <h4>Incompatible Node Types</h4>
                  <p className="incompatible-note">
                    These node types cannot run alongside your current configuration:
                  </p>
                  <div className="node-types-grid disabled">
                    {incompatibleTypes.map((nodeType) => (
                      <div key={nodeType.id} className="node-type-card disabled">
                        <h4>{nodeType.display_name}</h4>
                        <p className="node-description">{nodeType.description}</p>
                        <div className="incompatible-badge">Incompatible</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedNodeType && (
                <div className="node-customization">
                  <label>
                    Custom Name (optional):
                    <input
                      type="text"
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      placeholder={selectedNodeType.display_name}
                      className="input"
                    />
                  </label>
                </div>
              )}

              {error && <div className="error-message">{error}</div>}
              {isProcessing && <p className="status-message">{statusMessage}</p>}

              <div className="button-group">
                <button
                  className="btn btn-primary"
                  onClick={handleNodeTypeSelect}
                  disabled={!selectedNodeType || isProcessing}
                >
                  {isProcessing ? 'Setting up...' : 'Setup Node'}
                </button>
              </div>
            </div>
          )}

          {currentStep === 3 && (
            <div className="step-content">
              <h3>Setup Complete!</h3>
              <div className="success-icon">✓</div>

              <div className="summary-box">
                <h4>Configured Nodes:</h4>
                <ul className="node-summary-list">
                  {setupNodes.map((node, idx) => (
                    <li key={idx}>
                      <strong>{node.name}</strong> - {node.type}
                    </li>
                  ))}
                </ul>
              </div>

              <p>Your node environment is ready! Each node has its own isolated sandbox directory.</p>

              {compatibleTypes.length > 0 && (
                <div className="add-more-section">
                  <p>You can add more compatible nodes or proceed to the dashboard.</p>
                </div>
              )}

              {error && <div className="error-message">{error}</div>}

              <div className="button-group">
                {compatibleTypes.length > 0 && (
                  <button
                    className="btn btn-secondary"
                    onClick={handleAddAnotherNode}
                    disabled={isProcessing}
                  >
                    Add Another Node
                  </button>
                )}
                <button
                  className="btn btn-success"
                  onClick={handleFinish}
                  disabled={isProcessing}
                >
                  {isProcessing ? 'Loading...' : 'Go to Dashboard'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default NodeSetupWizard;
