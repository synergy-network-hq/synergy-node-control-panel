import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Link } from 'react-router-dom';

const REFRESH_SECONDS_OPTIONS = [3, 5, 10, 15, 30];

function truncate(value, max = 120) {
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function NetworkMonitorDashboard() {
  const [snapshot, setSnapshot] = useState(null);
  const [refreshSeconds, setRefreshSeconds] = useState(5);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [workspaceReady, setWorkspaceReady] = useState(false);

  // Global reset chain state
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetResult, setResetResult] = useState(null);

  const fetchSnapshot = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      if (!workspaceReady) {
        await invoke('monitor_initialize_workspace');
        await invoke('monitor_apply_devnet_topology');
        setWorkspaceReady(true);
      }
      const data = await invoke('get_monitor_snapshot');
      setSnapshot(data);
      setError('');
    } catch (err) {
      console.error('Failed to fetch monitor snapshot:', err);
      setError(String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchSnapshot();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const handle = setInterval(() => {
      fetchSnapshot(true);
    }, refreshSeconds * 1000);
    return () => clearInterval(handle);
  }, [autoRefresh, refreshSeconds, workspaceReady]);

  const handleGlobalResetChain = async () => {
    setResetBusy(true);
    setResetResult(null);
    try {
      const result = await invoke('monitor_bulk_node_control', {
        action: 'reset_chain',
        scope: 'all',
      });
      setResetResult(result);
      // Refresh dashboard after reset
      await fetchSnapshot(true);
    } catch (err) {
      setResetResult({ error: String(err) });
    } finally {
      setResetBusy(false);
      setResetConfirmOpen(false);
    }
  };

  const nodes = snapshot?.nodes || [];

  if (loading) {
    return (
      <section className="monitor-shell">
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Loading network monitor...</p>
        </div>
      </section>
    );
  }

  return (
    <section className="monitor-shell">
      <div className="monitor-toolbar">
        <div className="monitor-toolbar-left">
          <h2>Synergy Devnet Control Panel</h2>
          <div className="monitor-cards monitor-cards-compact">
            <article className="monitor-card monitor-card-border-lime">
              <span>Total Nodes</span>
              <strong>{snapshot?.total_nodes ?? 0}</strong>
            </article>
            <article className="monitor-card monitor-card-border-cyan">
              <span>Online</span>
              <strong>{snapshot?.online_nodes ?? 0}</strong>
            </article>
            <article className="monitor-card monitor-card-border-purple">
              <span>Offline</span>
              <strong>{snapshot?.offline_nodes ?? 0}</strong>
            </article>
            <article className="monitor-card monitor-card-border-blue">
              <span>Syncing</span>
              <strong>{snapshot?.syncing_nodes ?? 0}</strong>
            </article>
            <article className="monitor-card monitor-card-border-lime">
              <span>Highest Block</span>
              <strong>{snapshot?.highest_block ?? 'N/A'}</strong>
            </article>
          </div>
        </div>
        <div className="monitor-toolbar-right">
          <Link className="monitor-link-btn" to="/settings">
            Operator Configuration
          </Link>
          <button className="monitor-btn monitor-btn-primary" onClick={() => fetchSnapshot()}>
            Refresh Now
          </button>
          <button
            className="monitor-btn monitor-btn-danger"
            onClick={() => setResetConfirmOpen(true)}
            disabled={resetBusy}
            title="Reset all machines back to genesis block"
          >
            {resetBusy ? 'Resetting...' : 'Reset Chain to Genesis'}
          </button>
          <label className="monitor-toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            Auto-refresh
          </label>
          <label className="monitor-refresh-select">
            Interval
            <select
              value={refreshSeconds}
              onChange={(event) => setRefreshSeconds(Number(event.target.value))}
              disabled={!autoRefresh}
            >
              {REFRESH_SECONDS_OPTIONS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds}
                  s
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Global Reset Confirmation Dialog */}
      {resetConfirmOpen && (
        <div className="monitor-confirm-overlay">
          <div className="monitor-confirm-dialog">
            <h3>Reset Chain to Genesis</h3>
            <p>
              This will send a
              {' '}
              <code>reset_chain</code>
              {' '}
              command to
              {' '}
              <strong>all {snapshot?.total_nodes ?? 0} nodes</strong>
              {' '}
              across all machines. Each node will:
            </p>
            <ul>
              <li>Stop running</li>
              <li>Delete all chain state, logs, and runtime artifacts</li>
              <li>Redeploy configuration from the installer bundle</li>
              <li>Restart from genesis block 0</li>
            </ul>
            <p className="monitor-confirm-warning">
              This action is irreversible. All chain data will be permanently deleted.
            </p>
            <div className="monitor-confirm-actions">
              <button
                className="monitor-btn"
                onClick={() => setResetConfirmOpen(false)}
                disabled={resetBusy}
              >
                Cancel
              </button>
              <button
                className="monitor-btn monitor-btn-danger"
                onClick={handleGlobalResetChain}
                disabled={resetBusy}
              >
                {resetBusy ? 'Resetting All Nodes...' : 'Confirm: Reset All Nodes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Result Banner */}
      {resetResult && !resetResult.error && (
        <div className="monitor-success-box">
          <strong>Chain reset complete:</strong>
          {' '}
          {resetResult.succeeded} succeeded, {resetResult.failed} failed across {resetResult.requested_nodes} nodes.
          <button className="monitor-dismiss-btn" onClick={() => setResetResult(null)}>✕</button>
        </div>
      )}
      {resetResult?.error && (
        <div className="monitor-error-box">
          <strong>Chain reset failed:</strong>
          {' '}
          {truncate(resetResult.error, 260)}
          <button className="monitor-dismiss-btn" onClick={() => setResetResult(null)}>✕</button>
        </div>
      )}

      {error && (
        <div className="monitor-error-box">
          <strong>Monitor backend error:</strong>
          {' '}
          {truncate(error, 260)}
        </div>
      )}

      <div className="monitor-table-wrap">
        <table className="monitor-table">
          <thead>
            <tr>
              <th>Physical Machine</th>
              <th>Node Slot</th>
              <th>Node ID</th>
              <th>Role Group</th>
              <th>Role</th>
              <th>Type</th>
              <th>RPC</th>
              <th>Status</th>
              <th>Block</th>
              <th>Peers</th>
              <th>Syncing</th>
              <th>Latency</th>
              <th>Error</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((entry) => (
              <tr key={entry.node.machine_id}>
                <td>{entry.node.physical_machine || entry.node.machine_id}</td>
                <td>{entry.node.machine_id}</td>
                <td>{entry.node.node_id}</td>
                <td>{entry.node.role_group}</td>
                <td>{entry.node.role}</td>
                <td>{entry.node.node_type}</td>
                <td>
                  <code>{entry.node.rpc_url}</code>
                </td>
                <td>
                  <span className={`status-pill status-${entry.status}`}>{entry.status}</span>
                </td>
                <td>{entry.block_height ?? 'N/A'}</td>
                <td>{entry.peer_count ?? 'N/A'}</td>
                <td>{entry.syncing === null ? 'N/A' : String(entry.syncing)}</td>
                <td>
                  {entry.response_ms}
                  {' '}
                  ms
                </td>
                <td>{truncate(entry.error || '')}</td>
                <td>
                  <Link
                    className="monitor-link-btn"
                    to={`/node/${encodeURIComponent(entry.node.machine_id)}`}
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default NetworkMonitorDashboard;
