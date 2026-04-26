import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getVersion,
  invoke,
  openPath,
  showSaveDialog,
  writeTextFile,
} from '../../lib/desktopClient';
import { checkForUpdate } from '../../lib/appUpdater';
import { SNRGButton } from '../../styles/SNRGButton';
import { useControlPanel } from './ControlPanelProvider';
import {
  formatNumber,
  formatRuntimeDuration,
  formatTimestamp,
  localRpcEndpointForNode,
  nodeRuntimeLabel,
  nodeRuntimeTone,
  statusTone,
} from './controlPanelModel';
import {
  boostSyncAction,
  rejoinNetworkAction,
  restartNodeAction,
} from './controlPanelActions';
import {
  EmptyPanel,
  JarvisCard,
  MetricCard,
  PanelCard,
  SectionHeader,
} from './ControlPanelShared';
import ActionAuditStream from './ActionAuditStream';
import JsonInspectorPanel from './JsonInspectorPanel';

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 'Unavailable';
  }
  if (numeric === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(numeric) / Math.log(1024)), units.length - 1);
  const scaled = numeric / (1024 ** power);
  return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[power]}`;
}

function detectPlatformTarget() {
  if (typeof navigator === 'undefined') {
    return 'unknown';
  }
  const haystack = `${navigator.userAgent || ''} ${navigator.platform || ''}`.toLowerCase();
  if (haystack.includes('win')) {
    return 'windows';
  }
  if (haystack.includes('mac') || haystack.includes('darwin')) {
    return 'macos';
  }
  if (haystack.includes('linux')) {
    return 'linux';
  }
  return 'unknown';
}

async function readStorageEstimate() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return null;
  }
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

function buildSupportBundle({
  appVersion,
  updateStatus,
  selectedNode,
  selectedNodeLive,
  snapshot,
  security,
  agent,
  workspacePath,
  storageEstimate,
  actionAudit,
  lastCommandResult,
}) {
  return {
    exportedAt: new Date().toISOString(),
    appVersion,
    updateStatus,
    selectedNode,
    selectedNodeLive,
    workspacePath,
    storageEstimate,
    monitorSnapshot: snapshot,
    securityState: security,
    agentSnapshot: agent,
    actionAudit,
    lastCommandResult,
  };
}

function buildIssueList({ opsError, snapshot, agent, updateStatus, selectedNodeLive }) {
  const issues = [];
  if (opsError) {
    issues.push(opsError);
  }
  if (snapshot && Number(snapshot.offline_nodes || 0) > 0) {
    issues.push(`${snapshot.offline_nodes} node slot(s) are offline in the local monitor snapshot.`);
  }
  if (agent && Number(agent.unreachable_agents || 0) > 0) {
    issues.push(`${agent.unreachable_agents} machine agent(s) are unreachable on the management plane.`);
  }
  if (selectedNodeLive?.is_running && (Number(selectedNodeLive?.local_peer_count) || 0) <= 0) {
    issues.push('The selected runtime is online but has no visible peers.');
  }
  if (updateStatus?.error) {
    issues.push(updateStatus.error);
  }
  return issues;
}

export default function ControlPanelOperationsPage() {
  const {
    actionAudit,
    error,
    network,
    recordAction,
    refresh,
    selectedNode,
    selectedNodeLive,
    viewMode,
  } = useControlPanel();

  const [opsLoading, setOpsLoading] = useState(true);
  const [opsError, setOpsError] = useState('');
  const [appVersion, setAppVersion] = useState('unknown');
  const [updateStatus, setUpdateStatus] = useState({
    checking: false,
    available: false,
    version: '',
    currentVersion: '',
    error: '',
  });
  const [snapshot, setSnapshot] = useState(null);
  const [securityState, setSecurityState] = useState(null);
  const [agentSnapshot, setAgentSnapshot] = useState(null);
  const [workspacePath, setWorkspacePath] = useState('');
  const [storageEstimate, setStorageEstimate] = useState(null);
  const [actionBusy, setActionBusy] = useState('');
  const [supportBusy, setSupportBusy] = useState(false);
  const [eraseBusy, setEraseBusy] = useState(false);
  const [lastCommandResult, setLastCommandResult] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const loadContext = async ({ silent = false } = {}) => {
      if (!silent) {
        setOpsLoading(true);
      }

      try {
        await invoke('monitor_initialize_workspace').catch(() => null);
        const [version, storage, snapshotResult, securityResult, agentResult, workspaceResult] = await Promise.all([
          getVersion().catch(() => 'unknown'),
          readStorageEstimate(),
          invoke('get_monitor_snapshot').catch((error) => ({ __error: String(error) })),
          invoke('get_monitor_security_state').catch((error) => ({ __error: String(error) })),
          invoke('get_monitor_agent_snapshot').catch((error) => ({ __error: String(error) })),
          invoke('get_monitor_workspace_path').catch(() => ''),
        ]);

        if (cancelled) {
          return;
        }

        setAppVersion(version || 'unknown');
        setStorageEstimate(storage);
        setWorkspacePath(typeof workspaceResult === 'string' ? workspaceResult : '');
        setSnapshot(snapshotResult?.__error ? null : snapshotResult);
        setSecurityState(securityResult?.__error ? null : securityResult);
        setAgentSnapshot(agentResult?.__error ? null : agentResult);
        setOpsError([
          snapshotResult?.__error,
          securityResult?.__error,
          agentResult?.__error,
        ].filter(Boolean).join(' '));
      } catch (loadError) {
        if (!cancelled) {
          setOpsError(String(loadError));
        }
      } finally {
        if (!cancelled) {
          setOpsLoading(false);
        }
      }
    };

    void loadContext();
    const intervalId = window.setInterval(() => {
      void loadContext({ silent: true });
    }, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const activeOperator = useMemo(
    () => (securityState?.operators || []).find((entry) => entry.operator_id === securityState?.active_operator_id) || null,
    [securityState?.active_operator_id, securityState?.operators],
  );

  const issues = useMemo(
    () => buildIssueList({ opsError, snapshot, agent: agentSnapshot, updateStatus, selectedNodeLive }),
    [agentSnapshot, opsError, selectedNodeLive, snapshot, updateStatus],
  );

  const configPath = selectedNode?.workspace_directory ? `${selectedNode.workspace_directory}/config/node.toml` : '';
  const logsPath = selectedNode?.workspace_directory ? `${selectedNode.workspace_directory}/logs` : '';
  const localRpcEndpoint = selectedNode ? localRpcEndpointForNode(selectedNode, selectedNodeLive) : '';
  const storageUsed = storageEstimate?.usage != null ? formatBytes(storageEstimate.usage) : 'Unavailable';
  const storageQuota = storageEstimate?.quota != null ? formatBytes(storageEstimate.quota) : 'Unavailable';
  const platformTarget = detectPlatformTarget();

  const runCommand = async ({ title, command, cwd = undefined, followupRefresh = false }) => {
    if (actionBusy) {
      return;
    }
    setActionBusy(title);
    try {
      const result = await invoke('monitor_run_terminal_command', { command, cwd });
      setLastCommandResult(result);
      recordAction({
        title,
        detail: result?.success
          ? (result.stdout?.split('\n').find(Boolean) || 'Command completed successfully.')
          : (result?.stderr || 'Command failed.'),
        status: result?.success ? 'good' : 'bad',
        source: 'operations-page',
        command,
        payload: result,
      });
      if (followupRefresh) {
        await refresh();
      }
    } catch (commandError) {
      const text = String(commandError);
      setLastCommandResult({
        success: false,
        command,
        stderr: text,
        stdout: '',
        executed_at_utc: new Date().toISOString(),
      });
      recordAction({
        title,
        detail: text,
        status: 'bad',
        source: 'operations-page',
        command,
      });
    } finally {
      setActionBusy('');
    }
  };

  const handleCheckUpdates = async () => {
    setUpdateStatus((current) => ({
      ...current,
      checking: true,
      error: '',
    }));
    const result = await checkForUpdate();
    setUpdateStatus({
      checking: false,
      available: result.available === true,
      version: result.version || '',
      currentVersion: result.currentVersion || appVersion,
      error: result.error || '',
    });
    recordAction({
      title: 'Checked for updates',
      detail: result.error
        ? result.error
        : (result.available
          ? `Version ${result.version} is available.`
          : 'The control panel is already current.'),
      status: result.error ? 'bad' : 'good',
      source: 'operations-page',
    });
  };

  const handleRestartNode = async () => {
    if (!selectedNode || actionBusy) {
      return;
    }
    setActionBusy('restart-node');
    try {
      const message = await restartNodeAction({ node: selectedNode, network });
      await refresh();
      recordAction({
        title: 'Restarted node',
        detail: message,
        status: 'good',
        source: 'operations-page',
      });
    } catch (restartError) {
      recordAction({
        title: 'Restart node failed',
        detail: String(restartError),
        status: 'bad',
        source: 'operations-page',
      });
    } finally {
      setActionBusy('');
    }
  };

  const handleRejoinNetwork = async () => {
    if (!selectedNode || actionBusy) {
      return;
    }
    setActionBusy('rejoin-network');
    try {
      const message = await rejoinNetworkAction({ node: selectedNode, network });
      await refresh();
      recordAction({
        title: 'Rejoined network',
        detail: message,
        status: 'good',
        source: 'operations-page',
      });
    } catch (rejoinError) {
      recordAction({
        title: 'Rejoin network failed',
        detail: String(rejoinError),
        status: 'bad',
        source: 'operations-page',
      });
    } finally {
      setActionBusy('');
    }
  };

  const handleBoostSync = async () => {
    if (!selectedNode || actionBusy) {
      return;
    }
    setActionBusy('boost-sync');
    try {
      const message = await boostSyncAction(selectedNode.id);
      await refresh();
      recordAction({
        title: 'Boost sync',
        detail: message,
        status: 'good',
        source: 'operations-page',
      });
    } catch (syncError) {
      recordAction({
        title: 'Boost sync failed',
        detail: String(syncError),
        status: 'bad',
        source: 'operations-page',
      });
    } finally {
      setActionBusy('');
    }
  };

  const handleExportSupportBundle = async () => {
    if (!selectedNode || supportBusy) {
      return;
    }
    setSupportBusy(true);
    try {
      const defaultPath = await showSaveDialog({
        defaultPath: `${selectedNode.id || 'control-panel'}-support-bundle.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!defaultPath) {
        return;
      }
      const payload = buildSupportBundle({
        appVersion,
        updateStatus,
        selectedNode,
        selectedNodeLive,
        snapshot,
        security: securityState,
        agent: agentSnapshot,
        workspacePath,
        storageEstimate,
        actionAudit,
        lastCommandResult,
      });
      await writeTextFile(defaultPath, JSON.stringify(payload, null, 2));
      recordAction({
        title: 'Exported support bundle',
        detail: defaultPath,
        status: 'good',
        source: 'operations-page',
      });
    } catch (exportError) {
      recordAction({
        title: 'Support bundle export failed',
        detail: String(exportError),
        status: 'bad',
        source: 'operations-page',
      });
    } finally {
      setSupportBusy(false);
    }
  };

  const handleEraseLocalData = async () => {
    if (platformTarget === 'unknown' || eraseBusy) {
      return;
    }
    const confirmed = window.confirm(
      'Erase local machine data for this Control Panel workspace?\n\nThis deletes the local Testnet-Beta workspace and should only be used as a deliberate recovery step.',
    );
    if (!confirmed) {
      return;
    }

    setEraseBusy(true);
    try {
      const result = await invoke('testbeta_erase_local_machine_data', { targetPlatform: platformTarget });
      recordAction({
        title: 'Erased local machine data',
        detail: result?.message || 'Local Testnet-Beta data was erased.',
        status: 'warn',
        source: 'operations-page',
        payload: result,
      });
      await refresh();
    } catch (eraseError) {
      recordAction({
        title: 'Erase local data failed',
        detail: String(eraseError),
        status: 'bad',
        source: 'operations-page',
      });
    } finally {
      setEraseBusy(false);
    }
  };

  if (!selectedNode) {
    return (
      <EmptyPanel
        title="No node selected for local operations"
        copy="Select or provision a node before using machine-level tools, maintenance actions, and support exports."
        actionLabel="Refresh"
        onAction={() => void refresh()}
      />
    );
  }

  return (
    <div className="cp-page-stack">
      <SectionHeader
        eyebrow={viewMode === 'basic' ? 'Safe Maintenance' : viewMode === 'advanced' ? 'Machine Operations' : 'Control Room'}
        title={viewMode === 'basic' ? 'Tools' : viewMode === 'advanced' ? 'Operations' : 'Local Ops'}
        copy={viewMode === 'basic'
          ? 'Basic users should only see safe maintenance tools and guided recovery steps.'
          : viewMode === 'advanced'
            ? 'Inspect local workspace state, machine diagnostics, controlled maintenance actions, and recent operator activity.'
            : 'Expose environment state, grouped operator actions, raw local inspectors, action output, and a gated danger zone.'}
        actions={(
          <>
            <SNRGButton variant="blue" size="sm" onClick={() => void refresh()}>
              Refresh State
            </SNRGButton>
            <SNRGButton variant="purple" size="sm" onClick={() => void handleCheckUpdates()} disabled={updateStatus.checking}>
              {updateStatus.checking ? 'Checking…' : 'Check Updates'}
            </SNRGButton>
            <SNRGButton variant="blue" size="sm" onClick={() => void handleExportSupportBundle()} disabled={supportBusy}>
              {supportBusy ? 'Exporting…' : 'Export Support Bundle'}
            </SNRGButton>
          </>
        )}
      />

      {(opsError || error) ? (
        <div className={`cp-inline-notice tone-${statusTone(opsError || error)}`}>
          {opsError || error}
        </div>
      ) : null}

      {viewMode === 'basic' ? (
        <div className="cp-dashboard-grid">
          <div className="cp-dashboard-main">
            <PanelCard title="App and node summary" detail={opsLoading ? 'Loading local machine context…' : 'Version, update state, selected node, and current runtime health.'}>
              <div className="cp-metric-grid cp-metric-grid-dashboard">
                <MetricCard label="App version" value={appVersion} detail={updateStatus.available ? `Update ${updateStatus.version} available` : 'No pending update detected'} tone={updateStatus.available ? 'warn' : 'good'} icon="system_update" />
                <MetricCard label="Current node" value={selectedNode.display_label || selectedNode.id} detail={selectedNode.role_display_name || 'Node'} tone="cyan" icon="dns" />
                <MetricCard label="Connected" value={nodeRuntimeLabel(selectedNodeLive)} detail={`${formatNumber(selectedNodeLive?.local_peer_count || 0)} visible peers`} tone={nodeRuntimeTone(selectedNodeLive)} icon="hub" />
                <MetricCard label="Workspace" value={storageUsed} detail={storageQuota !== 'Unavailable' ? `${storageQuota} available to the app` : 'Storage quota unavailable'} tone="blue" icon="hard_drive_2" />
              </div>
            </PanelCard>

            <PanelCard title="Safe maintenance actions" detail="Basic mode keeps only the most reliable recovery actions above the fold.">
              <div className="cp-button-grid">
                <SNRGButton variant="blue" size="sm" onClick={() => void handleCheckUpdates()} disabled={updateStatus.checking}>
                  {updateStatus.checking ? 'Checking…' : 'Check For Updates'}
                </SNRGButton>
                <SNRGButton variant="blue" size="sm" onClick={() => void refresh()}>
                  Refresh Connection
                </SNRGButton>
                <SNRGButton variant="purple" size="sm" onClick={() => void handleRestartNode()} disabled={actionBusy === 'restart-node'}>
                  {actionBusy === 'restart-node' ? 'Restarting…' : 'Restart Node'}
                </SNRGButton>
                <SNRGButton variant="blue" size="sm" onClick={() => void handleExportSupportBundle()} disabled={supportBusy}>
                  {supportBusy ? 'Exporting…' : 'Export Help Bundle'}
                </SNRGButton>
              </div>
            </PanelCard>

            <PanelCard title="Storage and health summary" detail="A quick picture of local state before you attempt deeper repairs.">
              <div className="cp-definition-list">
                <div className="cp-definition-item">
                  <span>Disk use</span>
                  <strong>{selectedNodeLive?.disk_percent != null ? `${formatNumber(selectedNodeLive.disk_percent)}%` : storageUsed}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Last restart</span>
                  <strong>{formatRuntimeDuration(selectedNodeLive?.process_uptime_secs)}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Last good state</span>
                  <strong>{selectedNodeLive?.local_rpc_ready === false ? 'Runtime starting' : 'Healthy runtime reported'}</strong>
                </div>
              </div>
            </PanelCard>

            <PanelCard title="Help and recovery" detail="Stay inside guided flows before you move into operator tooling.">
              <div className="cp-checklist">
                <div className="cp-checklist-item">
                  <strong>Use My Node first.</strong>
                  <small>That page is still the safest place to confirm whether the node is online, connected, and catching up.</small>
                </div>
                <div className="cp-checklist-item">
                  <strong>Use Activity if something looks wrong.</strong>
                  <small>The Activity page explains warnings in plain language without dumping raw machine output on you.</small>
                </div>
                <div className="cp-checklist-item">
                  <strong>Export a help bundle before escalations.</strong>
                  <small>The support bundle preserves the current runtime, monitor, and action context in one file.</small>
                </div>
              </div>
            </PanelCard>
          </div>

          <div className="cp-dashboard-side">
            <JarvisCard
              mode="basic"
              title="Assistant help"
              message="Basic mode keeps maintenance safe: confirm the node is online, refresh state, restart only when necessary, and export a help bundle before you escalate."
              chips={[
                activeOperator?.display_name || 'No active operator',
                snapshot?.captured_at_utc ? formatTimestamp(snapshot.captured_at_utc) : 'Monitor pending',
                platformTarget,
              ]}
            />

            <PanelCard title="Simple maintenance checklist" detail="Three quick checks before you call this machine healthy.">
              <div className="cp-checklist">
                <div className="cp-checklist-item">
                  <strong>App current</strong>
                  <small>{updateStatus.available ? `Update ${updateStatus.version} is waiting.` : 'No newer published update is currently reported.'}</small>
                </div>
                <div className="cp-checklist-item">
                  <strong>Node connected</strong>
                  <small>{formatNumber(selectedNodeLive?.local_peer_count || 0)} visible peers right now.</small>
                </div>
                <div className="cp-checklist-item">
                  <strong>Support bundle ready</strong>
                  <small>Export the bundle before attempting manual repair steps.</small>
                </div>
              </div>
            </PanelCard>

            <PanelCard title="Recent maintenance activity" detail="This rail stays fixed-height so new activity does not push the rest of the layout down.">
              <div className="cp-panel-scroll cp-panel-scroll-tight">
                <ActionAuditStream entries={actionAudit.slice(0, 12)} emptyMessage="Recent maintenance actions will appear here." />
              </div>
            </PanelCard>
          </div>
        </div>
      ) : null}

      {viewMode === 'advanced' ? (
        <div className="cp-dashboard-grid">
          <div className="cp-dashboard-main">
            <div className="cp-metric-grid cp-metric-grid-dashboard">
              <MetricCard label="App version" value={appVersion} detail={updateStatus.available ? `Update ${updateStatus.version} available` : 'Current release'} tone={updateStatus.available ? 'warn' : 'good'} icon="system_update" />
              <MetricCard label="Runtime version" value={selectedNodeLive?.binary_version || 'Unknown'} detail="Selected runtime binary version" tone="cyan" icon="memory" />
              <MetricCard label="Node slots on machine" value={formatNumber(snapshot?.total_nodes || 0)} detail={`${formatNumber(snapshot?.online_nodes || 0)} online right now`} tone="blue" icon="dns" />
              <MetricCard label="Peer visibility" value={formatNumber(selectedNodeLive?.local_peer_count || 0)} detail="Visible sessions from the selected runtime" tone="purple" icon="hub" />
            </div>

            <PanelCard title="Workspace operations panel" detail="Operator-grade local actions without the full developer dock.">
              <div className="cp-button-grid">
                <SNRGButton variant="blue" size="sm" onClick={() => openPath(configPath)} disabled={!configPath}>
                  Open Config
                </SNRGButton>
                <SNRGButton variant="blue" size="sm" onClick={() => openPath(logsPath)} disabled={!logsPath}>
                  Open Logs
                </SNRGButton>
                <SNRGButton variant="purple" size="sm" onClick={() => void handleRestartNode()} disabled={actionBusy === 'restart-node'}>
                  {actionBusy === 'restart-node' ? 'Restarting…' : 'Restart Services'}
                </SNRGButton>
                <SNRGButton variant="blue" size="sm" onClick={() => void handleExportSupportBundle()} disabled={supportBusy}>
                  {supportBusy ? 'Exporting…' : 'Export Support Bundle'}
                </SNRGButton>
              </div>
            </PanelCard>

            <PanelCard title="Machine diagnostics panel" detail="Disk, CPU, memory, network, and local monitor status.">
              <div className="cp-definition-list">
                <div className="cp-definition-item">
                  <span>CPU</span>
                  <strong>{selectedNodeLive?.cpu_percent != null ? `${formatNumber(selectedNodeLive.cpu_percent)}%` : 'Unavailable'}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Memory</span>
                  <strong>{selectedNodeLive?.memory_mb != null ? `${formatNumber(selectedNodeLive.memory_mb)} MB` : 'Unavailable'}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Disk</span>
                  <strong>{selectedNodeLive?.disk_percent != null ? `${formatNumber(selectedNodeLive.disk_percent)}%` : storageUsed}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Monitor captured</span>
                  <strong>{snapshot?.captured_at_utc ? formatTimestamp(snapshot.captured_at_utc) : 'Pending'}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Agent reachability</span>
                  <strong>{formatNumber(agentSnapshot?.reachable_agents || 0)} / {formatNumber(agentSnapshot?.total_agents || 0)}</strong>
                </div>
              </div>
            </PanelCard>

            <PanelCard title="Controlled maintenance panel" detail="Run guided repair actions and bounded local diagnostics.">
              <div className="cp-button-grid">
                <SNRGButton variant="blue" size="sm" onClick={() => void runCommand({ title: 'Environment check', command: 'pwd && uname -a && whoami', cwd: selectedNode.workspace_directory })} disabled={actionBusy === 'Environment check'}>
                  Environment Check
                </SNRGButton>
                <SNRGButton variant="blue" size="sm" onClick={() => void runCommand({ title: 'Listener check', command: 'lsof -nP -iTCP:5620-5699 -sTCP:LISTEN 2>/dev/null || true', cwd: selectedNode.workspace_directory })} disabled={actionBusy === 'Listener check'}>
                  Listener Check
                </SNRGButton>
                <SNRGButton variant="purple" size="sm" onClick={() => void handleRejoinNetwork()} disabled={actionBusy === 'rejoin-network'}>
                  {actionBusy === 'rejoin-network' ? 'Rejoining…' : 'Guided Rejoin'}
                </SNRGButton>
                <SNRGButton variant="purple" size="sm" onClick={() => void handleBoostSync()} disabled={actionBusy === 'boost-sync'}>
                  {actionBusy === 'boost-sync' ? 'Boosting…' : 'Boost Sync'}
                </SNRGButton>
              </div>
            </PanelCard>

            <PanelCard title="Action history" detail="Operator actions performed in this session on this machine.">
              <div className="cp-panel-scroll cp-panel-scroll-medium">
                <ActionAuditStream entries={actionAudit} emptyMessage="Actions will appear here after you use the operations controls." />
              </div>
            </PanelCard>

            <PanelCard title="Small output drawer" detail="Advanced mode keeps command output available without mounting the full developer dock.">
              {lastCommandResult ? (
                <div className="cp-command-output">
                  <div className="cp-command-output-head">
                    <strong>{lastCommandResult.command}</strong>
                    <span>{lastCommandResult.executed_at_utc ? formatTimestamp(lastCommandResult.executed_at_utc) : 'Just now'}</span>
                  </div>
                  <pre>{lastCommandResult.stdout || lastCommandResult.stderr || 'No output returned.'}</pre>
                </div>
              ) : (
                <div className="cp-empty-inline">Run a bounded diagnostic from the panel above to capture output here.</div>
              )}
            </PanelCard>
          </div>

          <div className="cp-dashboard-side">
            <JarvisCard
              mode="advanced"
              title="Machine visibility"
              message={`This machine currently reports ${formatNumber(snapshot?.online_nodes || 0)} online node slot(s) out of ${formatNumber(snapshot?.total_nodes || 0)} in the local monitor workspace.`}
              chips={[
                activeOperator?.display_name || 'No active operator',
                workspacePath || 'No workspace path',
                localRpcEndpoint || 'No local RPC',
              ]}
            />

            <PanelCard title="Local discovery card" detail="Inventory, operator, and agent reachability for this machine.">
              <div className="cp-definition-list">
                <div className="cp-definition-item">
                  <span>Workspace path</span>
                  <strong>{workspacePath || 'Unavailable'}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Active operator</span>
                  <strong>{activeOperator?.display_name || securityState?.active_operator_id || 'None'}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Agent coverage</span>
                  <strong>{formatNumber(agentSnapshot?.reachable_agents || 0)} / {formatNumber(agentSnapshot?.total_agents || 0)}</strong>
                </div>
              </div>
            </PanelCard>

            <PanelCard title="Recent maintenance issues" detail="These are the current blockers worth resolving before deeper repair work.">
              <div className="cp-checklist">
                {(issues.length ? issues : ['No current maintenance issues were detected in the local monitor snapshot.']).map((issue) => (
                  <div key={issue} className="cp-checklist-item">
                    <strong>{issue}</strong>
                    <small>Move into Local Ops if you need raw inspectors or the developer dock.</small>
                  </div>
                ))}
              </div>
            </PanelCard>
          </div>
        </div>
      ) : null}

      {viewMode === 'developer' ? (
        <div className="cp-dashboard-grid">
          <div className="cp-dashboard-main">
            <div className="cp-metric-grid cp-metric-grid-dashboard">
              <MetricCard label="App version" value={appVersion} detail={updateStatus.available ? `Update ${updateStatus.version} available` : 'Current release'} tone={updateStatus.available ? 'warn' : 'good'} icon="system_update" />
              <MetricCard label="Runtime binary" value={selectedNodeLive?.binary_version || 'Unknown'} detail="Selected node runtime" tone="cyan" icon="memory" />
              <MetricCard label="Workspace root" value={selectedNode.workspace_directory || workspacePath || 'Unavailable'} detail="Active runtime workspace path" tone="blue" icon="folder_open" />
              <MetricCard
                label="Control plane"
                value={`${formatNumber(agentSnapshot?.reachable_agents || 0)} / ${formatNumber(agentSnapshot?.total_agents || 0)}`}
                detail="Reachable machine agents"
                tone="purple"
                icon="devices"
              />
              <MetricCard label="Active services" value={nodeRuntimeLabel(selectedNodeLive)} detail={`Uptime ${formatRuntimeDuration(selectedNodeLive?.process_uptime_secs)}`} tone={nodeRuntimeTone(selectedNodeLive)} icon="monitor_heart" />
              <MetricCard label="Local RPC" value={localRpcEndpoint || 'Unavailable'} detail="Developer dock RPC console targets this endpoint" tone="good" icon="lan" />
            </div>

            <PanelCard title="Operator actions matrix" detail="Grouped by domain so the control room stays structured instead of becoming another tool dump.">
              <div className="cp-ops-matrix">
                <div className="cp-ops-group">
                  <span className="cp-eyebrow">Runtime</span>
                  <div className="cp-button-grid">
                    <SNRGButton variant="blue" size="sm" onClick={() => void refresh()}>Refresh Runtime</SNRGButton>
                    <SNRGButton variant="purple" size="sm" onClick={() => void handleRestartNode()} disabled={actionBusy === 'restart-node'}>
                      {actionBusy === 'restart-node' ? 'Restarting…' : 'Restart Node'}
                    </SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => void runCommand({ title: 'Runtime status', command: 'ps aux | grep synergy-testbeta | grep -v grep || true', cwd: selectedNode.workspace_directory })} disabled={actionBusy === 'Runtime status'}>
                      Runtime Status
                    </SNRGButton>
                  </div>
                </div>

                <div className="cp-ops-group">
                  <span className="cp-eyebrow">Config</span>
                  <div className="cp-button-grid">
                    <SNRGButton variant="blue" size="sm" onClick={() => openPath(configPath)} disabled={!configPath}>Open Config</SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => openPath(selectedNode.workspace_directory)} disabled={!selectedNode.workspace_directory}>Reopen Workspace</SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => void runCommand({ title: 'Read config', command: `sed -n '1,220p' "${configPath}"`, cwd: selectedNode.workspace_directory })} disabled={!configPath || actionBusy === 'Read config'}>
                      Read Config
                    </SNRGButton>
                  </div>
                </div>

                <div className="cp-ops-group">
                  <span className="cp-eyebrow">Network</span>
                  <div className="cp-button-grid">
                    <SNRGButton variant="purple" size="sm" onClick={() => void handleRejoinNetwork()} disabled={actionBusy === 'rejoin-network'}>
                      {actionBusy === 'rejoin-network' ? 'Rejoining…' : 'Rejoin Network'}
                    </SNRGButton>
                    <SNRGButton variant="purple" size="sm" onClick={() => void handleBoostSync()} disabled={actionBusy === 'boost-sync'}>
                      {actionBusy === 'boost-sync' ? 'Boosting…' : 'Boost Sync'}
                    </SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => void runCommand({ title: 'Environment checks', command: 'pwd && uname -a && whoami && date', cwd: selectedNode.workspace_directory })} disabled={actionBusy === 'Environment checks'}>
                      Environment Checks
                    </SNRGButton>
                  </div>
                </div>

                <div className="cp-ops-group">
                  <span className="cp-eyebrow">Logs</span>
                  <div className="cp-button-grid">
                    <SNRGButton variant="blue" size="sm" onClick={() => openPath(logsPath)} disabled={!logsPath}>Open Logs</SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => void runCommand({ title: 'Tail logs', command: `ls "${logsPath}" && tail -n 120 "${logsPath}"/synergy-testbeta.log`, cwd: selectedNode.workspace_directory })} disabled={!logsPath || actionBusy === 'Tail logs'}>
                      Tail Logs
                    </SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => void runCommand({ title: 'Listener check', command: 'lsof -nP -iTCP:5620-5699 -sTCP:LISTEN 2>/dev/null || true', cwd: selectedNode.workspace_directory })} disabled={actionBusy === 'Listener check'}>
                      Listener Check
                    </SNRGButton>
                  </div>
                </div>

                <div className="cp-ops-group">
                  <span className="cp-eyebrow">Maintenance</span>
                  <div className="cp-button-grid">
                    <SNRGButton variant="purple" size="sm" onClick={() => void handleExportSupportBundle()} disabled={supportBusy}>
                      {supportBusy ? 'Exporting…' : 'Export Bundle'}
                    </SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => void handleCheckUpdates()} disabled={updateStatus.checking}>
                      {updateStatus.checking ? 'Checking…' : 'Check Updates'}
                    </SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => void runCommand({ title: 'Open local context', command: 'pwd && ls -la', cwd: selectedNode.workspace_directory })} disabled={actionBusy === 'Open local context'}>
                      Local Context
                    </SNRGButton>
                  </div>
                </div>
              </div>
            </PanelCard>

            <PanelCard title="Machine + workspace inspector" detail="Raw paths, service names, discovery status, and recent operation receipts.">
              <div className="cp-definition-list">
                <div className="cp-definition-item">
                  <span>Workspace root</span>
                  <strong>{selectedNode.workspace_directory || workspacePath || 'Unavailable'}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Monitor workspace</span>
                  <strong>{workspacePath || 'Unavailable'}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Local RPC endpoint</span>
                  <strong>{localRpcEndpoint || 'Unavailable'}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Discovery status</span>
                  <strong>{snapshot?.syncing_nodes != null ? `${formatNumber(snapshot.syncing_nodes)} syncing slot(s)` : 'Unavailable'}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Recent receipt</span>
                  <strong>{actionAudit[0]?.title || 'No actions recorded yet.'}</strong>
                </div>
              </div>
            </PanelCard>

            <PanelCard title="Action output panel" detail="Last bounded command result plus the structured payload.">
              {lastCommandResult ? (
                <div className="cp-command-output">
                  <div className="cp-command-output-head">
                    <strong>{lastCommandResult.command}</strong>
                    <span>{lastCommandResult.executed_at_utc ? formatTimestamp(lastCommandResult.executed_at_utc) : 'Just now'}</span>
                  </div>
                  <pre>{lastCommandResult.stdout || lastCommandResult.stderr || 'No output returned.'}</pre>
                  <JsonInspectorPanel title="Action payload" value={lastCommandResult} />
                </div>
              ) : (
                <div className="cp-empty-inline">Run any grouped action above to inspect its structured result here.</div>
              )}
            </PanelCard>
          </div>

          <div className="cp-dashboard-side">
            <PanelCard title="Local discovery inspector" detail="Security and inventory context for this machine.">
              <JsonInspectorPanel title="Security state" value={securityState} emptyMessage="Security state not loaded yet." />
            </PanelCard>

            <PanelCard title="Service / source inspector" detail="Raw runtime and local service visibility for the selected node.">
              <JsonInspectorPanel
                title="Runtime context"
                value={{
                  selectedNode,
                  selectedNodeLive,
                  snapshotSummary: snapshot ? {
                    total_nodes: snapshot.total_nodes,
                    online_nodes: snapshot.online_nodes,
                    offline_nodes: snapshot.offline_nodes,
                    syncing_nodes: snapshot.syncing_nodes,
                  } : null,
                  agentSummary: agentSnapshot ? {
                    total_agents: agentSnapshot.total_agents,
                    reachable_agents: agentSnapshot.reachable_agents,
                    unreachable_agents: agentSnapshot.unreachable_agents,
                  } : null,
                }}
              />
            </PanelCard>

            <PanelCard title="Action audit trail" detail="Every local operation stays visible here with timestamps and receipts.">
              <div className="cp-panel-scroll cp-panel-scroll-tight">
                <ActionAuditStream entries={actionAudit} emptyMessage="No local ops have been recorded yet." />
              </div>
            </PanelCard>

            <PanelCard title="Danger zone" detail="Destructive actions stay gated and audited.">
              <div className="cp-checklist">
                <div className="cp-checklist-item">
                  <strong>Erase local machine data</strong>
                  <small>This removes the local Testnet-Beta workspace on this machine. Use it only as a deliberate recovery step.</small>
                </div>
              </div>
              <div className="cp-button-grid">
                <SNRGButton variant="orange" size="sm" onClick={() => void handleEraseLocalData()} disabled={eraseBusy || platformTarget === 'unknown'}>
                  {eraseBusy ? 'Erasing…' : 'Erase Local Data'}
                </SNRGButton>
              </div>
            </PanelCard>
          </div>
        </div>
      ) : null}
    </div>
  );
}
