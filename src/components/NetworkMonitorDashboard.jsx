import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Link } from 'react-router-dom';

const REFRESH_SECONDS_OPTIONS = [3, 5, 10, 15, 30];

function truncate(value, max = 120) {
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function formatCountRatio(value, total) {
  const safeValue = Number(value || 0);
  const safeTotal = Number(total || 0);
  return `${safeValue}/${safeTotal}`;
}

function formatWholeNumber(value) {
  if (value === null || value === undefined) return 'N/A';
  return Number(value).toLocaleString();
}

function formatBlockTime(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  return `${Number(value).toFixed(2)}s`;
}

function formatThroughput(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  const numeric = Number(value);
  const digits = numeric >= 10 ? 1 : 2;
  return `${numeric.toFixed(digits)} tx/s`;
}

function NetworkMonitorDashboard() {
  const [snapshot, setSnapshot] = useState(null);
  const [agentSnapshot, setAgentSnapshot] = useState(null);
  const [refreshSeconds, setRefreshSeconds] = useState(5);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [workspaceReady, setWorkspaceReady] = useState(false);

  // Global reset chain state
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetResult, setResetResult] = useState(null);

  // Global fleet control state (stop all / start all / restart all / sync_node)
  const [fleetAction, setFleetAction] = useState(null); // 'stop' | 'start' | 'restart' | 'sync_node'
  const [fleetConfirmOpen, setFleetConfirmOpen] = useState(false);
  const [fleetBusy, setFleetBusy] = useState(false);
  const [fleetResult, setFleetResult] = useState(null);
  const [nodeActionKey, setNodeActionKey] = useState('');

  const fetchSnapshot = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      if (!workspaceReady) {
        await invoke('monitor_initialize_workspace');
        await invoke('monitor_apply_devnet_topology');
        setWorkspaceReady(true);
      }
      const [data, agentData] = await Promise.all([
        invoke('get_monitor_snapshot'),
        invoke('get_monitor_agent_snapshot').catch(() => null),
      ]);
      setSnapshot(data);
      setAgentSnapshot(agentData);
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

  const handleFleetConfirm = (action) => {
    setFleetAction(action);
    setFleetResult(null);
    setFleetConfirmOpen(true);
  };

  const handleGlobalFleet = async () => {
    if (!fleetAction) return;
    setFleetBusy(true);
    setFleetResult(null);
    try {
      const result = await invoke('monitor_bulk_node_control', {
        action: fleetAction,
        scope: 'all',
      });
      setFleetResult({ action: fleetAction, ...result });
      await fetchSnapshot(true);
    } catch (err) {
      setFleetResult({ action: fleetAction, error: String(err) });
    } finally {
      setFleetBusy(false);
      setFleetConfirmOpen(false);
    }
  };

  const handleNodeAction = async (nodeSlotId, action) => {
    const actionKey = `${nodeSlotId}:${action}`;
    setNodeActionKey(actionKey);
    setFleetResult(null);
    try {
      await invoke('monitor_node_control', {
        nodeSlotId,
        action,
      });
      await fetchSnapshot(true);
      setError('');
    } catch (err) {
      console.error(`Failed to ${action} ${nodeSlotId}:`, err);
      setError(String(err));
    } finally {
      setNodeActionKey('');
    }
  };

  const nodes = snapshot?.nodes || [];
  const totalNodes = snapshot?.total_nodes ?? 0;
  const summaryCards = [
    {
      label: 'Online',
      value: formatCountRatio(snapshot?.online_nodes, totalNodes),
      note: 'Nodes responding',
      tone: 'cyan',
    },
    {
      label: 'Syncing',
      value: formatCountRatio(snapshot?.syncing_nodes, totalNodes),
      note: 'Catching up',
      tone: 'blue',
    },
    {
      label: 'Average Block Time',
      value: formatBlockTime(snapshot?.average_block_time_secs),
      note: 'Consensus cadence',
      tone: 'violet',
    },
    {
      label: 'Offline',
      value: formatCountRatio(snapshot?.offline_nodes, totalNodes),
      note: 'Need attention',
      tone: 'crimson',
    },
    {
      label: 'Highest Block',
      value: formatWholeNumber(snapshot?.highest_block),
      note: 'Network head',
      tone: 'lime',
    },
    {
      label: 'Throughput',
      value: formatThroughput(snapshot?.throughput_tps),
      note: 'Block emission velocity',
      tone: 'amber',
    },
  ];

  // Build a per-machine agent lookup so the table can show agent reachability without
  // an extra column fetch.  Keyed on physical_machine_id to match entry.node.physical_machine_id.
  const agentByMachine = {};
  for (const a of (agentSnapshot?.agents || [])) {
    agentByMachine[a.physical_machine_id] = a;
  }

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
          <div className="monitor-summary-strip">
            <div className="monitor-summary-title">
              <h2>Devnet Control Panel</h2>
            </div>
            <div className="monitor-summary-grid">
              {summaryCards.map((card) => (
                <article
                  key={card.label}
                  className={`monitor-summary-card monitor-summary-card-${card.tone}`}
                >
                  <span className="monitor-summary-card-label">{card.label}</span>
                  <strong className="monitor-summary-card-value">{card.value}</strong>
                  <span className="monitor-summary-card-note">{card.note}</span>
                </article>
              ))}
            </div>
          </div>
        </div>
        <div className="monitor-toolbar-right">
          <div className="monitor-toolbar-actions">
            <button className="monitor-btn monitor-btn-primary" onClick={() => fetchSnapshot()}>
              Refresh Now
            </button>
            <button
              className="monitor-btn monitor-btn-success"
              onClick={() => handleFleetConfirm('start')}
              disabled={fleetBusy || resetBusy}
              title="Start all nodes across all machines"
            >
              {fleetBusy && fleetAction === 'start' ? 'Starting...' : 'Start All'}
            </button>
            <button
              className="monitor-btn"
              onClick={() => handleFleetConfirm('stop')}
              disabled={fleetBusy || resetBusy}
              title="Stop all nodes across all machines"
            >
              {fleetBusy && fleetAction === 'stop' ? 'Stopping...' : 'Stop All'}
            </button>
            <button
              className="monitor-btn monitor-btn-primary"
              onClick={() => handleFleetConfirm('restart')}
              disabled={fleetBusy || resetBusy}
              title="Restart all nodes across all machines"
            >
              {fleetBusy && fleetAction === 'restart' ? 'Restarting...' : 'Restart All'}
            </button>
            <button
              className="monitor-btn monitor-btn-warning"
              onClick={() => handleFleetConfirm('sync_node')}
              disabled={fleetBusy || resetBusy}
              title="Download all missing blocks on every node without starting them. Use after a reset or for nodes that have been offline."
            >
              {fleetBusy && fleetAction === 'sync_node' ? 'Syncing All...' : 'Sync All'}
            </button>
            <button
              className="monitor-btn monitor-btn-danger"
              onClick={() => setResetConfirmOpen(true)}
              disabled={resetBusy || fleetBusy}
              title="Reset all machines back to genesis block (no auto-restart)"
            >
              {resetBusy ? 'Resetting...' : 'Reset Chain to Genesis'}
            </button>
          </div>
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
            </ul>
            <p className="monitor-confirm-warning">
              This action is irreversible. All chain data will be permanently deleted.
              Nodes will <strong>not</strong> auto-restart — use <em>Sync All</em> then <em>Start All</em> when ready.
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

      {/* Fleet Action Confirmation Dialog */}
      {fleetConfirmOpen && fleetAction && (
        <div className="monitor-confirm-overlay">
          <div className="monitor-confirm-dialog">
            <h3>
              {fleetAction === 'stop' && 'Stop All Nodes'}
              {fleetAction === 'start' && 'Start All Nodes'}
              {fleetAction === 'restart' && 'Restart All Nodes'}
              {fleetAction === 'sync_node' && 'Sync All Nodes'}
            </h3>
            {fleetAction === 'sync_node' ? (
              <p>
                This will run <code>nodectl sync</code> on{' '}
                <strong>all {snapshot?.total_nodes ?? 0} nodes</strong> in parallel. Each node will
                download all missing blocks from peers <em>without starting</em>. This can take up
                to 2 hours for cold nodes. Nodes should be stopped before syncing.
              </p>
            ) : (
              <p>
                This will send a{' '}
                <code>{fleetAction}</code>{' '}
                command to{' '}
                <strong>all {snapshot?.total_nodes ?? 0} nodes</strong>{' '}
                across all machines.
              </p>
            )}
            <div className="monitor-confirm-actions">
              <button
                className="monitor-btn"
                onClick={() => setFleetConfirmOpen(false)}
                disabled={fleetBusy}
              >
                Cancel
              </button>
              <button
                className={`monitor-btn ${
                  fleetAction === 'stop'
                    ? ''
                    : fleetAction === 'sync_node'
                      ? 'monitor-btn-warning'
                      : 'monitor-btn-primary'
                }`}
                onClick={handleGlobalFleet}
                disabled={fleetBusy}
              >
                {fleetBusy
                  ? fleetAction === 'sync_node'
                    ? 'Syncing All Nodes...'
                    : `${fleetAction.charAt(0).toUpperCase()}${fleetAction.slice(1)}ing All Nodes...`
                  : fleetAction === 'sync_node'
                    ? 'Confirm: Sync All Nodes'
                    : `Confirm: ${fleetAction.charAt(0).toUpperCase()}${fleetAction.slice(1)} All Nodes`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fleet Action Result Banner */}
      {fleetResult && !fleetResult.error && (
        <div className="monitor-success-box">
          <strong>
            {fleetResult.action === 'sync_node'
              ? 'Sync complete:'
              : fleetResult.action
                ? `${fleetResult.action.charAt(0).toUpperCase()}${fleetResult.action.slice(1)} complete:`
                : 'Fleet action complete:'}
          </strong>
          {' '}
          {fleetResult.succeeded} succeeded, {fleetResult.failed} failed across {fleetResult.requested_nodes} nodes.
          <button className="monitor-dismiss-btn" onClick={() => setFleetResult(null)}>✕</button>
        </div>
      )}
      {fleetResult?.error && (
        <div className="monitor-error-box">
          <strong>Fleet action failed:</strong>
          {' '}
          {truncate(fleetResult.error, 260)}
          <button className="monitor-dismiss-btn" onClick={() => setFleetResult(null)}>✕</button>
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
              <th>Machine #</th>
              <th>Node Slot</th>
              <th>Operator</th>
              <th>Device</th>
              <th>Role</th>
              <th>RPC</th>
              <th>Agent</th>
              <th>Status</th>
              <th>Block</th>
              <th>Peers</th>
              <th>Syncing</th>
              <th>Latency</th>
              <th className="monitor-col-error">Error</th>
              <th>Controls</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((entry) => (
              <tr key={entry.node.node_slot_id}>
                <td>{entry.node.physical_machine_id || entry.node.node_slot_id}</td>
                <td>{entry.node.node_slot_id}</td>
                <td>{entry.node.operator || 'Unassigned'}</td>
                <td>{entry.node.device || 'Unknown device'}</td>
                <td>{entry.node.role}</td>
                <td>
                  <code>{entry.node.rpc_url}</code>
                </td>
                <td>
                  {(() => {
                    const machineId = entry.node.physical_machine_id;
                    const agent = machineId ? agentByMachine[machineId] : undefined;
                    if (!agent) {
                      return <span className="status-pill" style={{ color: 'var(--snrg-muted, #888)', borderColor: 'transparent' }}>—</span>;
                    }
                    return (
                      <span className={`status-pill status-${agent.reachable ? 'online' : 'offline'}`}>
                        {agent.reachable ? 'online' : 'offline'}
                      </span>
                    );
                  })()}
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
                <td className="monitor-col-error">{truncate(entry.error || '', 88)}</td>
                <td className="monitor-controls-cell">
                  <div className="monitor-row-controls">
                    <button
                      className="monitor-row-btn monitor-row-btn-success"
                      onClick={() => handleNodeAction(entry.node.node_slot_id, 'start')}
                      disabled={fleetBusy || resetBusy || !!nodeActionKey || entry.online}
                    >
                      {nodeActionKey === `${entry.node.node_slot_id}:start` ? 'Starting...' : 'Start'}
                    </button>
                    <button
                      className="monitor-row-btn monitor-row-btn-danger"
                      onClick={() => handleNodeAction(entry.node.node_slot_id, 'stop')}
                      disabled={fleetBusy || resetBusy || !!nodeActionKey || !entry.online}
                    >
                      {nodeActionKey === `${entry.node.node_slot_id}:stop` ? 'Stopping...' : 'Stop'}
                    </button>
                    <Link
                      className="monitor-link-btn monitor-row-link-btn"
                      to={`/node/${encodeURIComponent(entry.node.node_slot_id)}`}
                    >
                      Details
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="monitor-table-footer">
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
    </section>
  );
}

export default NetworkMonitorDashboard;
