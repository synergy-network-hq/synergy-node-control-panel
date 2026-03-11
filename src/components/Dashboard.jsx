import { useState, useEffect } from 'react';
import { invoke, listen } from '../lib/desktopClient';
import LogsViewer from './LogsViewer';

function Dashboard() {
  const [status, setStatus] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);

    // Set up real-time event listeners
    let unlistenMonitoring = null;
    let unlistenBlockchain = null;

    const setupEventListeners = async () => {
      try {
        unlistenMonitoring = await listen('node-monitoring-update', (event) => {
          // Update status with real-time monitoring data
          if (event.payload && status) {
            setStatus(prev => ({
              ...prev,
              ...event.payload
            }));
          }
        });

        unlistenBlockchain = await listen('blockchain-update', (event) => {
          // Update blockchain-related status
          if (event.payload && status) {
            setStatus(prev => ({
              ...prev,
              block_height: event.payload.current_block_height,
              peer_count: event.payload.network_peers,
              sync_status: event.payload.is_synced ? 'Synced' : 'Syncing'
            }));
          }
        });
      } catch (err) {
        console.error('Failed to setup event listeners:', err);
      }
    };

    setupEventListeners();

    return () => {
      clearInterval(interval);
      if (unlistenMonitoring) unlistenMonitoring();
      if (unlistenBlockchain) unlistenBlockchain();
    };
  }, []);

  const fetchStatus = async () => {
    try {
      const nodeStatus = await invoke('get_node_status');
      setStatus(nodeStatus);
      setIsLoading(false);
      setError(null);
    } catch (err) {
      setError(err);
      setIsLoading(false);
    }
  };

  const handleStart = async () => {
    try {
      await invoke('start_node');
      setTimeout(fetchStatus, 1000);
    } catch (err) {
      alert(`Failed to start node: ${err}`);
    }
  };

  const handleStop = async () => {
    try {
      await invoke('stop_node');
      setTimeout(fetchStatus, 1000);
    } catch (err) {
      alert(`Failed to stop node: ${err}`);
    }
  };

  const handleRestart = async () => {
    try {
      await invoke('restart_node');
      setTimeout(fetchStatus, 2000);
    } catch (err) {
      alert(`Failed to restart node: ${err}`);
    }
  };

  if (isLoading) {
    return <div className="loading-container"><div className="spinner"></div></div>;
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>Node Dashboard</h2>
        <div className="control-buttons">
          <button 
            className="btn btn-success" 
            onClick={handleStart}
            disabled={status?.is_running}
          >
            ▶ Start
          </button>
          <button 
            className="btn btn-danger" 
            onClick={handleStop}
            disabled={!status?.is_running}
          >
            ■ Stop
          </button>
          <button 
            className="btn btn-warning" 
            onClick={handleRestart}
            disabled={!status?.is_running}
          >
            ↻ Restart
          </button>
        </div>
      </div>

      <div className="tabs">
        <button 
          className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button 
          className={`tab ${activeTab === 'logs' ? 'active' : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          Logs
        </button>
      </div>

      {activeTab === 'overview' && (
        <div className="overview-content">
          <div className="status-cards">
            <div className={`status-card ${status?.is_running ? 'running' : 'stopped'}`}>
              <div className="card-header">
                <h3>Node Status</h3>
                <div className={`status-indicator ${status?.is_running ? 'active' : 'inactive'}`}></div>
              </div>
              <div className="card-value">
                {status?.is_running ? 'Running' : 'Stopped'}
              </div>
              {status?.pid && <div className="card-detail">PID: {status.pid}</div>}
            </div>

            <div className="status-card">
              <div className="card-header">
                <h3>Block Height</h3>
              </div>
              <div className="card-value">
                {status?.block_height?.toLocaleString() || 'N/A'}
              </div>
              <div className="card-detail">
                {status?.sync_status || 'Not syncing'}
              </div>
            </div>

            <div className="status-card">
              <div className="card-header">
                <h3>Peers</h3>
              </div>
              <div className="card-value">
                {status?.peer_count || 0}
              </div>
              <div className="card-detail">Connected</div>
            </div>

            <div className="status-card">
              <div className="card-header">
                <h3>Version</h3>
              </div>
              <div className="card-value">
                {status?.version || 'Unknown'}
              </div>
              <div className="card-detail">Synergy Node</div>
            </div>
          </div>

          {status?.is_running && (
            <div className="metrics-section">
              <h3>Node Metrics</h3>
              <div className="metrics-grid">
                <div className="metric-item">
                  <span className="metric-label">Uptime:</span>
                  <span className="metric-value">
                    {status?.uptime ? `${Math.floor(status.uptime / 3600)}h ${Math.floor((status.uptime % 3600) / 60)}m` : 'N/A'}
                  </span>
                </div>
                <div className="metric-item">
                  <span className="metric-label">Network:</span>
                  <span className="metric-value">Testnet</span>
                </div>
                <div className="metric-item">
                  <span className="metric-label">RPC Port:</span>
                  <span className="metric-value">48638</span>
                </div>
                <div className="metric-item">
                  <span className="metric-label">P2P Port:</span>
                  <span className="metric-value">38638</span>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="error-banner">
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>
      )}

      {activeTab === 'logs' && <LogsViewer />}
    </div>
  );
}

export default Dashboard;
