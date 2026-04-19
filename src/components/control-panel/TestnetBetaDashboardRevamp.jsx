import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke, openPath } from '../../lib/desktopClient';
import { SNRGButton } from '../../styles/SNRGButton';
import { useControlPanel } from './ControlPanelProvider';
import {
  buildTopologyModel,
  formatNumber,
  formatPercent,
  formatRuntimeDuration,
  formatScore,
  networkHealthSummary,
  nodeBlockHeightDetail,
  nodeBlockHeightValue,
  nodeRuntimeLabel,
  nodeRuntimeTone,
  nodeSyncPercent,
  roleTypeLabel,
  safeArray,
  simplifyLogEntry,
  statusTone,
} from './controlPanelModel';
import {
  ActivityFeed,
  EmptyPanel,
  JarvisCard,
  MetricBars,
  MetricCard,
  PanelCard,
  SectionHeader,
  StatusPill,
  TopologyMap,
} from './ControlPanelShared';
import {
  boostSyncAction,
  registerWithSeedsAction,
  restartNodeAction,
  runNodeControlAction,
} from './controlPanelActions';

export default function TestnetBetaDashboardRevamp({ onLaunchSetup }) {
  const {
    error,
    liveStatus,
    loading,
    network,
    networkStats,
    nodes,
    nodeLiveById,
    refresh,
    selectedNode,
    selectedNodeLive,
    selectedRole,
    setSelectedNodeId,
    validatorNodesByAddress,
    viewMode,
  } = useControlPanel();

  const [actionBusy, setActionBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [nodeLogBundle, setNodeLogBundle] = useState(null);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setNotice('');
    }, 3200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);

  useEffect(() => {
    if (!selectedNode) {
      setNodeLogBundle(null);
      setLogsLoading(false);
      return undefined;
    }

    let cancelled = false;

    const loadLogs = async () => {
      if (!cancelled) {
        setLogsLoading(true);
      }

      try {
        const bundle = await invoke('testbeta_get_node_logs', {
          nodeId: selectedNode.id,
          lines: 140,
        });

        if (!cancelled) {
          setNodeLogBundle(bundle || null);
        }
      } catch {
        if (!cancelled) {
          setNodeLogBundle(null);
        }
      } finally {
        if (!cancelled) {
          setLogsLoading(false);
        }
      }
    };

    void loadLogs();
    const intervalId = window.setInterval(() => {
      void loadLogs();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedNode]);

  const handleAction = async (kind) => {
    if (!selectedNode) {
      return;
    }

    setActionBusy(kind);
    try {
      let message = '';

      if (kind === 'restart') {
        message = await restartNodeAction({ node: selectedNode, network });
      } else if (kind === 'boost') {
        message = await boostSyncAction(selectedNode.id);
      } else if (kind === 'register') {
        message = await registerWithSeedsAction(selectedNode.id);
      } else {
        const result = await runNodeControlAction({
          node: selectedNode,
          network,
          action: kind,
        });
        message = result.message;
      }

      setNotice(message);
      await refresh({ silent: true });
    } catch (actionError) {
      setNotice(String(actionError));
    } finally {
      setActionBusy('');
    }
  };

  const healthSummary = useMemo(
    () => networkHealthSummary(liveStatus),
    [liveStatus],
  );

  const activityItems = useMemo(
    () => safeArray(nodeLogBundle?.entries)
      .slice(-6)
      .reverse()
      .map((entry) => simplifyLogEntry(entry, viewMode)),
    [nodeLogBundle?.entries, viewMode],
  );

  const topologyModel = useMemo(
    () => buildTopologyModel({
      selectedNode,
      selectedNodeLive,
      liveStatus,
      validatorNodesByAddress,
      nodeLiveById,
      viewMode,
    }),
    [liveStatus, nodeLiveById, selectedNode, selectedNodeLive, validatorNodesByAddress, viewMode],
  );

  const syncPercent = nodeSyncPercent(selectedNodeLive, liveStatus);

  const overviewBars = useMemo(() => ([
    {
      id: 'sync',
      label: viewMode === 'basic' ? 'Sync progress' : 'Chain sync',
      value: formatPercent(syncPercent, 0),
      detail: nodeBlockHeightDetail(selectedNodeLive, liveStatus),
      numericValue: syncPercent,
      tone: nodeRuntimeTone(selectedNodeLive),
    },
    {
      id: 'peers',
      label: viewMode === 'basic' ? 'Connected nodes' : 'Visible peers',
      value: formatNumber(selectedNodeLive?.local_peer_count ?? networkStats.totalPeers),
      detail: 'Live peer sessions seen by this node',
      numericValue: Number(selectedNodeLive?.local_peer_count ?? networkStats.totalPeers ?? 0),
      tone: 'cyan',
    },
    {
      id: 'score',
      label: 'Synergy score',
      value: formatScore(selectedNodeLive?.synergy_score),
      detail: selectedNodeLive?.synergy_score_status || 'Waiting for live telemetry',
      numericValue: Number(selectedNodeLive?.synergy_score ?? 0),
      tone: 'purple',
    },
    {
      id: 'bootnodes',
      label: viewMode === 'basic' ? 'Bootstrap relays' : 'Bootstrap reachability',
      value: `${formatNumber(networkStats.healthyBootnodes)}/${formatNumber(networkStats.totalBootnodes)}`,
      detail: 'Healthy relays answering the latest probe',
      numericValue: Number(networkStats.healthyBootnodes || 0),
      tone: networkStats.healthyBootnodes === networkStats.totalBootnodes ? 'good' : 'warn',
    },
  ]), [
    liveStatus,
    networkStats.healthyBootnodes,
    networkStats.totalBootnodes,
    networkStats.totalPeers,
    selectedNodeLive,
    syncPercent,
    viewMode,
  ]);

  const dashboardCopy = selectedNode
    ? (viewMode === 'basic'
      ? 'Your node at a glance: health, progress, network connections, and today’s important events.'
      : 'Live node state, operator actions, topology, and telemetry in a single control surface.')
    : 'Provision a node to populate the control panel with live network telemetry.';

  if (!loading && !nodes.length) {
    return (
      <EmptyPanel
        title="No node workspaces yet"
        copy="Launch Jarvis setup to provision the first Synergy node on this machine."
        actionLabel="Launch Setup"
        onAction={onLaunchSetup}
      />
    );
  }

  return (
    <div className="cp-page-stack">
      <SectionHeader
        eyebrow={viewMode === 'basic' ? 'Basic View' : viewMode === 'expert' ? 'Expert View' : 'Developer View'}
        title={viewMode === 'basic' ? 'Node Overview' : viewMode === 'expert' ? 'Operations Overview' : 'Runtime Telemetry'}
        copy={dashboardCopy}
        actions={(
          <>
            <SNRGButton variant="blue" size="sm" onClick={() => void refresh()}>
              Refresh
            </SNRGButton>
            <SNRGButton variant="blue" size="sm" onClick={onLaunchSetup}>
              Jarvis Setup
            </SNRGButton>
          </>
        )}
      />

      {(notice || error) ? (
        <div className={`cp-inline-notice tone-${statusTone(notice || error)}`}>
          {notice || error}
        </div>
      ) : null}

      <div className="cp-node-selector">
        {nodes.map((node) => {
          const nodeLive = nodeLiveById[node.id] || null;
          const active = selectedNode?.id === node.id;
          return (
            <button
              key={node.id}
              type="button"
              className={`cp-node-chip ${active ? 'is-active' : ''}`}
              onClick={() => setSelectedNodeId(node.id)}
            >
              <span>{node.display_label || roleTypeLabel(node.role_display_name)}</span>
              <strong>{nodeRuntimeLabel(nodeLive)}</strong>
            </button>
          );
        })}
      </div>

      {selectedNode ? (
        <div className="cp-dashboard-grid">
          <div className="cp-dashboard-main">
            <PanelCard
              className="cp-hero-panel"
              eyebrow={selectedRole?.class_name || 'Node'}
              title={selectedNode.display_label || roleTypeLabel(selectedNode.role_display_name)}
              detail={selectedNode.public_host || selectedNode.workspace_directory || 'Private workspace ready'}
              action={(
                <StatusPill tone={nodeRuntimeTone(selectedNodeLive)}>
                  {nodeRuntimeLabel(selectedNodeLive)}
                </StatusPill>
              )}
            >
              <div className="cp-hero-layout">
                <div className="cp-hero-copy">
                  <h2>{healthSummary.title}</h2>
                  <p>
                    {viewMode === 'basic'
                      ? 'Jarvis is surfacing the essentials first: whether the node is healthy, how far behind it is, and whether the network path is stable.'
                      : 'This pane keeps the operator actions and the live node state in the same frame so you can recover quickly without context switching.'}
                  </p>
                  <div className="cp-stat-strip">
                    <div>
                      <span>Runtime</span>
                      <strong>{formatRuntimeDuration(selectedNodeLive?.process_uptime_secs)}</strong>
                    </div>
                    <div>
                      <span>Block height</span>
                      <strong>{formatNumber(nodeBlockHeightValue(selectedNodeLive, liveStatus))}</strong>
                    </div>
                    <div>
                      <span>Peers</span>
                      <strong>{formatNumber(selectedNodeLive?.local_peer_count)}</strong>
                    </div>
                  </div>
                </div>
                <div className="cp-action-stack">
                  <SNRGButton
                    variant="lime"
                    size="sm"
                    disabled={actionBusy === 'start' || !selectedNode}
                    onClick={() => void handleAction('start')}
                  >
                    {actionBusy === 'start' ? 'Starting...' : 'Start Node'}
                  </SNRGButton>
                  <SNRGButton
                    variant="purple"
                    size="sm"
                    disabled={actionBusy === 'restart' || !selectedNode}
                    onClick={() => void handleAction('restart')}
                  >
                    {actionBusy === 'restart' ? 'Restarting...' : 'Restart'}
                  </SNRGButton>
                  <SNRGButton
                    variant="blue"
                    size="sm"
                    disabled={actionBusy === 'boost' || !selectedNode}
                    onClick={() => void handleAction('boost')}
                  >
                    {actionBusy === 'boost' ? 'Boosting...' : 'Boost Sync'}
                  </SNRGButton>
                  <SNRGButton
                    variant="blue"
                    size="sm"
                    onClick={() => openPath(selectedNode.workspace_directory)}
                  >
                    Open Workspace
                  </SNRGButton>
                  <SNRGButton
                    as={Link}
                    to={`/node/${selectedNode.id}`}
                    variant="blue"
                    size="sm"
                  >
                    Node Details
                  </SNRGButton>
                </div>
              </div>
            </PanelCard>

            <div className="cp-metric-grid cp-metric-grid-dashboard">
              <MetricCard
                label="Runtime state"
                value={nodeRuntimeLabel(selectedNodeLive)}
                detail={selectedNodeLive?.local_rpc_status || 'Control-service heartbeat is active.'}
                tone={nodeRuntimeTone(selectedNodeLive)}
                icon="monitor_heart"
              />
              <MetricCard
                label={viewMode === 'basic' ? 'Network height' : 'Public chain tip'}
                value={formatNumber(networkStats.publicChainHeight)}
                detail="Most recent public chain height"
                tone="cyan"
                icon="data_usage"
              />
              <MetricCard
                label="Role"
                value={roleTypeLabel(selectedNode.role_display_name)}
                detail={selectedRole?.authority_plane || selectedRole?.summary || 'Role-bound runtime'}
                tone="purple"
                icon="account_tree"
              />
              <MetricCard
                label="Score"
                value={formatScore(selectedNodeLive?.synergy_score)}
                detail={selectedNodeLive?.synergy_score_status || 'Waiting for score telemetry'}
                tone="good"
                icon="auto_graph"
              />
            </div>

            <MetricBars
              title={viewMode === 'basic' ? 'Today at a glance' : 'Operational signal bars'}
              detail={viewMode === 'basic'
                ? 'These bars turn technical telemetry into a few simple operator signals.'
                : 'A compact readout of sync, peer count, score, and bootstrap health.'}
              items={overviewBars}
            />

            <TopologyMap
              title={viewMode === 'basic' ? 'Network map' : 'Peer topology'}
              detail={viewMode === 'basic'
                ? 'Your node in the middle, connected peers around it.'
                : 'Peer sessions clustered around the selected node.'}
              model={topologyModel}
              action={(
                <SNRGButton as={Link} to="/connectivity" variant="blue" size="sm">
                  Open Connectivity
                </SNRGButton>
              )}
            />
          </div>

          <div className="cp-dashboard-side">
            <JarvisCard
              mode={viewMode}
              title={viewMode === 'basic' ? 'What Jarvis sees' : 'Operator guidance'}
              message={viewMode === 'basic'
                ? `Your node is ${nodeRuntimeLabel(selectedNodeLive).toLowerCase()}. If you only do one thing from here, watch the sync bar and the activity feed below.`
                : `${healthSummary.detail} Jarvis will eventually execute direct actions here, but today the focus is a clear command surface that explains what is happening.`}
              chips={[
                nodeRuntimeLabel(selectedNodeLive),
                `${formatNumber(selectedNodeLive?.local_peer_count ?? 0)} peers`,
                `${formatPercent(syncPercent, 0)} sync`,
              ]}
              footer="Type “Genesis setup” in Jarvis to return to the conversational provisioning flow."
            />

            <ActivityFeed
              title={viewMode === 'basic' ? 'Daily activity' : 'Recent events'}
              detail={logsLoading ? 'Updating live event feed…' : 'Fresh from the selected node workspace.'}
              items={activityItems}
              emptyMessage="No log events have arrived yet."
            />

            <PanelCard
              title="Quick controls"
              detail="Common recovery actions stay one click away."
            >
              <div className="cp-button-grid">
                <SNRGButton
                  variant="blue"
                  size="sm"
                  disabled={actionBusy === 'register' || !selectedNode}
                  onClick={() => void handleAction('register')}
                >
                  {actionBusy === 'register' ? 'Registering...' : 'Re-register'}
                </SNRGButton>
                <SNRGButton
                  variant="purple"
                  size="sm"
                  disabled={actionBusy === 'stop' || !selectedNode}
                  onClick={() => void handleAction('stop')}
                >
                  {actionBusy === 'stop' ? 'Stopping...' : 'Stop Node'}
                </SNRGButton>
                <SNRGButton as={Link} to="/logs" variant="blue" size="sm">
                  Open Logs
                </SNRGButton>
                <SNRGButton as={Link} to="/connectivity" variant="blue" size="sm">
                  Peer Map
                </SNRGButton>
              </div>
            </PanelCard>
          </div>
        </div>
      ) : (
        <EmptyPanel
          title="Waiting for node selection"
          copy="A workspace exists, but the panel has not selected it yet."
          actionLabel="Refresh"
          onAction={() => void refresh()}
        />
      )}
    </div>
  );
}
