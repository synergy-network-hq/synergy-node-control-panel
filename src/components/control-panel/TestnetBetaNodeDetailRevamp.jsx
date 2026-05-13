import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { invoke, openPath, readTextFile, resolvePeerTopology } from '../../lib/desktopClient';
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
  MetricBars,
  MetricCard,
  PanelCard,
  SectionHeader,
  StatusPill,
  TopologyMap,
} from './ControlPanelShared';
import HealthTrendChart from './charts/HealthTrendChart';
import PeerGlobe from './PeerGlobe';
import PeerGlobeLegend from './PeerGlobeLegend';
import PeerGraph from './PeerGraph';
import PeerTable from './PeerTable';
import PeerDetailsDrawer from './PeerDetailsDrawer';
import JsonInspectorPanel from './JsonInspectorPanel';
import ActionAuditStream from './ActionAuditStream';
import ConfigDiffViewer from './ConfigDiffViewer';
import ValidatorCatchUpCard from './ValidatorCatchUpCard';
import {
  boostSyncAction,
  registerWithSeedsAction,
  rejoinNetworkAction,
  restartNodeAction,
  runNodeControlAction,
  syncCatchUpRejoinAction,
} from './controlPanelActions';

function buildExpectedConfigProfile(node, nodeLive) {
  const endpoint = localRpcEndpointForNode(node, nodeLive);
  return [
    `[node]`,
    `role = "${node?.role_id || 'validator'}"`,
    `display_label = "${node?.display_label || node?.role_display_name || 'Node'}"`,
    `public_host = "${node?.public_host || ''}"`,
    `node_address = "${node?.node_address || ''}"`,
    '',
    `[workspace]`,
    `root = "${node?.workspace_directory || ''}"`,
    `config = "${safeArray(node?.config_paths)[0] || ''}"`,
    '',
    `[rpc]`,
    `endpoint = "${endpoint}"`,
  ].join('\n');
}

function activationPreflightMessage(result) {
  const canActivate = result?.canActivate === true || result?.can_activate === true;
  const ready = canActivate ? 'ready for activation' : 'not ready for activation';
  const failedChecks = safeArray(result?.checks)
    .filter((check) => check?.status !== 'pass')
    .map((check) => check?.label || check?.id)
    .filter(Boolean)
    .slice(0, 3);
  const blockedBy = failedChecks.length ? ` Blocked by: ${failedChecks.join(', ')}.` : '';
  return `Validator preflight is ${ready}. Liquid ${formatNumber(result?.balance_nwei || 0)} nWei; staked ${formatNumber(result?.staked_balance_nwei || 0)} / ${formatNumber(result?.required_stake_nwei || 0)} nWei.${blockedBy}`;
}

function formatSnrg(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '0';
  }
  return number.toLocaleString(undefined, {
    maximumFractionDigits: 9,
  });
}

