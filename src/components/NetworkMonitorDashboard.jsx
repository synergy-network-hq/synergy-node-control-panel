import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke } from '../lib/desktopClient';

const REFRESH_SECONDS_OPTIONS = [3, 5, 10, 15, 30];
const BOOTSTRAP_VALIDATOR_QUORUM = 4;

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function numericOrdinal(value) {
  const match = String(value || '').match(/(\d+)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sortMachineIds(values) {
  return [...values].sort((left, right) => {
    const leftOrdinal = numericOrdinal(left);
    const rightOrdinal = numericOrdinal(right);
    if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
    return String(left).localeCompare(String(right));
  });
}

function sortNodeSlotIds(values) {
  return sortMachineIds(values);
}

function isBootstrapConsensusValidator(node) {
  return normalizeId(node?.role_group) === 'consensus'
    && normalizeId(node?.node_type || node?.role) === 'validator';
}

function buildMachineTopology(entries = []) {
  const grouped = new Map();

  entries.forEach((entry) => {
    const node = entry?.node || entry;
    const machineId = normalizeId(node?.physical_machine_id || node?.node_slot_id);
    const nodeSlotId = normalizeId(node?.node_slot_id);
    if (!machineId || !nodeSlotId) return;

    const existing = grouped.get(machineId) || {
      machineId,
      managementHost: String(node?.management_host || '').trim() || String(node?.host || '').trim(),
      operator: String(node?.operator || '').trim(),
      device: String(node?.device || '').trim(),
      slots: [],
    };

    if (!existing.managementHost) {
      existing.managementHost = String(node?.management_host || '').trim() || String(node?.host || '').trim();
    }
    if (!existing.operator) existing.operator = String(node?.operator || '').trim();
    if (!existing.device) existing.device = String(node?.device || '').trim();

    existing.slots.push({
      nodeSlotId,
      role: String(node?.role || '').trim(),
      role_group: String(node?.role_group || '').trim(),
      node_type: String(node?.node_type || '').trim(),
      operator: String(node?.operator || '').trim(),
      device: String(node?.device || '').trim(),
      rpc_url: String(node?.rpc_url || '').trim(),
      physical_machine_id: machineId,
    });

    grouped.set(machineId, existing);
  });

  return sortMachineIds([...grouped.keys()]).map((machineId) => {
    const entry = grouped.get(machineId);
    entry.slots = sortNodeSlotIds(entry.slots.map((slot) => slot.nodeSlotId))
      .map((nodeSlotId) => entry.slots.find((slot) => slot.nodeSlotId === nodeSlotId))
      .filter(Boolean);
    return entry;
  });
}

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

function formatLatency(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  return `${Math.round(Number(value))} ms`;
}

function NetworkMonitorDashboard() {
  const [snapshot, setSnapshot] = useState(null);
  const [agentSnapshot, setAgentSnapshot] = useState(null);
  const [securityState, setSecurityState] = useState(null);
  const [localIdentity, setLocalIdentity] = useState(null);
  const [refreshSeconds, setRefreshSeconds] = useState(5);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [placeholderSelections, setPlaceholderSelections] = useState({});

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
        await invoke('monitor_apply_topology');
        setWorkspaceReady(true);
      }
      const [data, agentData, securityData, identityData] = await Promise.all([
        invoke('get_monitor_snapshot'),
        invoke('get_monitor_agent_snapshot').catch(() => null),
        invoke('get_monitor_security_state').catch(() => null),
        invoke('monitor_detect_local_machine_identity').catch(() => null),
      ]);
      setSnapshot(data);
      setAgentSnapshot(agentData);
      setSecurityState(securityData);
      setLocalIdentity(identityData);
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

  const nodes = snapshot?.nodes || [];
  const machineTopologyRows = buildMachineTopology(nodes);
  const machineTopologyMap = machineTopologyRows.reduce((acc, entry) => {
    acc[entry.machineId] = entry;
    return acc;
  }, {});
  const nodeStatusById = nodes.reduce((acc, entry) => {
    const nodeSlotId = normalizeId(entry?.node?.node_slot_id);
    if (nodeSlotId) {
      acc[nodeSlotId] = entry;
    }
    return acc;
  }, {});
  const installedByMachine = {};
  for (const agent of (agentSnapshot?.agents || [])) {
    if (!agent?.reachable) continue;
    const machineId = normalizeId(agent.physical_machine_id);
    if (!machineId) continue;
    installedByMachine[machineId] = (Array.isArray(agent.node_slot_ids) ? agent.node_slot_ids : [])
      .map((nodeSlotId) => normalizeId(nodeSlotId))
      .filter(Boolean);
  }
  const installedNodeIds = new Set(
    Object.values(installedByMachine).flatMap((nodeSlotIds) => nodeSlotIds),
  );
  const localMachineId = normalizeId(localIdentity?.physical_machine_id);
  const localManagementHost = String(
    localIdentity?.management_host || machineTopologyMap[localMachineId]?.managementHost || '',
  ).trim();
  const scopedMachineTopologyRows = localMachineId
    ? machineTopologyRows.filter((machine) => machine.machineId === localMachineId)
    : machineTopologyRows;
  const availableNodeOptions = scopedMachineTopologyRows
    .flatMap((entry) => entry.slots)
    .filter((slot) => !installedNodeIds.has(slot.nodeSlotId));
  const bootstrapValidatorNodeIds = machineTopologyRows
    .flatMap((entry) => entry.slots)
    .filter((slot) => isBootstrapConsensusValidator(slot))
    .map((slot) => slot.nodeSlotId);
  const installedBootstrapValidatorIds = bootstrapValidatorNodeIds.filter((nodeSlotId) =>
    installedNodeIds.has(nodeSlotId),
  );
  const validatorQuorumReady = installedBootstrapValidatorIds.length >= BOOTSTRAP_VALIDATOR_QUORUM;

  const dashboardRows = scopedMachineTopologyRows.flatMap((machine) => {
    const installedNodeSlots = installedByMachine[machine.machineId] || [];
    const capacity = Math.max(machine.slots.length, installedNodeSlots.length, 1);

    return Array.from({ length: capacity }, (_, index) => {
      const installedNodeId = installedNodeSlots[index] || '';
      return {
        rowKey: `${machine.machineId}:${index}`,
        rowIndex: index,
        machine,
        installedNodeId,
        entry: installedNodeId ? nodeStatusById[installedNodeId] || null : null,
      };
    });
  });

  useEffect(() => {
    if (!dashboardRows.length) return;

    setPlaceholderSelections((prev) => {
      const next = { ...prev };
      let changed = false;

      dashboardRows.forEach((row) => {
        if (row.installedNodeId || row.machine.machineId !== localMachineId) return;

        const rowKey = row.rowKey;
        const otherSelections = new Set(
          Object.entries(next)
            .filter(([key]) => key !== rowKey)
            .map(([, value]) => normalizeId(value))
            .filter(Boolean),
        );
        const currentValue = normalizeId(next[rowKey]);
        const currentStillAvailable = currentValue
          && availableNodeOptions.some((slot) => slot.nodeSlotId === currentValue)
          && !otherSelections.has(currentValue);

        if (currentStillAvailable) {
          return;
        }

        const fallback = availableNodeOptions
          .map((slot) => slot.nodeSlotId)
          .find((nodeSlotId) => !otherSelections.has(nodeSlotId));

        if (fallback) {
          if (next[rowKey] !== fallback) {
            next[rowKey] = fallback;
            changed = true;
          }
        } else {
          if (rowKey in next) {
            delete next[rowKey];
            changed = true;
          }
        }
      });

      return changed ? next : prev;
    });
  }, [availableNodeOptions, dashboardRows, localMachineId]);

  const resolveSetupProfileId = () => {
    const bindings = Array.isArray(securityState?.ssh_bindings) ? securityState.ssh_bindings : [];
    const matchingBinding = bindings.find(
      (binding) => normalizeId(binding?.host_override) === normalizeId(localManagementHost),
    );
    if (matchingBinding?.profile_id) {
      return matchingBinding.profile_id;
    }

    const profiles = Array.isArray(securityState?.ssh_profiles) ? securityState.ssh_profiles : [];
    return profiles[0]?.profile_id || 'ops';
  };

  const maybeStartBootstrapValidators = async () => {
    if (bootstrapValidatorNodeIds.length < BOOTSTRAP_VALIDATOR_QUORUM) return;

    const [freshSnapshot, freshAgentSnapshot] = await Promise.all([
      invoke('get_monitor_snapshot'),
      invoke('get_monitor_agent_snapshot').catch(() => null),
    ]);
    setSnapshot(freshSnapshot);
    setAgentSnapshot(freshAgentSnapshot);

    const installedNodeSet = new Set(
      (freshAgentSnapshot?.agents || [])
        .filter((agent) => agent?.reachable)
        .flatMap((agent) => (Array.isArray(agent.node_slot_ids) ? agent.node_slot_ids : []))
        .map((nodeSlotId) => normalizeId(nodeSlotId))
        .filter(Boolean),
    );
    const installedValidators = bootstrapValidatorNodeIds.filter((nodeSlotId) =>
      installedNodeSet.has(nodeSlotId),
    );

    if (installedValidators.length < BOOTSTRAP_VALIDATOR_QUORUM) {
      return;
    }

    const onlineNodeSet = new Set(
      (freshSnapshot?.nodes || [])
        .filter((entry) => entry?.online)
        .map((entry) => normalizeId(entry?.node?.node_slot_id))
        .filter(Boolean),
    );
    const nodesToStart = installedValidators.filter((nodeSlotId) => !onlineNodeSet.has(nodeSlotId));
    if (!nodesToStart.length) {
      return;
    }
    await invoke('monitor_bulk_node_control', {
      action: 'start',
      scope: nodesToStart.join(','),
    });
  };

  const handlePlaceholderSelection = (rowKey, nodeSlotId) => {
    setPlaceholderSelections((prev) => ({
      ...prev,
      [rowKey]: normalizeId(nodeSlotId),
    }));
  };

  const handlePlaceholderSetup = async (row) => {
    const targetNodeId = normalizeId(placeholderSelections[row.rowKey]);
    if (!targetNodeId) {
      setError('Select a node slot before running setup.');
      return;
    }
    if (!localMachineId || row.machine.machineId !== localMachineId) {
      setError('Node setup from the dashboard is only allowed on the local machine.');
      return;
    }
    if (!localManagementHost) {
      setError('Local machine address was not detected, so this machine cannot claim a node slot yet.');
      return;
    }

    const actionKey = `${row.rowKey}:setup`;
    setNodeActionKey(actionKey);
    setError('');
    try {
      await invoke('monitor_assign_ssh_binding', {
        input: {
          node_slot_id: targetNodeId,
          profile_id: resolveSetupProfileId(),
          host_override: localManagementHost,
          remote_dir_override: null,
        },
      });
      await invoke('monitor_node_control', {
        nodeSlotId: targetNodeId,
        action: 'setup',
      });
      if (bootstrapValidatorNodeIds.includes(targetNodeId)) {
        await maybeStartBootstrapValidators();
      }
      await fetchSnapshot(true);
    } catch (err) {
      console.error(`Failed to set up ${targetNodeId}:`, err);
      setError(String(err));
    } finally {
      setNodeActionKey('');
    }
  };

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
      const normalizedNodeId = normalizeId(nodeSlotId);
      const isBootstrapTarget = bootstrapValidatorNodeIds.includes(normalizedNodeId);
      if (isBootstrapTarget && (action === 'start' || action === 'restart')) {
        await invoke('monitor_bulk_node_control', {
          action,
          scope: installedBootstrapValidatorIds.join(','),
        });
      } else {
        await invoke('monitor_node_control', {
          nodeSlotId,
          action,
        });
      }
      await fetchSnapshot(true);
      setError('');
    } catch (err) {
      console.error(`Failed to ${action} ${nodeSlotId}:`, err);
      setError(String(err));
    } finally {
      setNodeActionKey('');
    }
  };

  const totalNodes = snapshot?.total_nodes ?? 0;
  const totalMachines = scopedMachineTopologyRows.length || machineTopologyRows.length;
  const reachableAgentCount = (agentSnapshot?.agents || []).filter((agent) => agent?.reachable).length;
  const liveResponseSamples = nodes
    .filter((entry) => entry?.online && Number.isFinite(Number(entry?.response_ms)))
    .map((entry) => Number(entry.response_ms));
  const averageLatencyMs = liveResponseSamples.length
    ? liveResponseSamples.reduce((sum, value) => sum + value, 0) / liveResponseSamples.length
    : null;
  const stagedBootstrapCount = installedBootstrapValidatorIds.filter((nodeSlotId) => {
    const entry = nodeStatusById[nodeSlotId];
    return entry && !entry.online;
  }).length;
  const displayOnlineCount = Number(snapshot?.online_nodes || 0) + stagedBootstrapCount;
  const displayOfflineCount = Math.max(totalNodes - displayOnlineCount, 0);
  const summaryCards = [
    {
      label: 'Online',
      value: formatCountRatio(displayOnlineCount, totalNodes),
      note: 'Nodes responding',
      tone: 'lime',
    },
    {
      label: 'Syncing',
      value: formatCountRatio(snapshot?.syncing_nodes, totalNodes),
      note: 'Catching up',
      tone: 'cyan',
    },
    {
      label: 'Average Block Time',
      value: formatBlockTime(snapshot?.average_block_time_secs),
      note: 'Consensus cadence',
      tone: 'violet',
    },
    {
      label: 'Offline',
      value: formatCountRatio(displayOfflineCount, totalNodes),
      note: 'Need attention',
      tone: 'lime',
    },
    {
      label: 'Highest Block',
      value: formatWholeNumber(snapshot?.highest_block),
      note: 'Network head',
      tone: 'cyan',
    },
    {
      label: 'Throughput',
      value: formatThroughput(snapshot?.throughput_tps),
      note: 'Block emission velocity',
      tone: 'violet',
    },
    {
      label: 'Agent Reachability',
      value: formatCountRatio(reachableAgentCount, totalMachines),
      note: 'Machines with agent',
      tone: 'blue',
    },
    {
      label: 'Average RPC Latency',
      value: formatLatency(averageLatencyMs),
      note: 'Operator responsiveness',
      tone: 'blue',
    },
  ];

  const agentByMachine = {};
  for (const a of (agentSnapshot?.agents || [])) {
    agentByMachine[normalizeId(a?.physical_machine_id)] = a;
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
              <h2>Testnet-Beta Control Panel</h2>
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
            <button
              className="monitor-btn monitor-action-start"
              onClick={() => handleFleetConfirm('start')}
              disabled={fleetBusy || resetBusy}
              title="Start all nodes across all machines"
            >
              {fleetBusy && fleetAction === 'start' ? 'Starting...' : 'Start All'}
            </button>
            <button
              className="monitor-btn monitor-action-stop"
              onClick={() => handleFleetConfirm('stop')}
              disabled={fleetBusy || resetBusy}
              title="Stop all nodes across all machines"
            >
              {fleetBusy && fleetAction === 'stop' ? 'Stopping...' : 'Stop All'}
            </button>
            <button className="monitor-btn monitor-btn-primary" onClick={() => fetchSnapshot()}>
              Refresh Now
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
              title="Catch up every installed non-validator node and auto-start it after sync completes."
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
              Nodes will <strong>not</strong> auto-restart. Re-stage validator quorum with <em>Start All</em>,
              and use <em>Sync All</em> for late-joining non-validator nodes.
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
                <strong>every installed non-validator node</strong> in parallel. Each node will
                catch up from peers and <em>auto-start after sync completes</em>. Bootstrap validators
                are excluded because they must enter service through validator quorum start.
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
            {dashboardRows.map((row) => {
              const entry = row.entry;
              const machineId = row.machine.machineId;
              const agent = agentByMachine[machineId];
              const isInstalled = Boolean(row.installedNodeId && entry);
              const selectedPlaceholderNodeId = normalizeId(placeholderSelections[row.rowKey]);
              const selectedPlaceholderNode = availableNodeOptions.find(
                (slot) => slot.nodeSlotId === selectedPlaceholderNodeId,
              );
              const rowOptions = availableNodeOptions.filter((slot) => {
                const duplicateSelection = Object.entries(placeholderSelections).some(
                  ([key, value]) => key !== row.rowKey && normalizeId(value) === slot.nodeSlotId,
                );
                return !duplicateSelection || slot.nodeSlotId === selectedPlaceholderNodeId;
              });
              const isBootstrapRow = isInstalled && isBootstrapConsensusValidator(entry.node);
              const isStagedBootstrap = isBootstrapRow
                && installedBootstrapValidatorIds.includes(normalizeId(entry.node.node_slot_id))
                && !validatorQuorumReady
                && !entry.online;
              const displayStatus = isInstalled
                ? (isStagedBootstrap ? 'online' : entry.status)
                : 'empty';
              const statusTone = displayStatus === 'empty' ? '' : `status-${displayStatus}`;

              return (
                <tr key={row.rowKey}>
                  <td>{machineId}</td>
                  <td>
                    {isInstalled ? (
                      entry.node.node_slot_id
                    ) : machineId === localMachineId ? (
                      <select
                        value={selectedPlaceholderNodeId}
                        onChange={(event) => handlePlaceholderSelection(row.rowKey, event.target.value)}
                      >
                        <option value="" disabled>Pick node slot</option>
                        {rowOptions.map((slot) => (
                          <option key={slot.nodeSlotId} value={slot.nodeSlotId}>
                            {slot.nodeSlotId}
                            {' '}
                            (
                            {slot.role}
                            )
                          </option>
                        ))}
                      </select>
                    ) : '—'}
                  </td>
                  <td>{isInstalled ? (entry.node.operator || 'Unassigned') : (row.machine.operator || 'Unassigned')}</td>
                  <td>{isInstalled ? (entry.node.device || 'Unknown device') : (row.machine.device || 'Unknown device')}</td>
                  <td>{isInstalled ? entry.node.role : (selectedPlaceholderNode?.role || 'Empty slot')}</td>
                  <td>
                    {isInstalled ? <code>{entry.node.rpc_url}</code> : '—'}
                  </td>
                  <td>
                    {!agent ? (
                      <span className="status-pill" style={{ color: 'var(--snrg-muted, #888)', borderColor: 'transparent' }}>—</span>
                    ) : (
                      <span className={`status-pill status-${agent.reachable ? 'online' : 'offline'}`}>
                        {agent.reachable ? 'online' : 'offline'}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${statusTone}`.trim()}>
                      {displayStatus === 'empty' ? 'awaiting install' : displayStatus}
                    </span>
                  </td>
                  <td>{isInstalled ? (entry.block_height ?? 'N/A') : '—'}</td>
                  <td>{isInstalled ? (entry.peer_count ?? 'N/A') : '—'}</td>
                  <td>{isInstalled ? (entry.syncing === null ? 'N/A' : String(entry.syncing)) : '—'}</td>
                  <td>
                    {isInstalled ? `${entry.response_ms} ms` : '—'}
                  </td>
                  <td className="monitor-col-error">
                    {isInstalled
                      ? truncate(entry.error || (isStagedBootstrap ? `Waiting for ${BOOTSTRAP_VALIDATOR_QUORUM}-validator quorum before block production starts.` : ''), 88)
                      : '—'}
                  </td>
                  <td className="monitor-controls-cell">
                    {isInstalled ? (
                      <div className="monitor-row-controls">
                        <button
                          className="monitor-row-btn monitor-action-start"
                          onClick={() => handleNodeAction(entry.node.node_slot_id, 'start')}
                          disabled={fleetBusy || resetBusy || !!nodeActionKey || entry.online || (isBootstrapRow && !validatorQuorumReady)}
                        >
                          {nodeActionKey === `${entry.node.node_slot_id}:start` ? 'Starting...' : 'Start'}
                        </button>
                        <button
                          className="monitor-row-btn monitor-action-stop"
                          onClick={() => handleNodeAction(entry.node.node_slot_id, 'stop')}
                          disabled={fleetBusy || resetBusy || !!nodeActionKey || !entry.online}
                        >
                          {nodeActionKey === `${entry.node.node_slot_id}:stop` ? 'Stopping...' : 'Stop'}
                        </button>
                        <button
                          className="monitor-row-btn"
                          onClick={() => handleNodeAction(entry.node.node_slot_id, 'sync_node')}
                          disabled={fleetBusy || resetBusy || !!nodeActionKey || isBootstrapRow}
                        >
                          {nodeActionKey === `${entry.node.node_slot_id}:sync_node` ? 'Syncing...' : 'Sync'}
                        </button>
                        <Link
                          className="monitor-link-btn monitor-row-link-btn"
                          to={`/node/${encodeURIComponent(entry.node.node_slot_id)}`}
                        >
                          Details
                        </Link>
                      </div>
                    ) : machineId === localMachineId ? (
                      <div className="monitor-row-controls">
                        <button
                          className="monitor-row-btn monitor-action-start"
                          onClick={() => handlePlaceholderSetup(row)}
                          disabled={!selectedPlaceholderNodeId || fleetBusy || resetBusy || !!nodeActionKey}
                        >
                          {nodeActionKey === `${row.rowKey}:setup` ? 'Installing...' : 'Install'}
                        </button>
                      </div>
                    ) : (
                      <span className="status-pill">awaiting operator</span>
                    )}
                  </td>
                </tr>
              );
            })}
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
