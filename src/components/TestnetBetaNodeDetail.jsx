import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { invoke, openPath, readTextFile } from '../lib/desktopClient';
import {
  applyTestnetBetaPortSettings,
  applyStoredTestnetBetaPortSettings,
  formatPortSettingsForForm,
  formatPortSettingsSummary,
  getTestnetBetaPortFields,
  readTestnetBetaNodePortSettings,
  resolveNginxConfPath,
  refreshTestnetBetaBootstrapConfig,
  validateTestnetBetaPortSettingsForm,
} from '../lib/testnetBetaBootstrap';
import { SNRGButton } from '../styles/SNRGButton';

const DEFAULT_ATLAS_API_BASE = 'https://testbeta-atlas-api.synergy-network.io';
const POLL_INTERVAL_MS = 8000;
const P2P_REJOIN_GRACE_SECS = 45;
const NWEI_PER_SNRG = 1000000000n;

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
  const networkHeight = nodeLive?.best_network_height ?? liveStatus?.public_chain_height;
  if (!nodeLive?.is_running) {
    return `Best observed network tip: ${formatNumber(networkHeight)}`;
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

function nodePeerCountDetail(nodeLive, liveStatus) {
  if (!nodeLive?.is_running) {
    return liveStatus?.public_peer_count != null
      ? `Public RPC reports ${formatNumber(liveStatus.public_peer_count)} visible peers.`
      : 'Public network peers';
  }
  if (nodeLive.local_rpc_ready === false) {
    return nodeLive?.local_rpc_status || 'Local RPC is not responding.';
  }
  if (nodeIsRejoiningPeers(nodeLive)) {
    return `Node restarted ${formatNumber(nodeLive?.process_uptime_secs)}s ago and is still rejoining the P2P mesh.`;
  }
  if (
    liveStatus?.public_peer_count != null
    && nodeLive?.local_peer_count != null
    && liveStatus.public_peer_count !== nodeLive.local_peer_count
  ) {
    return `This node sees ${formatNumber(nodeLive.local_peer_count)} local peers; public RPC sees ${formatNumber(liveStatus.public_peer_count)} visible peers.`;
  }
  return 'Live connected peers';
}

function nodeIsRejoiningPeers(nodeLive) {
  return Boolean(
    nodeLive?.is_running
      && (nodeLive?.local_peer_count ?? 0) === 0
      && (nodeLive?.process_uptime_secs ?? Number.MAX_SAFE_INTEGER) < P2P_REJOIN_GRACE_SECS,
  );
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

const ROLE_REWARD_STANDARD = Object.freeze({
  validator: {
    baseMonthlySnrg: '30,000',
    fundingSource: 'Consensus emissions + fee share',
    payoutEquation: 'P = floor((B + 12*PBk + 6*FQk + 0.04*SS) * U * Q * H * S * 1e9) - Pen',
    bondSlash: '5,000 SNRG minimum bond; 15% slash for equivocation; 5% slash for invalid state vote',
    minTier: 'T4 Sovereign',
  },
  witness: {
    baseMonthlySnrg: '15,000',
    fundingSource: 'Treasury subsidy + per-event service rewards',
    payoutEquation: 'P = floor((B + 10*WEk + 4*CFk) * U * Q * H * 1e9) - Pen',
    bondSlash: '1,250 SNRG bond; 8% slash cap for false witness evidence',
    minTier: 'T2 Performance',
  },
  data_availability: {
    baseMonthlySnrg: '10,000',
    fundingSource: 'Capacity stipend + retrieval rewards',
    payoutEquation: 'P = floor((B + 2*TBm + 0.6*RSk + 1.2*RPk) * U * Q * H * 1e9) - Pen',
    bondSlash: '1,500 SNRG bond; 8% slash cap for durability breach',
    minTier: 'T3 Performance',
  },
  rpc_gateway: {
    baseMonthlySnrg: '8,000',
    fundingSource: 'Usage fees + optional network rebate',
    payoutEquation: 'P = floor((B + 0.9*RQM + 6*ENT) * U * Q * H * 1e9) - Pen',
    bondSlash: '500 SNRG bond; 3% slash cap for persistent SLA abuse',
    minTier: 'T2 Performance',
  },
  indexer: {
    baseMonthlySnrg: '7,000',
    fundingSource: 'Usage fees + ecosystem data-service revenue',
    payoutEquation: 'P = floor((B + 0.8*QMk + 1.5*APIk) * U * Q * H * 1e9) - Pen',
    bondSlash: '500 SNRG bond; 3% slash cap for corruption or lag breach',
    minTier: 'T2 Performance',
  },
  archive_validator: {
    baseMonthlySnrg: '6,000',
    fundingSource: 'Capacity stipend + proof reconstruction fees',
    payoutEquation: 'P = floor((B + 1.5*TBm + 3*PRk) * U * Q * H * 1e9) - Pen',
    bondSlash: '750 SNRG bond; 4% slash cap for missing history segments',
    minTier: 'T3 Performance',
  },
  audit_validator: {
    baseMonthlySnrg: '5,000',
    fundingSource: 'Treasury-funded audit pool + bounty payments',
    payoutEquation: 'P = floor((B + 12*AN + 20*DV) * U * Q * H * 1e9) - Pen',
    bondSlash: '750 SNRG bond; 4% slash cap for material missed divergence',
    minTier: 'T2 Performance',
  },
  governance_auditor: {
    baseMonthlySnrg: '3,500',
    fundingSource: 'Treasury-funded governance assurance budget',
    payoutEquation: 'P = floor((B + 30*GP + 12*EV) * U * Q * H * 1e9) - Pen',
    bondSlash: '500 SNRG bond; 3% slash cap for scope-review failure',
    minTier: 'T2 Standard+',
  },
  ai_inference: {
    baseMonthlySnrg: '2,500',
    fundingSource: 'Grant-style treasury budget + service contracts',
    payoutEquation: 'P = floor((B + 8*SIMk + 25*AR) * U * Q * H * 1e9) - Pen',
    bondSlash: '250 SNRG bond; 2% slash cap for repeated stale output',
    minTier: 'T1 Standard',
  },
  observer: {
    baseMonthlySnrg: '1,000',
    fundingSource: 'Low-rate micro-reward pool',
    payoutEquation: 'P = floor((B + 0.2*PVk + 0.05*HPk) * U * H * 1e9) - Pen',
    bondSlash: 'No mandatory bond; optional reputation stake',
    minTier: 'T0 Bootstrap',
  },
});

function parseNwei(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));

  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!text) return 0n;

  try {
    return BigInt(text);
  } catch {
    if (!/^\d+(\.\d+)?$/.test(text)) return 0n;
    const [whole = '0', fraction = ''] = text.split('.');
    return (BigInt(whole || '0') * NWEI_PER_SNRG) + BigInt(`${fraction}000000000`.slice(0, 9));
  }
}

