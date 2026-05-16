import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SNRGButton } from '../../styles/SNRGButton';
import { invoke } from '../../lib/desktopClient';
import { useControlPanel } from './ControlPanelProvider';
import {
  effectiveLocalChainHeight,
  formatNumber,
  formatRuntimeDuration,
  nodeRuntimeLabel,
  nodeRuntimeTone,
} from './controlPanelModel';
import {
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
  runNodeControlAction,
  syncCatchUpRejoinAction,
} from './controlPanelActions';

const SYNC_READY_GAP = 32;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function readObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function formatBytes(bytes) {
  const numeric = Number(bytes);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(numeric) / Math.log(1024)), units.length - 1);
  return `${(numeric / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function metric(label, value, detail, tone = 'neutral', icon = 'analytics', numericValue = null) {
  return { label, value, detail, tone, icon, numericValue };
}

function probeStatusCounts(snapshot) {
  const probes = safeArray(snapshot?.rpc?.probes);
  const passing = probes.filter((probe) => probe.status === 'pass').length;
  return { passing, total: probes.length, failing: probes.length - passing };
}

function firstProbe(snapshot, method) {
  return safeArray(snapshot?.rpc?.probes).find((probe) => probe.method === method) || null;
}

function probeResult(snapshot, method) {
  return readObject(firstProbe(snapshot, method)?.result);
}

function arrayProbeResult(snapshot, method) {
  const result = firstProbe(snapshot, method)?.result;
  return safeArray(result);
}

function readinessCounts(snapshot) {
  const readiness = readObject(snapshot?.readiness);
  const total = Number(readiness.total_count ?? readiness.totalCount ?? 0);
  const ready = Number(readiness.ready_count ?? readiness.readyCount ?? 0);
  return { ready, total, blocked: Math.max(0, total - ready) };
}

function logSummary(snapshot) {
  return readObject(snapshot?.logs?.summary);
}

function chainBlocks(snapshot) {
  return safeArray(snapshot?.chain?.blocks);
}

function graphSnapshot(snapshot) {
  const dagGraph = readObject(snapshot?.dag?.graph);
  if (safeArray(dagGraph.nodes).length || safeArray(dagGraph.edges).length) {
    return dagGraph;
  }
  return readObject(snapshot?.chain?.graph);
}

function mempoolTransactions(snapshot) {
  const structured = safeArray(snapshot?.mempool?.transactions);
  return structured.length ? structured : arrayProbeResult(snapshot, 'synergy_getTransactionPool');
}

function pendingTransactions(snapshot) {
  const structured = mempoolTransactions(snapshot);
  return structured.length ? structured : arrayProbeResult(snapshot, 'synergy_getPendingTransactions');
}

function nodeAddress(snapshot) {
  return snapshot?.node?.node_address || snapshot?.node?.nodeAddress || '';
}

function selectedNodeLabel(snapshot, selectedNode) {
  return selectedNode?.display_label
    || selectedNode?.role_display_name
    || snapshot?.node?.display_label
    || snapshot?.node?.id
    || 'Node';
}

function buildMetrics(featureKey, snapshot, selectedNodeLive, networkStats) {
  const probes = probeStatusCounts(snapshot);
  const readiness = readinessCounts(snapshot);
  const logs = logSummary(snapshot);
  const blocks = chainBlocks(snapshot);
  const latestBlock = blocks[0] || {};
  const storage = readObject(snapshot?.storage);
  const graph = graphSnapshot(snapshot);
  const validation = probeResult(snapshot, 'synergy_getBlockValidationStatus');
  const validator = probeResult(snapshot, 'synergy_getValidator');
  const validatorPerformance = probeResult(snapshot, 'synergy_getValidatorPerformance');
  const slashing = probeResult(snapshot, 'synergy_getValidatorSlashingHistory');
  const pool = mempoolTransactions(snapshot);
  const pendingPool = pendingTransactions(snapshot);
  const mempoolStats = readObject(snapshot?.mempool?.stats);
  const dag = readObject(snapshot?.dag);
  const processCount = safeArray(snapshot?.diagnostics?.processes).length;

  const common = [
    metric('Runtime', nodeRuntimeLabel(selectedNodeLive), selectedNodeLive?.local_rpc_status || 'Runtime state read from control service', nodeRuntimeTone(selectedNodeLive), 'monitor_heart'),
    metric('Local height', formatNumber(effectiveLocalChainHeight(selectedNodeLive)), `Network tip ${formatNumber(selectedNodeLive?.best_network_height ?? networkStats.publicChainHeight ?? 0)}`, selectedNodeLive?.is_running ? 'cyan' : 'warn', 'layers'),
    metric('Readiness', `${formatNumber(readiness.ready)}/${formatNumber(readiness.total)}`, `${formatNumber(readiness.blocked)} checks need action`, readiness.blocked ? 'warn' : 'good', 'fact_check', readiness.ready),
    metric('RPC probes', `${formatNumber(probes.passing)}/${formatNumber(probes.total)}`, `${formatNumber(probes.failing)} probe failures`, probes.failing ? 'warn' : 'good', 'terminal', probes.passing),
  ];

  if (featureKey === 'alerts') {
    return [
      metric('Critical logs', formatNumber(logs.error_count || 0), 'ERROR entries from local logs', logs.error_count ? 'bad' : 'good', 'report', logs.error_count || 0),
      metric('Warnings', formatNumber(logs.warn_count || 0), 'WARN entries from local logs', logs.warn_count ? 'warn' : 'good', 'warning', logs.warn_count || 0),
      metric('Blocked checks', formatNumber(readiness.blocked), 'Failed readiness checks', readiness.blocked ? 'bad' : 'good', 'rule', readiness.blocked),
      metric('RPC failures', formatNumber(probes.failing), 'Failed live probes', probes.failing ? 'warn' : 'good', 'lan', probes.failing),
    ];
  }

  if (featureKey === 'validator') {
    return [
      metric('Validator status', validator.status || 'Not active', `Address ${nodeAddress(snapshot)}`, String(validator.status || '').toLowerCase() === 'active' ? 'good' : 'warn', 'verified_user'),
      metric('Produced blocks', formatNumber(validator.total_blocks_produced ?? validator.totalBlocksProduced ?? validatorPerformance.totalBlocksProduced ?? 0), 'Reported by validator RPC', 'cyan', 'inventory'),
      metric('Missed duties', formatNumber(validatorPerformance.missedAttestations ?? 0), 'Reported by performance RPC', Number(validatorPerformance.missedAttestations || 0) ? 'warn' : 'good', 'event_busy'),
      metric('Synergy score', formatNumber(validator.synergy_score ?? validatorPerformance.synergyScore ?? 0), 'Validator weighting score', 'purple', 'auto_graph'),
    ];
  }

  if (featureKey === 'security' || featureKey === 'identity') {
    return [
      metric('Identity address', nodeAddress(snapshot) ? 'Present' : 'Missing', nodeAddress(snapshot), nodeAddress(snapshot) ? 'good' : 'bad', 'badge'),
      metric('Key files', formatNumber(readObject(safeArray(snapshot?.storage?.sections).find((item) => item.label === 'keys'))?.files || 0), 'Files in workspace keys folder', 'purple', 'key'),
      metric('Slashing events', formatNumber(safeArray(slashing.slashingEvents).length), 'Reported by slashing RPC', safeArray(slashing.slashingEvents).length ? 'bad' : 'good', 'gpp_maybe'),
      metric('Readiness', `${formatNumber(readiness.ready)}/${formatNumber(readiness.total)}`, 'Security-relevant readiness checks', readiness.blocked ? 'warn' : 'good', 'shield'),
    ];
  }

  if (featureKey === 'consensus') {
    return [
      metric('Latest block', formatNumber(latestBlock.number ?? latestBlock.block_index ?? latestBlock.blockNumber ?? 0), 'Latest local block returned by RPC', 'cyan', 'account_tree'),
      metric('Active validators', formatNumber(validation.active_validators ?? 0), `${formatNumber(validation.total_validators ?? 0)} total validators in validation RPC`, 'purple', 'groups'),
      metric('Sync gap', formatNumber(selectedNodeLive?.sync_gap ?? 0), 'Blocks behind visible network tip', Number(selectedNodeLive?.sync_gap || 0) > SYNC_READY_GAP ? 'warn' : 'good', 'sync'),
      metric('Recent blocks', formatNumber(blocks.length), 'Block range returned by local RPC', blocks.length ? 'good' : 'warn', 'view_timeline'),
    ];
  }

  if (featureKey === 'dag') {
    const certificateValue = dag.certificates;
    const certificateCount = Array.isArray(certificateValue)
      ? certificateValue.length
      : safeArray(readObject(certificateValue).certificates).length;
    const dagStatus = dag.available ? 'Dedicated DAG' : 'PoSy fallback';
    return [
      metric('DAG source', dagStatus, dag.detail || 'DAG snapshot source', dag.available ? 'good' : 'warn', 'schema'),
      metric('Vertices', formatNumber(safeArray(dag.vertices).length || safeArray(graph.nodes).length), 'Dedicated DAG vertices or finalized evidence nodes', 'cyan', 'account_tree'),
      metric('Certificates', formatNumber(certificateCount), 'Availability/certification evidence returned by node RPC', certificateCount ? 'good' : 'warn', 'verified'),
      metric('Parent links', formatNumber(safeArray(graph.edges).length), 'Graph links returned by DAG or PoSy evidence', 'purple', 'share'),
    ];
  }

  if (featureKey === 'transactions') {
    return [
      metric('Pending pool', formatNumber(pool.length || pendingPool.length), `Selected node mempool via ${snapshot?.mempool?.sourceMethod || 'RPC probe'}`, pool.length || pendingPool.length ? 'warn' : 'good', 'pending_actions'),
      metric('Latest block txs', formatNumber(safeArray(latestBlock.transactions).length), 'Transactions in latest local block', 'cyan', 'receipt_long'),
      metric('Avg gas price', formatNumber(mempoolStats.avgGasPriceNwei || 0), 'Average nWei gas price across pending transactions', 'purple', 'payments'),
      metric('RPC probes', `${formatNumber(probes.passing)}/${formatNumber(probes.total)}`, 'Transaction RPC health', probes.failing ? 'warn' : 'good', 'terminal'),
    ];
  }

  if (featureKey === 'storage') {
    const disk = readObject(storage.disk);
    const free = disk.availableBytes;
    return [
      metric('Workspace size', formatBytes(storage.workspaceBytes), `${formatNumber(storage.workspaceFiles || 0)} files`, 'blue', 'folder_open'),
      metric('Log data', formatBytes(readObject(safeArray(storage.sections).find((item) => item.label === 'logs'))?.bytes || 0), 'Local log footprint', 'cyan', 'receipt_long'),
      metric('Chain data', formatBytes(readObject(safeArray(storage.sections).find((item) => item.label === 'data'))?.bytes || 0), 'Runtime data folder', 'purple', 'database'),
      metric('Disk free', free != null ? formatBytes(free) : 'Disk probe pending', disk.mountPoint || 'Host disk probe', free != null ? 'good' : 'warn', 'hard_drive'),
    ];
  }

  if (featureKey === 'api') {
    const latencies = safeArray(snapshot?.rpc?.probes).map((probe) => Number(probe.latencyMs)).filter(Number.isFinite);
    const avgLatency = latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0;
    return [
      metric('Endpoint', snapshot?.rpc?.endpoint || 'Endpoint not resolved', 'Selected node JSON-RPC endpoint', 'blue', 'terminal'),
      metric('Passing methods', `${formatNumber(probes.passing)}/${formatNumber(probes.total)}`, 'Live method probes', probes.failing ? 'warn' : 'good', 'fact_check'),
      metric('Average latency', `${formatNumber(avgLatency)} ms`, 'Mean probe latency', avgLatency > 500 ? 'warn' : 'good', 'speed'),
      metric('Chain ID', String(firstProbe(snapshot, 'synergy_getChainId')?.result || snapshot?.network?.chainId || ''), 'Live chain identifier', 'purple', 'tag'),
    ];
  }

  if (featureKey === 'maintenance') {
    return [
      metric('Runtime', nodeRuntimeLabel(selectedNodeLive), formatRuntimeDuration(selectedNodeLive?.process_uptime_secs), nodeRuntimeTone(selectedNodeLive), 'build_circle'),
      metric('Sync gap', formatNumber(selectedNodeLive?.sync_gap ?? 0), 'Use Sync Catch Up when behind', Number(selectedNodeLive?.sync_gap || 0) > SYNC_READY_GAP ? 'warn' : 'good', 'sync'),
      metric('Processes', formatNumber(processCount), 'Workspace runtime processes', processCount === 1 ? 'good' : 'warn', 'memory'),
      metric('Readiness', `${formatNumber(readiness.ready)}/${formatNumber(readiness.total)}`, 'Pre-maintenance checks', readiness.blocked ? 'warn' : 'good', 'rule'),
    ];
  }

  if (featureKey === 'diagnostics') {
    return [
      metric('Processes', formatNumber(processCount), 'Workspace runtime process matches', processCount === 1 ? 'good' : 'warn', 'memory'),
      metric('Listeners', String(readObject(snapshot?.diagnostics?.listeners).status ?? 'Captured'), 'Port listener command status', 'cyan', 'settings_ethernet'),
      metric('Disk command', String(readObject(snapshot?.diagnostics?.disk).status ?? 'Captured'), 'Disk command status', 'blue', 'hard_drive'),
      metric('Log entries', formatNumber(logs.total_entries || 0), 'Parsed from workspace logs', 'purple', 'receipt_long'),
    ];
  }

  if (featureKey === 'config') {
    const files = safeArray(snapshot?.config?.files);
    const present = files.filter((file) => file.exists).length;
    return [
      metric('Config files', `${formatNumber(present)}/${formatNumber(files.length)}`, 'Files read from workspace', present === files.length ? 'good' : 'warn', 'description'),
      metric('RPC endpoint', snapshot?.rpc?.endpoint || 'Endpoint not resolved', 'Resolved from node.toml', 'cyan', 'terminal'),
      metric('Chain ID', String(snapshot?.network?.chainId || ''), 'Bundled Testnet network profile', 'purple', 'tag'),
      metric('Bootstrap entries', formatNumber(safeArray(snapshot?.network?.bootnodes).length + safeArray(snapshot?.network?.seedServers).length), 'Bootnodes and seed servers in network profile', 'blue', 'hub'),
    ];
  }

  return common;
}

function buildChecks(featureKey, snapshot) {
  const readinessChecks = safeArray(snapshot?.readiness?.checks).map((check) => ({
    id: check.id || check.label,
    label: check.label || check.id,
    detail: check.detail || check.suggestion || 'Runtime check returned without detail.',
    status: check.status === 'pass' ? 'pass' : 'fail',
  }));
  const rpcChecks = safeArray(snapshot?.rpc?.probes).map((probe) => ({
    id: `rpc-${probe.method}`,
    label: probe.method,
    detail: probe.status === 'pass' ? `${probe.summary || 'Method responded'} in ${formatNumber(probe.latencyMs)} ms` : String(probe.detail || 'RPC probe failed'),
    status: probe.status === 'pass' ? 'pass' : 'fail',
  }));

  if (featureKey === 'config') {
    return safeArray(snapshot?.config?.files).map((file) => ({
      id: file.path,
      label: file.path?.split('/').slice(-2).join('/') || 'config file',
      detail: file.exists ? `${formatBytes(file.bytes)} read from workspace` : 'File was not found in this workspace.',
      status: file.exists ? 'pass' : 'fail',
    }));
  }

  if (featureKey === 'diagnostics') {
    return [
      ...safeArray(snapshot?.diagnostics?.processes).map((process) => ({
        id: `pid-${process.pid}`,
        label: `Process ${process.pid}`,
        detail: `Runtime process has been alive for ${formatRuntimeDuration(process.uptimeSecs)}.`,
        status: 'pass',
      })),
      {
        id: 'listeners',
        label: 'Port listeners command',
        detail: readObject(snapshot?.diagnostics?.listeners).stdout || readObject(snapshot?.diagnostics?.listeners).stderr || 'Listener command completed.',
        status: readObject(snapshot?.diagnostics?.listeners).status === 0 ? 'pass' : 'fail',
      },
      {
        id: 'disk',
        label: 'Disk command',
        detail: readObject(snapshot?.diagnostics?.disk).stdout || readObject(snapshot?.diagnostics?.disk).stderr || 'Disk command completed.',
        status: readObject(snapshot?.diagnostics?.disk).status === 0 ? 'pass' : 'fail',
      },
    ];
  }

  return [...readinessChecks, ...rpcChecks].slice(0, 10);
}

function buildTable(featureKey, snapshot) {
  const blocks = chainBlocks(snapshot);
  const graph = graphSnapshot(snapshot);

  if (featureKey === 'alerts') {
    const logRows = safeArray(snapshot?.logs?.entries)
      .filter((entry) => ['WARN', 'ERROR'].includes(String(entry.level || '').toUpperCase()))
      .slice(0, 8)
      .map((entry) => [
        String(entry.level || 'INFO').toUpperCase(),
        entry.module || entry.source_label || 'runtime',
        entry.message || entry.raw || '',
        entry.timestamp_utc || 'No timestamp',
      ]);
    const checkRows = safeArray(snapshot?.readiness?.checks)
      .filter((check) => check.status !== 'pass')
      .slice(0, 6)
      .map((check) => ['CHECK', check.label || check.id, check.detail || check.suggestion || '', snapshot?.readiness?.generated_at_utc || 'Current']);
    return {
      title: 'Incident evidence',
      columns: ['Severity', 'Signal', 'Detail', 'Time'],
      rows: [...logRows, ...checkRows],
    };
  }

  if (featureKey === 'storage') {
    return {
      title: 'Workspace storage',
      columns: ['Section', 'Bytes', 'Files', 'Path'],
      rows: safeArray(snapshot?.storage?.sections).map((section) => [
        section.label,
        formatBytes(section.bytes),
        formatNumber(section.files),
        section.path,
      ]),
    };
  }

  if (featureKey === 'api') {
    return {
      title: 'RPC method probes',
      columns: ['Method', 'Status', 'Latency', 'Result'],
      rows: safeArray(snapshot?.rpc?.probes).map((probe) => [
        probe.method,
        probe.status,
        `${formatNumber(probe.latencyMs)} ms`,
        probe.summary || String(probe.detail || ''),
      ]),
    };
  }

  if (featureKey === 'diagnostics') {
    return {
      title: 'Machine command output',
      columns: ['Check', 'Status', 'Output'],
      rows: [
        ['Listeners', String(readObject(snapshot?.diagnostics?.listeners).status ?? 'captured'), readObject(snapshot?.diagnostics?.listeners).stdout || readObject(snapshot?.diagnostics?.listeners).stderr || ''],
        ['Disk', String(readObject(snapshot?.diagnostics?.disk).status ?? 'captured'), readObject(snapshot?.diagnostics?.disk).stdout || readObject(snapshot?.diagnostics?.disk).stderr || ''],
      ],
    };
  }

  if (featureKey === 'config') {
    return {
      title: 'Config files',
      columns: ['File', 'Bytes', 'Modified', 'Path'],
      rows: safeArray(snapshot?.config?.files).map((file) => [
        file.path?.split('/').pop() || 'file',
        file.exists ? formatBytes(file.bytes) : 'Missing',
        file.modifiedAtUtc || 'No timestamp',
        file.path,
      ]),
    };
  }

  if (featureKey === 'transactions') {
    const pool = mempoolTransactions(snapshot);
    const latestTransactions = safeArray(blocks[0]?.transactions);
    return {
      title: 'Selected node mempool',
      columns: ['Hash', 'State', 'Amount/Fee', 'Source'],
      rows: [
        ...pool.slice(0, 8).map((tx) => [
          tx.hash || tx.tx_hash || tx.id || 'pending transaction',
          tx.status || 'pending',
          tx.amount || tx.fee || tx.gas || '0',
          'pool',
        ]),
        ...latestTransactions.slice(0, 8).map((tx) => [
          tx.hash || tx.tx_hash || tx.id || 'block transaction',
          tx.status || 'confirmed',
          tx.amount || tx.fee || tx.gas || '0',
          `block ${formatNumber(blocks[0]?.number ?? blocks[0]?.block_index ?? 0)}`,
        ]),
      ],
    };
  }

  if (featureKey === 'dag') {
    const dag = readObject(snapshot?.dag);
    const vertices = safeArray(dag.vertices);
    if (vertices.length) {
      return {
        title: 'DAG vertex evidence',
        columns: ['Vertex', 'Round/Height', 'Author', 'Certified'],
        rows: vertices.slice(0, 16).map((vertex, index) => [
          vertex.id || vertex.vertex_id || vertex.hash || `vertex-${index}`,
          formatNumber(vertex.round ?? vertex.height ?? vertex.block_height ?? 0),
          vertex.author || vertex.validator || vertex.validator_id || '',
          String(vertex.certified ?? vertex.available ?? false),
        ]),
      };
    }
    return {
      title: dag.available ? 'DAG graph evidence' : 'PoSy finalized block evidence',
      columns: ['Height', 'Hash', 'Parent', 'Validator'],
      rows: blocks.slice(0, 16).map((block) => [
        formatNumber(block.number ?? block.block_index ?? block.blockNumber ?? 0),
        block.hash || '',
        block.parentHash || block.parent_hash || block.previous_hash || '',
        block.validator || block.validator_id || '',
      ]),
    };
  }

  return {
    title: featureKey === 'consensus' ? 'Recent consensus blocks' : 'Live RPC evidence',
    columns: ['Height', 'Hash', 'Validator', 'Transactions'],
    rows: blocks.slice(0, 12).map((block) => [
      formatNumber(block.number ?? block.block_index ?? block.blockNumber ?? 0),
      block.hash || '',
      block.validator || block.validator_id || '',
      formatNumber(safeArray(block.transactions).length),
    ]),
  };
}

function FeatureChecklist({ items }) {
  return (
    <PanelCard title="Live checks">
      <div className="cp-feature-checklist">
        {items.length ? items.map((item) => (
          <article key={item.id} className={`cp-feature-check tone-${item.status === 'pass' ? 'good' : 'warn'} ${item.status === 'pass' ? 'is-done' : ''}`}>
            <span className="material-icons" aria-hidden="true">{item.status === 'pass' ? 'check_circle' : 'radio_button_unchecked'}</span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </article>
        )) : (
          <div className="cp-empty-inline">The live snapshot returned zero actionable checks.</div>
        )}
      </div>
    </PanelCard>
  );
}

function FeatureTable({ table }) {
  return (
    <PanelCard title={table.title}>
      <div className="cp-feature-table">
        <div className="cp-feature-table-row cp-feature-table-head">
          {table.columns.map((column) => <span key={column}>{column}</span>)}
        </div>
        {table.rows.length ? table.rows.map((row, rowIndex) => (
          <div key={`${row.join('-')}-${rowIndex}`} className="cp-feature-table-row">
            {row.map((cell, index) => (
              <span key={`${index}-${String(cell).slice(0, 40)}`} className={index === 0 ? 'is-primary' : ''}>{String(cell)}</span>
            ))}
          </div>
        )) : (
          <div className="cp-empty-inline">The live source returned zero rows for this screen.</div>
        )}
      </div>
    </PanelCard>
  );
}

function LiveGraphVisual({ snapshot }) {
  const graph = graphSnapshot(snapshot);
  const nodes = safeArray(graph.nodes).slice(0, 18);
  const nodeById = new Map(nodes.map((node, index) => [node.id, {
    ...node,
    x: 8 + (index % 6) * 17,
    y: 24 + Math.floor(index / 6) * 28,
  }]));
  const edges = safeArray(graph.edges)
    .map((edge) => ({ from: nodeById.get(edge.from), to: nodeById.get(edge.to) }))
    .filter((edge) => edge.from && edge.to);
  const nodeLabel = (height) => {
    const text = String(height ?? '').replace(/[^\d]/g, '');
    return text ? `#${text.slice(-4)}` : '#0';
  };

  return (
    <div className="cp-feature-visual cp-feature-live-runtime">
      {nodes.length ? (
        <svg viewBox="0 0 112 100" role="img" aria-label="Live block parent graph">
          {edges.map((edge, index) => (
            <line key={`${edge.from.id}-${edge.to.id}-${index}`} x1={edge.from.x} y1={edge.from.y} x2={edge.to.x} y2={edge.to.y} />
          ))}
          {Array.from(nodeById.values()).map((node) => (
            <g key={node.id || node.height} transform={`translate(${node.x} ${node.y})`}>
              <circle r="5.5" className="tone-cyan" />
              <text x="0" y="14" textAnchor="middle">{nodeLabel(node.height)}</text>
            </g>
          ))}
        </svg>
      ) : (
        <div className="cp-empty-inline">The node returned zero recent block graph rows.</div>
      )}
    </div>
  );
}