export default function TestnetBetaNodeDetailRevamp() {
  const { nodeId } = useParams();
  const navigate = useNavigate();
  const {
    actionAudit,
    error,
    knownValidatorAddressesByHost,
    liveStatus,
    network,
    nodeLiveById,
    nodes,
    recordAction,
    refresh,
    selectedNode: currentSelectedNode,
    selectedPeerId,
    setSelectedNodeId,
    setSelectedPeerId,
    telemetryHistory,
    validatorNodesByAddress,
    viewMode,
    viewProfile,
  } = useControlPanel();

  const node = useMemo(
    () => nodes.find((entry) => entry.id === nodeId) || currentSelectedNode || nodes[0] || null,
    [currentSelectedNode, nodeId, nodes],
  );
  const nodeLive = node ? nodeLiveById[node.id] || null : null;

  const [readinessReport, setReadinessReport] = useState(null);
  const [activationReport, setActivationReport] = useState(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [rewardsData, setRewardsData] = useState(null);
  const [localPeerInfo, setLocalPeerInfo] = useState(null);
  const [localPeerError, setLocalPeerError] = useState('');
  const [configPreview, setConfigPreview] = useState('');
  const [configError, setConfigError] = useState('');
  const [actionBusy, setActionBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [catchUpResult, setCatchUpResult] = useState(null);
  const [peerTopology, setPeerTopology] = useState({
    points: [],
    regionSummary: [],
    routes: [],
  });

  useEffect(() => {
    if (node?.id) {
      setSelectedNodeId(node.id);
    }
  }, [node?.id, setSelectedNodeId]);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }

    const timer = window.setTimeout(() => setNotice(''), 3600);
    return () => window.clearTimeout(timer);
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
        if (String(node.role_id || '').trim().toLowerCase() === 'validator') {
          const preflight = await invoke('testbeta_get_validator_activation_preflight', { nodeId: node.id });
          if (!cancelled) {
            setActivationReport(preflight);
          }
        } else if (!cancelled) {
          setActivationReport(null);
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
    if (!node) {
      setRewardsData(null);
      return undefined;
    }

    let cancelled = false;
    const fetchRewards = async () => {
      try {
        const payload = await invoke('testbeta_get_rewards_data', { nodeId: node.id });
        if (!cancelled) {
          setRewardsData(payload);
        }
      } catch {
        if (!cancelled) {
          setRewardsData(null);
        }
      }
    };

    void fetchRewards();
    const intervalId = window.setInterval(fetchRewards, 12000);
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
    const intervalId = window.setInterval(fetchPeers, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [knownValidatorAddressesByHost, node, nodeLive]);

  useEffect(() => {
    let cancelled = false;

    const loadTopology = async () => {
      const topology = await resolvePeerTopology({
        peers: safeArray(localPeerInfo?.peers),
        localNode: node,
        bootnodes: liveStatus?.bootnodes,
      });
      if (!cancelled) {
        setPeerTopology(topology);
      }
    };

    void loadTopology();
    return () => {
      cancelled = true;
    };
  }, [liveStatus?.bootnodes, localPeerInfo?.peers, node]);

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
          setConfigPreview(String(contents || '').slice(0, 12000));
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
      } else if (kind === 'sync-catch-up') {
        const actionResult = await syncCatchUpRejoinAction({ node, network });
        setCatchUpResult(actionResult.result || null);
        if (actionResult.result?.preflight) {
          setActivationReport(actionResult.result.preflight);
        }
        message = actionResult.message;
      } else if (kind === 'boost') {
        message = await boostSyncAction(node.id);
      } else if (kind === 'register') {
        message = await registerWithSeedsAction(node.id);
      } else if (kind === 'activation-preflight') {
        const result = await invoke('testbeta_get_validator_activation_preflight', { nodeId: node.id });
        message = activationPreflightMessage(result);
      } else if (kind === 'activate-validator') {
        const result = await invoke('testbeta_activate_validator', {
          input: {
            nodeId: node.id,
            displayName: node.display_label || node.role_display_name || 'Validator',
          },
        });
        message = result?.message || `Validator activation submitted${result?.tx_hash ? `: ${result.tx_hash}` : ''}.`;
      } else {
        const result = await runNodeControlAction({
          node,
          network,
          action: kind,
        });
        message = result.message;
      }

      recordAction({
        title: `${kind} node action`,
        detail: message,
        status: 'good',
        source: 'node-detail',
        command: kind,
      });
      setNotice(message);
      await refresh({ silent: true });
      try {
        const payload = await invoke('testbeta_get_rewards_data', { nodeId: node.id });
        setRewardsData(payload);
      } catch {
        // The action receipt is more important than refreshing optional economics telemetry.
      }
    } catch (actionError) {
      const detail = String(actionError);
      recordAction({
        title: `${kind} node action failed`,
        detail,
        status: 'bad',
        source: 'node-detail',
        command: kind,
      });
      setNotice(detail);
    } finally {
      setActionBusy('');
    }
  };

  const handleCatchUpRepair = (action) => {
    if (action === 'rewards') {
      navigate('/rewards');
      return;
    }
    if (action === 'diagnostics') {
      navigate(viewMode === 'developer' ? '/diagnostics' : '/settings');
      return;
    }
    if (action === 'settings') {
      navigate('/settings');
      return;
    }
    if (action === 'register-seeds') {
      void handleAction('register');
      return;
    }
    void handleAction(action);
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

  const nodeHistory = useMemo(
    () => telemetryHistory.byNodeId?.[node?.id] || [],
    [node?.id, telemetryHistory.byNodeId],
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

  const activeReadinessReport = activationReport || readinessReport;
  const readinessItems = safeArray(activeReadinessReport?.checks).map((check) => ({
    id: check.id,
    title: check.label,
    detail: `${check.detail}${check.suggestion ? ` ${check.suggestion}` : ''}`,
    time: activeReadinessReport?.overall_status || (activationReport ? 'Activation' : 'Readiness'),
    tone: statusTone(check.status),
  }));

  const selectedPeer = useMemo(
    () => peerTopology.points.find((peer) => peer.id === selectedPeerId) || null,
    [peerTopology.points, selectedPeerId],
  );
  const performanceSeries = nodeHistory.map((entry) => ({
    at: entry.at,
    value: entry.isRunning ? Math.max(8, 100 - Math.min(90, entry.syncGap)) : 0,
  }));
  const recentEvents = actionAudit.slice(0, 8);
  const isValidatorNode = String(node?.role_id || '').trim().toLowerCase() === 'validator';
  const readinessTitle = activationReport
    ? `Activation checklist ${formatNumber(activationReport.checks?.filter((check) => check?.status === 'pass').length || 0)}/${formatNumber(activationReport.checks?.length || 0)}`
    : `Readiness checklist ${formatNumber(readinessReport?.ready_count ?? 0)}/${formatNumber(readinessReport?.total_count ?? 0)}`;
  const walletLive = rewardsData?.live || {};
  const walletBalanceSnrg = walletLive.wallet_balance_snrg ?? 0;
  const stakedBalanceSnrg = walletLive.staked_balance_snrg ?? 0;
  const validatorStatus = walletLive.validator_status || 'Not active';

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
        eyebrow={viewProfile.label}
        title={viewProfile.navLabels.details}
      />

      {(notice || error || localPeerError || configError) ? (
        <div className={`cp-inline-notice tone-${statusTone(notice || error || localPeerError || configError)}`}>
          {notice || error || localPeerError || configError}
        </div>
      ) : null}

      {viewMode === 'basic' ? (
        <div className="cp-dashboard-grid">
          <div className="cp-dashboard-main">
            <PanelCard
              className="cp-hero-panel"
              eyebrow={roleTypeLabel(node.role_display_name)}
              title={node.display_label || roleTypeLabel(node.role_display_name)}
              detail={nodeRuntimeLabel(nodeLive)}
              action={<StatusPill tone={nodeRuntimeTone(nodeLive)}>{nodeRuntimeLabel(nodeLive)}</StatusPill>}
            >
              <div className="cp-action-grid cp-action-grid-compact">
                <SNRGButton variant="lime" size="sm" disabled={isRunning || actionBusy === 'start'} onClick={() => void handleAction('start')}>
                  {actionBusy === 'start' ? 'Starting…' : 'Start'}
                </SNRGButton>
                <SNRGButton variant="red" size="sm" disabled={!isRunning || actionBusy === 'stop'} onClick={() => void handleAction('stop')}>
                  {actionBusy === 'stop' ? 'Stopping…' : 'Stop'}
                </SNRGButton>
                <SNRGButton variant="purple" size="sm" disabled={actionBusy === 'restart'} onClick={() => void handleAction('restart')}>
                  {actionBusy === 'restart' ? 'Restarting…' : 'Restart'}
                </SNRGButton>
                {isValidatorNode ? (
                  <>
                    <SNRGButton variant="purple" size="sm" disabled={actionBusy === 'sync-catch-up'} onClick={() => void handleAction('sync-catch-up')}>
                      Sync Catch Up
                    </SNRGButton>
                    <SNRGButton variant="blue" size="sm" disabled={actionBusy === 'activation-preflight'} onClick={() => void handleAction('activation-preflight')}>
                      Preflight
                    </SNRGButton>
                    <SNRGButton variant="purple" size="sm" onClick={() => navigate('/validator')}>
                      Validator
                    </SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => navigate('/rewards')}>
                      Rewards
                    </SNRGButton>
                  </>
                ) : null}
              </div>
            </PanelCard>

            <ValidatorCatchUpCard
              node={node}
              nodeLive={nodeLive}
              liveStatus={liveStatus}
              preflight={activationReport}
              lastResult={catchUpResult}
              actionBusy={actionBusy}
              mode={viewMode}
              onRun={() => void handleAction('sync-catch-up')}
              onRepair={handleCatchUpRepair}
            />

            <PanelCard title="Rewards summary" detail="Wallet and validator economics actions live on Rewards." action={<StatusPill tone={validatorStatus === 'Active' ? 'good' : 'warn'}>{validatorStatus}</StatusPill>}>
              <div className="cp-metric-grid cp-metric-grid-dashboard">
                <MetricCard label="Wallet balance" value={`${formatSnrg(walletBalanceSnrg)} SNRG`} tone="cyan" icon="wallet" />
                <MetricCard label="Bonded amount" value={`${formatSnrg(stakedBalanceSnrg)} SNRG`} tone={Number(stakedBalanceSnrg) >= 50000 ? 'good' : 'warn'} icon="account_balance" />
              </div>
              <div className="cp-button-grid">
                <SNRGButton variant="blue" size="sm" onClick={() => navigate('/rewards')}>Open Rewards</SNRGButton>
              </div>
            </PanelCard>

            <PanelCard title="Node summary" detail="The essentials for this workspace.">
              <div className="cp-definition-list">
                <div className="cp-definition-item">
                  <span>Role</span>
                  <strong>{roleTypeLabel(node.role_display_name)}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Online or offline</span>
                  <strong>{nodeRuntimeLabel(nodeLive)}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Last seen</span>
                  <strong>{formatTimestamp(node.updated_at_utc || node.created_at_utc)}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Readiness</span>
                  <strong>{readinessReport?.overall_status || 'Pending'}</strong>
                </div>
              </div>
            </PanelCard>

            <MetricBars title="Simple performance" detail="Connection quality, keeping up, stability, and recent issues." items={signalBars} />

            <PanelCard title="Small topology preview" detail="A simple picture of whether the node can currently see the network.">
              <TopologyMap
                title="Peer preview"
                detail={localPeerInfo?.peerCount
                  ? `${formatNumber(localPeerInfo.peerCount)} peer sessions visible from this node`
                  : 'The preview will fill in once the local RPC reports peer sessions.'}
                model={topologyModel}
              />
            </PanelCard>

            <ActivityFeed
              title={readinessTitle}
              detail={readinessLoading ? 'Refreshing checks...' : 'Current workspace readiness status.'}
              items={readinessItems}
              fixedLines={8}
            />
          </div>

          <div className="cp-dashboard-side">
            <PanelCard title="Identity">
              <div className="cp-definition-list">
                <div className="cp-definition-item">
                  <span>Node label</span>
                  <strong>{node.display_label || roleTypeLabel(node.role_display_name)}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Public host</span>
                  <strong>{node.public_host || 'Not assigned yet'}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Wallet</span>
                  <strong>{truncateMiddle(node.node_address, 8, 6)}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Rewards workflow</span>
                  <strong>Open Rewards</strong>
                </div>
              </div>
            </PanelCard>
          </div>
        </div>
      ) : viewMode === 'advanced' ? (
        <div className="cp-dashboard-grid">
          <div className="cp-dashboard-main">
            <PanelCard
              className="cp-hero-panel"
              eyebrow="Node controls"
              title="Action strip"
              detail={node.public_host || node.workspace_directory}
              action={<StatusPill tone={nodeRuntimeTone(nodeLive)}>{nodeRuntimeLabel(nodeLive)}</StatusPill>}
            >
              <div className="cp-action-grid">
                <SNRGButton variant="green" size="sm" disabled={isRunning || actionBusy === 'start'} onClick={() => void handleAction('start')}>Start</SNRGButton>
                <SNRGButton variant="red" size="sm" disabled={!isRunning || actionBusy === 'stop'} onClick={() => void handleAction('stop')}>Stop</SNRGButton>
                <SNRGButton variant="orange" size="sm" disabled={actionBusy === 'restart'} onClick={() => void handleAction('restart')}>Restart</SNRGButton>
                <SNRGButton variant="blue" size="sm" disabled={actionBusy === 'rejoin'} onClick={() => void handleAction('rejoin')}>Bootstrap / reconnect</SNRGButton>
                <SNRGButton variant="blue" size="sm" disabled={actionBusy === 'register'} onClick={() => void handleAction('register')}>Re-register</SNRGButton>
                {isValidatorNode ? (
                  <>
                    <SNRGButton variant="purple" size="sm" disabled={actionBusy === 'sync-catch-up'} onClick={() => void handleAction('sync-catch-up')}>Sync Catch Up</SNRGButton>
                    <SNRGButton variant="blue" size="sm" disabled={actionBusy === 'activation-preflight'} onClick={() => void handleAction('activation-preflight')}>Activation Preflight</SNRGButton>
                    <SNRGButton variant="purple" size="sm" onClick={() => navigate('/validator')}>Validator Lifecycle</SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => navigate('/rewards')}>Rewards</SNRGButton>
                  </>
                ) : null}
                <SNRGButton variant="blue" size="sm" onClick={() => openPath(`${node.workspace_directory}/logs`)}>Open logs</SNRGButton>
              </div>
            </PanelCard>

            <ValidatorCatchUpCard
              node={node}
              nodeLive={nodeLive}
              liveStatus={liveStatus}
              preflight={activationReport}
              lastResult={catchUpResult}
              actionBusy={actionBusy}
              mode={viewMode}
              onRun={() => void handleAction('sync-catch-up')}
              onRepair={handleCatchUpRepair}
            />

            <PanelCard title="Rewards summary" detail="Economics controls live on Rewards so this page stays focused on runtime detail." action={<StatusPill tone={validatorStatus === 'Active' ? 'good' : 'warn'}>{validatorStatus}</StatusPill>}>
              <div className="cp-metric-grid cp-metric-grid-dashboard">
                <MetricCard label="Wallet balance" value={`${formatSnrg(walletBalanceSnrg)} SNRG`} tone="cyan" icon="wallet" />
                <MetricCard label="Bonded amount" value={`${formatSnrg(stakedBalanceSnrg)} SNRG`} tone={Number(stakedBalanceSnrg) >= 50000 ? 'good' : 'warn'} icon="account_balance" />
              </div>
              <div className="cp-button-grid">
                <SNRGButton variant="blue" size="sm" onClick={() => navigate('/rewards')}>Open Rewards</SNRGButton>
              </div>
            </PanelCard>

            <div className="cp-metric-grid cp-metric-grid-dashboard">
              <MetricCard label="Sync lag" value={`${formatNumber(nodeLive?.sync_gap ?? 0)} blocks`} detail={nodeBlockHeightDetail(nodeLive, liveStatus)} tone={nodeRuntimeTone(nodeLive)} icon="sync" />
              <MetricCard label="Peer visibility" value={formatNumber(localPeerInfo?.peerCount ?? nodeLive?.local_peer_count)} detail="Visible sessions" tone="cyan" icon="hub" />
              <MetricCard label="Recent errors" value={formatNumber(recentEvents.length)} detail="Recent local actions and alerts" tone={recentEvents.length ? 'warn' : 'good'} icon="warning" />
              <MetricCard label="Rewards availability" value={formatScore(nodeLive?.synergy_score)} detail="Open rewards for detail" tone="purple" icon="savings" />
            </div>

            <PanelCard title="Workspace artifacts" detail="Paths, files, and runtime surface with copy-friendly visibility.">
              <div className="cp-endpoint-list">
                <div className="cp-endpoint-item">
                  <div>
                    <strong>Workspace root</strong>
                    <span>{node.workspace_directory}</span>
                  </div>
                  <SNRGButton variant="blue" size="sm" onClick={() => openPath(node.workspace_directory)}>Open</SNRGButton>
                </div>
                <div className="cp-endpoint-item">
                  <div>
                    <strong>Log folder</strong>
                    <span>{node.workspace_directory}/logs</span>
                  </div>
                  <SNRGButton variant="blue" size="sm" onClick={() => openPath(`${node.workspace_directory}/logs`)}>Open</SNRGButton>
                </div>
                {safeArray(node.config_paths).map((path) => (
                  <div key={path} className="cp-endpoint-item">
                    <div>
                      <strong>Config path</strong>
                      <span>{path}</span>
                    </div>
                    <SNRGButton variant="blue" size="sm" onClick={() => openPath(path)}>Open</SNRGButton>
                  </div>
                ))}
              </div>
            </PanelCard>

            <HealthTrendChart title="Operational metrics" detail="Health and readiness trend for this node." data={performanceSeries} tone={nodeRuntimeTone(nodeLive)} />

            <PanelCard title="Topology card" detail="Interactive regional preview and selected peer detail.">
              <PeerGlobe
                points={peerTopology.points}
                routes={peerTopology.routes}
                regionSummary={peerTopology.regionSummary}
                selectedPeerId={selectedPeerId}
                onSelectPeer={(peer) => setSelectedPeerId(peer.id)}
                mode="advanced"
              />
              <PeerGlobeLegend />
            </PanelCard>

            <ActivityFeed
              title={readinessTitle}
              detail={readinessLoading ? 'Refreshing readiness checks…' : `${formatNumber(readinessReport?.ready_count ?? 0)} checks are currently passing.`}
              items={readinessItems}
              fixedLines={8}
            />
          </div>

          <div className="cp-dashboard-side">
            <PanelCard title="Identity">
              <div className="cp-definition-list">
                <div className="cp-definition-item">
                  <span>Wallet</span>
                  <strong>{truncateMiddle(node.node_address, 10, 8)}</strong>
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
                  <span>Last update</span>
                  <strong>{formatTimestamp(node.updated_at_utc || node.created_at_utc)}</strong>
                </div>
                <div className="cp-definition-item">
                  <span>Rewards workflow</span>
                  <strong>Use Rewards + Stake</strong>
                </div>
              </div>
            </PanelCard>

            <PanelCard title="Selected peer" detail="The currently highlighted peer appears here.">
              <PeerDetailsDrawer peer={selectedPeer} mode="advanced" />
            </PanelCard>

            <PanelCard title="Recent node events">
              <div className="cp-panel-scroll cp-panel-scroll-tight">
                <ActionAuditStream entries={recentEvents} emptyMessage="No node-specific actions have been recorded yet." />
              </div>
            </PanelCard>
          </div>
        </div>
      ) : (
        <div className="cp-dashboard-grid">
          <div className="cp-dashboard-main">
            <PanelCard
              className="cp-hero-panel"
              eyebrow="Validator detail"
              title={node.display_label || roleTypeLabel(node.role_display_name)}
              detail={node.workspace_directory}
              action={<StatusPill tone={nodeRuntimeTone(nodeLive)} live>{nodeRuntimeLabel(nodeLive)}</StatusPill>}
            >
              <div className="cp-action-grid">
                <SNRGButton variant="green" size="sm" onClick={() => void handleAction('start')}>Start</SNRGButton>
                <SNRGButton variant="red" size="sm" disabled={!isRunning || actionBusy === 'stop'} onClick={() => void handleAction('stop')}>Stop</SNRGButton>
                <SNRGButton variant="orange" size="sm" onClick={() => void handleAction('restart')}>Restart</SNRGButton>
                <SNRGButton variant="blue" size="sm" onClick={() => void handleAction('rejoin')}>Bootstrap</SNRGButton>
                <SNRGButton variant="blue" size="sm" onClick={() => void handleAction('register')}>Re-register</SNRGButton>
                {isValidatorNode ? (
                  <>
                    <SNRGButton variant="purple" size="sm" disabled={actionBusy === 'sync-catch-up'} onClick={() => void handleAction('sync-catch-up')}>Sync Catch Up</SNRGButton>
                    <SNRGButton variant="blue" size="sm" disabled={actionBusy === 'activation-preflight'} onClick={() => void handleAction('activation-preflight')}>Activation Preflight</SNRGButton>
                    <SNRGButton variant="purple" size="sm" onClick={() => navigate('/validator')}>Validator Lifecycle</SNRGButton>
                    <SNRGButton variant="blue" size="sm" onClick={() => navigate('/rewards')}>Rewards Ledger</SNRGButton>
                  </>
                ) : null}
                <SNRGButton variant="blue" size="sm" onClick={() => openPath(node.workspace_directory)}>Open workspace</SNRGButton>
                <SNRGButton variant="blue" size="sm" onClick={() => openPath(`${node.workspace_directory}/logs`)}>Tail logs</SNRGButton>
              </div>
            </PanelCard>

            <ValidatorCatchUpCard
              node={node}
              nodeLive={nodeLive}
              liveStatus={liveStatus}
              preflight={activationReport}
              lastResult={catchUpResult}
              actionBusy={actionBusy}
              mode={viewMode}
              onRun={() => void handleAction('sync-catch-up')}
              onRepair={handleCatchUpRepair}
            />

            <PanelCard title="Rewards summary" detail="Use Rewards + Ledger for wallet, bonding, and payout operations." action={<StatusPill tone={validatorStatus === 'Active' ? 'good' : 'warn'}>{validatorStatus}</StatusPill>}>
              <div className="cp-metric-grid cp-metric-grid-dashboard">
                <MetricCard label="Wallet balance" value={`${formatSnrg(walletBalanceSnrg)} SNRG`} tone="cyan" icon="wallet" />
                <MetricCard label="Bonded amount" value={`${formatSnrg(stakedBalanceSnrg)} SNRG`} tone={Number(stakedBalanceSnrg) >= 50000 ? 'good' : 'warn'} icon="account_balance" />
              </div>
              <div className="cp-button-grid">
                <SNRGButton variant="blue" size="sm" onClick={() => navigate('/rewards')}>Open Rewards Ledger</SNRGButton>
              </div>
            </PanelCard>

            <div className="cp-metric-grid cp-metric-grid-dashboard cp-metric-grid-dense">
              <MetricCard label="Runtime" value={nodeRuntimeLabel(nodeLive)} detail={nodeLive?.local_rpc_status || 'Runtime status'} tone={nodeRuntimeTone(nodeLive)} icon="monitor_heart" />
              <MetricCard label="Block height" value={formatNumber(nodeBlockHeightValue(nodeLive, liveStatus))} detail={nodeBlockHeightDetail(nodeLive, liveStatus)} tone={nodeRuntimeTone(nodeLive)} icon="data_usage" />
              <MetricCard label="Peer visibility" value={formatNumber(localPeerInfo?.peerCount ?? nodeLive?.local_peer_count)} detail="Current session set" tone="cyan" icon="hub" />
              <MetricCard label="Action latency" value={actionAudit[0] ? 'Tracked' : 'Waiting'} detail={actionAudit[0]?.title || 'No action receipt yet'} tone={actionAudit[0]?.status || 'neutral'} icon="bolt" />
              <MetricCard label="Config drift" value={configPreview ? 'Inspectable' : 'Pending'} detail="Compare runtime config to the expected profile below." tone={configPreview ? 'warn' : 'neutral'} icon="difference" />
              <MetricCard label="Recent failures" value={formatNumber(recentEvents.filter((entry) => entry.status === 'bad').length)} detail="Recorded in action history" tone="bad" icon="warning" />
            </div>

            <MetricBars title="Dense node metrics" detail="Runtime, sync, peer visibility, readiness, and score." items={signalBars} />

            <PanelCard title="Workspace artifact panel" detail="Raw paths, config files, and workspace references.">
              <div className="cp-endpoint-list">
                <div className="cp-endpoint-item">
                  <div>
                    <strong>Workspace root</strong>
                    <span>{node.workspace_directory}</span>
                  </div>
                  <SNRGButton variant="blue" size="sm" onClick={() => openPath(node.workspace_directory)}>Open</SNRGButton>
                </div>
                {safeArray(node.config_paths).map((path) => (
                  <div key={path} className="cp-endpoint-item">
                    <div>
                      <strong>Config file</strong>
                      <span>{path}</span>
                    </div>
                    <SNRGButton variant="blue" size="sm" onClick={() => openPath(path)}>Open</SNRGButton>
                  </div>
                ))}
              </div>
            </PanelCard>

            <PanelCard title="Topology panel" detail="Peer globe, logical graph, and session table.">
              <PeerGlobe
                points={peerTopology.points}
                routes={peerTopology.routes}
                regionSummary={peerTopology.regionSummary}
                selectedPeerId={selectedPeerId}
                onSelectPeer={(peer) => setSelectedPeerId(peer.id)}
                mode="developer"
              />
              <PeerGlobeLegend />
              <div className="cp-split-grid">
                <PeerGraph peers={peerTopology.points} selectedPeerId={selectedPeerId} onSelectPeer={(peer) => setSelectedPeerId(peer.id)} />
                <PeerTable peers={peerTopology.points} selectedPeerId={selectedPeerId} onSelectPeer={(peer) => setSelectedPeerId(peer.id)} mode="developer" />
              </div>
            </PanelCard>

            <PanelCard title={readinessTitle}>
              <ActionAuditStream
                entries={readinessItems.map((item) => ({
                  id: item.id,
                  title: item.title,
                  detail: item.detail,
                  at: Date.now(),
                  status: 'info',
                  source: 'readiness',
                }))}
                emptyMessage="Readiness has zero checks in the latest snapshot."
              />
            </PanelCard>

            <ConfigDiffViewer
              leftTitle="Current config"
              rightTitle="Expected profile"
              leftText={configPreview}
              rightText={buildExpectedConfigProfile(node, nodeLive)}
            />
          </div>

          <div className="cp-dashboard-side">
            <JsonInspectorPanel title="Raw identity / metadata inspector" value={node} emptyMessage="Node metadata has not been reported yet." />
            <JsonInspectorPanel title="Runtime payload" value={nodeLive} emptyMessage="Runtime payload has not been reported yet." />

            <PanelCard title="Selected peer inspector" detail="Raw peer metadata and timing.">
              <PeerDetailsDrawer peer={selectedPeer} mode="developer" />
            </PanelCard>

            <PanelCard title="Recent payloads / action receipts" detail="The newest machine actions recorded for this node.">
              <div className="cp-panel-scroll cp-panel-scroll-tight">
                <ActionAuditStream entries={recentEvents} emptyMessage="No action receipts are available yet." />
              </div>
            </PanelCard>
          </div>
        </div>
      )}
    </div>
  );
}
