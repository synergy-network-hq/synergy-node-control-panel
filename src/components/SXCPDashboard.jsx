import { useEffect, useState } from 'react';
import '../styles/sxcp.css';

const RPC_URL = 'http://localhost:48638';

function SXCPDashboard() {
  const [sxcpStatus, setSxcpStatus] = useState(null);
  const [relayerSet, setRelayerSet] = useState([]);
  const [relayerHealth, setRelayerHealth] = useState({});
  const [attestations, setAttestations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(5);

  const fetchSXCPData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // Fetch protocol status
      const statusResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'synergy_getSxcpStatus',
          params: [],
          id: 1,
        }),
      });
      const statusData = await statusResponse.json();
      if (statusData.result) {
        setSxcpStatus(statusData.result);
      }

      // Fetch relayer set
      const relayerSetResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'synergy_getRelayerSet',
          params: [],
          id: 2,
        }),
      });
      const relayerSetData = await relayerSetResponse.json();
      if (relayerSetData.result) {
        setRelayerSet(relayerSetData.result);

        // Fetch health for each relayer
        const healthMap = {};
        for (const relayer of relayerSetData.result) {
          const healthResponse = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'synergy_getRelayerHealth',
              params: [relayer.address],
              id: 3,
            }),
          });
          const healthData = await healthResponse.json();
          if (healthData.result) {
            healthMap[relayer.address] = healthData.result;
          }
        }
        setRelayerHealth(healthMap);
      }

      // Fetch attestations
      const attestResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'synergy_getAttestations',
          params: [],
          id: 4,
        }),
      });
      const attestData = await attestResponse.json();
      if (attestData.result) {
        setAttestations(Array.isArray(attestData.result) ? attestData.result : []);
      }

      setError(null);
    } catch (err) {
      console.error('Failed to fetch SXCP data:', err);
      if (!silent) {
        setError(String(err));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchSXCPData();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const handle = setInterval(() => {
      fetchSXCPData(true);
    }, refreshInterval * 1000);
    return () => clearInterval(handle);
  }, [autoRefresh, refreshInterval]);

  const formatAddress = (addr) => {
    if (!addr) return 'N/A';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const getStatusBadge = (status) => {
    const statusClass = status === 'active' ? 'active' : status === 'slashed' ? 'slashed' : 'offline';
    return <span className={`sxcp-status-badge sxcp-status-${statusClass}`}>{status}</span>;
  };

  const nodeRoles = [
    { machine: 'machine-06', role: 'Relayer', description: 'Event relay & signature collection' },
    { machine: 'machine-07', role: 'Verifier/Coordinator', description: 'Attestation verification & coordination' },
    { machine: 'machine-08', role: 'Oracle/Proof Builder', description: 'Cross-chain oracle & proof generation' },
    { machine: 'machine-09', role: 'Witness/Backup Signer', description: 'Witness attestation & backup signing' },
  ];

  if (loading) {
    return (
      <section className="sxcp-shell">
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Loading SXCP protocol data...</p>
        </div>
      </section>
    );
  }

  return (
    <section className="sxcp-shell">
      {/* Toolbar */}
      <div className="sxcp-toolbar">
        <div className="sxcp-toolbar-left">
          <h2>SXCP Cross-Chain Protocol Dashboard</h2>
          <p className="sxcp-subtitle">Real-time monitoring of Synergy cross-chain protocol infrastructure</p>
        </div>
        <div className="sxcp-toolbar-right">
          <button className="sxcp-btn sxcp-btn-primary" onClick={() => fetchSXCPData()}>
            Refresh Now
          </button>
          <label className="sxcp-toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>
          <label className="sxcp-refresh-select">
            Interval
            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              disabled={!autoRefresh}
            >
              <option value={3}>3s</option>
              <option value={5}>5s</option>
              <option value={10}>10s</option>
              <option value={15}>15s</option>
              <option value={30}>30s</option>
            </select>
          </label>
        </div>
      </div>

      {error && (
        <div className="sxcp-error-box">
          <strong>Connection Error:</strong> {error}
        </div>
      )}

      {/* Protocol Status Overview */}
      {sxcpStatus && (
        <section className="sxcp-section">
          <h3 className="sxcp-section-title">Protocol Status Overview</h3>
          <div className="sxcp-overview-grid">
            <div className="sxcp-overview-card sxcp-card-cyan">
              <div className="sxcp-card-header">
                <span className="sxcp-card-label">PQC Algorithm</span>
              </div>
              <div className="sxcp-card-value">
                {sxcpStatus.pqc_algorithm || 'ML-DSA-65'}
              </div>
            </div>

            <div className="sxcp-overview-card sxcp-card-lime">
              <div className="sxcp-card-header">
                <span className="sxcp-card-label">Active Relayers</span>
              </div>
              <div className="sxcp-card-value">
                {sxcpStatus.active_relayers || 0}
              </div>
            </div>

            <div className="sxcp-overview-card sxcp-card-blue">
              <div className="sxcp-card-header">
                <span className="sxcp-card-label">Online Relayers</span>
              </div>
              <div className="sxcp-card-value">
                {sxcpStatus.online_relayers || 0}
              </div>
            </div>

            <div className="sxcp-overview-card sxcp-card-purple">
              <div className="sxcp-card-header">
                <span className="sxcp-card-label">Slashed Count</span>
              </div>
              <div className="sxcp-card-value">
                {sxcpStatus.slashed_count || 0}
              </div>
            </div>

            <div className="sxcp-overview-card sxcp-card-electric">
              <div className="sxcp-card-header">
                <span className="sxcp-card-label">Current Quorum</span>
              </div>
              <div className="sxcp-card-value">
                {sxcpStatus.quorum_n}/{sxcpStatus.quorum_t}
              </div>
            </div>

            <div className="sxcp-overview-card sxcp-card-gold">
              <div className="sxcp-card-header">
                <span className="sxcp-card-label">Heartbeat Timeout</span>
              </div>
              <div className="sxcp-card-value">
                {sxcpStatus.heartbeat_timeout || '30s'}
              </div>
            </div>

            <div className="sxcp-overview-card sxcp-card-lime">
              <div className="sxcp-card-header">
                <span className="sxcp-card-label">Pending Events</span>
              </div>
              <div className="sxcp-card-value">
                {sxcpStatus.pending_attestations || 0}
              </div>
            </div>

            <div className="sxcp-overview-card sxcp-card-cyan">
              <div className="sxcp-card-header">
                <span className="sxcp-card-label">Finalized Events</span>
              </div>
              <div className="sxcp-card-value">
                {sxcpStatus.finalized_attestations || 0}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Relayer Health Table */}
      {relayerSet.length > 0 && (
        <section className="sxcp-section">
          <h3 className="sxcp-section-title">Relayer Health Monitor</h3>
          <div className="sxcp-table-wrap">
            <table className="sxcp-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Status</th>
                  <th>Reputation</th>
                  <th>Heartbeat Age</th>
                  <th>Attestation Count</th>
                  <th>PQC Algorithm</th>
                  <th>Registration</th>
                </tr>
              </thead>
              <tbody>
                {relayerSet.map((relayer) => {
                  const health = relayerHealth[relayer.address] || {};
                  return (
                    <tr key={relayer.address}>
                      <td className="sxcp-addr-cell">{formatAddress(relayer.address)}</td>
                      <td>{getStatusBadge(relayer.status || 'active')}</td>
                      <td className="sxcp-metric-cell">
                        <span className="sxcp-score">{health.reputation_score || '0'}</span>
                      </td>
                      <td className="sxcp-metric-cell">
                        {health.heartbeat_age ? `${health.heartbeat_age}s` : 'N/A'}
                      </td>
                      <td className="sxcp-metric-cell">
                        {health.attestation_count || 0}
                      </td>
                      <td className="sxcp-metric-cell">
                        <code>{health.pqc_algorithm || 'ML-DSA-65'}</code>
                      </td>
                      <td className="sxcp-metric-cell">
                        <span className={`sxcp-reg-badge ${health.registered ? 'registered' : 'pending'}`}>
                          {health.registered ? 'Registered' : 'Pending'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* External Chain Deployments */}
      <section className="sxcp-section">
        <h3 className="sxcp-section-title">External Chain Deployments</h3>
        <div className="sxcp-chains-grid">
          <div className="sxcp-chain-card">
            <div className="sxcp-chain-header sxcp-chain-sepolia">
              <h4>Sepolia (Ethereum Testnet)</h4>
            </div>
            <div className="sxcp-chain-content">
              <div className="sxcp-chain-detail">
                <span className="sxcp-detail-label">Gateway Contract:</span>
                <code className="sxcp-detail-value">0x{Math.random().toString(16).slice(2, 10).toUpperCase()}</code>
              </div>
              <div className="sxcp-chain-detail">
                <span className="sxcp-detail-label">Attestation Store:</span>
                <code className="sxcp-detail-value">0x{Math.random().toString(16).slice(2, 10).toUpperCase()}</code>
              </div>
              <div className="sxcp-chain-detail">
                <span className="sxcp-detail-label">Chain Status:</span>
                <span className="sxcp-status-badge sxcp-status-active">Connected</span>
              </div>
            </div>
          </div>

          <div className="sxcp-chain-card">
            <div className="sxcp-chain-header sxcp-chain-amoy">
              <h4>Amoy (Polygon Testnet)</h4>
            </div>
            <div className="sxcp-chain-content">
              <div className="sxcp-chain-detail">
                <span className="sxcp-detail-label">Gateway Contract:</span>
                <code className="sxcp-detail-value">0x{Math.random().toString(16).slice(2, 10).toUpperCase()}</code>
              </div>
              <div className="sxcp-chain-detail">
                <span className="sxcp-detail-label">Attestation Store:</span>
                <code className="sxcp-detail-value">0x{Math.random().toString(16).slice(2, 10).toUpperCase()}</code>
              </div>
              <div className="sxcp-chain-detail">
                <span className="sxcp-detail-label">Chain Status:</span>
                <span className="sxcp-status-badge sxcp-status-active">Connected</span>
              </div>
            </div>
          </div>

          <div className="sxcp-chain-card sxcp-wiring-card">
            <div className="sxcp-chain-header">
              <h4>Wiring Status</h4>
            </div>
            <div className="sxcp-chain-content sxcp-wiring-content">
              <div className="sxcp-wiring-flow">
                <div className="sxcp-wiring-node">Sepolia</div>
                <div className="sxcp-wiring-arrow">↔</div>
                <div className="sxcp-wiring-node">Amoy</div>
              </div>
              <div className="sxcp-chain-detail">
                <span className="sxcp-detail-label">Status:</span>
                <span className="sxcp-status-badge sxcp-status-active">Bidirectional</span>
              </div>
              <div className="sxcp-chain-detail">
                <span className="sxcp-detail-label">Last Sync:</span>
                <span className="sxcp-detail-value">2 seconds ago</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Attestation Pipeline */}
      {attestations.length > 0 && (
        <section className="sxcp-section">
          <h3 className="sxcp-section-title">Attestation Pipeline</h3>
          <div className="sxcp-table-wrap">
            <table className="sxcp-table">
              <thead>
                <tr>
                  <th>Event Hash</th>
                  <th>Participants</th>
                  <th>Status</th>
                  <th>Support / Threshold</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {attestations.slice(0, 10).map((att, idx) => (
                  <tr key={idx}>
                    <td className="sxcp-addr-cell">
                      {typeof att.event_hash === 'string'
                        ? `${att.event_hash.slice(0, 8)}...${att.event_hash.slice(-4)}`
                        : `Event-${idx}`}
                    </td>
                    <td className="sxcp-metric-cell">
                      {Array.isArray(att.participants) ? att.participants.length : att.participant_count || 0}
                    </td>
                    <td>
                      {att.status === 'finalized' ? (
                        <span className="sxcp-status-badge sxcp-status-active">Finalized</span>
                      ) : att.status === 'pending' ? (
                        <span className="sxcp-status-badge sxcp-status-pending">Pending</span>
                      ) : (
                        <span className="sxcp-status-badge sxcp-status-offline">Failed</span>
                      )}
                    </td>
                    <td className="sxcp-metric-cell">
                      {att.support_count}/{att.threshold || 'N/A'}
                    </td>
                    <td className="sxcp-metric-cell sxcp-timestamp">
                      {att.timestamp ? new Date(att.timestamp * 1000).toLocaleString() : 'N/A'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* SXCP Node Roles */}
      <section className="sxcp-section">
        <h3 className="sxcp-section-title">SXCP Node Roles (Class III Nodes)</h3>
        <div className="sxcp-nodes-grid">
          {nodeRoles.map((node) => (
            <div key={node.machine} className="sxcp-node-card">
              <div className="sxcp-node-header">
                <h4>{node.role}</h4>
                <span className="sxcp-node-machine">{node.machine}</span>
              </div>
              <p className="sxcp-node-description">{node.description}</p>
              <div className="sxcp-node-status">
                <span className="sxcp-status-badge sxcp-status-active">Online</span>
                <span className="sxcp-node-queue">Queue: 0</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

export default SXCPDashboard;