function formatDigits(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatSnrgFromNwei(value, options = {}) {
  const { decimals = 3, suffix = true } = options;
  const raw = parseNwei(value);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / NWEI_PER_SNRG;
  const fraction = abs % NWEI_PER_SNRG;
  const fractionText = decimals > 0
    ? fraction.toString().padStart(9, '0').slice(0, decimals).replace(/0+$/, '')
    : '';
  const formatted = `${negative ? '-' : ''}${formatDigits(whole.toString())}${fractionText ? `.${fractionText}` : ''}`;
  return suffix ? `${formatted} SNRG` : formatted;
}

function roleRewardStandard(roleId, fallbackDisplayName = 'Node') {
  return ROLE_REWARD_STANDARD[roleId] || {
    baseMonthlySnrg: 'Unavailable',
    fundingSource: `${fallbackDisplayName} compensation standard not loaded.`,
    payoutEquation: 'Not defined for this role in the current wallet view.',
    bondSlash: 'Refer to the ratified rewards standard.',
    minTier: 'N/A',
  };
}

function totalReservedNweiForNetwork(networkProfile, fallbackValue) {
  const manifests = Array.isArray(networkProfile?.funding_manifests) ? networkProfile.funding_manifests : [];
  const manifestTotal = manifests.reduce(
    (sum, manifest) => sum + parseNwei(manifest?.amount_nwei || manifest?.amount_snrg),
    0n,
  );
  if (manifestTotal > 0n) return manifestTotal;
  return parseNwei(fallbackValue);
}

function localRpcEndpointForNode(node, nodeLive) {
  if (nodeLive?.rpc_endpoint) return nodeLive.rpc_endpoint;
  const slot = Number(node?.port_slot || 0);
  return `http://127.0.0.1:${48638 + slot}`;
}

async function queryLocalRpc(endpoint, method, params = []) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error?.message || JSON.stringify(payload.error));
  return payload?.result;
}

