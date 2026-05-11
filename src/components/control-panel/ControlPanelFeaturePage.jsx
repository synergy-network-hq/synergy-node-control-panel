import { useMemo, useState } from 'react';
import { SNRGButton } from '../../styles/SNRGButton';
import { invoke } from '../../lib/desktopClient';
import { useControlPanel } from './ControlPanelProvider';
import {
  effectiveLocalChainHeight,
  formatNumber,
  formatPercent,
  formatRuntimeDuration,
  nodeRuntimeLabel,
  nodeRuntimeTone,
  nodeSyncPercent,
} from './controlPanelModel';
import { runNodeControlAction } from './controlPanelActions';
import {
  JarvisCard,
  MetricCard,
  PanelCard,
  SectionHeader,
  StatusPill,
} from './ControlPanelShared';
import ActionAuditStream from './ActionAuditStream';
import JsonInspectorPanel from './JsonInspectorPanel';
import { getFeatureScreenByKey } from './controlPanelFeatureScreens';
import {
  boostSyncAction,
  registerWithSeedsAction,
  rejoinNetworkAction,
  restartNodeAction,
} from './controlPanelActions';

function joinClasses(...values) {
  return values.filter(Boolean).join(' ');
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
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

const SYNC_READY_GAP = 32;

function buildLiveMetrics(selectedNodeLive, liveStatus, networkStats) {
  const syncPercent = nodeSyncPercent(selectedNodeLive, liveStatus);
  const localHeight = effectiveLocalChainHeight(selectedNodeLive);
  const networkHeight = selectedNodeLive?.best_network_height ?? liveStatus?.public_chain_height ?? networkStats.publicChainHeight;
  return [
    {
      label: 'Selected node',
      value: nodeRuntimeLabel(selectedNodeLive),
      detail: `${formatNumber(selectedNodeLive?.local_peer_count ?? networkStats.totalPeers)} visible peers`,
      tone: nodeRuntimeTone(selectedNodeLive),
      icon: 'dns',
    },
    {
      label: 'Sync readiness',
      value: `${Math.round(syncPercent)}%`,
      detail: `${formatNumber(selectedNodeLive?.sync_gap ?? 0)} block gap`,
      tone: syncPercent >= 99 ? 'good' : syncPercent >= 80 ? 'warn' : 'bad',
      icon: 'sync',
    },
    {
      label: 'Local height',
      value: formatNumber(localHeight),
      detail: `Network tip ${formatNumber(networkHeight)}`,
      tone: selectedNodeLive?.is_running ? 'cyan' : 'neutral',
      icon: 'layers',
    },
    {
      label: 'Local RPC',
      value: selectedNodeLive?.local_rpc_ready ? 'Ready' : selectedNodeLive?.is_running ? 'Starting' : 'Offline',
      detail: selectedNodeLive?.rpc_endpoint || liveStatus?.public_rpc_endpoint || 'RPC status unavailable',
      tone: selectedNodeLive?.local_rpc_ready ? 'good' : selectedNodeLive?.is_running ? 'warn' : 'bad',
      icon: 'terminal',
    },
    {
      label: 'Peers',
      value: formatNumber(selectedNodeLive?.local_peer_count ?? networkStats.totalPeers),
      detail: `${formatNumber(selectedNodeLive?.connected_validator_count ?? 0)} validator peer(s) visible`,
      tone: Number(selectedNodeLive?.local_peer_count ?? networkStats.totalPeers) > 0 ? 'good' : 'warn',
      icon: 'lan',
    },
    {
      label: 'Runtime',
      value: selectedNodeLive?.is_running ? 'Running' : 'Stopped',
      detail: formatRuntimeDuration(selectedNodeLive?.process_uptime_secs),
      tone: selectedNodeLive?.is_running ? 'good' : 'bad',
      icon: 'monitor_heart',
    },
  ];
}

function buildLiveQuestions(selectedNodeLive, liveStatus, networkStats) {
  const syncGap = Number(selectedNodeLive?.sync_gap);
  const syncPercent = nodeSyncPercent(selectedNodeLive, liveStatus);
  const rpcReady = selectedNodeLive?.local_rpc_ready === true;
  const running = selectedNodeLive?.is_running === true;
  const safe = running && rpcReady && (!Number.isFinite(syncGap) || syncGap <= SYNC_READY_GAP);

  return [
    {
      label: 'Am I safe?',
      value: safe ? 'Safe to operate' : running ? 'Wait for sync' : 'Runtime stopped',
      tone: safe ? 'good' : running ? 'warn' : 'bad',
      icon: safe ? 'health_and_safety' : 'warning',
    },
    {
      label: 'Am I participating correctly?',
      value: running && syncPercent >= 99.5 ? 'At chain head' : `${formatPercent(syncPercent, 0)} synced`,
      tone: running && syncPercent >= 99.5 ? 'good' : 'warn',
      icon: 'how_to_reg',
    },
    {
      label: 'What should I do next?',
      value: running ? 'Watch live state' : 'Start chain sync',
      tone: running ? 'cyan' : 'warn',
      icon: running ? 'visibility' : 'play_arrow',
    },
  ];
}

function buildLiveChecklist(selectedNodeLive) {
  const syncGap = Number(selectedNodeLive?.sync_gap);
  return [
    {
      label: 'Workspace exists',
      detail: selectedNodeLive?.workspace_ready ? 'Node workspace is present on this machine.' : 'Workspace has not been reported by the runtime service.',
      done: selectedNodeLive?.workspace_ready === true,
      tone: selectedNodeLive?.workspace_ready ? 'good' : 'bad',
    },
    {
      label: 'Configuration file present',
      detail: selectedNodeLive?.config_ready ? 'node.toml is available for the selected node.' : 'The selected node has no readable node.toml yet.',
      done: selectedNodeLive?.config_ready === true,
      tone: selectedNodeLive?.config_ready ? 'good' : 'bad',
    },
    {
      label: 'Wallet and identity present',
      detail: selectedNodeLive?.wallet_ready ? 'Local key material exists in the workspace.' : 'Wallet material was not reported for this node.',
      done: selectedNodeLive?.wallet_ready === true,
      tone: selectedNodeLive?.wallet_ready ? 'good' : 'bad',
    },
    {
      label: 'Runtime responding',
      detail: selectedNodeLive?.local_rpc_status || 'No runtime status is available yet.',
      done: selectedNodeLive?.is_running === true && selectedNodeLive?.local_rpc_ready !== false,
      tone: selectedNodeLive?.local_rpc_ready ? 'good' : selectedNodeLive?.is_running ? 'warn' : 'bad',
    },
    {
      label: 'Chain caught up',
      detail: Number.isFinite(syncGap) ? `${formatNumber(syncGap)} block gap to best visible network height.` : 'Waiting for local and network chain height data.',
      done: Number.isFinite(syncGap) && syncGap <= SYNC_READY_GAP,
      tone: Number.isFinite(syncGap) && syncGap <= SYNC_READY_GAP ? 'good' : 'warn',
    },
  ];
}

function buildLiveTableRows(nodes, liveStatus) {
  const liveNodes = Array.isArray(liveStatus?.nodes) ? liveStatus.nodes : [];
  if (!liveNodes.length) {
    return [];
  }

  return liveNodes.map((entry) => {
    const node = nodes.find((candidate) => candidate.id === entry.node_id);
    const localHeight = effectiveLocalChainHeight(entry);
    return [
      node?.display_label || entry.node_id || 'Node',
      nodeRuntimeLabel(entry),
      formatNumber(localHeight),
      Number.isFinite(Number(entry?.sync_gap)) ? `${formatNumber(entry.sync_gap)} blocks` : 'Waiting',
      formatNumber(entry?.local_peer_count ?? 0),
    ];
  });
}

function FeatureQuestionStrip({ questions }) {
  return (
    <div className="cp-feature-question-strip">
      {questions.map((item) => (
        <article key={item.label} className={`cp-feature-question tone-${item.tone || 'neutral'}`}>
          <span className="material-icons" aria-hidden="true">{item.icon}</span>
          <div>
            <small>{item.label}</small>
            <strong>{item.value}</strong>
          </div>
        </article>
      ))}
    </div>
  );
}

function FeatureChecklist({ title, items }) {
  return (
    <PanelCard title={title} detail="Safety and readiness checks for this workspace.">
      <div className="cp-feature-checklist">
        {items.map((item) => (
          <article key={item.label} className={`cp-feature-check tone-${item.tone || 'neutral'} ${item.done ? 'is-done' : ''}`}>
            <span className="material-icons" aria-hidden="true">{item.done ? 'check_circle' : 'radio_button_unchecked'}</span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </PanelCard>
  );
}

function FeatureTable({ title, columns, rows }) {
  return (
    <PanelCard title={title} detail="Operational rows are structured for scan-first review.">
      <div className="cp-feature-table">
        <div className="cp-feature-table-row cp-feature-table-head">
          {columns.map((column) => <span key={column}>{column}</span>)}
        </div>
        {rows.length ? rows.map((row) => (
          <div key={row.join('-')} className="cp-feature-table-row">
            {row.map((cell, index) => (
              <span key={`${cell}-${index}`} className={index === 0 ? 'is-primary' : ''}>{cell}</span>
            ))}
          </div>
        )) : (
          <div className="cp-feature-table-row">
            <span className="is-primary">No live runtime rows available</span>
            <span>Start chain sync</span>
            <span>Waiting</span>
            <span>Waiting</span>
            <span>0</span>
          </div>
        )}
      </div>
    </PanelCard>
  );
}

function DangerWorkflow({ danger, onOpen }) {
  const [confirmText, setConfirmText] = useState('');
  const armed = confirmText.trim().toUpperCase() === 'REVIEW';

  if (!danger) {
    return null;
  }

  return (
    <PanelCard className="cp-feature-danger" title={danger.title} detail={danger.copy}>
      <div className="cp-feature-danger-body">
        <label className="cp-form-field">
          <span>Type REVIEW to open the guarded workflow</span>
          <input
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder="REVIEW"
            autoComplete="off"
          />
        </label>
        <SNRGButton
          variant="red"
          size="sm"
          disabled={!armed}
          onClick={() => {
            onOpen();
            setConfirmText('');
          }}
        >
          {danger.confirmLabel}
        </SNRGButton>
      </div>
    </PanelCard>
  );
}

function Dot({ x, y, tone = 'cyan', shape = 'circle' }) {
  if (shape === 'triangle') {
    return <polygon points={`${x},${y - 5} ${x + 6},${y + 6} ${x - 6},${y + 6}`} className={`tone-${tone}`} />;
  }
  if (shape === 'diamond') {
    return <rect x={x - 5} y={y - 5} width="10" height="10" transform={`rotate(45 ${x} ${y})`} className={`tone-${tone}`} />;
  }
  return <circle cx={x} cy={y} r="5.5" className={`tone-${tone}`} />;
}

function DagVisual() {
  const nodes = [
    [8, 55, 'cyan', 'triangle'],
    [22, 38, 'cyan', 'diamond'],
    [22, 72, 'cyan', 'diamond'],
    [36, 25, 'cyan', 'diamond'],
    [36, 55, 'cyan', 'circle'],
    [36, 84, 'cyan', 'diamond'],
    [52, 36, 'cyan', 'diamond'],
    [52, 62, 'cyan', 'diamond'],
    [66, 45, 'warn', 'circle'],
    [66, 72, 'warn', 'diamond'],
    [80, 24, 'bad', 'circle'],
    [80, 50, 'warn', 'diamond'],
    [80, 76, 'bad', 'triangle'],
    [94, 55, 'bad', 'triangle'],
  ];
  const edges = [
    [8, 55, 22, 38], [8, 55, 22, 72], [22, 38, 36, 25], [22, 38, 36, 55],
    [22, 72, 36, 55], [22, 72, 36, 84], [36, 25, 52, 36], [36, 55, 52, 36],
    [36, 55, 52, 62], [36, 84, 52, 62], [52, 36, 66, 45], [52, 62, 66, 45],
    [52, 62, 66, 72], [66, 45, 80, 24], [66, 45, 80, 50], [66, 72, 80, 50],
    [66, 72, 80, 76], [80, 24, 94, 55], [80, 50, 94, 55], [80, 76, 94, 55],
  ];

  return (
    <div className="cp-feature-visual cp-feature-visual-dag">
      <svg viewBox="0 0 100 100" role="img" aria-label="DAG topology view">
        {edges.map((edge) => (
          <line key={edge.join('-')} x1={edge[0]} y1={edge[1]} x2={edge[2]} y2={edge[3]} />
        ))}
        {nodes.map((node) => (
          <Dot key={node.join('-')} x={node[0]} y={node[1]} tone={node[2]} shape={node[3]} />
        ))}
      </svg>
      <div className="cp-feature-legend">
        <span><i className="tone-cyan"></i>Finalized</span>
        <span><i className="tone-warn"></i>Pending</span>
        <span><i className="tone-bad"></i>Conflicting</span>
      </div>
    </div>
  );
}

function ConsensusVisual() {
  return (
    <div className="cp-feature-visual cp-feature-consensus">
      <div className="cp-feature-finality-line">
        {['Block', 'Vote', 'QC', 'Checkpoint', 'DAG Anchor', 'Finalized'].map((item, index) => (
          <div key={item} className={index < 5 ? 'is-complete' : ''}>
            <span>{index + 1}</span>
            <strong>{item}</strong>
          </div>
        ))}
      </div>
      <DagVisual />
    </div>
  );
}

function StorageVisual() {
  return (
    <div className="cp-feature-visual cp-feature-storage">
      <svg viewBox="0 0 360 170" role="img" aria-label="Storage growth forecast">
        <polyline points="12,145 70,124 128,100 184,72 240,45 305,28 348,18" />
        <line x1="12" y1="145" x2="348" y2="145" />
        <line x1="240" y1="22" x2="240" y2="145" className="warn-line" />
      </svg>
      <div className="cp-feature-donut" style={{ '--value': '76%' }}>
        <strong>76%</strong>
        <span>Projected capacity</span>
      </div>
    </div>
  );
}

function AlertsVisual() {
  return (
    <div className="cp-feature-visual cp-feature-alerts">
      {[
        ['Critical', 78, 'bad'],
        ['Warning', 56, 'warn'],
        ['Info', 34, 'cyan'],
        ['Recovered', 82, 'good'],
      ].map(([label, height, tone]) => (
        <div key={label} className="cp-feature-alert-bar">
          <span style={{ height: `${height}%` }} className={`tone-${tone}`}></span>
          <strong>{label}</strong>
        </div>
      ))}
    </div>
  );
}

function LifecycleVisual() {
  return (
    <div className="cp-feature-visual cp-feature-lifecycle">
      {['Registration', 'Activation', 'Performance', 'Exit'].map((step, index) => (
        <div key={step} className={index < 2 ? 'is-complete' : index === 2 ? 'is-active' : ''}>
          <span>{index + 1}</span>
          <strong>{step}</strong>
        </div>
      ))}
    </div>
  );
}

function GenericVisual({ type }) {
  if (type === 'dag') return <DagVisual />;
  if (type === 'consensus') return <ConsensusVisual />;
  if (type === 'storage') return <StorageVisual />;
  if (type === 'alerts') return <AlertsVisual />;
  if (type === 'lifecycle') return <LifecycleVisual />;

  return (
    <div className={joinClasses('cp-feature-visual', `cp-feature-visual-${type}`)}>
      <div className="cp-feature-signal-orbit">
        <span></span>
        <span></span>
        <span></span>
        <i className="material-icons" aria-hidden="true">
          {type === 'security' ? 'shield' : type === 'rpc' ? 'terminal' : type === 'fleet' ? 'lan' : type === 'governance' ? 'how_to_vote' : 'hub'}
        </i>
      </div>
      <div className="cp-feature-mini-grid">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <span key={index} className={index % 3 === 0 ? 'tone-purple' : index % 2 === 0 ? 'tone-good' : 'tone-cyan'}></span>
        ))}
      </div>
    </div>
  );
}

function LiveRuntimeVisual({ feature, selectedNodeLive, liveStatus, networkStats }) {
  const syncPercent = nodeSyncPercent(selectedNodeLive, liveStatus);
  const localHeight = effectiveLocalChainHeight(selectedNodeLive);
  const networkHeight = selectedNodeLive?.best_network_height ?? liveStatus?.public_chain_height ?? networkStats.publicChainHeight;
  const isProtocolSpecific = ['dag', 'consensus', 'transactions', 'governance'].includes(feature.key);

  return (
    <div className="cp-feature-visual cp-feature-live-runtime">
      <div className="cp-feature-live-chain">
        <span style={{ width: `${Math.max(2, Math.min(100, syncPercent))}%` }}></span>
      </div>
      <div className="cp-feature-live-steps">
        <article className={selectedNodeLive?.workspace_ready ? 'is-complete' : ''}>
          <span className="material-icons" aria-hidden="true">folder_open</span>
          <strong>Workspace</strong>
          <small>{selectedNodeLive?.workspace_ready ? 'Ready' : 'Missing'}</small>
        </article>
        <article className={selectedNodeLive?.is_running ? 'is-complete' : ''}>
          <span className="material-icons" aria-hidden="true">play_circle</span>
          <strong>Runtime</strong>
          <small>{selectedNodeLive?.is_running ? 'Running' : 'Stopped'}</small>
        </article>
        <article className={selectedNodeLive?.local_rpc_ready ? 'is-complete' : ''}>
          <span className="material-icons" aria-hidden="true">terminal</span>
          <strong>RPC</strong>
          <small>{selectedNodeLive?.local_rpc_ready ? 'Ready' : 'Waiting'}</small>
        </article>
        <article className={syncPercent >= 99.5 ? 'is-complete' : ''}>
          <span className="material-icons" aria-hidden="true">sync</span>
          <strong>Chain</strong>
          <small>{formatPercent(syncPercent, 0)}</small>
        </article>
      </div>
      <div className="cp-feature-live-heights">
        <span>Local {formatNumber(localHeight)}</span>
        <span>Network {formatNumber(networkHeight)}</span>
      </div>
      {isProtocolSpecific ? (
        <p className="cp-feature-live-limited">
          The runtime is not exposing dedicated {feature.label} telemetry yet, so this screen shows live node, RPC, peer, and chain-sync data instead of fabricated protocol metrics.
        </p>
      ) : null}
    </div>
  );
}

function buildRuntimeActionsForFeature(featureKey, selectedNodeLive) {
  const startAction = {
    id: 'start-chain-sync',
    label: selectedNodeLive?.is_running ? 'Resume Chain Sync' : 'Start Chain Sync',
    variant: 'purple',
  };
  const common = {
    refresh: { id: 'refresh-live-state', label: 'Refresh Live State', variant: 'blue', requiresNode: false },
    readiness: { id: 'run-readiness-check', label: 'Run Readiness Check', variant: 'lime' },
    logs: { id: 'inspect-recent-logs', label: 'Inspect Recent Logs', variant: 'blue' },
    stop: { id: 'stop-node', label: 'Stop Node', variant: 'red' },
    restart: { id: 'restart-node', label: 'Restart Runtime', variant: 'purple' },
    boost: { id: 'boost-sync', label: 'Boost Sync', variant: 'lime' },
    register: { id: 'register-seeds', label: 'Re-register Seeds', variant: 'blue' },
    rejoin: { id: 'rejoin-network', label: 'Rejoin Network', variant: 'purple' },
    preflight: { id: 'activation-preflight', label: 'Activation Preflight', variant: 'lime' },
    stake: { id: 'stake-validator', label: 'Stake Validator', variant: 'purple' },
    activate: { id: 'activate-validator', label: 'Activate Validator', variant: 'blue' },
  };

  const actionMap = {
    alerts: [common.refresh, common.readiness, common.logs],
    validator: [common.preflight, common.stake, common.activate, common.register],
    security: [common.readiness, common.logs, common.refresh],
    identity: [common.readiness, common.preflight, common.logs],
    consensus: [common.refresh, common.readiness, common.register, startAction],
    dag: [common.refresh, common.logs, common.boost],
    transactions: [common.logs, common.readiness, common.refresh],
    governance: [common.refresh, common.preflight, common.logs],
    storage: [common.readiness, common.logs, common.refresh],
    api: [common.refresh, common.readiness, common.logs],
    maintenance: [common.restart, common.rejoin, common.boost, common.stop],
    fleet: [common.refresh, common.rejoin, common.register],
    compliance: [common.readiness, common.logs, common.refresh],
  };

  return actionMap[featureKey] || [common.refresh, startAction, common.readiness, common.stop];
}

export default function ControlPanelFeaturePage({ screenKey }) {
  const feature = getFeatureScreenByKey(screenKey);
  const {
    actionAudit,
    liveStatus,
    network,
    networkStats,
    nodes,
    recordAction,
    refresh,
    selectedNode,
    selectedNodeLive,
    viewMode,
  } = useControlPanel();
  const [notice, setNotice] = useState('');
  const [localView, setLocalView] = useState('local');

  const liveMetrics = useMemo(
    () => (feature ? buildLiveMetrics(selectedNodeLive, liveStatus, networkStats) : []),
    [feature, liveStatus, networkStats, selectedNodeLive],
  );
  const liveQuestions = useMemo(
    () => buildLiveQuestions(selectedNodeLive, liveStatus, networkStats),
    [liveStatus, networkStats, selectedNodeLive],
  );
  const liveChecklist = useMemo(
    () => buildLiveChecklist(selectedNodeLive),
    [selectedNodeLive],
  );
  const liveRows = useMemo(
    () => buildLiveTableRows(nodes, liveStatus),
    [liveStatus, nodes],
  );

  if (!feature) {
    return null;
  }

  const handleAction = async (action) => {
    if (!selectedNode && action.requiresNode !== false) {
      setNotice('No node is selected.');
      return;
    }

    try {
      let detail = '';
      if (action.id === 'refresh-live-state') {
        await refresh({ silent: false });
        detail = 'Live state refreshed from the control service.';
      } else if (action.id === 'start-chain-sync') {
        const response = await runNodeControlAction({ node: selectedNode, network, action: 'start' });
        detail = response?.message || 'Node start requested.';
        await refresh({ silent: true });
      } else if (action.id === 'stop-node') {
        const response = await runNodeControlAction({ node: selectedNode, network, action: 'stop' });
        detail = response?.message || 'Node stop requested.';
        await refresh({ silent: true });
      } else if (action.id === 'restart-node') {
        detail = await restartNodeAction({ node: selectedNode, network });
        await refresh({ silent: true });
      } else if (action.id === 'boost-sync') {
        detail = await boostSyncAction(selectedNode.id);
        await refresh({ silent: true });
      } else if (action.id === 'register-seeds') {
        detail = await registerWithSeedsAction(selectedNode.id);
        await refresh({ silent: true });
      } else if (action.id === 'rejoin-network') {
        detail = await rejoinNetworkAction({ node: selectedNode, network });
        await refresh({ silent: true });
      } else if (action.id === 'run-readiness-check') {
        const report = await invoke('testbeta_get_node_readiness', { nodeId: selectedNode.id });
        detail = `Readiness ${report?.overall_status || 'unknown'}: ${formatNumber(report?.ready_count)} of ${formatNumber(report?.total_count)} checks passing.`;
      } else if (action.id === 'inspect-recent-logs') {
        const bundle = await invoke('testbeta_get_node_logs', { nodeId: selectedNode.id, lines: 40 });
        const entries = Array.isArray(bundle?.entries) ? bundle.entries : [];
        const latest = entries[entries.length - 1];
        detail = entries.length
          ? `Loaded ${formatNumber(entries.length)} log entries. Latest: ${latest?.level || 'INFO'} ${latest?.message || latest?.raw || 'runtime event'}.`
          : 'No recent log entries were returned for the selected node.';
      } else if (action.id === 'activation-preflight') {
        const result = await invoke('testbeta_get_validator_activation_preflight', { nodeId: selectedNode.id });
        detail = activationPreflightMessage(result);
      } else if (action.id === 'stake-validator') {
        if (selectedNode?.role_id !== 'validator') {
          throw new Error('Stake Validator is only available on validator nodes.');
        }
        const result = await invoke('testbeta_stake_validator', { input: { nodeId: selectedNode.id } });
        detail = result?.message || `Validator stake submitted${result?.tx_hash ? `: ${result.tx_hash}` : ''}.`;
      } else if (action.id === 'activate-validator') {
        if (selectedNode?.role_id !== 'validator') {
          throw new Error('Activate Validator is only available on validator nodes.');
        }
        const result = await invoke('testbeta_activate_validator', {
          input: {
            nodeId: selectedNode.id,
            displayName: selectedNode.display_label || selectedNode.role_display_name || 'Validator',
          },
        });
        detail = result?.message || `Validator activation submitted${result?.tx_hash ? `: ${result.tx_hash}` : ''}.`;
      } else {
        throw new Error(`${action.label} is not wired to a runtime command.`);
      }

      setNotice(detail);
      recordAction({
        title: action.label,
        detail,
        status: action.id.startsWith('stop') ? 'warn' : 'info',
        source: feature.key,
        command: action.id,
        payload: {
          screen: feature.key,
          nodeId: selectedNode?.id || null,
          viewMode,
        },
      });
    } catch (error) {
      const detail = String(error);
      setNotice(detail);
      recordAction({
        title: `${action.label} failed`,
        detail,
        status: 'error',
        source: feature.key,
        command: action.id,
        payload: {
          screen: feature.key,
          nodeId: selectedNode?.id || null,
          viewMode,
        },
      });
    }
  };

  const modeCopy = feature.modeCopy?.[viewMode] || feature.description;
  const runtimeActions = buildRuntimeActionsForFeature(feature.key, selectedNodeLive);

  return (
    <div className="cp-page-stack cp-feature-page">
      <SectionHeader
        eyebrow={feature.eyebrow}
        title={feature.title}
        copy={modeCopy}
        actions={(
          <>
            <StatusPill tone={feature.tone}>{feature.label}</StatusPill>
            {feature.key === 'dag' ? (
              <div className="cp-feature-toggle">
                {['local', 'network'].map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={localView === option ? 'is-active' : ''}
                    onClick={() => setLocalView(option)}
                  >
                    {option === 'local' ? 'Local View' : 'Network View'}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      />

      {notice ? <div className="cp-inline-notice">{notice}</div> : null}

      <FeatureQuestionStrip questions={liveQuestions} />

      <div className="cp-dashboard-grid cp-feature-grid">
        <div className="cp-dashboard-main">
          <PanelCard
            className="cp-feature-hero"
            eyebrow={selectedNode?.display_label || 'Selected node'}
            title={feature.description}
            detail={`Current mode: ${viewMode}. Runtime status: ${nodeRuntimeLabel(selectedNodeLive)}.`}
            action={<StatusPill tone={nodeRuntimeTone(selectedNodeLive)} live>{nodeRuntimeLabel(selectedNodeLive)}</StatusPill>}
          >
            <LiveRuntimeVisual
              feature={feature}
              selectedNodeLive={selectedNodeLive}
              liveStatus={liveStatus}
              networkStats={networkStats}
            />
          </PanelCard>

          <div className="cp-metric-grid cp-metric-grid-dashboard">
            {liveMetrics.map((metric) => (
              <MetricCard key={`${feature.key}-${metric.label}`} {...metric} />
            ))}
          </div>

          <div className="cp-split-grid">
            <FeatureChecklist title="Live readiness checklist" items={liveChecklist} />
            <PanelCard title={`${feature.label} action center`} detail="These controls call real control-service commands or return a clear runtime error.">
              <div className="cp-feature-action-grid">
                {runtimeActions.map((action) => (
                  <SNRGButton
                    key={action.id}
                    variant={action.variant}
                    size="sm"
                    onClick={() => void handleAction(action)}
                    disabled={!selectedNode && action.requiresNode !== false}
                  >
                    {action.label}
                  </SNRGButton>
                ))}
              </div>
              <div className="cp-feature-runtime-note">
                <span className="material-icons" aria-hidden="true">info</span>
                <p>Unavailable protocol-specific commands are shown as unavailable instead of returning dummy success.</p>
              </div>
            </PanelCard>
          </div>

          <FeatureTable
            title="Live runtime rows"
            columns={['Node', 'Runtime', 'Local height', 'Gap', 'Peers']}
            rows={liveRows}
          />

          <DangerWorkflow
            danger={feature.danger}
            onOpen={() => handleAction({ id: `${feature.key}-danger-review`, label: feature.danger.confirmLabel, variant: 'red' })}
          />
        </div>

        <div className="cp-dashboard-side">
          <JarvisCard
            mode={viewMode}
            title="Jarvis guidance"
            message={feature.jarvis}
            chips={[feature.label, selectedNode?.display_label || 'No node selected', nodeRuntimeLabel(selectedNodeLive)]}
          />

          <PanelCard title="Coverage map" detail="Spec areas represented by this screen.">
            <div className="cp-feature-coverage-list">
              {(feature.coverage || [
                feature.title,
                'Safety checks',
                'Operator action center',
                'Audit trail',
              ]).map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </PanelCard>

          <PanelCard title="Recent action audit" detail="Privileged and guided actions recorded in this session.">
            <ActionAuditStream entries={actionAudit.slice(0, 5)} emptyMessage="No actions recorded for this session yet." />
          </PanelCard>

          {viewMode === 'developer' ? (
            <JsonInspectorPanel
              title="Screen model"
              value={{
                screen: feature.key,
                selectedNodeId: selectedNode?.id || null,
                localView,
                metrics: liveMetrics,
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