function buildRuntimeActionsForFeature(featureKey, selectedNodeLive) {
  const common = {
    refresh: { id: 'refresh-live-state', label: 'Refresh Live State', variant: 'blue', requiresNode: false },
    readiness: { id: 'run-readiness-check', label: 'Run Readiness Check', variant: 'lime' },
    logs: { id: 'inspect-recent-logs', label: 'Inspect Recent Logs', variant: 'blue' },
    start: { id: 'start-node', label: selectedNodeLive?.is_running ? 'Node Running' : 'Start Node', variant: 'lime' },
    stop: { id: 'stop-node', label: 'Stop Node', variant: 'red' },
    restart: { id: 'restart-node', label: 'Restart Runtime', variant: 'purple' },
    boost: { id: 'boost-sync', label: 'Boost Sync', variant: 'lime' },
    catchUp: { id: 'sync-catch-up', label: 'Sync Catch Up', variant: 'purple' },
    register: { id: 'register-seeds', label: 'Refresh Seeds', variant: 'blue' },
    rejoin: { id: 'rejoin-network', label: 'Rejoin Network', variant: 'purple' },
    preflight: { id: 'activation-preflight', label: 'Activation Preflight', variant: 'lime' },
    activate: { id: 'activate-validator', label: 'Activate Validator', variant: 'blue' },
    settings: { id: 'open-settings', label: 'Open Settings', variant: 'blue', requiresNode: false },
  };

  const actionMap = {
    alerts: [common.refresh, common.readiness, common.logs],
    validator: [common.preflight, common.catchUp, common.activate, common.register],
    security: [common.readiness, common.logs, common.refresh],
    identity: [common.readiness, common.preflight, common.logs],
    consensus: [common.refresh, common.readiness, common.register, common.catchUp],
    dag: [common.refresh, common.logs, common.boost],
    transactions: [common.logs, common.refresh, common.readiness],
    storage: [common.refresh, common.logs, common.settings],
    api: [common.refresh, common.readiness, common.logs],
    maintenance: [common.restart, common.catchUp, common.rejoin, common.boost, common.stop],
    diagnostics: [common.refresh, common.logs, common.readiness],
    config: [common.refresh, common.readiness, common.logs],
  };

  return actionMap[featureKey] || [common.refresh, common.readiness];
}

