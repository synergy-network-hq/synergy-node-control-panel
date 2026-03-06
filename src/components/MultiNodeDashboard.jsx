import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * MultiNodeDashboard component provides a comprehensive dashboard for managing
 * multiple Synergy nodes with enhanced monitoring, rewards, security, and analytics.
 */
function MultiNodeDashboard({ onResetSetup, onStateChange }) {
  const [nodes, setNodes] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  // Monitoring data state
  const [blockValidationStatus, setBlockValidationStatus] = useState(null);
  const [validatorActivity, setValidatorActivity] = useState(null);
  const [peerInfo, setPeerInfo] = useState(null);
  const [monitoringLoading, setMonitoringLoading] = useState(false);
  const [nodeBalance, setNodeBalance] = useState('N/A');

  // System metrics state
  const [systemMetrics, setSystemMetrics] = useState(null);
  const [nodeInfo, setNodeInfo] = useState(null);
  const [nodeHealth, setNodeHealth] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [synergyScoreBreakdown, setSynergyScoreBreakdown] = useState(null);

  // Rewards state
  const [rewardsData, setRewardsData] = useState(null);
  const [rewardsLoading, setRewardsLoading] = useState(false);

  // Security state
  const [securityStatus, setSecurityStatus] = useState(null);
  const [securityLoading, setSecurityLoading] = useState(false);

  // Performance history state
  const [performanceHistory, setPerformanceHistory] = useState([]);
  const [performancePeriod, setPerformancePeriod] = useState('24h');

  // Logs state
  const [logs, setLogs] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [logFilter, setLogFilter] = useState('all');
  const [logSearch, setLogSearch] = useState('');
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);

  // Config editor state
  const [configContent, setConfigContent] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const [configEditing, setConfigEditing] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);

  // Network discovery state
  const [networkPeers, setNetworkPeers] = useState(null);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [networkSession, setNetworkSession] = useState({ rx: 0, tx: 0 });
  const networkTotalsRef = useRef(null);
  const [diagnosticsLog, setDiagnosticsLog] = useState('');
  const [diagnosticsLogPath, setDiagnosticsLogPath] = useState('');
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);

  const normalizeAddress = (address) => {
    if (!address) return null;
    return address.toLowerCase().trim();
  };

  const normalizeDevnetChainId = (value) => {
    if (value === null || value === undefined || value === '') return '338638';
    return String(value) === '7963749' ? '338638' : value;
  };

  const currentValidator = useMemo(() => {
    const normalizedNodeAddress = normalizeAddress(selectedNode?.address);
    if (!normalizedNodeAddress || !validatorActivity?.validators) {
      return null;
    }

    return (
      validatorActivity.validators.find(
        (validator) => normalizeAddress(validator.address) === normalizedNodeAddress,
      ) || null
    );
  }, [selectedNode?.address, validatorActivity]);

  // Helper function to format uptime as hh:mm:ss
  const formatUptime = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Helper function to format uptime for display (longer format)
  const formatUptimeDisplay = (seconds) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  };

  // Helper to shorten address (first 5...last 4)
  const shortenAddress = (address) => {
    if (!address || address.length < 12) return address || 'No address';
    return `${address.slice(0, 5)}...${address.slice(-4)}`;
  };

  // Helper to format bytes
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Helper to format SNRG amounts
  const formatSNRG = (amount) => {
    if (typeof amount !== 'number') return 'N/A';
    return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Helper to get health status color
  const getHealthColor = (status) => {
    switch (status) {
      case 'healthy': return 'var(--snrg-status-success)';
      case 'warning': return 'var(--snrg-status-warning)';
      case 'critical': return 'var(--snrg-status-error)';
      default: return 'var(--snrg-text-secondary)';
    }
  };

  useEffect(() => {
    loadNodes();
    const interval = setInterval(loadNodes, 5000);
    let unlistenMonitoring = null;
    let unlistenBlockchain = null;
    const setupEventListeners = async () => {
      try {
        unlistenMonitoring = await listen('node-monitoring-update', (event) => {
          if (event.payload && event.payload.node_id) {
            setNodes((prevNodes) =>
              prevNodes.map((node) =>
                node.id === event.payload.node_id
                  ? { ...node, is_running: event.payload.node_status === 'running' }
                  : node
              )
            );
            if (selectedNode && selectedNode.id === event.payload.node_id) {
              setSelectedNode((prev) => ({
                ...prev,
                is_running: event.payload.node_status === 'running',
              }));
            }
          }
        });
        unlistenBlockchain = await listen('blockchain-update', (event) => {
          console.log('Blockchain update received:', event.payload);
          if (selectedNode?.is_running) {
            loadMonitoringData();
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
  }, [selectedNode]);

  useEffect(() => {
    if (selectedNode?.is_running) {
      loadMonitoringData();
      loadSystemMetrics();
      const monitoringInterval = setInterval(() => {
        loadMonitoringData();
        loadSystemMetrics();
      }, 3000);
      return () => clearInterval(monitoringInterval);
    }
  }, [selectedNode]);

  // Expose state and handlers to parent component
  useEffect(() => {
    if (onStateChange && selectedNode) {
      onStateChange(selectedNode, {
        onStart: () => handleStartNode(selectedNode.id),
        onStop: () => handleStopNode(selectedNode.id),
      });
    }
  }, [selectedNode, onStateChange]);

  const loadNodes = async () => {
    try {
      const allNodes = await invoke('get_all_nodes');
      setNodes(allNodes);
      if (allNodes.length > 0 && !selectedNode) {
        setSelectedNode(allNodes[0]);
      }
      setIsLoading(false);
      setError(null);
    } catch (err) {
      setError(`Failed to load nodes: ${err}`);
      setIsLoading(false);
    }
  };

  const handleStartNode = async (nodeId) => {
    try {
      await invoke('start_node_by_id', { nodeId });
      setTimeout(loadNodes, 1000);
    } catch (err) {
      alert(`Failed to start node: ${err}`);
    }
  };

  const handleStopNode = async (nodeId) => {
    try {
      await invoke('stop_node_by_id', { nodeId });
      setTimeout(loadNodes, 1000);
    } catch (err) {
      alert(`Failed to stop node: ${err}`);
    }
  };

  const loadMonitoringData = async () => {
    if (!selectedNode?.is_running) return;
    setMonitoringLoading(true);
    try {
      const blockStatus = await invoke('get_block_validation_status', { nodeId: selectedNode.id });
      setBlockValidationStatus(blockStatus);
      const validatorData = await invoke('get_validator_activity', { nodeId: selectedNode.id });
      setValidatorActivity(validatorData);
      const peerData = await invoke('get_peer_info', { nodeId: selectedNode.id });
      setPeerInfo(peerData);
      // Fetch balance separately via RPC
      try {
        const balance = await invoke('get_node_balance', { nodeId: selectedNode.id });
        setNodeBalance(balance || 'N/A');
      } catch (balanceErr) {
        console.log('Balance fetch pending:', balanceErr);
        setNodeBalance('N/A');
      }
      // Fetch node info
      try {
        const info = await invoke('get_rpc_node_info', { nodeId: selectedNode.id });
        setNodeInfo(info);
      } catch (err) {
        console.log('Node info fetch error:', err);
        setNodeInfo(null);
      }
      // Fetch node health
      try {
        const health = await invoke('get_node_health', { nodeId: selectedNode.id });
        setNodeHealth(health);
      } catch (err) {
        console.log('Health fetch error:', err);
      }
      // Fetch alerts
      try {
        const nodeAlerts = await invoke('get_node_alerts', { nodeId: selectedNode.id });
        setAlerts(nodeAlerts || []);
      } catch (err) {
        console.log('Alerts fetch error:', err);
      }
      // Fetch synergy score breakdown
      try {
        const breakdown = await invoke('get_synergy_score_breakdown', { nodeId: selectedNode.id });
        setSynergyScoreBreakdown(breakdown);
      } catch (err) {
        console.log('Synergy score breakdown fetch error:', err);
        setSynergyScoreBreakdown(null);
      }
    } catch (err) {
      console.error('Failed to load monitoring data:', err);
      setBlockValidationStatus(null);
      setValidatorActivity(null);
      setPeerInfo(null);
      setNodeBalance('N/A');
      setNodeInfo(null);
    } finally {
      setMonitoringLoading(false);
    }
  };

  const loadSystemMetrics = async () => {
    try {
      const metrics = await invoke('get_system_metrics');
      const prevTotals = networkTotalsRef.current;
      if (prevTotals) {
        const deltaRx = Math.max(metrics.network_rx_bytes - prevTotals.rx, 0);
        const deltaTx = Math.max(metrics.network_tx_bytes - prevTotals.tx, 0);
        setNetworkSession({ rx: deltaRx, tx: deltaTx });
      }
      networkTotalsRef.current = {
        rx: metrics.network_rx_bytes,
        tx: metrics.network_tx_bytes,
      };
      setSystemMetrics(metrics);
    } catch (err) {
      console.log('System metrics fetch error:', err);
    }
  };

  const loadRewardsData = async () => {
    if (!selectedNode) return;
    setRewardsLoading(true);
    try {
      const rewards = await invoke('get_rewards_data', { nodeId: selectedNode.id });
      setRewardsData(rewards);
    } catch (err) {
      console.error('Failed to load rewards data:', err);
      setRewardsData(null);
    } finally {
      setRewardsLoading(false);
    }
  };

  const loadSecurityStatus = async () => {
    if (!selectedNode) return;
    setSecurityLoading(true);
    try {
      const security = await invoke('get_security_status', { nodeId: selectedNode.id });
      setSecurityStatus(security);
    } catch (err) {
      console.error('Failed to load security status:', err);
      setSecurityStatus(null);
    } finally {
      setSecurityLoading(false);
    }
  };

  const loadPerformanceHistory = async () => {
    if (!selectedNode) return;
    try {
      const history = await invoke('get_performance_history', {
        nodeId: selectedNode.id,
        period: performancePeriod,
      });
      setPerformanceHistory(history);
    } catch (err) {
      console.error('Failed to load performance history:', err);
    }
  };

  const loadDiagnosticsLog = useCallback(async () => {
    setDiagnosticsBusy(true);
    try {
      const log = await invoke('read_diagnostics_log');
      setDiagnosticsLog(log);
    } catch (err) {
      console.error('Failed to read diagnostics log:', err);
      setDiagnosticsLog(`Diagnostics log unavailable: ${err}`);
    } finally {
      setDiagnosticsBusy(false);
    }
  }, []);

  const captureDiagnostics = useCallback(async () => {
    if (!selectedNode) return;
    setDiagnosticsBusy(true);
    try {
      const logPath = await invoke('capture_connection_diagnostics', { nodeId: selectedNode.id });
      setDiagnosticsLogPath(logPath);
      await loadDiagnosticsLog();
    } catch (err) {
      console.error('Failed to capture diagnostics:', err);
      setDiagnosticsLog(`Failed to capture diagnostics: ${err}`);
    } finally {
      setDiagnosticsBusy(false);
    }
  }, [loadDiagnosticsLog, selectedNode]);

  const loadLogs = async () => {
    if (!selectedNode) return;
    setLogsLoading(true);
    try {
      const logContent = await invoke('get_node_logs', { nodeId: selectedNode.id });
      setLogs(logContent || 'No logs available yet.');
    } catch (err) {
      console.error('Failed to load logs:', err);
      setLogs(`Error loading logs: ${err}`);
    } finally {
      setLogsLoading(false);
    }
  };

  // Filter logs based on level and search
  const filteredLogs = useMemo(() => {
    let filtered = logs;
    if (logFilter !== 'all') {
      const lines = logs.split('\n');
      filtered = lines.filter((line) => {
        const lowerLine = line.toLowerCase();
        switch (logFilter) {
          case 'error':
            return lowerLine.includes('error') || lowerLine.includes('failed');
          case 'warn':
            return lowerLine.includes('warn');
          case 'info':
            return lowerLine.includes('info');
          case 'debug':
            return lowerLine.includes('debug');
          default:
            return true;
        }
      }).join('\n');
    }
    if (logSearch) {
      const lines = filtered.split('\n');
      filtered = lines.filter((line) =>
        line.toLowerCase().includes(logSearch.toLowerCase())
      ).join('\n');
    }
    return filtered;
  }, [logs, logFilter, logSearch]);

  const validationSuccessRate = useMemo(() => {
    const blocks = blockValidationStatus?.recent_blocks;
    if (!blocks || blocks.length === 0) {
      return null;
    }
    const validated = blocks.filter((block) => block.status === 'validated').length;
    return ((validated / blocks.length) * 100).toFixed(1);
  }, [blockValidationStatus]);

  useEffect(() => {
    if (activeTab === 'logs' && selectedNode) {
      loadLogs();
      const logsInterval = setInterval(loadLogs, 3000);
      return () => clearInterval(logsInterval);
    }
  }, [activeTab, selectedNode]);

  useEffect(() => {
    if (activeTab === 'config' && selectedNode) {
      loadConfig();
      if (!securityStatus) {
        loadSecurityStatus();
      }
    }
  }, [activeTab, selectedNode, securityStatus]);

  useEffect(() => {
    if (activeTab === 'rewards' && selectedNode) {
      loadRewardsData();
    }
  }, [activeTab, selectedNode]);

  useEffect(() => {
    if (activeTab === 'security' && selectedNode) {
      loadSecurityStatus();
    }
  }, [activeTab, selectedNode]);

  useEffect(() => {
    if (activeTab === 'performance' && selectedNode) {
      loadPerformanceHistory();
    }
  }, [activeTab, selectedNode, performancePeriod]);

  const loadConfig = async () => {
    if (!selectedNode) return;
    setConfigLoading(true);
    try {
      const content = await invoke('get_node_config', { nodeId: selectedNode.id });
      setConfigContent(content);
    } catch (err) {
      console.error('Failed to load config:', err);
      alert(`Failed to load configuration: ${err}`);
    } finally {
      setConfigLoading(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!selectedNode) return;
    setConfigSaving(true);
    try {
      await invoke('save_node_config', {
        nodeId: selectedNode.id,
        configContent: configContent,
      });
      alert('Configuration saved successfully! Restart the node for changes to take effect.');
      setConfigEditing(false);
    } catch (err) {
      console.error('Failed to save config:', err);
      alert(`Failed to save configuration: ${err}`);
    } finally {
      setConfigSaving(false);
    }
  };

  const handleReloadConfig = async () => {
    if (!selectedNode) return;
    if (selectedNode.is_running) {
      alert('Cannot reload configuration while node is running. Please stop the node first.');
      return;
    }
    try {
      await invoke('reload_node_config', { nodeId: selectedNode.id });
      alert('Configuration reloaded successfully!');
      await loadConfig();
    } catch (err) {
      console.error('Failed to reload config:', err);
      alert(`Failed to reload configuration: ${err}`);
    }
  };

  const handleAddNode = () => {
    if (onResetSetup) {
      onResetSetup();
    } else {
      window.location.reload();
    }
  };

  // Load network discovery data
  const loadNetworkData = async () => {
    setNetworkLoading(true);
    try {
      await invoke('init_network_discovery');
      const status = await invoke('get_network_peers');
      setNetworkPeers(status);
    } catch (err) {
      console.error('Failed to load network data:', err);
      setNetworkPeers(null);
    } finally {
      setNetworkLoading(false);
    }
  };

  // Refresh network data
  const refreshNetworkData = async () => {
    setNetworkLoading(true);
    try {
      const status = await invoke('refresh_network_peers');
      setNetworkPeers(status);
    } catch (err) {
      console.error('Failed to refresh network data:', err);
    } finally {
      setNetworkLoading(false);
    }
  };

  // Load network data when switching to network tab
  useEffect(() => {
    if (activeTab === 'network') {
      loadNetworkData();
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'monitoring') {
      loadDiagnosticsLog();
    }
  }, [activeTab, loadDiagnosticsLog]);

  if (isLoading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Loading nodes...</p>
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div className="empty-state">
        <h2>No Nodes Configured</h2>
        <p>Get started by setting up your first Synergy node.</p>
        <button className="btn btn-primary" onClick={handleAddNode}>
          Setup Node
        </button>
      </div>
    );
  }

  // Get node synergy score from validatorActivity if available
  const getNodeSynergyScore = (nodeId) => {
    if (selectedNode?.id === nodeId && synergyScoreBreakdown?.total_score !== undefined) {
      return synergyScoreBreakdown.total_score.toFixed(2);
    }
    if (selectedNode?.id === nodeId && currentValidator?.synergy_score !== undefined) {
      return currentValidator.synergy_score.toFixed(2);
    }
    if (selectedNode?.id === nodeId && validatorActivity?.average_synergy_score !== undefined) {
      return validatorActivity.average_synergy_score.toFixed(2);
    }
    return null;
  };

  // Get current validator's stake amount
  const getValidatorStake = () => {
    if (!currentValidator?.stake_amount) {
      return null;
    }
    const stakeInSNRG = currentValidator.stake_amount / 1_000_000_000;
    return stakeInSNRG.toFixed(2);
  };

  // Get current validator's blocks produced
  const getValidatorBlocksProduced = () => {
    return currentValidator?.blocks_produced ?? null;
  };

  // Get node uptime in seconds
  const getNodeUptime = (node) => {
    if (node.is_running && node.started_at) {
      return Math.floor(Date.now() / 1000 - node.started_at);
    }
    return 0;
  };

  // Calculate uptime percentage (based on 24h target)
  const getUptimePercentage = (node) => {
    if (!node.is_running) return 0;
    const uptimeSeconds = getNodeUptime(node);
    const percentage = (uptimeSeconds / (24 * 3600)) * 100;
    return Math.min(percentage, 100).toFixed(1);
  };

  return (
    <div className="multi-node-dashboard">
      <div className="dashboard-layout">
        <aside className="node-sidebar">
          <h3 className="sidebar-title">Your Nodes</h3>
          <div className="sidebar-separator"></div>
          <div className="node-list">
            {nodes.map((node) => (
              <div
                key={node.id}
                className={`node-item ${selectedNode?.id === node.id ? 'active' : ''} ${
                  node.is_running ? 'running' : 'stopped'
                }`}
                onClick={() => setSelectedNode(node)}
              >
                <div className="node-item-header">
                  <span className={`node-health-dot ${node.is_running ? 'healthy' : 'offline'}`}></span>
                  <span className="node-item-address">
                    {node.display_name || shortenAddress(node.address)}
                  </span>
                </div>
                <div className="node-item-row">
                  <span className="node-item-type">{node.node_type.toUpperCase()}</span>
                  <span className={`node-status-label ${node.is_running ? 'running' : 'stopped'}`}>
                    {node.is_running ? 'Running' : 'Stopped'}
                  </span>
                </div>
                {node.is_running && (
                  <>
                    <div className="node-item-row node-item-stats">
                      <span className="node-item-score">
                        {(() => {
                          const score = selectedNode?.id === node.id ? getNodeSynergyScore(node.id) : null;
                          return `Score: ${score !== null ? `${score}%` : 'N/A'}`;
                        })()}
                      </span>
                    </div>
                    <div className="node-item-row node-item-stats">
                      <span className="node-item-uptime">
                        Uptime: {formatUptime(getNodeUptime(node))}
                      </span>
                    </div>
                  </>
                )}
              </div>
              ))}
            </div>
          <div className="sidebar-footer">
            <button className="btn btn-outline add-node-btn" onClick={handleAddNode}>
              + Add Node
            </button>
          </div>
        </aside>
        <main className="node-content">
          {selectedNode && (
            <>
              <h2 className="panel-title">Node Control Panel</h2>
              <div className="tabs">
                <button
                  className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
                  onClick={() => setActiveTab('overview')}
                >
                  Overview
                </button>
                <button
                  className={`tab ${activeTab === 'monitoring' ? 'active' : ''}`}
                  onClick={() => setActiveTab('monitoring')}
                  disabled={!selectedNode.is_running}
                >
                  Monitoring
                </button>
                <button
                  className={`tab ${activeTab === 'rewards' ? 'active' : ''}`}
                  onClick={() => setActiveTab('rewards')}
                >
                  Rewards
                </button>
                <button
                  className={`tab ${activeTab === 'security' ? 'active' : ''}`}
                  onClick={() => setActiveTab('security')}
                >
                  Security
                </button>
                <button
                  className={`tab ${activeTab === 'performance' ? 'active' : ''}`}
                  onClick={() => setActiveTab('performance')}
                >
                  Performance
                </button>
                <button
                  className={`tab ${activeTab === 'config' ? 'active' : ''}`}
                  onClick={() => setActiveTab('config')}
                >
                  Configuration
                </button>
                <button
                  className={`tab ${activeTab === 'logs' ? 'active' : ''}`}
                  onClick={() => setActiveTab('logs')}
                >
                  Logs
                </button>
                <button
                  className={`tab ${activeTab === 'network' ? 'active' : ''}`}
                  onClick={() => setActiveTab('network')}
                >
                  Network
                </button>
              </div>
              <div className="tab-content">
                {/* OVERVIEW TAB */}
                {activeTab === 'overview' && (
                  <div className="overview-content">
                    {/* Node Health Score */}
                    {nodeHealth && (
                      <div className="health-score-banner" style={{ backgroundColor: getHealthColor(nodeHealth.status) + '20', borderLeft: `4px solid ${getHealthColor(nodeHealth.status)}` }}>
                        <div className="health-score-main">
                          <div className="health-score-value">
                            <span className="score-number">{nodeHealth.overall_score.toFixed(0)}</span>
                            <span className="score-label">Health Score</span>
                          </div>
                          <div className="health-status" style={{ color: getHealthColor(nodeHealth.status) }}>
                            {nodeHealth.status.toUpperCase()}
                          </div>
                        </div>
                        {nodeHealth.recommendations?.length > 0 && (
                          <div className="health-recommendations">
                            {nodeHealth.recommendations.slice(0, 2).map((rec, i) => (
                              <span key={i} className="recommendation-item">* {rec}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Critical Alerts Panel */}
                    {alerts.filter((a) => a.level === 'critical' || a.level === 'warning').length > 0 && (
                      <div className="alerts-panel">
                        <h4>Active Alerts</h4>
                        <div className="alerts-list">
                          {alerts.filter((a) => a.level === 'critical' || a.level === 'warning').slice(0, 3).map((alert) => (
                            <div key={alert.id} className={`alert-item alert-${alert.level}`}>
                              <span className="alert-icon">{alert.level === 'critical' ? '!' : '*'}</span>
                              <div className="alert-content">
                                <span className="alert-title">{alert.title}</span>
                                <span className="alert-message">{alert.message}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Key Metrics Section */}
                    <div className="key-metrics">
                      <div className="metric-card highlight">
                        <div className="metric-icon">$</div>
                        <div className="metric-info">
                          <div className="metric-label">SNRG Balance</div>
                          <div className="metric-value">
                            {selectedNode.is_running ? nodeBalance : '---'}
                          </div>
                          <div className="metric-unit">SNRG</div>
                        </div>
                      </div>
                      <div className="metric-card highlight">
                        <div className="metric-icon">*</div>
                        <div className="metric-info">
                          <div className="metric-label">Synergy Score</div>
                          <div className="metric-value">
                            {selectedNode.is_running
                              ? (getNodeSynergyScore(selectedNode.id) ?? 'N/A')
                              : '---'}
                          </div>
                          <div className="metric-unit">/100</div>
                        </div>
                      </div>
                      <div className="metric-card highlight">
                        <div className="metric-icon">#</div>
                        <div className="metric-info">
                          <div className="metric-label">Current Block</div>
                          <div className="metric-value">
                            {selectedNode.is_running
                              ? (blockValidationStatus?.current_block_height ?? 'N/A')
                              : '---'}
                          </div>
                          <div className="metric-unit">blocks</div>
                        </div>
                      </div>
                      <div className="metric-card highlight">
                        <div className="metric-icon">@</div>
                        <div className="metric-info">
                          <div className="metric-label">Connected Peers</div>
                          <div className="metric-value">
                            {selectedNode.is_running ? (peerInfo?.peer_count ?? 'N/A') : '---'}
                          </div>
                          <div className="metric-unit">peers</div>
                        </div>
                      </div>
                      <div className="metric-card highlight">
                        <div className="metric-icon">%</div>
                        <div className="metric-info">
                          <div className="metric-label">Staked Amount</div>
                          <div className="metric-value">
                            {selectedNode.is_running ? (getValidatorStake() ?? 'N/A') : '---'}
                          </div>
                          <div className="metric-unit">SNRG</div>
                        </div>
                      </div>
                      <div className="metric-card highlight">
                        <div className="metric-icon">+</div>
                        <div className="metric-info">
                          <div className="metric-label">Blocks Produced</div>
                          <div className="metric-value">
                            {selectedNode.is_running ? (getValidatorBlocksProduced() ?? 'N/A') : '---'}
                          </div>
                          <div className="metric-unit">blocks</div>
                        </div>
                      </div>
                    </div>

                    {/* System Resources */}
                    {systemMetrics && selectedNode.is_running && (
                      <div className="system-resources-section">
                        <h3>System Resources</h3>
                        <div className="resource-bars">
                        <div className="resource-item">
                          <div className="resource-header">
                            <span className="resource-label">CPU Usage</span>
                            <span className="resource-value">{systemMetrics.cpu_usage.toFixed(1)}%</span>
                          </div>
                          <div className="resource-bar">
                            <div
                              className="resource-bar-fill"
                              style={{
                                width: `${Math.min(systemMetrics.cpu_usage, 100)}%`,
                              }}
                            ></div>
                          </div>
                        </div>
                          <div className="resource-item">
                            <div className="resource-header">
                              <span className="resource-label">Memory Usage</span>
                              <span className="resource-value">{formatBytes(systemMetrics.memory_used)} / {formatBytes(systemMetrics.memory_total)}</span>
                            </div>
                            <div className="resource-bar">
                            <div
                              className="resource-bar-fill"
                              style={{
                                width: `${Math.min(systemMetrics.memory_percentage, 100)}%`,
                              }}
                            ></div>
                          </div>
                        </div>
                          <div className="resource-item">
                            <div className="resource-header">
                              <span className="resource-label">Disk Usage</span>
                              <span className="resource-value">{formatBytes(systemMetrics.disk_used)} / {formatBytes(systemMetrics.disk_total)}</span>
                            </div>
                            <div className="resource-bar">
                            <div
                              className="resource-bar-fill"
                              style={{
                                width: `${Math.min(systemMetrics.disk_percentage, 100)}%`,
                              }}
                            ></div>
                          </div>
                        </div>
                        </div>
                        <div className="network-io-stats">
                          <div className="io-stat">
                            <span className="io-label">Session RX</span>
                            <span className="io-value">{formatBytes(networkSession.rx)}</span>
                          </div>
                          <div className="io-stat">
                            <span className="io-label">Session TX</span>
                            <span className="io-value">{formatBytes(networkSession.tx)}</span>
                          </div>
                          <div className="io-stat">
                            <span className="io-label">Total RX</span>
                            <span className="io-value">{formatBytes(systemMetrics.network_rx_bytes)}</span>
                          </div>
                          <div className="io-stat">
                            <span className="io-label">Total TX</span>
                            <span className="io-value">{formatBytes(systemMetrics.network_tx_bytes)}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Status Overview */}
                    <div className="status-cards">
                      <div className="status-card">
                        <div className="card-header">
                          <h3>Uptime</h3>
                        </div>
                        <div className="card-value">
                          {selectedNode.is_running && selectedNode.started_at
                            ? formatUptimeDisplay(Date.now() / 1000 - selectedNode.started_at)
                            : 'Not running'}
                        </div>
                        {selectedNode.pid && (
                          <div className="card-detail">PID: {selectedNode.pid}</div>
                        )}
                        {selectedNode.is_running && (
                          <div className="card-detail">Uptime: {getUptimePercentage(selectedNode)}%</div>
                        )}
                      </div>
                      <div className="status-card">
                        <div className="card-header">
                          <h3>Sync Status</h3>
                        </div>
                      <div className="card-value sync-status">
                        {selectedNode.is_running
                          ? nodeInfo?.sync_status
                            ? `${nodeInfo.sync_status.charAt(0).toUpperCase()}${nodeInfo.sync_status.slice(1)}`
                            : blockValidationStatus?.current_block_height
                              ? 'Synced'
                              : 'Syncing'
                          : 'Offline'}
                      </div>
                        <div className="card-detail">
                          {selectedNode.is_running && blockValidationStatus?.current_block_height
                            ? `Block #${blockValidationStatus.current_block_height}`
                            : 'Not synced'}
                        </div>
                      </div>
                      <div className="status-card">
                        <div className="card-header">
                          <h3>Network</h3>
                        </div>
                        <div className="card-value">
                          {nodeInfo?.network || 'Unknown'}
                        </div>
                        <div className="card-detail">
                          Chain ID: {normalizeDevnetChainId(nodeInfo?.chain_id)}
                        </div>
                        <div className="card-detail">
                          Consensus: {nodeInfo?.consensus || 'Proof of Synergy'}
                        </div>
                      </div>
                    </div>

                    {/* Synergy Score Breakdown */}
                    {synergyScoreBreakdown && selectedNode.is_running && (() => {
                      const components = synergyScoreBreakdown.components;
                      const componentValues = [
                        components.stake_weight,
                        components.reputation,
                        components.contribution_index,
                        Math.abs(components.cartelization_penalty),
                      ];
                      const componentMax = Math.max(...componentValues, 1);
                      const percent = (value) => Math.min((Math.abs(value) / componentMax) * 100, 100);
                      return (
                        <div className="synergy-score-section">
                          <h3>Synergy Score Breakdown</h3>
                          <div className="score-breakdown-grid">
                            <div className="score-component">
                              <span className="component-label">Stake Weight</span>
                              <div className="component-bar">
                                <div className="component-bar-fill" style={{ width: `${percent(components.stake_weight)}%` }}></div>
                              </div>
                              <span className="component-value">{components.stake_weight.toFixed(4)}</span>
                            </div>
                            <div className="score-component">
                              <span className="component-label">Reputation</span>
                              <div className="component-bar">
                                <div className="component-bar-fill" style={{ width: `${percent(components.reputation)}%` }}></div>
                              </div>
                              <span className="component-value">{components.reputation.toFixed(4)}</span>
                            </div>
                            <div className="score-component">
                              <span className="component-label">Contribution Index</span>
                              <div className="component-bar">
                                <div className="component-bar-fill" style={{ width: `${percent(components.contribution_index)}%` }}></div>
                              </div>
                              <span className="component-value">{components.contribution_index.toFixed(4)}</span>
                            </div>
                            <div className="score-component">
                              <span className="component-label">Cartelization Penalty</span>
                              <div className="component-bar">
                                <div className="component-bar-fill" style={{ width: `${percent(components.cartelization_penalty)}%` }}></div>
                              </div>
                              <span className="component-value">{components.cartelization_penalty.toFixed(4)}</span>
                            </div>
                          </div>
                          {synergyScoreBreakdown.multiplier && (
                            <div className="score-multiplier">
                              Reward Multiplier: <strong>{synergyScoreBreakdown.multiplier.toFixed(2)}x</strong>
                            </div>
                          )}
                          {components.last_updated && (
                            <div className="score-updated">
                              Last updated: {new Date(components.last_updated * 1000).toLocaleString()}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Quick Actions */}
                    <div className="quick-actions">
                      <h3>Quick Actions</h3>
                      <div className="action-buttons">
                        {selectedNode.is_running ? (
                          <button className="btn btn-warning" onClick={() => handleStopNode(selectedNode.id)}>
                            Stop Node
                          </button>
                        ) : (
                          <button className="btn btn-success" onClick={() => handleStartNode(selectedNode.id)}>
                            Start Node
                          </button>
                        )}
                        <button className="btn btn-secondary" onClick={() => setActiveTab('logs')}>
                          View Logs
                        </button>
                        <button className="btn btn-secondary" onClick={() => setActiveTab('config')}>
                          Edit Config
                        </button>
                        <button className="btn btn-secondary" onClick={() => setActiveTab('rewards')}>
                          View Rewards
                        </button>
                      </div>
                    </div>

                  </div>
                )}

                {/* MONITORING TAB */}
                {activeTab === 'monitoring' && (
                  <div className="monitoring-content">
                    <div className="monitoring-header">
                      <h3>Real-Time Node Monitoring</h3>
                      {monitoringLoading && <div className="mini-spinner"></div>}
                      <span className="last-updated">
                        Last updated: {new Date().toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="diagnostics-actions">
                      <button
                        className="btn diag-btn"
                        onClick={captureDiagnostics}
                        disabled={diagnosticsBusy}
                      >
                        {diagnosticsBusy ? 'Capturing...' : 'Capture Diagnostics'}
                      </button>
                      <button
                        className="btn diag-btn ghost"
                        onClick={loadDiagnosticsLog}
                        disabled={diagnosticsBusy}
                      >
                        {diagnosticsBusy ? 'Refreshing...' : 'Refresh Log'}
                      </button>
                      {diagnosticsBusy && <span className="diag-status">Working...</span>}
                    </div>

                    {/* Block Validation Status */}
                    <div className="monitoring-section">
                      <h4>Block Validation Status</h4>
                      {blockValidationStatus ? (
                        <div className="block-status-grid">
                          <div className="status-metric">
                            <div className="metric-label">Current Block Height</div>
                            <div className="metric-value">
                              {blockValidationStatus.current_block_height}
                            </div>
                          </div>
                          <div className="status-metric">
                            <div className="metric-label">Active Validators</div>
                            <div className="metric-value">
                              {blockValidationStatus.active_validators}
                            </div>
                          </div>
                          <div className="status-metric">
                            <div className="metric-label">Total Validators</div>
                            <div className="metric-value">
                              {blockValidationStatus.total_validators}
                            </div>
                          </div>
                          <div className="status-metric">
                            <div className="metric-label">Active Clusters</div>
                            <div className="metric-value">
                              {blockValidationStatus.cluster_info?.active_clusters || 0}
                            </div>
                          </div>
                          <div className="status-metric">
                            <div className="metric-label">Your Blocks Produced</div>
                            <div className="metric-value">
                              {getValidatorBlocksProduced() ?? 'N/A'}
                            </div>
                          </div>
                          <div className="status-metric">
                            <div className="metric-label">Validation Success Rate</div>
                            <div className="metric-value">
                              {validationSuccessRate !== null ? `${validationSuccessRate}%` : 'N/A'}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <p className="no-data">No block validation data available</p>
                      )}
                      {blockValidationStatus?.recent_blocks && blockValidationStatus.recent_blocks.length > 0 && (
                        <div className="recent-blocks">
                          <h5>Recent Blocks</h5>
                          <div className="blocks-table">
                            <div className="table-header">
                              <span>Block #</span>
                              <span>Validator</span>
                              <span>Transactions</span>
                              <span>Status</span>
                              <span>Time</span>
                            </div>
                            {blockValidationStatus.recent_blocks.map((block, index) => (
                              <div key={index} className="table-row">
                                <span className="block-number">#{block.block_number}</span>
                                <span className="validator-address">
                                  {block.validator ? `${block.validator.substring(0, 12)}...` : 'Unknown'}
                                </span>
                                <span className="tx-count">{block.transactions ?? 'N/A'} tx</span>
                                <span
                                  className={`status-badge ${
                                    block.status === 'validated' ? 'success' : 'pending'
                                  }`}
                                >
                                  {block.status || 'unknown'}
                                </span>
                                <span className="timestamp">
                                  {block.timestamp
                                    ? new Date(block.timestamp * 1000).toLocaleTimeString()
                                    : 'N/A'}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Validator Activity */}
                    <div className="monitoring-section">
                      <h4>Validator Activity</h4>
                      {validatorActivity ? (
                        <div className="validator-stats">
                          <div className="validator-summary">
                            <div className="summary-metric">
                              <span className="metric-label">Total Active Validators</span>
                              <span className="metric-value">
                                {validatorActivity.total_active ?? 'N/A'}
                              </span>
                            </div>
                            <div className="summary-metric">
                              <span className="metric-label">Average Synergy Score</span>
                              <span className="metric-value">
                                {typeof validatorActivity.average_synergy_score === 'number'
                                  ? validatorActivity.average_synergy_score.toFixed(2)
                                  : 'N/A'}
                              </span>
                            </div>
                          </div>
                          <div className="validator-list">
                            <h5>Top Active Validators</h5>
                            <div className="validators-table">
                              <div className="table-header">
                                <span>Validator</span>
                                <span>Name</span>
                                <span>Synergy Score</span>
                                <span>Blocks Produced</span>
                                <span>Uptime</span>
                              </div>
                              {validatorActivity.validators.slice(0, 5).map((validator, index) => (
                                <div key={index} className={`table-row ${validator.address === selectedNode.address ? 'highlight-row' : ''}`}>
                                  <span className="validator-address">
                                    {validator.address.substring(0, 12)}...
                                    {validator.address === selectedNode.address && ' (You)'}
                                  </span>
                                  <span className="validator-name">
                                    {validator.name || 'Anonymous'}
                                  </span>
                                  <span className="synergy-score">
                                    {validator.synergy_score.toFixed(2)}
                                  </span>
                                  <span className="blocks-produced">
                                    {validator.blocks_produced}
                                  </span>
                                  <span className="uptime">{validator.uptime}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <p className="no-data">No validator activity data available</p>
                      )}
                    </div>

                    {/* Network Status */}
                    <div className="monitoring-section">
                      <h4>Network Status</h4>
                      {peerInfo ? (
                        <div className="peer-info-section">
                          <div className="peer-count-header">
                            <div className="status-metric">
                              <div className="metric-label">Connected Peers</div>
                              <div className="metric-value">
                                {peerInfo.peer_count}
                              </div>
                            </div>
                          </div>
                          {peerInfo.peers && peerInfo.peers.length > 0 && (
                            <div className="peers-list">
                              <h5>Connected Peers</h5>
                              {peerInfo.peers.map((peer, index) => (
                                <div key={index} className="peer-item">
                                  <div className="peer-detail">
                                    <span className="peer-label">Node:</span>
                                    <span className="peer-value">
                                      {peer.node_id ? `${peer.node_id.substring(0, 20)}...` : 'Unknown'}
                                    </span>
                                  </div>
                                  <div className="peer-detail">
                                    <span className="peer-label">Address:</span>
                                    <span className="peer-value">{peer.address}</span>
                                  </div>
                                  <div className="peer-detail">
                                    <span className="peer-label">Version:</span>
                                    <span className="peer-value">{peer.version || 'N/A'}</span>
                                  </div>
                                  <div className="peer-detail">
                                    <span className="peer-label">Blocks Sent/Received:</span>
                                    <span className="peer-value">{peer.blocks_sent ?? 'N/A'}/{peer.blocks_received ?? 'N/A'}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="no-data">No peer information available</p>
                      )}
                    </div>
                    <div className="diagnostics-panel">
                      <div className="diagnostics-header">
                        <h4>Connection Diagnostics</h4>
                        {diagnosticsLogPath && (
                          <span className="diag-path">
                            Last captured: {diagnosticsLogPath}
                          </span>
                        )}
                      </div>
                      <pre className="diagnostics-log">
                        {diagnosticsLog || 'No diagnostics captured yet. Use the buttons above to take a snapshot.'}
                      </pre>
                    </div>
                    {!blockValidationStatus && !validatorActivity && !peerInfo && !monitoringLoading && (
                      <div className="no-monitoring-data">
                        <h4>Monitoring Data Unavailable</h4>
                        <p>The node must be running to display real-time monitoring data.</p>
                        <p>Start the node to see live blockchain activity, validator status, and network information.</p>
                      </div>
                    )}
                  </div>
                )}

                {/* REWARDS TAB */}
                {activeTab === 'rewards' && (
                  <div className="rewards-content">
                    <div className="rewards-header">
                      <h3>Rewards & Economics</h3>
                      <button className="btn btn-secondary" onClick={loadRewardsData} disabled={rewardsLoading}>
                        {rewardsLoading ? 'Loading...' : 'Refresh'}
                      </button>
                    </div>

                    {rewardsData ? (
                      <>
                        {/* Earnings Overview */}
                        <div className="earnings-overview">
                          <div className="earnings-card total">
                            <div className="earnings-label">Total Earned (Lifetime)</div>
                            <div className="earnings-value">{formatSNRG(rewardsData.total_earned)} SNRG</div>
                          </div>
                          <div className="earnings-card pending">
                            <div className="earnings-label">Pending Rewards</div>
                            <div className="earnings-value">{formatSNRG(rewardsData.pending_rewards)} SNRG</div>
                            {typeof rewardsData.pending_rewards === 'number' && rewardsData.pending_rewards > 0 && (
                              <button className="btn btn-sm btn-primary">Claim Rewards</button>
                            )}
                          </div>
                          <div className="earnings-card staked">
                            <div className="earnings-label">Total Staked</div>
                            <div className="earnings-value">{formatSNRG(rewardsData.staked_amount)} SNRG</div>
                          </div>
                        </div>

                        {/* Earnings Period */}
                        <div className="earnings-periods">
                          <h4>Earnings by Period</h4>
                          <div className="period-cards">
                            <div className="period-card">
                              <span className="period-label">Last 24 Hours</span>
                              <span className="period-value">{formatSNRG(rewardsData.last_24h)} SNRG</span>
                            </div>
                            <div className="period-card">
                              <span className="period-label">Last 7 Days</span>
                              <span className="period-value">{formatSNRG(rewardsData.last_7d)} SNRG</span>
                            </div>
                            <div className="period-card">
                              <span className="period-label">Last 30 Days</span>
                              <span className="period-value">{formatSNRG(rewardsData.last_30d)} SNRG</span>
                            </div>
                          </div>
                        </div>

                        {/* Staking Info */}
                        <div className="staking-info-section">
                          <h4>Staking Information</h4>
                          <div className="staking-grid">
                            <div className="staking-item">
                              <span className="staking-label">Estimated APY</span>
                              <span className="staking-value highlight">
                                {typeof rewardsData.estimated_apy === 'number'
                                  ? `${rewardsData.estimated_apy.toFixed(2)}%`
                                  : 'N/A'}
                              </span>
                            </div>
                            <div className="staking-item">
                              <span className="staking-label">Commission Rate</span>
                              <span className="staking-value">
                                {typeof rewardsData.commission_rate === 'number'
                                  ? `${rewardsData.commission_rate.toFixed(2)}%`
                                  : 'N/A'}
                              </span>
                            </div>
                            <div className="staking-item">
                              <span className="staking-label">Synergy Multiplier</span>
                              <span className="staking-value">
                                {typeof synergyScoreBreakdown?.multiplier === 'number'
                                  ? `${synergyScoreBreakdown.multiplier.toFixed(2)}x`
                                  : 'N/A'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Reward History */}
                        {rewardsData.reward_history?.length > 0 && (
                          <div className="reward-history-section">
                            <h4>Recent Reward History</h4>
                            <div className="reward-history-table">
                              <div className="table-header">
                                <span>Date</span>
                                <span>Amount</span>
                                <span>Block</span>
                                <span>Type</span>
                              </div>
                              {rewardsData.reward_history.slice(0, 10).map((entry, index) => (
                                <div key={index} className="table-row">
                                  <span>{new Date(entry.timestamp * 1000).toLocaleString()}</span>
                                  <span className="reward-amount">+{formatSNRG(entry.amount)} SNRG</span>
                                  <span>#{entry.block_number}</span>
                                  <span className="reward-type">{entry.reward_type}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="no-data-message">
                        <p>No rewards data available. Start your node and begin validating to earn rewards.</p>
                      </div>
                    )}
                  </div>
                )}

                {/* SECURITY TAB */}
                {activeTab === 'security' && (
                  <div className="security-content">
                    <div className="security-header">
                      <h3>Security Dashboard</h3>
                      <button className="btn btn-secondary" onClick={loadSecurityStatus} disabled={securityLoading}>
                        {securityLoading ? 'Loading...' : 'Refresh'}
                      </button>
                    </div>

                    {securityStatus ? (
                      <>
                        {/* Security Score */}
                        <div className="security-score-banner">
                          <div className="security-score-main">
                            <div className="security-score-value">
                              <span className="score-number">
                                {typeof securityStatus.security_score === 'number'
                                  ? securityStatus.security_score.toFixed(0)
                                  : 'N/A'}
                              </span>
                              <span className="score-label">Security Score</span>
                            </div>
                            {typeof securityStatus.security_score === 'number' && (
                              <div className="security-status" style={{ color: securityStatus.security_score >= 80 ? 'var(--snrg-status-success)' : 'var(--snrg-status-warning)' }}>
                                {securityStatus.security_score >= 80 ? 'SECURE' : 'NEEDS ATTENTION'}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Quantum Security */}
                        <div className="quantum-security-section">
                          <h4>Quantum Security (Aegis Protocol)</h4>
                          <div className="quantum-grid">
                            <div className="quantum-item">
                              <span className="quantum-label">Algorithm</span>
                              <span className="quantum-value">
                                {securityStatus.quantum_security.algorithm || 'N/A'}
                              </span>
                            </div>
                            <div className="quantum-item">
                              <span className="quantum-label">Key Strength</span>
                              <span className="quantum-value">
                                {securityStatus.quantum_security.key_strength || 'N/A'}
                              </span>
                            </div>
                            <div className="quantum-item">
                              <span className="quantum-label">Aegis Status</span>
                              <span className="quantum-value status-active">
                                {securityStatus.quantum_security.aegis_status || 'N/A'}
                              </span>
                            </div>
                            <div className="quantum-item">
                              <span className="quantum-label">Post-Quantum Enabled</span>
                              <span className="quantum-value">
                                {typeof securityStatus.quantum_security.post_quantum_enabled === 'boolean'
                                  ? (securityStatus.quantum_security.post_quantum_enabled ? 'Yes' : 'No')
                                  : 'N/A'}
                              </span>
                            </div>
                            <div className="quantum-item">
                              <span className="quantum-label">Signature Verification Rate</span>
                              <span className="quantum-value">
                                {typeof securityStatus.quantum_security.signature_verification_rate === 'number'
                                  ? `${securityStatus.quantum_security.signature_verification_rate.toFixed(1)}%`
                                  : 'N/A'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Key Management */}
                        <div className="key-management-section">
                          <h4>Key Management</h4>
                          <div className="key-grid">
                            <div className="key-item">
                              <span className="key-label">Last Key Rotation</span>
                              <span className="key-value">
                                {securityStatus.last_key_rotation
                                  ? new Date(securityStatus.last_key_rotation * 1000).toLocaleDateString()
                                  : 'Never'}
                              </span>
                            </div>
                            <div className="key-item">
                              <span className="key-label">Next Key Rotation</span>
                              <span className="key-value">
                                {securityStatus.next_key_rotation
                                  ? new Date(securityStatus.next_key_rotation * 1000).toLocaleDateString()
                                  : 'Not scheduled'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Network Security */}
                        <div className="network-security-section">
                          <h4>Network Security</h4>
                          <div className="network-security-grid">
                            <div className="security-item">
                              <span className="security-label">Firewall</span>
                              <span className={`security-value ${
                                securityStatus.firewall_enabled === true
                                  ? 'status-active'
                                  : securityStatus.firewall_enabled === false
                                    ? 'status-inactive'
                                    : 'status-unknown'
                              }`}>
                                {securityStatus.firewall_enabled === true
                                  ? 'Enabled'
                                  : securityStatus.firewall_enabled === false
                                    ? 'Disabled'
                                    : 'Unknown'}
                              </span>
                            </div>
                            <div className="security-item">
                              <span className="security-label">Open Ports</span>
                              <span className="security-value">{securityStatus.open_ports.join(', ')}</span>
                            </div>
                            <div className="security-item">
                              <span className="security-label">SSL Certificate</span>
                              <span className={`security-value ${
                                securityStatus.ssl_certificate_valid === true
                                  ? 'status-active'
                                  : securityStatus.ssl_certificate_valid === false
                                    ? 'status-inactive'
                                    : 'status-unknown'
                              }`}>
                                {securityStatus.ssl_certificate_valid === true
                                  ? 'Valid'
                                  : securityStatus.ssl_certificate_valid === false
                                    ? 'Invalid'
                                    : 'Unknown'}
                                {typeof securityStatus.ssl_expiry_days === 'number' && ` (${securityStatus.ssl_expiry_days} days)`}
                              </span>
                            </div>
                            <div className="security-item">
                              <span className="security-label">Failed Auth Attempts</span>
                              <span className={`security-value ${
                                typeof securityStatus.failed_auth_attempts === 'number' && securityStatus.failed_auth_attempts > 0
                                  ? 'status-warning'
                                  : ''
                              }`}>
                                {typeof securityStatus.failed_auth_attempts === 'number'
                                  ? securityStatus.failed_auth_attempts
                                  : 'N/A'}
                              </span>
                            </div>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="no-data-message">
                        <p>Loading security status...</p>
                      </div>
                    )}
                  </div>
                )}

                {/* PERFORMANCE TAB */}
                {activeTab === 'performance' && (
                  <div className="performance-content">
                    <div className="performance-header">
                      <h3>Performance & Analytics</h3>
                      <div className="period-selector">
                        <button
                          className={`period-btn ${performancePeriod === '24h' ? 'active' : ''}`}
                          onClick={() => setPerformancePeriod('24h')}
                        >
                          24H
                        </button>
                        <button
                          className={`period-btn ${performancePeriod === '7d' ? 'active' : ''}`}
                          onClick={() => setPerformancePeriod('7d')}
                        >
                          7D
                        </button>
                        <button
                          className={`period-btn ${performancePeriod === '30d' ? 'active' : ''}`}
                          onClick={() => setPerformancePeriod('30d')}
                        >
                          30D
                        </button>
                      </div>
                    </div>

                    {/* Current Stats */}
                    {systemMetrics && (
                      <div className="current-stats-grid">
                        <div className="stat-card">
                          <div className="stat-label">CPU Usage</div>
                          <div className="stat-value">{systemMetrics.cpu_usage.toFixed(1)}%</div>
                          <div className="stat-trend">Current</div>
                        </div>
                        <div className="stat-card">
                          <div className="stat-label">Memory Usage</div>
                          <div className="stat-value">{systemMetrics.memory_percentage.toFixed(1)}%</div>
                          <div className="stat-trend">{formatBytes(systemMetrics.memory_used)}</div>
                        </div>
                        <div className="stat-card">
                          <div className="stat-label">Disk Usage</div>
                          <div className="stat-value">{systemMetrics.disk_percentage.toFixed(1)}%</div>
                          <div className="stat-trend">{formatBytes(systemMetrics.disk_used)}</div>
                        </div>
                        <div className="stat-card">
                          <div className="stat-label">System Uptime</div>
                          <div className="stat-value">{formatUptimeDisplay(systemMetrics.uptime_seconds)}</div>
                          <div className="stat-trend">Host</div>
                        </div>
                        <div className="stat-card">
                          <div className="stat-label">Node Uptime</div>
                          <div className="stat-value">
                            {selectedNode ? formatUptimeDisplay(getNodeUptime(selectedNode)) : '0s'}
                          </div>
                          <div className="stat-trend">Since start</div>
                        </div>
                      </div>
                    )}

                    {/* Performance History Table */}
                    {performanceHistory.length > 0 && (
                      <div className="performance-history-section">
                        <h4>Performance History</h4>
                        <div className="performance-table">
                          <div className="table-header">
                            <span>Time</span>
                            <span>CPU %</span>
                            <span>Memory %</span>
                            <span>Blocks Validated</span>
                          </div>
                          {performanceHistory.slice(0, 12).map((point, index) => (
                            <div key={index} className="table-row">
                              <span>{new Date(point.timestamp * 1000).toLocaleTimeString()}</span>
                              <span>{point.cpu_usage.toFixed(1)}%</span>
                              <span>{point.memory_usage.toFixed(1)}%</span>
                              <span>{point.blocks_validated}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Node Performance Stats */}
                    {selectedNode.is_running && blockValidationStatus && (
                      <div className="node-performance-section">
                        <h4>Node Performance</h4>
                        <div className="node-perf-grid">
                          <div className="perf-item">
                            <span className="perf-label">Blocks Produced</span>
                            <span className="perf-value">{getValidatorBlocksProduced() ?? 'N/A'}</span>
                          </div>
                          <div className="perf-item">
                            <span className="perf-label">Validation Success Rate</span>
                            <span className="perf-value">
                              {validationSuccessRate !== null ? `${validationSuccessRate}%` : 'N/A'}
                            </span>
                          </div>
                          <div className="perf-item">
                            <span className="perf-label">Synergy Score</span>
                            <span className="perf-value">
                              {getNodeSynergyScore(selectedNode.id) !== null
                                ? `${getNodeSynergyScore(selectedNode.id)}%`
                                : 'N/A'}
                            </span>
                          </div>
                          <div className="perf-item">
                            <span className="perf-label">Network Uptime</span>
                            <span className="perf-value">{getUptimePercentage(selectedNode)}%</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* CONFIGURATION TAB */}
                {activeTab === 'config' && (
                  <div className="config-content">
                    {/* Node Identity Section */}
                    <div className="info-section" style={{ marginBottom: '1.5rem' }}>
                      <h3>Node Identity</h3>
                      <div className="info-grid">
                        <div className="info-item">
                          <span className="info-label">Node Address:</span>
                          <span className="info-value address-value">
                            {selectedNode.address || 'Not generated'}
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Display Name:</span>
                          <span className="info-value">{selectedNode.display_name || 'N/A'}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Node Type:</span>
                          <span className="info-value">{selectedNode.node_type}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Operation Mode:</span>
                          <span className="info-value">
                            {selectedNode.operation_mode === 'user_operated_local'
                              ? 'User-operated local'
                              : 'Network participating'}
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Node ID:</span>
                          <span className="info-value">{selectedNode.id}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Node Class:</span>
                          <span className="info-value">{selectedNode.node_class || 'N/A'}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Algorithm:</span>
                          <span className="info-value">
                            {securityStatus?.quantum_security?.algorithm || 'N/A'}
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Node Version:</span>
                          <span className="info-value">{nodeInfo?.version || 'N/A'}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Protocol Version:</span>
                          <span className="info-value">
                            {nodeInfo?.protocol_version ?? 'N/A'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Node Status Details */}
                    <div className="info-section" style={{ marginBottom: '1.5rem' }}>
                      <h3>Node Status</h3>
                      <div className="info-grid">
                        <div className="info-item">
                          <span className="info-label">Network</span>
                          <span className="info-value">{nodeInfo?.network || 'Unknown'}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Chain ID</span>
                          <span className="info-value">{normalizeDevnetChainId(nodeInfo?.chain_id)}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Sync Status</span>
                          <span className="info-value">
                            {nodeInfo?.sync_status
                              ? `${nodeInfo.sync_status.charAt(0).toUpperCase()}${nodeInfo.sync_status.slice(1)}`
                              : 'Unknown'}
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Last Block</span>
                          <span className="info-value">{nodeInfo?.last_block ?? 'N/A'}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Average Block Time</span>
                          <span className="info-value">
                            {nodeInfo?.average_block_time?.toFixed(2) ?? 'N/A'}s
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Consensus</span>
                          <span className="info-value">{nodeInfo?.consensus || 'Proof of Synergy'}</span>
                        </div>
                      </div>
                    </div>

                    {/* Quantum Security Settings */}
                    <div className="info-section" style={{ marginBottom: '1.5rem' }}>
                      <h3>Quantum Security Settings</h3>
                      <div className="info-grid">
                        <div className="info-item">
                          <span className="info-label">Post-Quantum Algorithm:</span>
                          <span className="info-value">
                            {securityStatus?.quantum_security?.algorithm || 'N/A'}
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Security Level:</span>
                          <span className="info-value">
                            {securityStatus?.quantum_security?.key_strength || 'N/A'}
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Aegis Protocol:</span>
                          <span className="info-value status-active">
                            {securityStatus?.quantum_security?.aegis_status || 'N/A'}
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Key Rotation:</span>
                          <span className="info-value">
                            {securityStatus?.next_key_rotation
                              ? new Date(securityStatus.next_key_rotation * 1000).toLocaleDateString()
                              : 'N/A'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="config-header">
                      <h3>Configuration File</h3>
                      <div className="config-actions">
                        {!configEditing ? (
                          <>
                            <button
                              className="btn btn-primary"
                              onClick={() => setConfigEditing(true)}
                              disabled={selectedNode.is_running || configLoading}
                            >
                              Edit Configuration
                            </button>
                            <button
                              className="btn btn-secondary"
                              onClick={handleReloadConfig}
                              disabled={selectedNode.is_running || configLoading}
                            >
                              Reload Configuration
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn btn-success"
                              onClick={handleSaveConfig}
                              disabled={configSaving}
                            >
                              {configSaving ? 'Saving...' : 'Save Changes'}
                            </button>
                            <button
                              className="btn btn-secondary"
                              onClick={() => {
                                setConfigEditing(false);
                                loadConfig();
                              }}
                              disabled={configSaving}
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="info-section" style={{ marginBottom: '1.5rem' }}>
                      <h3>Node Paths</h3>
                      <div className="info-grid">
                        <div className="info-item">
                          <span className="info-label">Config Path</span>
                          <span className="info-value">{selectedNode.config_path}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Data Path</span>
                          <span className="info-value">{selectedNode.data_path}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Logs Path</span>
                          <span className="info-value">{selectedNode.logs_path}</span>
                        </div>
                      </div>
                    </div>
                    {selectedNode.is_running && (
                      <p className="config-warning">
                        Stop the node before editing configuration
                      </p>
                    )}
                    <div className="config-editor">
                      {configLoading ? (
                        <div className="config-loading">
                          <div className="spinner"></div>
                          <p>Loading configuration...</p>
                        </div>
                      ) : (
                        <textarea
                          className="config-textarea"
                          value={configContent}
                          onChange={(e) => setConfigContent(e.target.value)}
                          disabled={!configEditing}
                          rows={25}
                          spellCheck={false}
                        />
                      )}
                    </div>
                    <p className="config-note">
                      Configuration changes require a node restart to take effect.
                    </p>
                  </div>
                )}

                {/* LOGS TAB */}
                {activeTab === 'logs' && (
                  <div className="logs-content">
                    <div className="logs-header">
                      <h3>Node Logs</h3>
                      <div className="logs-controls">
                        <select
                          className="log-filter-select"
                          value={logFilter}
                          onChange={(e) => setLogFilter(e.target.value)}
                        >
                          <option value="all">All Levels</option>
                          <option value="error">Errors</option>
                          <option value="warn">Warnings</option>
                          <option value="info">Info</option>
                          <option value="debug">Debug</option>
                        </select>
                        <input
                          type="text"
                          className="log-search-input"
                          placeholder="Search logs..."
                          value={logSearch}
                          onChange={(e) => setLogSearch(e.target.value)}
                        />
                        <label className="auto-scroll-toggle">
                          <input
                            type="checkbox"
                            checked={autoScrollLogs}
                            onChange={(e) => setAutoScrollLogs(e.target.checked)}
                          />
                          Auto-scroll
                        </label>
                        <button
                          className="btn btn-secondary"
                          onClick={loadLogs}
                          disabled={logsLoading}
                        >
                          {logsLoading ? 'Refreshing...' : 'Refresh'}
                        </button>
                      </div>
                    </div>
                    <p className="logs-path">
                      <strong>Log Directory:</strong> {selectedNode.logs_path}
                    </p>
                    <div className="logs-viewer">
                      {logsLoading && logs === '' ? (
                        <div className="logs-loading">
                          <div className="spinner"></div>
                          <p>Loading logs...</p>
                        </div>
                      ) : (
                        <pre className="logs-output">{filteredLogs}</pre>
                      )}
                    </div>
                  </div>
                )}

                {/* NETWORK TAB */}
                {activeTab === 'network' && (
                  <div className="network-content">
                    <div className="network-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                      <h3>Network Discovery</h3>
                      <button
                        className="btn btn-secondary"
                        onClick={refreshNetworkData}
                        disabled={networkLoading}
                      >
                        {networkLoading ? 'Refreshing...' : 'Refresh'}
                      </button>
                    </div>

                    {networkLoading && !networkPeers ? (
                      <div className="network-loading" style={{ textAlign: 'center', padding: '2rem' }}>
                        <div className="spinner"></div>
                        <p>Discovering network peers...</p>
                      </div>
                    ) : networkPeers ? (
                      <>
                        <div className="network-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                          <div className="metric-card">
                            <div className="metric-label">Discovered Peers</div>
                            <div className="metric-value" style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{networkPeers.peer_count}</div>
                          </div>
                          <div className="metric-card">
                            <div className="metric-label">Bootstrap Nodes</div>
                            <div className="metric-value" style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
                              {networkPeers.bootstrap_nodes_reachable}/{networkPeers.bootstrap_nodes_total}
                            </div>
                            <div className="metric-unit" style={{ fontSize: '0.8rem', color: 'var(--snrg-text-secondary)' }}>reachable</div>
                          </div>
                          {networkPeers.chain_id && (
                            <div className="metric-card">
                              <div className="metric-label">Chain ID</div>
                              <div className="metric-value" style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{normalizeDevnetChainId(networkPeers.chain_id)}</div>
                            </div>
                          )}
                          {networkPeers.current_block && (
                            <div className="metric-card">
                              <div className="metric-label">Current Block</div>
                              <div className="metric-value" style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{networkPeers.current_block}</div>
                            </div>
                          )}
                          <div className="metric-card">
                            <div className="metric-label">Last Updated</div>
                            <div className="metric-value" style={{ fontSize: '1rem' }}>
                              {new Date(networkPeers.last_updated * 1000).toLocaleTimeString()}
                            </div>
                          </div>
                        </div>

                        {/* Bandwidth Stats */}
                        {systemMetrics && (
                          <div className="bandwidth-section" style={{ marginBottom: '1.5rem' }}>
                            <h4>Bandwidth Usage</h4>
                            <div className="bandwidth-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                              <div className="bandwidth-card">
                                <span className="bandwidth-label">Total Downloaded</span>
                                <span className="bandwidth-value">{formatBytes(systemMetrics.network_rx_bytes)}</span>
                              </div>
                              <div className="bandwidth-card">
                                <span className="bandwidth-label">Total Uploaded</span>
                                <span className="bandwidth-value">{formatBytes(systemMetrics.network_tx_bytes)}</span>
                              </div>
                            </div>
                          </div>
                        )}

                        <div className="peers-list">
                          <h4 style={{ marginBottom: '1rem' }}>Discovered Peers ({networkPeers.peers.length})</h4>
                          {networkPeers.peers.length === 0 ? (
                            <p style={{ color: 'var(--snrg-text-secondary)' }}>No peers discovered yet. The network may be starting up.</p>
                          ) : (
                            <div className="peers-table" style={{ overflowX: 'auto' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                  <tr style={{ borderBottom: '1px solid var(--snrg-border-neutral)' }}>
                                    <th style={{ textAlign: 'left', padding: '0.75rem', color: 'var(--snrg-text-secondary)' }}>Address</th>
                                    <th style={{ textAlign: 'left', padding: '0.75rem', color: 'var(--snrg-text-secondary)' }}>Node ID</th>
                                    <th style={{ textAlign: 'left', padding: '0.75rem', color: 'var(--snrg-text-secondary)' }}>Version</th>
                                    <th style={{ textAlign: 'right', padding: '0.75rem', color: 'var(--snrg-text-secondary)' }}>Blocks Sent</th>
                                    <th style={{ textAlign: 'right', padding: '0.75rem', color: 'var(--snrg-text-secondary)' }}>Blocks Received</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {networkPeers.peers.map((peer, index) => (
                                    <tr key={index} style={{ borderBottom: '1px solid var(--snrg-border-neutral-weak)' }}>
                                      <td style={{ padding: '0.75rem', fontFamily: 'monospace', fontSize: '0.9rem' }}>{peer.address}</td>
                                      <td style={{ padding: '0.75rem', fontFamily: 'monospace', fontSize: '0.85rem', color: 'var(--snrg-text-secondary)' }}>{peer.node_id || '-'}</td>
                                      <td style={{ padding: '0.75rem' }}>{peer.version || '-'}</td>
                                      <td style={{ padding: '0.75rem', textAlign: 'right' }}>{peer.blocks_sent}</td>
                                      <td style={{ padding: '0.75rem', textAlign: 'right' }}>{peer.blocks_received}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="no-network-data" style={{ textAlign: 'center', padding: '2rem' }}>
                        <p style={{ marginBottom: '1rem' }}>Click Refresh to discover network peers</p>
                        <button className="btn btn-primary" onClick={loadNetworkData}>
                          Discover Peers
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          {error && (
            <div className="error-banner">
              <strong>Error:</strong> {error}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default MultiNodeDashboard;
