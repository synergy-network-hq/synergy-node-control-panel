import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { invoke, openPath, readTextFile } from '../lib/desktopClient';
import {
  applyStoredTestnetBetaPortSettings,
  formatPortSettingsSummary,
  readTestnetBetaNodePortSettings,
  refreshTestnetBetaBootstrapConfig,
} from '../lib/testnetBetaBootstrap';
import { SNRGButton } from '../styles/SNRGButton';

const DEFAULT_ATLAS_API_BASE = 'https://testbeta-atlas-api.synergy-network.io';
const POLL_INTERVAL_MS = 10000;

async function fetchExplorerJson(baseUrl, path) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const response = await fetch(`${base}${path}`);
  if (!response.ok) {
    throw new Error(`Explorer request failed (${response.status})`);
  }
  return response.json();
}

function Icon({ children }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const ICONS = {
  node: (<Icon><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" /><path d="M12 12 4 7.5" /><path d="M12 12l8-4.5" /><path d="M12 12v9" /></Icon>),
  chain: (<Icon><rect x="3" y="4" width="18" height="5" rx="1.5" /><rect x="3" y="10" width="18" height="5" rx="1.5" /><rect x="3" y="16" width="18" height="5" rx="1.5" /></Icon>),
  peers: (<Icon><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="3" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 4.13a4 4 0 0 1 0 7.75" /></Icon>),
  pulse: (<Icon><path d="M4 12h3l2-4 4 8 2-4h5" /></Icon>),
  score: (<Icon><path d="M4 14h4l2-7 4 10 2-5h4" /></Icon>),
  wallet: (<Icon><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5.5A2.5 2.5 0 0 1 3 16.5v-9Z" /><path d="M16 12h3" /><circle cx="16" cy="12" r="1" /></Icon>),
  folder: (<Icon><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" /></Icon>),
  file: (<Icon><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></Icon>),
  copy: (<Icon><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Icon>),
  refresh: (<Icon><path d="M20 11a8 8 0 1 0 2 5.3" /><path d="M20 4v7h-7" /></Icon>),
  play: (<Icon><path d="m8 5 11 7-11 7V5Z" /></Icon>),
  stop: (<Icon><rect x="6" y="6" width="12" height="12" rx="2" /></Icon>),
  sync: (<Icon><path d="M3 12a9 9 0 0 1 15.3-6.36L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.3 6.36L3 16" /><path d="M8 16H3v5" /></Icon>),
  shield: (<Icon><path d="M12 3 5 6v6c0 5 3 7 7 9 4-2 7-4 7-9V6l-7-3Z" /><path d="m9.5 12 1.8 1.8 3.2-3.6" /></Icon>),
  trash: (<Icon><path d="M4 6h16" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-.8 12.2a2 2 0 0 1-2 1.8H7.8a2 2 0 0 1-2-1.8L5 6" /><path d="M10 11v5" /><path d="M14 11v5" /></Icon>),
  back: (<Icon><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></Icon>),
  clock: (<Icon><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></Icon>),
  server: (<Icon><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><path d="M6 6h.01" /><path d="M6 18h.01" /></Icon>),
  globe: (<Icon><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></Icon>),
  stake: (<Icon><path d="M12 3v18" /><path d="M17 7.5c0-1.9-2.2-3.5-5-3.5S7 5.6 7 7.5 9.2 11 12 11s5 1.6 5 3.5S14.8 18 12 18s-5-1.6-5-3.5" /></Icon>),
};

function truncateAddress(value, prefix = 6, suffix = 5) {
  const text = String(value || '').trim();
  if (!text) return 'Not available';
  if (text.length <= prefix + suffix) return text;
  return `${text.slice(0, prefix)}...${text.slice(-suffix)}`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'N/A';
  return number.toLocaleString();
}

function formatWholeSnrg(value) {
  const number = Number.parseFloat(String(value || '0'));
  if (!Number.isFinite(number)) return '0';
  return Math.round(number).toLocaleString();
}

function formatScoreOutOfHundred(value) {
  if (value == null || Number.isNaN(Number(value))) return 'N/A';
  return `${Number(value).toFixed(1)}/100`;
}

function formatStatusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value.includes('online') || value.includes('live') || value.includes('running') || value.includes('ready') || value.includes('ok')) return 'good';
  if (value.includes('degraded') || value.includes('bootstrap') || value.includes('starting') || value.includes('sync')) return 'warn';
  return 'bad';
}

function nodeRuntimeLabel(nodeLive) {
  if (!nodeLive?.is_running) {
    return 'Offline';
  }
  if (nodeLive.local_rpc_ready === false) {
    return 'Degraded';
  }
  return 'Online';
}

function nodeRuntimeTone(nodeLive) {
  return formatStatusTone(nodeRuntimeLabel(nodeLive));
}

function nodeBlockHeightValue(nodeLive, liveStatus) {
  if (nodeLive?.is_running) {
    return nodeLive?.local_chain_height;
  }
  return nodeLive?.local_chain_height ?? liveStatus?.public_chain_height;
}

function nodeBlockHeightDetail(nodeLive, liveStatus) {
  if (!nodeLive?.is_running) {
    return `Public chain: ${formatNumber(liveStatus?.public_chain_height)}`;
  }
  if (nodeLive.local_rpc_ready === false) {
    return nodeLive?.local_rpc_status || 'Local RPC is not responding.';
  }
  return `${formatNumber(nodeLive?.sync_gap ?? 0)} blocks behind`;
}

function nodePeerCountValue(nodeLive, liveStatus) {
  if (nodeLive?.is_running) {
    return nodeLive?.local_peer_count;
  }
  return nodeLive?.local_peer_count ?? liveStatus?.public_peer_count;
}

function nodePeerCountDetail(nodeLive) {
  if (!nodeLive?.is_running) {
    return 'Public network peers';
  }
  if (nodeLive.local_rpc_ready === false) {
    return nodeLive?.local_rpc_status || 'Local RPC is not responding.';
  }
  return 'Live connected peers';
}

function formatTimestamp(utcString) {
  if (!utcString) return 'N/A';
  try {
    return new Date(utcString).toLocaleString();
  } catch {
    return utcString;
  }
}

function roleTypeLabel(roleDisplayName) {
  const value = String(roleDisplayName || '').trim();
  if (!value) return 'Unknown';
  return value.replace(/\s+node$/i, '').trim();
}

function classTierLabel(role) {
  const classId = Number(role?.class_id || 0);
  if (!Number.isFinite(classId) || classId < 1 || classId > 5) return 'Class Unknown';
  const roman = ['I', 'II', 'III', 'IV', 'V'];
  return `Class ${roman[classId - 1]}`;
}

function latencyLabel(entry) {
  if (!entry?.reachable || entry?.latency_ms == null) return entry?.detail || 'Unavailable';
  return `${entry.latency_ms} ms`;
}

function rewardProfileForRole(role) {
  const classId = Number(role?.class_id || 0);
  switch (classId) {
    case 1: return { tier: 'High', multiplier: '1.45x base', summary: 'Consensus-heavy roles earn the largest SNRG share.' };
    case 2: return { tier: 'Elevated', multiplier: '1.25x base', summary: 'Cross-system coordination roles earn above-base rewards.' };
    case 3: return { tier: 'Standard', multiplier: '1.10x base', summary: 'Compute and data roles earn for processing workloads.' };
    case 4: return { tier: 'Stewardship', multiplier: '1.00x base', summary: 'Governance and treasury roles earn for oversight.' };
    case 5: return { tier: 'Service', multiplier: '0.85x base', summary: 'Access and indexing roles earn for uptime and service quality.' };
    default: return { tier: 'Standard', multiplier: '1.00x base', summary: 'This role earns SNRG when online and active.' };
  }
}

/* ----- Confirmation Modal ----- */
function RemoveNodeModal({ node, onConfirm, onCancel, busy }) {
  return (
    <div className="nodedetail-modal-backdrop" onClick={onCancel}>
      <div className="nodedetail-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Remove Node</h3>
        <p className="nodedetail-modal-body">
          Are you sure you want to permanently remove <strong>{node?.display_label || 'this node'}</strong>?
        </p>
        <ul className="nodedetail-modal-list">
          <li>The node process will be stopped if it is running.</li>
          <li>The entire workspace directory will be deleted.</li>
          <li>The node will be deregistered from network seed servers.</li>
          <li>The associated funding manifest will be removed.</li>
        </ul>
        <p className="nodedetail-modal-warning">This action cannot be undone.</p>
        <div className="nodedetail-modal-actions">
          <SNRGButton variant="blue" size="sm" onClick={onCancel} disabled={busy}>Cancel</SNRGButton>
          <SNRGButton variant="red" size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? 'Removing...' : 'Yes, Remove Node'}
          </SNRGButton>
        </div>
      </div>
    </div>
  );
}

/* ----- Main Component ----- */
function TestnetBetaNodeDetail() {
  const { nodeId } = useParams();
  const navigate = useNavigate();

  const [state, setState] = useState(null);
  const [liveStatus, setLiveStatus] = useState(null);
  const [explorerData, setExplorerData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [controlBusy, setControlBusy] = useState('');
  const [controlMessage, setControlMessage] = useState('');
  const [copiedNotice, setCopiedNotice] = useState('');
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [portSettings, setPortSettings] = useState(null);
  const [configContents, setConfigContents] = useState('');
  const [activeTab, setActiveTab] = useState('overview');

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);

    const [stateResult, liveResult] = await Promise.allSettled([
      invoke('testbeta_get_state'),
      invoke('testbeta_get_live_status'),
    ]);

    if (stateResult.status === 'fulfilled') setState(stateResult.value);
    if (liveResult.status === 'fulfilled') setLiveStatus(liveResult.value);

    const errors = [];
    if (stateResult.status === 'rejected') errors.push(String(stateResult.reason));
    if (liveResult.status === 'rejected') errors.push(String(liveResult.reason));
    setError(errors.join(' '));

    try {
      const chain = await fetchExplorerJson(DEFAULT_ATLAS_API_BASE, '/chain/summary');
      setExplorerData(chain);
    } catch { /* explorer optional */ }

    if (!silent) setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    const intervalId = window.setInterval(() => fetchData(true), POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [fetchData]);

  useEffect(() => {
    if (!copiedNotice && !controlMessage) return undefined;
    const timer = window.setTimeout(() => { setCopiedNotice(''); setControlMessage(''); }, 2200);
    return () => window.clearTimeout(timer);
  }, [copiedNotice, controlMessage]);

  const nodes = state?.nodes || [];
  const network = state?.network_profile || {};
  const nodeCatalog = state?.node_catalog || [];
  const node = useMemo(() => nodes.find((n) => n.id === nodeId) || null, [nodes, nodeId]);
  const nodeLive = useMemo(() => (liveStatus?.nodes || []).find((e) => e.node_id === nodeId) || null, [liveStatus?.nodes, nodeId]);
  const role = useMemo(() => nodeCatalog.find((r) => r.id === node?.role_id) || null, [nodeCatalog, node?.role_id]);
  const fundingManifest = useMemo(() => (network?.funding_manifests || []).find((f) => f.id === node?.funding_manifest_id) || null, [network?.funding_manifests, node?.funding_manifest_id]);
  const rewardProfile = useMemo(() => rewardProfileForRole(role), [role]);
  const isRunning = Boolean(nodeLive?.is_running);
  const runtimeLabel = nodeRuntimeLabel(nodeLive);
  const runtimeTone = nodeRuntimeTone(nodeLive);

  // Load port settings and config when node is selected
  useEffect(() => {
    if (!node) {
      setPortSettings(null);
      setConfigContents('');
      return;
    }
    (async () => {
      try {
        const ports = await readTestnetBetaNodePortSettings(node);
        setPortSettings(ports?.portSettings || null);
      } catch {
        setPortSettings(null);
      }
      try {
        const nodeToml = node.config_paths?.find((p) => p.endsWith('/node.toml'));
        if (nodeToml) {
          const contents = await readTextFile(nodeToml);
          setConfigContents(contents || '');
        } else {
          setConfigContents('');
        }
      } catch {
        setConfigContents('');
      }
    })();
  }, [node]);

  const runNodeControl = async (action) => {
    if (!node) return;
    setControlBusy(action);
    try {
      let bootstrapNotice = '';
      if (action === 'start' || action === 'sync') {
        try {
          const portConfig = await applyStoredTestnetBetaPortSettings(node);
          bootstrapNotice = ` Port profile applied: ${formatPortSettingsSummary(portConfig.portSettings)}.`;
          const bootstrapConfig = await refreshTestnetBetaBootstrapConfig(node, network);
          bootstrapNotice += ` Peers.toml refreshed with ${bootstrapConfig.additionalDialTargets.length} seed targets.`;
        } catch (e) {
          bootstrapNotice = ` Bootstrap refresh skipped: ${String(e)}.`;
        }
      }
      const result = await invoke('testbeta_node_control', { input: { nodeId: node.id, action } });
      setControlMessage(`${result?.message || `${action} completed.`}${bootstrapNotice}`);
      await fetchData(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setControlBusy('');
    }
  };

  const handleRemoveNode = async () => {
    if (!node) return;
    setRemoveBusy(true);
    try {
      await invoke('testbeta_remove_node', { input: { node_id: node.id } });
      setShowRemoveModal(false);
      navigate('/');
    } catch (e) {
      setError(`Remove failed: ${String(e)}`);
      setRemoveBusy(false);
    }
  };

  const handleCopyAddress = async () => {
    if (!node) return;
    await navigator.clipboard.writeText(node.node_address);
    setCopiedNotice('Address copied');
  };

  if (loading) {
    return (
      <div className="nodedetail-shell">
        <div className="loading-container"><div className="spinner"></div><p>Loading node details...</p></div>
      </div>
    );
  }

  if (!node) {
    return (
      <div className="nodedetail-shell">
        <div className="nodedetail-not-found">
          <h2>Node Not Found</h2>
          <p>The node <code>{nodeId}</code> could not be found in the registry.</p>
          <SNRGButton as={Link} to="/" variant="blue" size="sm">Back to Dashboard</SNRGButton>
        </div>
      </div>
    );
  }

  const nodeTomlPath = node.config_paths?.find((p) => p.endsWith('/node.toml')) || node.config_paths?.[0];
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'connectivity', label: 'Connectivity' },
    { id: 'wallet', label: 'Wallet & Rewards' },
    { id: 'config', label: 'Configuration' },
    { id: 'files', label: 'Files' },
  ];

  const renderOverview = () => (
    <div className="nodedetail-tab-stack">
      {/* Metrics grid */}
      <div className="nodecp-stats-grid nodedetail-stats-grid">
        <article className="nodecp-stat-card">
          <div className="nodecp-stat-icon">{ICONS.node}</div>
          <div className="nodecp-stat-copy">
            <span className="nodecp-stat-label">Node Role</span>
            <strong className="nodecp-stat-value">{roleTypeLabel(node.role_display_name)}</strong>
            <span className="nodecp-stat-detail">{classTierLabel(role)} {role?.authority_plane ? `\u2022 ${role.authority_plane}` : ''}</span>
          </div>
        </article>
        <article className="nodecp-stat-card">
          <div className="nodecp-stat-icon">{ICONS.chain}</div>
          <div className="nodecp-stat-copy">
            <span className="nodecp-stat-label">Block Height</span>
            <strong className="nodecp-stat-value">{formatNumber(nodeBlockHeightValue(nodeLive, liveStatus))}</strong>
            <span className="nodecp-stat-detail">{nodeBlockHeightDetail(nodeLive, liveStatus)}</span>
          </div>
        </article>
        <article className="nodecp-stat-card">
          <div className="nodecp-stat-icon">{ICONS.peers}</div>
          <div className="nodecp-stat-copy">
            <span className="nodecp-stat-label">Peer Count</span>
            <strong className="nodecp-stat-value">{formatNumber(nodePeerCountValue(nodeLive, liveStatus))}</strong>
            <span className="nodecp-stat-detail">{nodePeerCountDetail(nodeLive)}</span>
          </div>
        </article>
        <article className="nodecp-stat-card">
          <div className="nodecp-stat-icon">{ICONS.score}</div>
          <div className="nodecp-stat-copy">
            <span className="nodecp-stat-label">Synergy Score</span>
            <strong className="nodecp-stat-value">{formatScoreOutOfHundred(nodeLive?.synergy_score)}</strong>
            <span className="nodecp-stat-detail">{nodeLive?.synergy_score_status || 'Waiting for live data'}</span>
          </div>
        </article>
        <article className="nodecp-stat-card">
          <div className="nodecp-stat-icon">{ICONS.pulse}</div>
          <div className="nodecp-stat-copy">
            <span className="nodecp-stat-label">Runtime Status</span>
            <strong className="nodecp-stat-value">{runtimeLabel}</strong>
            <span className="nodecp-stat-detail">{nodeLive?.local_rpc_status || (nodeLive?.pid ? `PID ${nodeLive.pid}` : 'No active process')}</span>
          </div>
        </article>
        <article className="nodecp-stat-card">
          <div className="nodecp-stat-icon">{ICONS.sync}</div>
          <div className="nodecp-stat-copy">
            <span className="nodecp-stat-label">Sync Gap</span>
            <strong className="nodecp-stat-value">{isRunning ? formatNumber(nodeLive?.sync_gap) : 'Offline'}</strong>
            <span className="nodecp-stat-detail">
              {isRunning
                ? (nodeLive?.local_rpc_ready === false
                  ? (nodeLive?.local_rpc_status || 'Local RPC is not responding.')
                  : 'Blocks remaining to catch up')
                : 'Start node to measure sync'}
            </span>
          </div>
        </article>
      </div>

      {/* Node Identity */}
      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Node Identity</p>
            <h3>{node.display_label}</h3>
          </div>
          <span className={`nodecp-health-pill nodecp-health-${runtimeTone}`}>
            {runtimeLabel}
          </span>
        </div>
        <div className="nodecp-summary-grid">
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Node ID</span>
            <p className="nodedetail-mono">{node.id}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Node Wallet Address</span>
            <p className="nodedetail-mono">{node.node_address}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Public Endpoint</span>
            <p>{node.public_host || 'Auto-detect pending'}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Workspace</span>
            <p className="nodedetail-mono">{node.workspace_directory}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Role Certificate</span>
            <p>{node.role_certificate_status}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Provisioned</span>
            <p>{formatTimestamp(node.created_at_utc)}</p>
          </div>
        </div>
      </section>

      {/* Role Details */}
      {role ? (
        <div className="nodecp-panel-grid">
          <section className="nodecp-panel">
            <div className="nodecp-panel-header">
              <div>
                <p className="nodecp-panel-kicker">Role responsibilities</p>
                <h3>What this node handles</h3>
              </div>
            </div>
            <ul className="nodecp-list">
              {(role.responsibilities || []).slice(0, 6).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
          <section className="nodecp-panel">
            <div className="nodecp-panel-header">
              <div>
                <p className="nodecp-panel-kicker">Service surface</p>
                <h3>Operator KPIs</h3>
              </div>
            </div>
            <ul className="nodecp-list">
              {(role.operator_kpis || []).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}

      {/* Chain & Network Summary */}
      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Network summary</p>
            <h3>Chain &amp; Discovery</h3>
          </div>
        </div>
        <div className="nodecp-summary-grid">
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Chain ID</span>
            <p>{network?.chain_id || 338639}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Environment</span>
            <p>{state?.display_name || 'Testnet-Beta'}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Public RPC</span>
            <p className="nodedetail-mono">{liveStatus?.public_rpc_endpoint || 'N/A'}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Public Chain Height</span>
            <p>{formatNumber(liveStatus?.public_chain_height)}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Discovery Status</span>
            <p>{liveStatus?.discovery_status || 'Unknown'}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Visible Peers (Network)</span>
            <p>{formatNumber(liveStatus?.public_peer_count)}</p>
          </div>
          {explorerData ? (
            <>
              <div className="nodecp-summary-block">
                <span className="nodecp-summary-label">Total Validators</span>
                <p>{formatNumber(explorerData.total_validators)}</p>
              </div>
              <div className="nodecp-summary-block">
                <span className="nodecp-summary-label">Total Transactions</span>
                <p>{formatNumber(explorerData.total_transactions)}</p>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );

  const renderConnectivity = () => (
    <div className="nodedetail-tab-stack">
      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Bootstrap health</p>
            <h3>Bootnodes</h3>
          </div>
        </div>
        <div className="nodecp-endpoint-stack">
          {(liveStatus?.bootnodes || []).map((entry) => (
            <div key={entry.host} className="nodecp-endpoint-row">
              <div>
                <span className="nodecp-endpoint-name">{entry.host}</span>
                <span className="nodecp-endpoint-meta">{entry.ip_address}:{entry.port}</span>
              </div>
              <div className="nodecp-endpoint-health">
                <span className={`nodecp-health-pill nodecp-health-${formatStatusTone(entry.status)}`}>{entry.status}</span>
                <span className="nodecp-endpoint-latency">{latencyLabel(entry)}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Discovery services</p>
            <h3>Seed Servers</h3>
          </div>
        </div>
        <div className="nodecp-endpoint-stack">
          {(liveStatus?.seed_servers || []).map((entry) => (
            <div key={entry.host} className="nodecp-endpoint-row">
              <div>
                <span className="nodecp-endpoint-name">{entry.host}</span>
                <span className="nodecp-endpoint-meta">{entry.ip_address}:{entry.port}</span>
              </div>
              <div className="nodecp-endpoint-health">
                <span className={`nodecp-health-pill nodecp-health-${formatStatusTone(entry.status)}`}>{entry.status}</span>
                <span className="nodecp-endpoint-latency">{latencyLabel(entry)}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="nodecp-panel-grid">
        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Local peer connections</p>
              <h3>Node P2P Status</h3>
            </div>
          </div>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Local peer count</span>
              <strong>{isRunning ? formatNumber(nodeLive?.local_peer_count) : 'Offline'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Public host</span>
              <strong>{node.public_host || 'Auto-detect'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Connectivity status</span>
              <strong>{node.connectivity_status || 'N/A'}</strong>
            </div>
          </div>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Network state</p>
              <h3>Chain Availability</h3>
            </div>
          </div>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Public RPC</span>
              <strong>{liveStatus?.public_rpc_endpoint || 'N/A'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Chain status</span>
              <strong>{liveStatus?.chain_status || 'Unknown'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Block height</span>
              <strong>{formatNumber(liveStatus?.public_chain_height)}</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  );

  const renderWallet = () => (
    <div className="nodedetail-tab-stack">
      <div className="nodecp-panel-grid">
        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Node wallet</p>
              <h3>Address &amp; Identity</h3>
            </div>
          </div>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Node wallet address</span>
              <strong className="nodedetail-mono">{node.node_address}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Reward payout address</span>
              <strong className="nodedetail-mono">{node.reward_payout_address || node.node_address}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Public key file</span>
              <strong className="nodedetail-mono nodedetail-break">{node.public_key_path}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Private key file</span>
              <strong className="nodedetail-mono nodedetail-break">{node.private_key_path}</strong>
            </div>
          </div>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Staking &amp; rewards</p>
              <h3>Earning Profile</h3>
            </div>
          </div>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Reserved stake</span>
              <strong>{formatWholeSnrg(fundingManifest?.amount_snrg || 5000)} SNRG</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Reward tier</span>
              <strong>{rewardProfile.tier}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Reward multiplier</span>
              <strong>{rewardProfile.multiplier}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Synergy score</span>
              <strong>{formatScoreOutOfHundred(nodeLive?.synergy_score)}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Funding manifest</span>
              <strong>{fundingManifest?.id || 'N/A'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Funding status</span>
              <strong>{fundingManifest?.status || 'N/A'}</strong>
            </div>
          </div>
        </section>
      </div>

      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Earning overview</p>
            <h3>{rewardProfile.summary}</h3>
          </div>
        </div>
        <div className="nodecp-summary-grid">
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Total stake on this machine</span>
            <p>{formatWholeSnrg(state?.summary?.total_sponsored_stake_snrg || 0)} SNRG</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Stake vault wallet</span>
            <p className="nodedetail-mono">{truncateAddress(fundingManifest?.stake_vault_wallet)}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Source treasury</span>
            <p className="nodedetail-mono">{truncateAddress(fundingManifest?.source_wallet)}</p>
          </div>
        </div>
      </section>
    </div>
  );

  const renderConfig = () => (
    <div className="nodedetail-tab-stack">
      {portSettings ? (
        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Port configuration</p>
              <h3>Network Ports</h3>
            </div>
          </div>
          <div className="nodecp-summary-grid">
            {Object.entries(portSettings).map(([key, val]) => (
              <div key={key} className="nodecp-summary-block">
                <span className="nodecp-summary-label">{key.toUpperCase()} Port</span>
                <p>{val || 'Default'}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">node.toml</p>
            <h3>Node Configuration</h3>
          </div>
          {nodeTomlPath ? (
            <SNRGButton variant="blue" size="sm" onClick={() => openPath(nodeTomlPath)}>
              Open in Editor
            </SNRGButton>
          ) : null}
        </div>
        <pre className="nodedetail-config-pre">{configContents || 'Configuration not loaded.'}</pre>
      </section>
    </div>
  );

  const renderFiles = () => (
    <div className="nodedetail-tab-stack">
      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Workspace files</p>
            <h3>Node File Paths</h3>
          </div>
        </div>
        <div className="nodecp-file-grid">
          <div className="nodecp-file-card">
            <span className="nodecp-file-label">Workspace root</span>
            <strong>{node.workspace_directory}</strong>
          </div>
          {(node.config_paths || []).map((path) => (
            <SNRGButton key={path} as="button" variant="blue" size="sm" className="nodecp-file-card nodecp-file-card-button" onClick={() => openPath(path)}>
              <span className="nodecp-file-label">{path.split('/').slice(-2).join('/')}</span>
              <strong>{path}</strong>
            </SNRGButton>
          ))}
          <SNRGButton as="button" variant="blue" size="sm" className="nodecp-file-card nodecp-file-card-button" onClick={() => openPath(`${node.workspace_directory}/logs`)}>
            <span className="nodecp-file-label">logs/</span>
            <strong>{node.workspace_directory}/logs</strong>
          </SNRGButton>
          <SNRGButton as="button" variant="blue" size="sm" className="nodecp-file-card nodecp-file-card-button" onClick={() => openPath(`${node.workspace_directory}/data`)}>
            <span className="nodecp-file-label">data/</span>
            <strong>{node.workspace_directory}/data</strong>
          </SNRGButton>
          <SNRGButton as="button" variant="blue" size="sm" className="nodecp-file-card nodecp-file-card-button" onClick={() => openPath(`${node.workspace_directory}/keys`)}>
            <span className="nodecp-file-label">keys/</span>
            <strong>{node.workspace_directory}/keys</strong>
          </SNRGButton>
        </div>
      </section>
    </div>
  );

  const renderTabContent = () => {
    switch (activeTab) {
      case 'connectivity': return renderConnectivity();
      case 'wallet': return renderWallet();
      case 'config': return renderConfig();
      case 'files': return renderFiles();
      case 'overview':
      default: return renderOverview();
    }
  };

  return (
    <div className="nodedetail-shell">
      {showRemoveModal ? (
        <RemoveNodeModal
          node={node}
          onConfirm={handleRemoveNode}
          onCancel={() => setShowRemoveModal(false)}
          busy={removeBusy}
        />
      ) : null}

      {/* Header bar with back button + title + action buttons */}
      <div className="nodedetail-header">
        <div className="nodedetail-header-left">
          <SNRGButton as={Link} to="/" variant="blue" size="sm" className="nodedetail-back-btn">
            <span className="nodecp-action-icon">{ICONS.back}</span>
            <span>Dashboard</span>
          </SNRGButton>
          <div className="nodedetail-header-info">
            <p className="nodecp-page-kicker">Synergy Testnet-Beta &bull; {roleTypeLabel(node.role_display_name)} &bull; {classTierLabel(role)}</p>
            <h2 className="nodecp-page-title">{node.display_label}</h2>
          </div>
        </div>

        <div className="nodedetail-header-actions">
          <SNRGButton variant="lime" size="sm" disabled={isRunning || !!controlBusy} onClick={() => runNodeControl('start')}>
            <span className="nodecp-action-icon">{ICONS.play}</span>
            <span>{controlBusy === 'start' ? 'Starting...' : 'Start'}</span>
          </SNRGButton>
          <SNRGButton variant="red" size="sm" disabled={!isRunning || !!controlBusy} onClick={() => runNodeControl('stop')}>
            <span className="nodecp-action-icon">{ICONS.stop}</span>
            <span>{controlBusy === 'stop' ? 'Stopping...' : 'Stop'}</span>
          </SNRGButton>
          <SNRGButton variant="yellow" size="sm" disabled={!!controlBusy} onClick={() => runNodeControl('sync')}>
            <span className="nodecp-action-icon">{ICONS.sync}</span>
            <span>{controlBusy === 'sync' ? 'Syncing...' : 'Speed Sync'}</span>
          </SNRGButton>
          <SNRGButton variant="blue" size="sm" onClick={handleCopyAddress}>
            <span className="nodecp-action-icon">{ICONS.copy}</span>
            <span>{copiedNotice || 'Copy Address'}</span>
          </SNRGButton>
          <SNRGButton variant="blue" size="sm" onClick={() => openPath(node.workspace_directory)}>
            <span className="nodecp-action-icon">{ICONS.folder}</span>
            <span>Open Workspace</span>
          </SNRGButton>
          <SNRGButton variant="blue" size="sm" onClick={() => fetchData(true)}>
            <span className="nodecp-action-icon">{ICONS.refresh}</span>
            <span>Refresh</span>
          </SNRGButton>
          <SNRGButton variant="red" size="sm" className="nodedetail-remove-btn" onClick={() => setShowRemoveModal(true)} disabled={!!controlBusy}>
            <span className="nodecp-action-icon">{ICONS.trash}</span>
            <span>Remove Node</span>
          </SNRGButton>
        </div>
      </div>

      {/* Status bar */}
      <div className="nodedetail-status-bar">
        <span className={`nodecp-health-pill nodecp-health-${runtimeTone}`}>
          {runtimeLabel}
        </span>
        <span className="nodedetail-status-text">
          {controlMessage
            || error
            || (isRunning
              ? (nodeLive?.local_rpc_ready === false
                ? `Degraded: ${nodeLive?.local_rpc_status || 'Local RPC is not responding.'}`
                : `Running (PID ${nodeLive?.pid || '?'}) \u2022 ${formatNumber(nodeLive?.local_peer_count ?? 0)} peers \u2022 Block ${formatNumber(nodeLive?.local_chain_height)}`)
              : 'Node is not running.')}
        </span>
      </div>

      {/* Tabs */}
      <div className="tabs nodecp-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={['tab', activeTab === tab.id ? 'active' : ''].filter(Boolean).join(' ')}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="tab-content nodecp-tab-content">{renderTabContent()}</div>
    </div>
  );
}

export default TestnetBetaNodeDetail;
