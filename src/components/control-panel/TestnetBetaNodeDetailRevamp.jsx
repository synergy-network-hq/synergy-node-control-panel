import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { invoke, openPath, readTextFile } from '../../lib/desktopClient';
import { normalizePeerInfoPayload } from '../../lib/testnetBetaPeerInfo';
import { SNRGButton } from '../../styles/SNRGButton';
import { useControlPanel } from './ControlPanelProvider';
import {
  buildTopologyModel,
  formatNumber,
  formatPercent,
  formatRuntimeDuration,
  formatScore,
  formatTimestamp,
  localRpcEndpointForNode,
  nodeBlockHeightDetail,
  nodeBlockHeightValue,
  nodeRuntimeLabel,
  nodeRuntimeTone,
  nodeSyncPercent,
  queryLocalRpc,
  roleTypeLabel,
  safeArray,
  statusTone,
  truncateMiddle,
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
  rejoinNetworkAction,
  restartNodeAction,
  runNodeControlAction,
} from './controlPanelActions';

export default function TestnetBetaNodeDetailRevamp() {
  const { nodeId } = useParams();
  const navigate = useNavigate();
  const {
    error,
    knownValidatorAddressesByHost,
    liveStatus,
    network,
    nodeLiveById,
    nodes,
    refresh,
    setSelectedNodeId,
    validatorNodesByAddress,
    viewMode,
  } = useControlPanel();

  const node = useMemo(
    () => nodes.find((entry) => entry.id === nodeId) || null,
    [nodeId, nodes],
  );
  const nodeLive = node ? nodeLiveById[node.id] || null : null;

  const [readinessReport, setReadinessReport] = useState(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [localPeerInfo, setLocalPeerInfo] = useState(null);
  const [localPeerError, setLocalPeerError] = useState('');
  const [configPreview, setConfigPreview] = useState('');
  const [configError, setConfigError] = useState('');
  const [actionBusy, setActionBusy] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (nodeId) {
      setSelectedNodeId(nodeId);
    }
  }, [nodeId, setSelectedNodeId]);

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
    if (!node) {
      setReadinessReport(null);
      setReadinessLoading(false);
      return undefined;
    }

    let cancelled = false;

    const fetchReadiness = async (showSpinner = false) => {
      if (showSpinner && !cancelled) {
        setReadinessLoading(true);
      }

      try {
        const report = await invoke('testbeta_get_node_readiness', { nodeId: node.id });
        if (!cancelled) {
          setReadinessReport(report);
        }
      } catch (readinessError) {
        if (!cancelled) {
          setNotice(`Readiness check failed: ${String(readinessError)}`);
        }
      } finally {
        if (!cancelled) {
          setReadinessLoading(false);
        }
      }
    };

    void fetchReadiness(true);
    const intervalId = window.setInterval(() => {
      void fetchReadiness(false);
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [node]);

  useEffect(() => {
    if (!node || !nodeLive?.is_running || nodeLive?.local_rpc_ready !== true) {
      setLocalPeerInfo(null);
      setLocalPeerError('');
      return undefined;
    }

    let cancelled = false;
    const endpoint = localRpcEndpointForNode(node, nodeLive);

    const fetchPeers = async () => {
      try {
        const peerInfo = await queryLocalRpc(endpoint, 'synergy_getPeerInfo', []);
        if (!cancelled) {
          setLocalPeerInfo(normalizePeerInfoPayload(peerInfo, knownValidatorAddressesByHost));
          setLocalPeerError('');
        }
      } catch (peerError) {
        if (!cancelled) {
          setLocalPeerInfo(null);
          setLocalPeerError(String(peerError));
        }
      }
    };

    void fetchPeers();
    const intervalId = window.setInterval(() => {
      void fetchPeers();
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [knownValidatorAddressesByHost, node, nodeLive]);

  useEffect(() => {
    if (!node || viewMode !== 'developer' || !safeArray(node.config_paths).length) {
      setConfigPreview('');
      setConfigError('');
      return undefined;
    }

    let cancelled = false;

    readTextFile(node.config_paths[0])
      .then((contents) => {
        if (!cancelled) {
          setConfigPreview(String(contents || '').slice(0, 6000));
          setConfigError('');
        }
      })
      .catch((previewError) => {
        if (!cancelled) {
          setConfigPreview('');
          setConfigError(String(previewError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [node, viewMode]);

  const handleAction = async (kind) => {
    if (!node) {
      return;
    }

    setActionBusy(kind);
    try {
      let message = '';

      if (kind === 'restart') {
        message = await restartNodeAction({ node, network });
      } else if (kind === 'rejoin') {
        message = await rejoinNetworkAction({ node, network });
      } else if (kind === 'boost') {
        message = await boostSyncAction(node.id);
      } else if (kind === 'register') {
        message = await registerWithSeedsAction(node.id);
      } else {
        const result = await runNodeControlAction({
          node,
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

  const topologyModel = useMemo(
    () => buildTopologyModel({
      selectedNode: node,
      selectedNodeLive: nodeLive,
      localPeerInfo,
      liveStatus,
      validatorNodesByAddress,
      nodeLiveById,
      viewMode,
    }),
    [liveStatus, localPeerInfo, node, nodeLive, nodeLiveById, validatorNodesByAddress, viewMode],
  );

  const isRunning = Boolean(nodeLive?.is_running);
  const syncPercent = nodeSyncPercent(nodeLive, liveStatus);
  const signalBars = [
    {
      id: 'sync',
      label: 'Sync progress',
      value: formatPercent(syncPercent, 0),
      detail: nodeBlockHeightDetail(nodeLive, liveStatus),
      numericValue: syncPercent,
      tone: nodeRuntimeTone(nodeLive),
    },
    {
      id: 'peers',
      label: 'Peer sessions',
      value: formatNumber(localPeerInfo?.peerCount ?? nodeLive?.local_peer_count),
      detail: 'Visible peer links from this node',
      numericValue: Number(localPeerInfo?.peerCount ?? nodeLive?.local_peer_count ?? 0),
      tone: 'cyan',
    },
    {
      id: 'score',
      label: 'Synergy score',
      value: formatScore(nodeLive?.synergy_score),
      detail: nodeLive?.synergy_score_status || 'Waiting for score telemetry',
      numericValue: Number(nodeLive?.synergy_score ?? 0),
      tone: 'purple',
    },
    {
      id: 'checks',
      label: 'Readiness',
      value: readinessReport ? `${formatNumber(readinessReport.ready_count)}/${formatNumber(readinessReport.total_count)}` : 'Pending',
      detail: readinessReport?.overall_status || 'Checklist pending',
      numericValue: Number(readinessReport?.ready_count ?? 0),
      tone: statusTone(readinessReport?.overall_status),
    },
  ];

  const readinessItems = safeArray(readinessReport?.checks)
    .slice(0, viewMode === 'developer' ? 8 : 5)
    .map((check) => ({
      id: check.id,
      title: check.label,
      detail: `${check.detail}${check.suggestion ? ` ${check.suggestion}` : ''}`,
      time: readinessReport?.overall_status || 'Readiness',
      tone: statusTone(check.status),
    }));

  if (!node) {
    return (
      <EmptyPanel
        title="Node not found"
        copy="The requested node is no longer registered on this machine."
        actionLabel="Return to Dashboard"
        onAction={() => navigate('/')}
      />
    );
  }

  return (
    <div className="cp-page-stack">
      <SectionHeader
        eyebrow={viewMode === 'basic' ? 'Node View' : 'Node Details'}
        title={node.display_label || roleTypeLabel(node.role_display_name)}
        actions={(
          <>
            <SNRGButton variant="blue" size="sm" onClick={() => openPath(node.workspace_directory)}>
              Open Workspace
            </SNRGButton>
            <SNRGButton variant="blue" size="sm" onClick={() => void refresh()}>
              Refresh
            </SNRGButton>
          </>
        )}
      />

      {(notice || error || localPeerError || configError) ? (
        <div className={`cp-inline-notice tone-${statusTone(notice || error || localPeerError || configError)}`}>
          {notice || error || localPeerError || configError}
        </div>
      ) : null}

      <div className="cp-dashboard-grid">
        <div className="cp-dashboard-main">
          <PanelCard
            className="cp-hero-panel"
            eyebrow="Controls"
            title="Node actions"
            detail={node.public_host || node.workspace_directory}
            action={(
              <StatusPill tone={nodeRuntimeTone(nodeLive)} live={isRunning}>
                {nodeRuntimeLabel(nodeLive)}
              </StatusPill>
            )}
          >
            <div className="cp-action-grid">
              <SNRGButton
                variant="green"
                size="sm"
                disabled={isRunning || actionBusy === 'start'}
                onClick={() => void handleAction('start')}
              >
                {actionBusy === 'start' ? 'Starting…' : 'Start'}
              </SNRGButton>
              <SNRGButton
                variant="red"
                size="sm"
                disabled={!isRunning || actionBusy === 'stop'}
                onClick={() => void handleAction('stop')}
              >
                {actionBusy === 'stop' ? 'Stopping…' : 'Stop'}
              </SNRGButton>
              <SNRGButton
                variant="orange"
                size="sm"
                disabled={actionBusy === 'restart'}
                onClick={() => void handleAction('restart')}
              >
                {actionBusy === 'restart' ? 'Restarting…' : 'Restart'}
              </SNRGButton>
              <SNRGButton
                variant="orange"
                size="sm"
                disabled={actionBusy === 'rejoin'}
                onClick={() => void handleAction('rejoin')}
              >
                {actionBusy === 'rejoin' ? 'Rejoining…' : 'Rejoin'}
              </SNRGButton>
              <SNRGButton
                variant="yellow"
                size="sm"
                disabled={actionBusy === 'boost'}
                onClick={() => void handleAction('boost')}
              >
                {actionBusy === 'boost' ? 'Boosting…' : 'Boost Sync'}
              </SNRGButton>
              <SNRGButton
                variant="yellow"
                size="sm"
                disabled={actionBusy === 'register'}
                onClick={() => void handleAction('register')}
              >
                {actionBusy === 'register' ? 'Registering…' : 'Re-register'}
              </SNRGButton>
            </div>
          </PanelCard>

          <div className="cp-metric-grid cp-metric-grid-dashboard">
            <MetricCard
              label="Synergy Score"
              value={formatScore(nodeLive?.synergy_score)}
              detail={nodeLive?.synergy_score_status || 'Waiting for telemetry'}
              tone="purple"
              icon="auto_graph"
            />
            <MetricCard
              label="Block Height"
              value={formatNumber(nodeBlockHeightValue(nodeLive, liveStatus))}
              detail={nodeBlockHeightDetail(nodeLive, liveStatus)}
              tone={nodeRuntimeTone(nodeLive)}
              icon="data_usage"
            />
            <MetricCard
              label="Uptime"
              value={formatRuntimeDuration(nodeLive?.process_uptime_secs) || '—'}
              detail={nodeLive?.is_running ? 'Running' : 'Stopped'}
              tone={nodeLive?.is_running ? 'good' : 'neutral'}
              icon="schedule"
            />
            <MetricCard
              label="Peers"
              value={formatNumber(localPeerInfo?.peerCount ?? nodeLive?.local_peer_count)}
              detail="Active sessions"
              tone="cyan"
              icon="hub"
            />
          </div>

          <MetricBars
            title="Runtime signals"
            detail="Live indicators for this node."
            items={signalBars}
          />

          <TopologyMap
            title={viewMode === 'basic' ? 'Connected nodes' : 'Peer topology'}
            detail={localPeerInfo?.peerCount
              ? `${formatNumber(localPeerInfo.peerCount)} peer sessions visible from this node`
              : 'Peer topology will populate after the node exposes local RPC peer info.'}
            model={topologyModel}
            action={(
              <SNRGButton as={Link} to="/connectivity" variant="blue" size="sm">
                Full Connectivity
              </SNRGButton>
            )}
          />

          {viewMode !== 'basic' ? (
            <ActivityFeed
              title="Readiness checklist"
              detail={readinessLoading ? 'Refreshing checks…' : `${formatNumber(readinessReport?.ready_count ?? 0)} checks currently passing`}
              items={readinessItems}
              emptyMessage="Run a readiness check to see the checklist here."
            />
          ) : null}

          {viewMode === 'developer' ? (
            <PanelCard
              title="Config preview"
              detail={safeArray(node.config_paths).length ? node.config_paths[0] : 'No config path reported'}
            >
              <div className="cp-config-preview">
                {configPreview ? <pre>{configPreview}</pre> : <div className="cp-empty-inline">No config preview available for this node.</div>}
              </div>
            </PanelCard>
          ) : null}
        </div>

        <div className="cp-dashboard-side">
          <JarvisCard
            mode={viewMode}
            title={viewMode === 'basic' ? 'Jarvis insight' : 'Control guidance'}
            message={viewMode === 'basic'
              ? 'Is the node healthy, connected, and which action is safest next?'
              : 'Command actions stay explicit here while Jarvis holds assistant context alongside.'}
            chips={[
              nodeRuntimeLabel(nodeLive),
              `${formatPercent(syncPercent, 0)} sync`,
              `${formatNumber(localPeerInfo?.peerCount ?? 0)} peers`,
            ]}
          />

          <PanelCard
            title="Workspace artifacts"
            detail="Open the generated files directly from the panel."
          >
            <div className="cp-endpoint-list">
              <div className="cp-endpoint-item">
                <div>
                  <strong>Workspace</strong>
                  <span>{node.workspace_directory}</span>
                </div>
                <SNRGButton variant="blue" size="sm" onClick={() => openPath(node.workspace_directory)}>
                  Open
                </SNRGButton>
              </div>
              <div className="cp-endpoint-item">
                <div>
                  <strong>Log folder</strong>
                  <span>{node.workspace_directory}/logs</span>
                </div>
                <SNRGButton variant="blue" size="sm" onClick={() => openPath(`${node.workspace_directory}/logs`)}>
                  Open
                </SNRGButton>
              </div>
              {safeArray(node.config_paths).map((path) => (
                <div key={path} className="cp-endpoint-item">
                  <div>
                    <strong>Config file</strong>
                    <span>{path}</span>
                  </div>
                  <SNRGButton variant="blue" size="sm" onClick={() => openPath(path)}>
                    Open
                  </SNRGButton>
                </div>
              ))}
            </div>
          </PanelCard>

          <PanelCard
            title="Identity"
            detail="Node identity and public endpoints."
          >
            <div className="cp-definition-list">
              <div className="cp-definition-item">
                <span>Wallet</span>
                <strong>{truncateMiddle(node.node_address, 8, 8)}</strong>
              </div>
              <div className="cp-definition-item">
                <span>Public host</span>
                <strong>{node.public_host || 'Not assigned'}</strong>
              </div>
              <div className="cp-definition-item">
                <span>Role ID</span>
                <strong>{node.role_id || 'Unknown'}</strong>
              </div>
              <div className="cp-definition-item">
                <span>Last updated</span>
                <strong>{formatTimestamp(node.updated_at_utc || node.created_at_utc)}</strong>
              </div>
            </div>
          </PanelCard>
        </div>
      </div>
    </div>
  );
}