function computeCatchUpStatus(nodeLive, networkHeight) {
  if (!nodeLive?.is_running) return 'Offline';
  if (nodeLive.local_rpc_ready === false) return nodeLive?.local_rpc_status || 'Local RPC is not responding.';
  if (nodeIsRejoiningPeers(nodeLive)) {
    return `Rejoining peers (${formatNumber(nodeLive?.process_uptime_secs)}s since restart)`;
  }
  if ((nodeLive?.sync_gap ?? 0) > 0) {
    return `Catching up (${formatNumber(nodeLive?.sync_gap)} blocks behind network tip ${formatNumber(networkHeight)})`;
  }
  return 'At chain head';
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
  const [portForm, setPortForm] = useState(() => formatPortSettingsForForm({}));
  const [portErrors, setPortErrors] = useState({});
  const [portBusy, setPortBusy] = useState(false);
  const [portNotice, setPortNotice] = useState('');
  const [portNoticeTone, setPortNoticeTone] = useState('good');
  const [configContents, setConfigContents] = useState('');
  const [activeTab, setActiveTab] = useState('overview');
  const [registerBusy, setRegisterBusy] = useState(false);
  const [registerMessage, setRegisterMessage] = useState('');
  const [registerTone, setRegisterTone] = useState('good');
  const [registerRestartFirst, setRegisterRestartFirst] = useState(false);
  const [walletSnapshot, setWalletSnapshot] = useState(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const portFields = useMemo(() => getTestnetBetaPortFields(), []);

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
  const totalReservedNwei = useMemo(
    () => totalReservedNweiForNetwork(network, state?.summary?.total_sponsored_stake_nwei),
    [network, state?.summary?.total_sponsored_stake_nwei],
  );
  const isRunning = Boolean(nodeLive?.is_running);
  const runtimeLabel = nodeRuntimeLabel(nodeLive);
  const runtimeTone = nodeRuntimeTone(nodeLive);
  const nodeTomlPath = node?.config_paths?.find((p) => p.endsWith('/node.toml')) || node?.config_paths?.[0];
  const nginxConfPath = node ? resolveNginxConfPath(node) : null;

  const loadConfigArtifacts = useCallback(async (targetNode) => {
    if (!targetNode) {
      setPortSettings(null);
      setPortForm(formatPortSettingsForForm({}));
      setConfigContents('');
      return;
    }

    try {
      const ports = await readTestnetBetaNodePortSettings(targetNode);
      setPortSettings(ports?.portSettings || null);
      setPortForm(formatPortSettingsForForm(ports?.portSettings || {}));
    } catch {
      setPortSettings(null);
      setPortForm(formatPortSettingsForForm({}));
    }

    try {
      const targetNodeTomlPath = targetNode.config_paths?.find((p) => p.endsWith('/node.toml'));
      if (targetNodeTomlPath) {
        const contents = await readTextFile(targetNodeTomlPath);
        setConfigContents(contents || '');
      } else {
        setConfigContents('');
      }
    } catch {
      setConfigContents('');
    }
  }, []);

  // Load port settings and config when node is selected
  useEffect(() => {
    if (!node) {
      loadConfigArtifacts(null);
      return;
    }
    setPortErrors({});
    setPortNotice('');
    setPortNoticeTone('good');
    loadConfigArtifacts(node);
  }, [loadConfigArtifacts, node]);

  useEffect(() => {
    if (activeTab !== 'wallet' || !node) {
      setWalletSnapshot(null);
      setWalletLoading(false);
      return undefined;
    }

    let cancelled = false;

    const loadWalletSnapshot = async () => {
      setWalletLoading(true);
      const endpoint = localRpcEndpointForNode(node, nodeLive);
      const reservedNwei = parseNwei(
        fundingManifest?.amount_nwei || fundingManifest?.amount_snrg || 0,
      );

      let walletBalanceNwei = 0n;
      let realizedEarnedNwei = 0n;
      let pendingRewardsNwei = 0n;
      let stakingEntryCount = 0;
      let lastError = '';

      try {
        const balances = await queryLocalRpc(endpoint, 'synergy_getAllBalances', [node.node_address]);
        walletBalanceNwei = parseNwei(balances?.SNRG);
      } catch (walletError) {
        lastError = String(walletError);
      }

      try {
        const stakingInfo = await queryLocalRpc(endpoint, 'synergy_getStakingInfo', [node.node_address]);
        const entries = Array.isArray(stakingInfo) ? stakingInfo : [];
        stakingEntryCount = entries.length;
        realizedEarnedNwei = entries.reduce(
          (sum, entry) => sum + parseNwei(entry?.rewards_earned),
          0n,
        );
      } catch (stakingError) {
        if (!lastError) lastError = String(stakingError);
      }

      try {
        const validatorStats = await queryLocalRpc(endpoint, 'synergy_getValidatorStats', []);
        pendingRewardsNwei = parseNwei(validatorStats?.epoch_rewards?.[node.node_address]);
      } catch (validatorError) {
        if (!lastError) lastError = String(validatorError);
      }

      const derivedEarnedNwei = walletBalanceNwei > reservedNwei
        ? walletBalanceNwei - reservedNwei
        : 0n;
      const earnedRewardsNwei = realizedEarnedNwei > derivedEarnedNwei
        ? realizedEarnedNwei
        : derivedEarnedNwei;
      const lifetimeRewardsNwei = earnedRewardsNwei + pendingRewardsNwei;

      if (!cancelled) {
        setWalletSnapshot({
          endpoint,
          walletBalanceNwei: walletBalanceNwei.toString(),
          reservedNwei: reservedNwei.toString(),
          earnedRewardsNwei: earnedRewardsNwei.toString(),
          pendingRewardsNwei: pendingRewardsNwei.toString(),
          lifetimeRewardsNwei: lifetimeRewardsNwei.toString(),
          stakingEntryCount,
          lastError,
        });
        setWalletLoading(false);
      }
    };

    loadWalletSnapshot();
    const intervalId = window.setInterval(loadWalletSnapshot, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeTab, fundingManifest?.amount_nwei, fundingManifest?.amount_snrg, node, nodeLive]);

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

  const handlePortFieldChange = useCallback((key, value) => {
    setPortForm((current) => ({
      ...current,
      [key]: value,
    }));
    setPortErrors((current) => {
      if (!current[key]) {
        return current;
      }

      const nextErrors = { ...current };
      delete nextErrors[key];
      return nextErrors;
    });
  }, []);

  const handleApplyNodePorts = useCallback(async () => {
    if (!node) {
      return;
    }

    const validation = validateTestnetBetaPortSettingsForm(portForm);
    setPortErrors(validation.errors);
    if (!validation.ok || !validation.value) {
      setPortNoticeTone('bad');
      setPortNotice('Fix the port validation errors before saving the node configuration.');
      return;
    }

    setPortBusy(true);
    try {
      const result = await applyTestnetBetaPortSettings(node, validation.value);
      await loadConfigArtifacts(node);
      await fetchData(true);
      setPortNoticeTone('good');
      setPortNotice(
        `Updated ${formatPortSettingsSummary(result.portSettings)}. Wrote ${result.updatedFiles.map((path) => path.split('/').slice(-1)[0]).join(', ')}. Restart the node so the new ports take effect.`,
      );
    } catch (applyError) {
      setPortNoticeTone('bad');
      setPortNotice(`Failed to update this node's ports: ${String(applyError)}`);
    } finally {
      setPortBusy(false);
    }
  }, [fetchData, loadConfigArtifacts, node, portForm]);

  const handleRegisterWithSeeds = async () => {
    if (!node) return;
    setRegisterBusy(true);
    setRegisterMessage('');
    try {
      if (registerRestartFirst) {
        await invoke('testbeta_node_control', { input: { nodeId: node.id, action: 'stop' } });
        await new Promise((resolve) => { window.setTimeout(resolve, 2000); });
        await invoke('testbeta_node_control', { input: { nodeId: node.id, action: 'start' } });
        await new Promise((resolve) => { window.setTimeout(resolve, 3000); });
      }
      const result = await invoke('testbeta_run_register_with_seeds', { nodeId: node.id });
      setRegisterTone('good');
      setRegisterMessage(result || 'Registered successfully with all seed servers.');
      await fetchData(true);
    } catch (e) {
      setRegisterTone('bad');
      setRegisterMessage(String(e));
    } finally {
      setRegisterBusy(false);
    }
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

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'connectivity', label: 'Connectivity' },
    { id: 'wallet', label: 'Wallet & Rewards' },
    { id: 'config', label: 'Configuration' },
    { id: 'files', label: 'Files' },
  ];
  const syncLabel = node?.role_id === 'validator' ? 'Rejoin' : 'Speed Sync';

  const renderOverview = () => {
    const rejoiningPeers = nodeIsRejoiningPeers(nodeLive);
    const zeroPeersRunning = isRunning && (nodeLive?.local_peer_count ?? 0) === 0 && !rejoiningPeers;
    const publicHeight = liveStatus?.public_chain_height;
    const networkHeight = nodeLive?.best_network_height ?? publicHeight;
    const networkVisiblePeerCount = liveStatus?.network_peer_count
      ?? explorerData?.total_validators
      ?? liveStatus?.public_peer_count
      ?? null;
    return (
    <div className="nodedetail-tab-stack">
      {rejoiningPeers && (
        <div className="nodecp-alert nodecp-alert-info">
          <strong>Rejoining peers</strong> — this node restarted {formatNumber(nodeLive?.process_uptime_secs)} seconds ago and is still reconnecting to the P2P mesh.
          {liveStatus?.public_peer_count != null
            ? ` Public RPC currently reports ${formatNumber(liveStatus.public_peer_count)} visible peers while the local node catches back up.`
            : ''}
        </div>
      )}
      {/* Zero-peer warning */}
      {zeroPeersRunning && (
        <div className="nodecp-alert nodecp-alert-warn">
          <strong>⚠ 0 local peers detected</strong> — this node is running but sees no P2P connections and cannot sync.
          {liveStatus?.public_peer_count != null
            ? ` Public RPC still reports ${formatNumber(liveStatus.public_peer_count)} visible peers, which means the wider network is up but this node is isolated.`
            : ''}
          Verify that port 38638 is open in your firewall and reachable from the internet.
          Check the Connectivity tab for bootnode and seed server health.
        </div>
      )}
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
            <span className="nodecp-stat-label">Peers</span>
            <strong className="nodecp-stat-value">{formatNumber(networkVisiblePeerCount)}</strong>
            <span className="nodecp-stat-detail">
              {liveStatus?.network_peer_count != null
                ? 'Active peers registered with seed services and currently reachable on the network.'
                : 'Waiting for a live bootstrap peer count from the seed services.'}
            </span>
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
            <span className="nodecp-summary-label">Local / Public Block Height</span>
            <p>
              {formatNumber(nodeLive?.local_chain_height)}
              {' / '}
              {pubHeight != null ? formatNumber(pubHeight) : 'N/A'}
            </p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Peers</span>
            <p>{networkVisiblePeerCount != null ? formatNumber(networkVisiblePeerCount) : 'N/A'}</p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Local Peer Count</span>
            <p>
              {nodeLive?.local_peer_count != null ? (
                <span className={zeroPeersRunning ? 'nodecp-warn-text' : ''}>
                  {zeroPeersRunning ? '⚠ ' : ''}{nodeLive.local_peer_count}
                </span>
              ) : '—'}
            </p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Public RPC Status</span>
            <p>
              <span className={`nodecp-health-pill nodecp-health-${liveStatus?.public_rpc_online ? 'ok' : 'error'}`}>
                {liveStatus?.public_rpc_online ? 'Online' : 'Offline'}
              </span>
            </p>
          </div>
          <div className="nodecp-summary-block">
            <span className="nodecp-summary-label">Discovery Status</span>
            <p>{liveStatus?.discovery_status || 'Unknown'}</p>
          </div>
          {explorerData?.total_validators != null && (
            <div className="nodecp-summary-block">
              <span className="nodecp-summary-label">Total Validators</span>
              <p>{formatNumber(explorerData.total_validators)}</p>
            </div>
          )}
          {explorerData?.total_transactions != null && (
            <div className="nodecp-summary-block">
              <span className="nodecp-summary-label">Total Transactions</span>
              <p>{formatNumber(explorerData.total_transactions)}</p>
            </div>
          )}
        </div>
      </section>
    </div>
    );
  };

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
            <div className="nodecp-definition-row">
              <span>Peers</span>
              <strong>{formatNumber(networkVisiblePeerCount)}</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  );

  const renderWallet = () => {
    const rewardStandard = roleRewardStandard(node.role_id, node.role_display_name);
    const catchUpStatus = computeCatchUpStatus(nodeLive, networkHeight);
    const snapshot = walletSnapshot || {};

    return (
      <div className="nodedetail-tab-stack">
        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Wallet telemetry</p>
              <h3>Rewards &amp; Catch-Up</h3>
            </div>
          </div>
          <div className="nodecp-inline-status">
            <span className={`nodecp-health-pill nodecp-health-${walletLoading ? 'warn' : 'good'}`}>
              {walletLoading ? 'Refreshing' : 'Live'}
            </span>
            <span>
              {walletLoading
                ? 'Refreshing wallet and reward telemetry from local node RPC.'
                : 'Wallet and reward telemetry refreshed from local RPC and validator stats.'}
            </span>
          </div>
        </section>

        <section className="nodecp-panel nodecp-wallet-slot">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">{node.display_label || node.role_display_name}</p>
              <h3>{node.role_display_name}</h3>
            </div>
            <span className={`nodecp-health-pill nodecp-health-${nodeRuntimeTone(nodeLive)}`}>
              {nodeRuntimeLabel(nodeLive)}
            </span>
          </div>

          <div className="nodecp-wallet-slot-grid">
            <div className="nodecp-summary-block">
              <span className="nodecp-summary-label">Identity & Catch-Up</span>
              <div className="nodecp-definition-list">
                <div className="nodecp-definition-row">
                  <span>Node type</span>
                  <strong>{node.role_display_name}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Full node address</span>
                  <strong className="nodecp-wallet-address">{node.node_address}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Reward payout address</span>
                  <strong className="nodecp-wallet-address">{node.reward_payout_address || node.node_address}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Catch-up status</span>
                  <strong>{catchUpStatus}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Local / public RPC / network tip</span>
                  <strong>{formatNumber(nodeLive?.local_chain_height)} / {formatNumber(publicHeight)} / {formatNumber(networkHeight)}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Peer count / sync gap</span>
                  <strong>{formatNumber(nodeLive?.local_peer_count)} peers / {formatNumber(nodeLive?.sync_gap)} blocks</strong>
                </div>
                {(publicHeight != null && networkHeight != null && networkHeight > publicHeight) && (
                  <div className="nodecp-definition-row">
                    <span>Network tip source</span>
                    <strong>Peers report {formatNumber(networkHeight)} while public RPC is at {formatNumber(publicHeight)}</strong>
                  </div>
                )}
                <div className="nodecp-definition-row">
                  <span>Synergy score</span>
                  <strong>{formatScoreOutOfHundred(nodeLive?.synergy_score)}</strong>
                </div>
              </div>
            </div>

            <div className="nodecp-summary-block">
              <span className="nodecp-summary-label">Live Rewards</span>
              <div className="nodecp-definition-list">
                <div className="nodecp-definition-row">
                  <span>Wallet balance</span>
                  <strong>{formatSnrgFromNwei(snapshot.walletBalanceNwei)}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Reserved stake</span>
                  <strong>{formatSnrgFromNwei(snapshot.reservedNwei || fundingManifest?.amount_nwei || fundingManifest?.amount_snrg || 0)}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Total reserved (network)</span>
                  <strong>{formatSnrgFromNwei(totalReservedNwei)}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Earned rewards</span>
                  <strong>{formatSnrgFromNwei(snapshot.earnedRewardsNwei)}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Pending rewards</span>
                  <strong>{formatSnrgFromNwei(snapshot.pendingRewardsNwei)}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Lifetime rewards</span>
                  <strong>{formatSnrgFromNwei(snapshot.lifetimeRewardsNwei)}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Reward telemetry</span>
                  <strong>{snapshot.lastError ? `Partial data (${snapshot.lastError})` : 'Local RPC + validator stats'}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Funding manifest</span>
                  <strong>{fundingManifest?.id || 'N/A'}</strong>
                </div>
              </div>
              <div className="nodecp-settings-actions nodecp-settings-actions-tight">
                <SNRGButton variant="yellow" size="sm" disabled title="Reward withdrawals are not enabled yet.">
                  Withdraw Rewards
                </SNRGButton>
              </div>
            </div>

            <div className="nodecp-summary-block">
              <span className="nodecp-summary-label">Role Economics</span>
              <div className="nodecp-definition-list">
                <div className="nodecp-definition-row">
                  <span>Base monthly rewards</span>
                  <strong>{rewardStandard.baseMonthlySnrg} SNRG</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Funding source</span>
                  <strong>{rewardStandard.fundingSource}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Minimum tier</span>
                  <strong>{rewardStandard.minTier}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Bond / slash</span>
                  <strong>{rewardStandard.bondSlash}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Monthly payout equation</span>
                  <strong className="nodecp-wallet-formula">{rewardStandard.payoutEquation}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Stake vault wallet</span>
                  <strong className="nodecp-wallet-address">{fundingManifest?.stake_vault_wallet || 'N/A'}</strong>
                </div>
                <div className="nodecp-definition-row">
                  <span>Source treasury</span>
                  <strong className="nodecp-wallet-address">{fundingManifest?.source_wallet || 'N/A'}</strong>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  };

  const renderConfig = () => (
    <div className="nodedetail-tab-stack">
      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Port configuration</p>
            <h3>Managed Node Ports</h3>
          </div>
        </div>
        <p className="nodecp-panel-copy">
          Update the ports this specific node uses. This writes the workspace&apos;s
          <code> node.toml </code>
          directly and also updates the generated
          <code> nginx.conf </code>
          when that file exists for public RPC roles.
        </p>
        <div className="monitor-form-grid monitor-form-grid-wide">
          {portFields.map((field) => (
            <label key={field.key} className="monitor-field">
              <span>{field.label} Port</span>
              <input
                type="number"
                min="1"
                max="65535"
                inputMode="numeric"
                value={portForm[field.key] ?? ''}
                onChange={(event) => handlePortFieldChange(field.key, event.target.value)}
              />
              <span className="nodecp-settings-field-detail">{field.detail}</span>
              {portErrors[field.key] ? (
                <span className="nodecp-settings-field-error">{portErrors[field.key]}</span>
              ) : null}
            </label>
          ))}
        </div>
        <div className="nodecp-controls-status">
          <span>Current profile: {portSettings ? formatPortSettingsSummary(portSettings) : 'Reading node ports...'}</span>
          <span>Managed files: {nginxConfPath ? 'node.toml + nginx.conf' : 'node.toml'}</span>
        </div>
        <div className="nodecp-settings-actions nodecp-settings-actions-tight">
          <SNRGButton
            variant="lime"
            size="sm"
            disabled={portBusy}
            onClick={handleApplyNodePorts}
          >
            {portBusy ? 'Saving...' : 'Save Ports'}
          </SNRGButton>
          <SNRGButton
            variant="blue"
            size="sm"
            disabled={portBusy}
            onClick={() => {
              setPortErrors({});
              setPortNotice('');
              setPortNoticeTone('good');
              setPortForm(formatPortSettingsForForm(portSettings || {}));
            }}
          >
            Reload Current
          </SNRGButton>
        </div>
        {portNotice ? (
          <div className="nodecp-controls-status">
            <span className={`nodecp-health-pill nodecp-health-${portNoticeTone}`}>
              {portNoticeTone === 'good' ? 'Saved' : 'Error'}
            </span>
            <span>{portNotice}</span>
          </div>
        ) : null}
      </section>

      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">P2P seed discovery</p>
            <h3>Register with Seeds</h3>
          </div>
        </div>
        <p className="nodecp-panel-copy">
          Re-register this node&apos;s public endpoint with the network&apos;s seed servers. Seed
          servers distribute your node&apos;s address to peers discovering the network. Run this
          after changing your P2P port or public IP address, or if this node is not appearing in
          peer lists.
        </p>
        <div className="nodecp-settings-actions nodecp-settings-actions-tight" style={{ marginBottom: '0.75rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={registerRestartFirst}
              onChange={(e) => setRegisterRestartFirst(e.target.checked)}
              disabled={registerBusy}
            />
            Stop and restart node before registering
          </label>
        </div>
        <div className="nodecp-settings-actions nodecp-settings-actions-tight">
          <SNRGButton
            variant="lime"
            size="sm"
            disabled={registerBusy}
            onClick={handleRegisterWithSeeds}
          >
            {registerBusy ? 'Registering...' : 'Register with Seeds'}
          </SNRGButton>
        </div>
        {registerMessage ? (
          <div className="nodecp-controls-status" style={{ marginTop: '0.75rem' }}>
            <span className={`nodecp-health-pill nodecp-health-${registerTone}`}>
              {registerTone === 'good' ? 'Done' : 'Error'}
            </span>
            <span>{registerMessage}</span>
          </div>
        ) : null}
      </section>

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
            <span>{controlBusy === 'sync' ? `${syncLabel}ing...` : syncLabel}</span>
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
                : `Running (PID ${nodeLive?.pid || '?'}) \u2022 ${formatNumber(nodeLive?.local_peer_count ?? 0)} local peers \u2022 Block ${formatNumber(nodeLive?.local_chain_height)}`)
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