export default function ControlPanelFeaturePage({ screenKey }) {
  const feature = getFeatureScreenByKey(screenKey);
  const navigate = useNavigate();
  const {
    actionAudit,
    liveStatus,
    network,
    networkStats,
    recordAction,
    refresh,
    selectedNode,
    selectedNodeLive,
    viewMode,
  } = useControlPanel();
  const [snapshot, setSnapshot] = useState(null);
  const [snapshotError, setSnapshotError] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionBusy, setActionBusy] = useState('');

  const loadSnapshot = async () => {
    if (!feature) return;
    setLoading(true);
    try {
      const nextSnapshot = await invoke('testnet_get_feature_snapshot', {
        input: {
          screenKey: feature.key,
          nodeId: selectedNode?.id,
        },
      });
      setSnapshot(nextSnapshot || null);
      setSnapshotError('');
    } catch (error) {
      setSnapshot(null);
      setSnapshotError(String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSnapshot();
  }, [feature?.key, selectedNode?.id, liveStatus]);

  const metrics = useMemo(
    () => buildMetrics(feature?.key, snapshot || {}, selectedNodeLive, networkStats),
    [feature?.key, networkStats, selectedNodeLive, snapshot],
  );
  const checks = useMemo(
    () => buildChecks(feature?.key, snapshot || {}),
    [feature?.key, snapshot],
  );
  const table = useMemo(
    () => buildTable(feature?.key, snapshot || {}),
    [feature?.key, snapshot],
  );
  const runtimeActions = buildRuntimeActionsForFeature(feature?.key, selectedNodeLive);
  const featureTitle = feature?.modeTitles?.[viewMode] || feature?.title;
  const featureCopy = feature?.modeCopy?.[viewMode] || feature?.description;

  if (!feature) {
    return null;
  }

  const handleAction = async (action) => {
    if (!selectedNode && action.requiresNode !== false) {
      setNotice('No node is selected.');
      return;
    }

    setActionBusy(action.id);
    try {
      let detail = '';
      if (action.id === 'refresh-live-state') {
        await refresh({ silent: false });
        await loadSnapshot();
        detail = 'Live state refreshed from the control service.';
      } else if (action.id === 'start-node') {
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
      } else if (action.id === 'sync-catch-up') {
        const result = await syncCatchUpRejoinAction({ node: selectedNode, network });
        detail = result?.message || 'Sync Catch Up completed.';
        await refresh({ silent: true });
      } else if (action.id === 'register-seeds') {
        detail = await registerWithSeedsAction(selectedNode.id);
        await refresh({ silent: true });
      } else if (action.id === 'rejoin-network') {
        detail = await rejoinNetworkAction({ node: selectedNode, network });
        await refresh({ silent: true });
      } else if (action.id === 'run-readiness-check') {
        const report = await invoke('testnet_get_node_readiness', { nodeId: selectedNode.id });
        detail = `Readiness ${report?.overall_status || 'reported'}: ${formatNumber(report?.ready_count)} of ${formatNumber(report?.total_count)} checks passing.`;
      } else if (action.id === 'inspect-recent-logs') {
        const bundle = await invoke('testnet_get_node_logs', { nodeId: selectedNode.id, lines: 80 });
        const entries = safeArray(bundle?.entries);
        const latest = entries[entries.length - 1];
        detail = entries.length
          ? `Loaded ${formatNumber(entries.length)} log entries. Latest: ${latest?.level || 'INFO'} ${latest?.message || latest?.raw || 'runtime event'}.`
          : 'The log reader returned zero entries for the selected node.';
      } else if (action.id === 'activation-preflight') {
        const result = await invoke('testnet_get_validator_activation_preflight', { nodeId: selectedNode.id });
        const ready = result?.canActivate || result?.can_activate;
        detail = ready ? 'Validator activation preflight is passing.' : 'Validator activation preflight returned blocking checks.';
      } else if (action.id === 'activate-validator') {
        const result = await invoke('testnet_activate_validator', {
          input: {
            nodeId: selectedNode.id,
            displayName: selectedNode.display_label || selectedNode.role_display_name || 'Validator',
          },
        });
        detail = result?.message || `Validator activation submitted${result?.tx_hash ? `: ${result.tx_hash}` : ''}.`;
      } else if (action.id === 'open-settings') {
        navigate('/settings');
        detail = 'Opened Settings.';
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
      await loadSnapshot();
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
    } finally {
      setActionBusy('');
    }
  };

  return (
    <div className="cp-page-stack cp-feature-page">
      <SectionHeader
        eyebrow={feature.eyebrow}
        title={featureTitle}
        copy={featureCopy}
        actions={(
          <>
            <StatusPill tone={feature.tone}>{feature.label}</StatusPill>
            <SNRGButton variant="blue" size="sm" onClick={() => void loadSnapshot()} disabled={loading}>
              {loading ? 'Refreshing...' : 'Refresh'}
            </SNRGButton>
          </>
        )}
      />

      {snapshotError ? <div className="cp-inline-notice tone-bad">{snapshotError}</div> : null}
      {notice ? <div className="cp-inline-notice">{notice}</div> : null}

      <div className="cp-dashboard-grid cp-feature-grid">
        <div className="cp-dashboard-main">
          <PanelCard
            className="cp-feature-hero"
            eyebrow={selectedNodeLabel(snapshot, selectedNode)}
            title={`${feature.label} live workspace`}
            detail={`Snapshot generated ${snapshot?.generatedAtUtc || 'after refresh'} from local control-service and node RPC sources.`}
            action={<StatusPill tone={nodeRuntimeTone(selectedNodeLive)} live>{nodeRuntimeLabel(selectedNodeLive)}</StatusPill>}
          >
            <LiveGraphVisual snapshot={snapshot || {}} />
          </PanelCard>

          <div className="cp-metric-grid cp-metric-grid-dashboard">
            {metrics.map((item) => (
              <MetricCard key={`${feature.key}-${item.label}`} {...item} />
            ))}
          </div>

          <div className="cp-split-grid">
            <FeatureChecklist items={checks} />
            <PanelCard title={`${feature.label} actions`} detail="These controls call the production control-service action path and record action receipts.">
              <div className="cp-feature-action-grid">
                {runtimeActions.map((action) => (
                  <SNRGButton
                    key={action.id}
                    variant={action.variant}
                    size="sm"
                    onClick={() => void handleAction(action)}
                    disabled={actionBusy === action.id || (!selectedNode && action.requiresNode !== false) || (action.id === 'start-node' && selectedNodeLive?.is_running)}
                  >
                    {actionBusy === action.id ? 'Working...' : action.label}
                  </SNRGButton>
                ))}
              </div>
            </PanelCard>
          </div>

          <FeatureTable table={table} />
        </div>

        <div className="cp-dashboard-side">
          <PanelCard title="Current node context" detail={selectedNodeLabel(snapshot, selectedNode)}>
            <div className="cp-definition-list">
              <div className="cp-definition-item">
                <span>Address</span>
                <strong>{nodeAddress(snapshot) || 'No node address reported'}</strong>
              </div>
              <div className="cp-definition-item">
                <span>RPC endpoint</span>
                <strong>{snapshot?.rpc?.endpoint || 'No endpoint reported'}</strong>
              </div>
              <div className="cp-definition-item">
                <span>Runtime</span>
                <strong>{nodeRuntimeLabel(selectedNodeLive)}</strong>
              </div>
              <div className="cp-definition-item">
                <span>Sync gap</span>
                <strong>{formatNumber(selectedNodeLive?.sync_gap ?? 0)}</strong>
              </div>
            </div>
          </PanelCard>

          <PanelCard title="Recent action audit">
            <div className="cp-panel-scroll cp-panel-scroll-tight">
              <ActionAuditStream entries={actionAudit.slice(0, 10)} emptyMessage="No actions recorded for this session yet." />
            </div>
          </PanelCard>

          {viewMode === 'developer' ? (
            <JsonInspectorPanel
              title="Production snapshot"
              value={snapshot}
              emptyMessage="Refresh to load the production snapshot."
            />
          ) : null}

          {feature.key === 'config' && viewMode === 'developer' ? (
            safeArray(snapshot?.config?.files).filter((file) => file.contents).slice(0, 3).map((file) => (
              <PanelCard key={file.path} title={file.path?.split('/').pop() || 'config'}>
                <pre className="cp-json-inspector">{file.contents}</pre>
              </PanelCard>
            ))
          ) : null}

          <PanelCard title="Related">
            <div className="cp-button-grid">
              <SNRGButton as={Link} to="/node" variant="blue" size="sm">Node Details</SNRGButton>
              <SNRGButton as={Link} to="/logs" variant="purple" size="sm">Logs</SNRGButton>
            </div>
          </PanelCard>
        </div>
      </div>
    </div>
  );
}
