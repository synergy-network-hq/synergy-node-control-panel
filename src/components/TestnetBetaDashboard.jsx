import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke, openPath } from '../lib/desktopClient';
import { useDeveloperMode } from '../lib/developerMode';
import {
  applyStoredTestnetBetaPortSettings,
  formatPortSettingsSummary,
  refreshTestnetBetaBootstrapConfig,
} from '../lib/testnetBetaBootstrap';
import { SNRGButton } from '../styles/SNRGButton';

const COMMON_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'connectivity', label: 'Connectivity' },
  { id: 'wallet', label: 'Rewards' },
  { id: 'files', label: 'Files' },
  { id: 'chain', label: 'Chain' },
  { id: 'logs', label: 'Logs' },
];
const MAX_NODE_SLOTS = 4;
const DEFAULT_ATLAS_API_BASE = 'https://testbeta-atlas-api.synergy-network.io';
const NWEI_PER_SNRG = 1000000000n;

async function fetchExplorerJson(baseUrl, path, timeoutMs = 5000) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, { signal: controller.signal });
    if (!response.ok) return null;
    return response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

function Icon({ children }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const ICONS = {
  node: (
    <Icon>
      <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
      <path d="M12 12 4 7.5" />
      <path d="M12 12l8-4.5" />
      <path d="M12 12v9" />
    </Icon>
  ),
  stake: (
    <Icon>
      <path d="M12 3v18" />
      <path d="M17 7.5c0-1.9-2.2-3.5-5-3.5S7 5.6 7 7.5 9.2 11 12 11s5 1.6 5 3.5S14.8 18 12 18s-5-1.6-5-3.5" />
    </Icon>
  ),
  score: (
    <Icon>
      <path d="M4 14h4l2-7 4 10 2-5h4" />
    </Icon>
  ),
  wallet: (
    <Icon>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5.5A2.5 2.5 0 0 1 3 16.5v-9Z" />
      <path d="M16 12h3" />
      <circle cx="16" cy="12" r="1" />
    </Icon>
  ),
  chain: (
    <Icon>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <rect x="3" y="10" width="18" height="5" rx="1.5" />
      <rect x="3" y="16" width="18" height="5" rx="1.5" />
    </Icon>
  ),
  peers: (
    <Icon>
      <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <circle cx="9.5" cy="7" r="3" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 4.13a4 4 0 0 1 0 7.75" />
    </Icon>
  ),
  pulse: (
    <Icon>
      <path d="M4 12h3l2-4 4 8 2-4h5" />
    </Icon>
  ),
  folder: (
    <Icon>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" />
    </Icon>
  ),
  file: (
    <Icon>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
    </Icon>
  ),
  copy: (
    <Icon>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  ),
  refresh: (
    <Icon>
      <path d="M20 11a8 8 0 1 0 2 5.3" />
      <path d="M20 4v7h-7" />
    </Icon>
  ),
  play: (
    <Icon>
      <path d="m8 5 11 7-11 7V5Z" />
    </Icon>
  ),
  stop: (
    <Icon>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Icon>
  ),
  sync: (
    <Icon>
      <path d="M3 12a9 9 0 0 1 15.3-6.36L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.3 6.36L3 16" />
      <path d="M8 16H3v5" />
    </Icon>
  ),
  shield: (
    <Icon>
      <path d="M12 3 5 6v6c0 5 3 7 7 9 4-2 7-4 7-9V6l-7-3Z" />
      <path d="m9.5 12 1.8 1.8 3.2-3.6" />
    </Icon>
  ),
};

function truncateAddress(value, prefix = 6, suffix = 5) {
  const text = String(value || '').trim();
  if (!text) return 'Not available';
  if (text.length <= prefix + suffix) return text;
  return `${text.slice(0, prefix)}...${text.slice(-suffix)}`;
}

function formatWholeSnrg(value) {
  const number = Number.parseFloat(String(value || '0'));
  if (!Number.isFinite(number)) {
    return '0';
  }
  return Math.round(number).toLocaleString();
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 'Not available';
  }
  return number.toLocaleString();
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toTimestampMs(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatScore(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return 'Not available';
  }
  return Number(value).toFixed(1);
}

function formatScoreOutOfHundred(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return 'N/A';
  }
  return `${Number(value).toFixed(1)}/100`;
}

function formatCompactScoreOutOfHundred(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return 'N/A / 100';
  }
  return `${Math.round(Number(value))}/100`;
}

function roleTypeLabel(roleDisplayName) {
  const value = String(roleDisplayName || '').trim();
  if (!value) return 'Unknown';
  return value.replace(/\s+node$/i, '').trim();
}

function classTierLabel(role) {
  const classId = Number(role?.class_id || 0);
  if (!Number.isFinite(classId) || classId < 1 || classId > 5) {
    return 'Class Unknown';
  }
  const roman = ['I', 'II', 'III', 'IV', 'V'];
  return `Class ${roman[classId - 1]}`;
}

function formatStatusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value.includes('online') || value.includes('live') || value.includes('running') || value.includes('ready')) return 'good';
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

function effectiveLocalChainHeight(nodeLive) {
  return nodeLive?.local_chain_height ?? nodeLive?.log_local_chain_height ?? null;
}

function maxDefined(values) {
  const numeric = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!numeric.length) return null;
  return Math.max(...numeric);
}

function nodeBlockHeightValue(nodeLive, liveStatus) {
  if (nodeLive?.is_running) {
    return effectiveLocalChainHeight(nodeLive);
  }
  return effectiveLocalChainHeight(nodeLive) ?? liveStatus?.public_chain_height;
}


function nodeBlockHeightDetail(nodeLive, liveStatus) {
  if (!nodeLive?.is_running) {
    return `Public chain currently reports ${formatNumber(liveStatus?.public_chain_height)} blocks`;
  }
  if (nodeLive.local_rpc_ready === false) {
    return nodeLive?.local_rpc_status || 'Local RPC is not responding.';
  }
  return `${formatNumber(nodeLive?.sync_gap ?? 0)} blocks behind the live chain`;
}


function latencyLabel(entry) {
  if (!entry?.reachable || entry?.latency_ms == null) {
    return entry?.detail || 'Unavailable';
  }
  return `${entry.latency_ms} ms`;
}

function formatPeerLastSeen(value) {
  const numeric = toFiniteNumber(value);
  if (numeric == null || numeric <= 0) {
    return 'Unknown';
  }

  const milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
  const timestamp = new Date(milliseconds);
  if (Number.isNaN(timestamp.getTime())) {
    return 'Unknown';
  }

  return timestamp.toLocaleString();
}

function choosePreferredPeerAddress(currentAddress, nextAddress, publicAddress) {
  const current = String(currentAddress || '').trim();
  const next = String(nextAddress || '').trim();
  const announced = String(publicAddress || '').trim();

  if (announced) {
    if (next === announced) return next;
    if (current === announced) return current;
  }

  return current || next;
}

function mergePeerEntries(current, next) {
  const publicAddress = current.publicAddress || next.publicAddress;
  return {
    id: current.id,
    address: choosePreferredPeerAddress(current.address, next.address, publicAddress),
    nodeId: current.nodeId || next.nodeId,
    publicAddress,
    validatorAddress: current.validatorAddress || next.validatorAddress,
    version: current.version || next.version,
    capabilities: Array.from(new Set([...current.capabilities, ...next.capabilities])),
    lastSeen: Math.max(current.lastSeen ?? 0, next.lastSeen ?? 0) || null,
    blocksSent: Math.max(current.blocksSent, next.blocksSent),
    blocksReceived: Math.max(current.blocksReceived, next.blocksReceived),
    txsSent: Math.max(current.txsSent, next.txsSent),
    txsReceived: Math.max(current.txsReceived, next.txsReceived),
  };
}

function normalizePeerInfoPayload(raw) {
  const peers = Array.isArray(raw?.peers) ? raw.peers : [];
  const dedupedPeers = new Map();

  peers.forEach((peer, index) => {
    const normalized = {
      id: String(
        peer?.validator_address
          || peer?.node_id
          || peer?.public_address
          || peer?.address
          || `peer-${index}`,
      ).trim(),
      address: String(peer?.address || '').trim(),
      nodeId: String(peer?.node_id || '').trim(),
      publicAddress: String(peer?.public_address || '').trim(),
      validatorAddress: String(peer?.validator_address || '').trim(),
      version: String(peer?.version || '').trim(),
      capabilities: Array.isArray(peer?.capabilities)
        ? peer.capabilities.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [],
      lastSeen: toFiniteNumber(peer?.last_seen),
      blocksSent: toFiniteNumber(peer?.blocks_sent) ?? 0,
      blocksReceived: toFiniteNumber(peer?.blocks_received) ?? 0,
      txsSent: toFiniteNumber(peer?.txs_sent) ?? 0,
      txsReceived: toFiniteNumber(peer?.txs_received) ?? 0,
    };

    const existing = dedupedPeers.get(normalized.id);
    dedupedPeers.set(
      normalized.id,
      existing ? mergePeerEntries(existing, normalized) : normalized,
    );
  });

  const normalizedPeers = Array.from(dedupedPeers.values()).sort((left, right) => {
    const leftSeen = left.lastSeen ?? 0;
    const rightSeen = right.lastSeen ?? 0;
    if (rightSeen !== leftSeen) {
      return rightSeen - leftSeen;
    }
    return left.id.localeCompare(right.id);
  });

  return {
    peerCount: normalizedPeers.length,
    peers: normalizedPeers,
  };
}

function rewardProfileForRole(role) {
  const classId = Number(role?.class_id || 0);

  switch (classId) {
    case 1:
      return {
        tier: 'High',
        multiplier: '1.45x base',
        summary: 'Consensus-heavy roles earn the largest SNRG share because they keep the chain producing and finalizing blocks.',
        sources: [
          'Block production participation',
          'Consensus availability and uptime',
          'Cluster coordination quality',
        ],
      };
    case 2:
      return {
        tier: 'Elevated',
        multiplier: '1.25x base',
        summary: 'Cross-system coordination roles earn above-base rewards for relaying, verification, and external event handling.',
        sources: [
          'Relay or witness participation',
          'Verification throughput',
          'Cross-service responsiveness',
        ],
      };
    case 3:
      return {
        tier: 'Standard',
        multiplier: '1.10x base',
        summary: 'Compute and data roles earn for processing workloads, serving data, and maintaining specialized services.',
        sources: [
          'Workload completion',
          'Data integrity and availability',
          'Service reliability',
        ],
      };
    case 4:
      return {
        tier: 'Stewardship',
        multiplier: '1.00x base',
        summary: 'Governance and treasury roles earn for oversight, review, and policy execution.',
        sources: [
          'Review and approval participation',
          'Policy execution',
          'Operational continuity',
        ],
      };
    case 5:
      return {
        tier: 'Service',
        multiplier: '0.85x base',
        summary: 'Access and indexing roles still earn SNRG, but their rewards are weighted more toward uptime and query service quality.',
        sources: [
          'RPC or data service uptime',
          'Query responsiveness',
          'Operator-facing reliability',
        ],
      };
    default:
      return {
        tier: 'Standard',
        multiplier: '1.00x base',
        summary: 'This role earns SNRG when it stays online and performs its assigned bounded services.',
        sources: ['Uptime', 'Assigned service quality'],
      };
  }
}

const ROLE_REWARD_STANDARD = Object.freeze({
  validator: {
    baseMonthlySnrg: '30,000',
    fundingSource: 'Consensus emissions + fee share',
    bondSlash: '5,000 SNRG minimum bond; 15% slash for equivocation; 5% slash for invalid state vote',
    minTier: 'T4 Sovereign',
  },
  witness: {
    baseMonthlySnrg: '15,000',
    fundingSource: 'Treasury subsidy + per-event service rewards',
    bondSlash: '1,250 SNRG bond; 8% slash cap for false witness evidence',
    minTier: 'T2 Performance',
  },
  data_availability: {
    baseMonthlySnrg: '10,000',
    fundingSource: 'Capacity stipend + retrieval rewards',
    bondSlash: '1,500 SNRG bond; 8% slash cap for durability breach',
    minTier: 'T3 Performance',
  },
  rpc_gateway: {
    baseMonthlySnrg: '8,000',
    fundingSource: 'Usage fees + optional network rebate',
    bondSlash: '500 SNRG bond; 3% slash cap for persistent SLA abuse',
    minTier: 'T2 Performance',
  },
  indexer: {
    baseMonthlySnrg: '7,000',
    fundingSource: 'Usage fees + ecosystem data-service revenue',
    bondSlash: '500 SNRG bond; 3% slash cap for corruption or lag breach',
    minTier: 'T2 Performance',
  },
  archive_validator: {
    baseMonthlySnrg: '6,000',
    fundingSource: 'Capacity stipend + proof reconstruction fees',
    bondSlash: '750 SNRG bond; 4% slash cap for missing history segments',
    minTier: 'T3 Performance',
  },
  audit_validator: {
    baseMonthlySnrg: '5,000',
    fundingSource: 'Treasury-funded audit pool + bounty payments',
    bondSlash: '750 SNRG bond; 4% slash cap for material missed divergence',
    minTier: 'T2 Performance',
  },
  governance_auditor: {
    baseMonthlySnrg: '3,500',
    fundingSource: 'Treasury-funded governance assurance budget',
    bondSlash: '500 SNRG bond; 3% slash cap for scope-review failure',
    minTier: 'T2 Standard+',
  },
  ai_inference: {
    baseMonthlySnrg: '2,500',
    fundingSource: 'Grant-style treasury budget + service contracts',
    bondSlash: '250 SNRG bond; 2% slash cap for repeated stale output',
    minTier: 'T1 Standard',
  },
  observer: {
    baseMonthlySnrg: '1,000',
    fundingSource: 'Low-rate micro-reward pool',
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
    if (!/^\d+(\.\d+)?$/.test(text)) {
      return 0n;
    }
    const [whole = '0', fraction = ''] = text.split('.');
    return (BigInt(whole || '0') * NWEI_PER_SNRG)
      + BigInt(`${fraction}000000000`.slice(0, 9));
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
    ? fraction
      .toString()
      .padStart(9, '0')
      .slice(0, decimals)
      .replace(/0+$/, '')
    : '';
  const formatted = `${negative ? '-' : ''}${formatDigits(whole.toString())}${fractionText ? `.${fractionText}` : ''}`;
  return suffix ? `${formatted} SNRG` : formatted;
}

function localRpcEndpointForNode(node, nodeLive) {
  if (nodeLive?.rpc_endpoint) return nodeLive.rpc_endpoint;
  const slot = Number(node?.port_slot || 0);
  return `http://127.0.0.1:${5640 + slot}`;
}

async function queryLocalRpc(endpoint, method, params = []) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`${method} returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload?.error) {
    throw new Error(payload.error?.message || JSON.stringify(payload.error));
  }
  return payload?.result;
}

function roleRewardStandard(roleId, fallbackDisplayName = 'Node') {
  return ROLE_REWARD_STANDARD[roleId] || {
    baseMonthlySnrg: 'Unavailable',
    fundingSource: `${fallbackDisplayName} compensation standard not loaded.`,
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
  if (manifestTotal > 0n) {
    return manifestTotal;
  }
  return parseNwei(fallbackValue);
}

function computeCatchUpStatus(nodeLive, networkHeight) {
  if (!nodeLive?.is_running) {
    return 'Offline';
  }
  if (nodeLive.local_rpc_ready === false) {
    return nodeLive?.local_rpc_status || 'Local RPC is not responding.';
  }
  if ((nodeLive?.sync_gap ?? 0) > 0) {
    return `Catching up (${formatNumber(nodeLive?.sync_gap)} blocks behind network tip ${formatNumber(networkHeight)})`;
  }
  return 'At chain head';
}

function tabsForRole(_role) {
  return [
    { id: 'overview', label: 'Overview' },
    { id: 'connectivity', label: 'Connectivity' },
    { id: 'wallet', label: 'Wallet & Rewards' },
    { id: 'files', label: 'Files' },
    { id: 'chain', label: 'Chain' },
    { id: 'logs', label: 'Logs' },
  ];
}

function nodeWorkspaceStatus(nodeLive) {
  if (!nodeLive) {
    return {
      label: 'Configured',
      detail: 'Workspace files are ready for this node.',
    };
  }

  if (nodeLive.is_running) {
    return {
      label: 'Running',
      detail: `Local runtime is active${nodeLive.pid ? ` (PID ${nodeLive.pid})` : ''}.`,
    };
  }

  if (nodeLive.runtime_report_present) {
    return {
      label: 'Started Before',
      detail: 'This workspace already contains a runtime report from a previous node launch.',
    };
  }

  if (nodeLive.workspace_ready && nodeLive.config_ready) {
    return {
      label: 'Ready',
      detail: 'Workspace, keys, and config files are in place.',
    };
  }

  return {
    label: 'Needs Attention',
    detail: 'Some required workspace files are missing.',
  };
}

// Module-level cache so navigate-back renders instantly with last-known data
let _cachedState = null;
let _cachedLiveStatus = null;

export function clearTestnetBetaDashboardCache() {
  _cachedState = null;
  _cachedLiveStatus = null;
}

function TestnetBetaDashboard({ onLaunchSetup }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [developerModeEnabled] = useDeveloperMode();
  const [state, setState] = useState(_cachedState);
  const [liveStatus, setLiveStatus] = useState(_cachedLiveStatus);
  const [relayerHealth, setRelayerHealth] = useState(null);
  const [sxcpStatus, setSxcpStatus] = useState(null);
  const [sxcpError, setSxcpError] = useState('');
  const [chainSummary, setChainSummary] = useState(null);
  const [localValidatorStats, setLocalValidatorStats] = useState(null);
  const [loading, setLoading] = useState(_cachedState === null);
  const [error, setError] = useState('');
  const [copiedNotice, setCopiedNotice] = useState('');
  const [controlBusy, setControlBusy] = useState('');
  const [controlMessage, setControlMessage] = useState('');
  const [walletSnapshots, setWalletSnapshots] = useState({});
  const [walletLoading, setWalletLoading] = useState(false);
  const [localPeerInfo, setLocalPeerInfo] = useState(null);
  const [localPeerInfoLoading, setLocalPeerInfoLoading] = useState(false);
  const [localPeerInfoError, setLocalPeerInfoError] = useState('');

  const atlasAvailable = useRef(true);

  // Logs tab state
  const [nodeLogs, setNodeLogs] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [logFilter, setLogFilter] = useState('all');
  const [logSearch, setLogSearch] = useState('');
  const [logsAutoScroll, setLogsAutoScroll] = useState(true);

  // Chain explorer tab state
  const [chainBlocks, setChainBlocks] = useState([]);
  const [chainLoading, setChainLoading] = useState(false);
  const [chainError, setChainError] = useState('');
  const [expandedBlock, setExpandedBlock] = useState(null);

  const fetchAtlas = async () => {
    if (!atlasAvailable.current) return;
    const explorerBase = DEFAULT_ATLAS_API_BASE;
    const [relayerResult, sxcpResult, chainResult] = await Promise.allSettled([
      fetchExplorerJson(explorerBase, '/relayers/health'),
      fetchExplorerJson(explorerBase, '/sxcp/status'),
      fetchExplorerJson(explorerBase, '/api/v1/network/summary'),
    ]);

    const relayer = relayerResult.status === 'fulfilled' ? relayerResult.value : null;
    const sxcp = sxcpResult.status === 'fulfilled' ? sxcpResult.value : null;
    const chain = chainResult.status === 'fulfilled' ? chainResult.value : null;

    if (!relayer && !sxcp && !chain) {
      atlasAvailable.current = false;
    }

    setRelayerHealth(relayer?.health || null);

    if (sxcp) {
      setSxcpStatus(sxcp.status || null);
      setSxcpError('');
    } else {
      setSxcpStatus(null);
      setSxcpError('SXCP status unavailable');
    }

    if (chain) {
      const raw = chain;
      setChainSummary({
        total_validators: raw.total_validators ?? raw.totalValidators ?? raw.activeValidators ?? null,
        active_validators: raw.active_validators ?? raw.activeValidators ?? null,
        total_validator_clusters: raw.total_validator_clusters ?? raw.totalValidatorClusters ?? null,
        total_transactions: raw.total_transactions ?? raw.totalTransactions ?? null,
        total_stake_snrg: raw.total_stake_snrg ?? raw.totalStakeSnrg ?? null,
        avg_block_time: raw.avg_block_time ?? raw.avgBlockTimeSeconds ?? raw.avgBlockTime ?? null,
        peer_count: raw.peer_count ?? raw.peerCount ?? null,
        latest_block: raw.latest_block ?? raw.latestBlock ?? null,
        average_synergy_score: raw.average_synergy_score ?? raw.averageSynergyScore ?? null,
        ...raw,
      });
    } else {
      setChainSummary(null);
    }
  };

  const fetchDashboard = async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }

    const [stateResult, liveResult] = await Promise.allSettled([
      invoke('testbeta_get_state'),
      invoke('testbeta_get_live_status'),
    ]);

    const nextErrors = [];

    if (stateResult.status === 'fulfilled') {
      _cachedState = stateResult.value;
      setState(stateResult.value);
    } else {
      nextErrors.push(String(stateResult.reason));
    }

    if (liveResult.status === 'fulfilled') {
      _cachedLiveStatus = liveResult.value;
      setLiveStatus(liveResult.value);
    } else {
      nextErrors.push(String(liveResult.reason));
    }

    setError(nextErrors.join(' '));
    if (!silent) {
      setLoading(false);
    }

    // Atlas API runs after the dashboard is visible — does not block render
    fetchAtlas();
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      fetchDashboard(true);
    }, 8000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!copiedNotice && !controlMessage) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setCopiedNotice('');
      setControlMessage('');
    }, 2200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [copiedNotice, controlMessage]);

  const nodes = state?.nodes || [];
  const network = state?.network_profile || {};
  const nodeCatalog = state?.node_catalog || [];

  useEffect(() => {
    if (!nodes.length) {
      setSelectedNodeId('');
      return;
    }

    setSelectedNodeId((current) => {
      if (nodes.some((node) => node.id === current)) {
        return current;
      }
      return nodes[0].id;
    });
  }, [nodes]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || nodes[0] || null,
    [nodes, selectedNodeId],
  );

  const selectedNodeLive = useMemo(
    () => (liveStatus?.nodes || []).find((entry) => entry.node_id === selectedNode?.id) || null,
    [liveStatus?.nodes, selectedNode?.id],
  );

  const selectedRole = useMemo(
    () => nodeCatalog.find((entry) => entry.id === selectedNode?.role_id) || null,
    [nodeCatalog, selectedNode?.role_id],
  );

  const selectedWorkspaceStatus = useMemo(
    () => nodeWorkspaceStatus(selectedNodeLive),
    [selectedNodeLive],
  );

  useEffect(() => {
    if (activeTab !== 'connectivity' || !developerModeEnabled) {
      setLocalPeerInfo(null);
      setLocalPeerInfoError('');
      setLocalPeerInfoLoading(false);
      return undefined;
    }

    if (!selectedNode || !selectedNodeLive?.is_running || selectedNodeLive?.local_rpc_ready !== true) {
      setLocalPeerInfo(null);
      setLocalPeerInfoError('');
      setLocalPeerInfoLoading(false);
      return undefined;
    }

    const endpoint = localRpcEndpointForNode(selectedNode, selectedNodeLive);
    let cancelled = false;

    const fetchLocalPeerInfo = async (showSpinner = false) => {
      if (showSpinner && !cancelled) {
        setLocalPeerInfoLoading(true);
      }

      try {
        const peerInfo = await queryLocalRpc(endpoint, 'synergy_getPeerInfo', []);
        if (!cancelled) {
          setLocalPeerInfo(normalizePeerInfoPayload(peerInfo));
          setLocalPeerInfoError('');
        }
      } catch (error) {
        if (!cancelled) {
          setLocalPeerInfo(null);
          setLocalPeerInfoError(String(error));
        }
      } finally {
        if (!cancelled) {
          setLocalPeerInfoLoading(false);
        }
      }
    };

    fetchLocalPeerInfo(true);
    const intervalId = window.setInterval(() => {
      fetchLocalPeerInfo(false);
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    activeTab,
    developerModeEnabled,
    selectedNode,
    selectedNodeLive,
  ]);

  const totalReservedNwei = useMemo(
    () => totalReservedNweiForNetwork(network, state?.summary?.total_sponsored_stake_nwei),
    [network, state?.summary?.total_sponsored_stake_nwei],
  );

  const dashboardTabs = useMemo(
    () => tabsForRole(selectedRole),
    [selectedRole],
  );

  useEffect(() => {
    if (!dashboardTabs.some((tab) => tab.id === activeTab && !tab.disabled)) {
      setActiveTab('overview');
    }
  }, [activeTab, dashboardTabs]);

  // Fetch logs when the logs tab is active
  useEffect(() => {
    if (activeTab !== 'logs' || !selectedNode) return undefined;

    const fetchLogs = async () => {
      setLogsLoading(true);
      try {
        const content = await invoke('testbeta_get_node_logs', {
          nodeId: selectedNode.id,
          lines: 500,
        });
        setNodeLogs(content || '');
      } catch (err) {
        setNodeLogs(`Error loading logs: ${err}`);
      } finally {
        setLogsLoading(false);
      }
    };

    fetchLogs();
    const logsInterval = window.setInterval(fetchLogs, 2000);
    return () => window.clearInterval(logsInterval);
  }, [activeTab, selectedNode?.id]);

  // Fetch canonical chain blocks when chain tab is active
  useEffect(() => {
    if (activeTab !== 'chain' || !selectedNode) return undefined;
    if (!selectedNodeLive?.is_running || selectedNodeLive?.local_rpc_ready !== true) {
      setChainLoading(false);
      setChainBlocks([]);
      setChainError('');
      return undefined;
    }

    const fetchChain = async () => {
      setChainLoading(true);
      setChainError('');
      try {
        const blocks = await invoke('testbeta_get_chain_blocks', {
          nodeId: selectedNode.id,
          count: 30,
        });
        setChainBlocks(blocks || []);
      } catch (err) {
        setChainError(String(err));
      } finally {
        setChainLoading(false);
      }
    };

    fetchChain();
    const chainInterval = window.setInterval(fetchChain, 5000);
    return () => window.clearInterval(chainInterval);
  }, [activeTab, selectedNode?.id, selectedNodeLive?.is_running, selectedNodeLive?.local_rpc_ready]);

  const nodeLiveById = useMemo(() => {
    const items = liveStatus?.nodes || [];
    return items.reduce((accumulator, item) => {
      accumulator[item.node_id] = item;
      return accumulator;
    }, {});
  }, [liveStatus?.nodes]);

  const syncedValidatorForNetworkStats = useMemo(() => nodes.find((node) => {
    const live = nodeLiveById[node.id];
    return (
      node.role_id === 'validator'
      && live?.is_running
      && live?.local_rpc_ready
      && (live?.sync_gap ?? Number.MAX_SAFE_INTEGER) <= 32
    );
  }) || null, [nodeLiveById, nodes]);

  useEffect(() => {
    if (!syncedValidatorForNetworkStats) {
      setLocalValidatorStats(null);
      return undefined;
    }

    const runningValidator = syncedValidatorForNetworkStats;
    const live = nodeLiveById[runningValidator.id] || null;
    if (!live?.local_rpc_ready) {
      setLocalValidatorStats(null);
      return undefined;
    }

    const endpoint = localRpcEndpointForNode(runningValidator, live);
    let cancelled = false;

    const fetchLocalValidatorStats = async () => {
      try {
        const stats = await queryLocalRpc(endpoint, 'synergy_getValidatorStats', []);
        if (!cancelled) {
          setLocalValidatorStats(stats || null);
        }
      } catch {
        if (!cancelled) {
          setLocalValidatorStats(null);
        }
      }
    };

    fetchLocalValidatorStats();
    const intervalId = window.setInterval(fetchLocalValidatorStats, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [nodeLiveById, syncedValidatorForNetworkStats]);

  const roleById = useMemo(() => {
    return nodeCatalog.reduce((accumulator, role) => {
      accumulator[role.id] = role;
      return accumulator;
    }, {});
  }, [nodeCatalog]);

  const validatorCount = useMemo(
    () => nodes.filter((node) => node.role_id === 'validator').length,
    [nodes],
  );

  const liveChainTip = useMemo(() => maxDefined([
    liveStatus?.public_chain_height,
    ...(liveStatus?.nodes || []).map((entry) => entry.best_observed_peer_height),
    ...(liveStatus?.nodes || []).map((entry) => effectiveLocalChainHeight(entry)),
  ]), [liveStatus?.nodes, liveStatus?.public_chain_height]);

  const chainSummaryIndexedAtMs = useMemo(
    () => toTimestampMs(chainSummary?.indexedAt ?? chainSummary?.indexed_at),
    [chainSummary?.indexedAt, chainSummary?.indexed_at],
  );

  const chainSummaryFresh = useMemo(() => {
    if (chainSummaryIndexedAtMs == null) return false;
    return (Date.now() - chainSummaryIndexedAtMs) <= 5 * 60 * 1000;
  }, [chainSummaryIndexedAtMs]);

  const atlasValidatorCount = useMemo(
    () => toFiniteNumber(chainSummary?.total_validators),
    [chainSummary?.total_validators],
  );

  const atlasClusterCount = useMemo(
    () => toFiniteNumber(chainSummary?.total_validator_clusters),
    [chainSummary?.total_validator_clusters],
  );

  const localActiveValidatorCount = useMemo(() => {
    if (localValidatorStats?.total_validators != null) {
      return toFiniteNumber(localValidatorStats.total_validators);
    }
    if (Array.isArray(localValidatorStats?.active_validators)) {
      return localValidatorStats.active_validators.length;
    }
    return null;
  }, [localValidatorStats]);

  const localValidatorClusterCount = useMemo(() => {
    if (!Array.isArray(localValidatorStats?.active_validators) || localValidatorStats.active_validators.length === 0) {
      return null;
    }
    const clusterIds = new Set(
      localValidatorStats.active_validators
        .map((entry) => entry?.cluster_id)
        .filter((value) => value != null),
    );
    if (clusterIds.size > 0) {
      return clusterIds.size;
    }
    return null;
  }, [localValidatorStats]);

  const networkChainTipDetail = useMemo(() => {
    const parts = [];
    if (liveStatus?.public_chain_height != null) {
      parts.push(`Public RPC: ${formatNumber(liveStatus.public_chain_height)}`);
    }
    if (selectedNode && effectiveLocalChainHeight(selectedNodeLive) != null) {
      parts.push(`Your node: ${formatNumber(effectiveLocalChainHeight(selectedNodeLive))}`);
    }
    if (
      liveChainTip != null
      && liveStatus?.public_chain_height != null
      && liveChainTip > liveStatus.public_chain_height
    ) {
      parts.push('Public RPC is behind the peer-observed network tip');
    }
    return parts.join(' • ') || 'Best observed network tip';
  }, [liveChainTip, liveStatus?.public_chain_height, selectedNode, selectedNodeLive]);

  const activeValidatorCount = useMemo(() => {
    if (localActiveValidatorCount != null && localActiveValidatorCount > 0) {
      return localActiveValidatorCount;
    }
    if (atlasValidatorCount != null && (chainSummaryFresh || atlasValidatorCount > 0)) {
      return atlasValidatorCount;
    }
    if (localActiveValidatorCount != null) {
      return localActiveValidatorCount;
    }
    if (!syncedValidatorForNetworkStats && atlasValidatorCount != null && atlasValidatorCount > 0) {
      return atlasValidatorCount;
    }
    return null;
  }, [atlasValidatorCount, chainSummaryFresh, localActiveValidatorCount, syncedValidatorForNetworkStats]);

  const validatorClusterCount = useMemo(() => {
    if (localValidatorClusterCount != null && localValidatorClusterCount > 0) {
      return localValidatorClusterCount;
    }
    if (atlasClusterCount != null && (chainSummaryFresh || atlasClusterCount > 0)) {
      return atlasClusterCount;
    }
    if (!syncedValidatorForNetworkStats && activeValidatorCount == null) {
      return null;
    }
    if (activeValidatorCount == null) {
      return null;
    }
    if (activeValidatorCount <= 0) {
      return 0;
    }
    if (activeValidatorCount <= 5) return 1;
    if (activeValidatorCount < 15) return 2;
    return 3 + Math.floor((activeValidatorCount - 15) / 5);
  }, [
    activeValidatorCount,
    atlasClusterCount,
    chainSummaryFresh,
    localValidatorClusterCount,
    syncedValidatorForNetworkStats,
  ]);

  const networkVisiblePeerCount = useMemo(() => {
    if (liveStatus?.network_peer_count != null) return liveStatus.network_peer_count;
    if (activeValidatorCount != null) return activeValidatorCount;
    return liveStatus?.public_peer_count ?? null;
  }, [activeValidatorCount, liveStatus?.network_peer_count, liveStatus?.public_peer_count]);

  const headerCopy = selectedNode
    ? `Live chain state, sync, and rewards for ${selectedNode.display_label || roleTypeLabel(selectedNode.role_display_name)}.`
    : 'Set up a node to begin tracking live chain state, peer connectivity, rewards, and service health.';

  const validatorQuorumCopy = selectedRole?.id === 'validator'
    ? (validatorCount >= 3
      ? 'Block production is configured to begin once three active validators are online.'
      : 'This validator will remain idle until the network sees three active validators.')
    : 'This role joins the network after bootstrap, sync, and role validation complete.';

  const nodeSlots = useMemo(() => {
    const visibleNodes = nodes.slice(0, MAX_NODE_SLOTS);
    return Array.from({ length: MAX_NODE_SLOTS }, (_, index) => {
      const node = visibleNodes[index] || null;
      if (!node) {
        return {
          id: `empty-slot-${index + 1}`,
          index,
          isEmpty: true,
        };
      }

      const nodeLive = nodeLiveById[node.id] || null;
      const role = roleById[node.role_id] || null;
      const statusLabel = nodeRuntimeLabel(nodeLive);
      return {
        id: node.id,
        index,
        isEmpty: false,
        node,
        nodeLive,
        role,
        isOnline: statusLabel === 'Online',
        statusLabel,
        statusTone: nodeRuntimeTone(nodeLive),
        typeLabel: roleTypeLabel(node.role_display_name),
        classLabel: classTierLabel(role),
        addressLabel: truncateAddress(node.node_address),
        blockHeightLabel: nodeLive?.is_running
          ? formatNumber(effectiveLocalChainHeight(nodeLive))
          : 'Offline',
        scoreLabel: formatCompactScoreOutOfHundred(nodeLive?.synergy_score),
      };
    });
  }, [liveStatus?.public_chain_height, nodeLiveById, nodes, roleById]);

  const relayerSummary = useMemo(() => {
    const relayers = relayerHealth?.relayers || [];
    const online = relayers.filter((entry) => entry.online).length;
    const eligible = relayers.filter((entry) => entry.eligible_for_quorum).length;
    const total = relayers.length;
    const quorum = sxcpStatus?.quorum ? `${sxcpStatus.quorum.t}/${sxcpStatus.quorum.n}` : 'Unknown';
    return {
      total,
      online,
      eligible,
      quorum,
      pending: sxcpStatus?.event_totals?.pending ?? null,
      finalized: sxcpStatus?.event_totals?.finalized ?? null,
    };
  }, [relayerHealth, sxcpStatus]);

  useEffect(() => {
    if (activeTab !== 'wallet' || !nodes.length) {
      return undefined;
    }

    let cancelled = false;

    const loadWalletSnapshots = async () => {
      setWalletLoading(true);
      try {
        const nextEntries = await Promise.all(
          nodes.slice(0, MAX_NODE_SLOTS).map(async (node) => {
            const nodeLive = nodeLiveById[node.id] || null;
            const fundingManifest = (network?.funding_manifests || []).find(
              (entry) => entry.id === node.funding_manifest_id,
            ) || null;
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
              const balances = await queryLocalRpc(
                endpoint,
                'synergy_getAllBalances',
                [node.node_address],
              );
              walletBalanceNwei = parseNwei(balances?.SNRG);
            } catch (error) {
              lastError = String(error);
            }

            try {
              const stakingInfo = await queryLocalRpc(
                endpoint,
                'synergy_getStakingInfo',
                [node.node_address],
              );
              const entries = Array.isArray(stakingInfo) ? stakingInfo : [];
              stakingEntryCount = entries.length;
              realizedEarnedNwei = entries.reduce(
                (sum, entry) => sum + parseNwei(entry?.rewards_earned),
                0n,
              );
            } catch (error) {
              if (!lastError) lastError = String(error);
            }

            try {
              const validatorStats = await queryLocalRpc(endpoint, 'synergy_getValidatorStats', []);
              pendingRewardsNwei = parseNwei(validatorStats?.epoch_rewards?.[node.node_address]);
            } catch (error) {
              if (!lastError) lastError = String(error);
            }

            const derivedEarnedNwei = walletBalanceNwei > reservedNwei
              ? walletBalanceNwei - reservedNwei
              : 0n;
            const earnedRewardsNwei = realizedEarnedNwei > derivedEarnedNwei
              ? realizedEarnedNwei
              : derivedEarnedNwei;
            const lifetimeRewardsNwei = earnedRewardsNwei + pendingRewardsNwei;

            return [
              node.id,
              {
                endpoint,
                walletBalanceNwei: walletBalanceNwei.toString(),
                reservedNwei: reservedNwei.toString(),
                earnedRewardsNwei: earnedRewardsNwei.toString(),
                pendingRewardsNwei: pendingRewardsNwei.toString(),
                lifetimeRewardsNwei: lifetimeRewardsNwei.toString(),
                stakingEntryCount,
                lastError,
              },
            ];
          }),
        );

        if (!cancelled) {
          setWalletSnapshots(Object.fromEntries(nextEntries));
        }
      } finally {
        if (!cancelled) {
          setWalletLoading(false);
        }
      }
    };

    loadWalletSnapshots();
    const intervalId = window.setInterval(loadWalletSnapshots, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeTab, nodeLiveById, nodes, network?.funding_manifests]);

  const copyToClipboard = (text, label = '') => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedNotice(label ? `Copied ${label}` : 'Copied');
    }).catch(() => {});
  };

  const runNodeControl = async (action) => {
    if (!selectedNode) {
      return;
    }

    setControlBusy(action);
    try {
      let bootstrapNotice = '';
      if (action === 'start' || action === 'sync') {
        try {
          const portConfig = await applyStoredTestnetBetaPortSettings(selectedNode);
          bootstrapNotice = portConfig.source === 'ceremony-package'
            ? ` Electron preserved ceremony-assigned node.toml ports: ${formatPortSettingsSummary(portConfig.portSettings)}.`
            : ` Electron wrote node.toml port profile: ${formatPortSettingsSummary(portConfig.portSettings)}.`;

          const bootstrapConfig = await refreshTestnetBetaBootstrapConfig(
            selectedNode,
            network,
          );
          bootstrapNotice += ` Electron refreshed peers.toml with ${bootstrapConfig.additionalDialTargets.length} seed-discovered dial target(s).`;
          if (bootstrapConfig.failures.length > 0) {
            bootstrapNotice += ` Seed preload warnings: ${bootstrapConfig.failures.join(' | ')}.`;
          }
        } catch (bootstrapError) {
          bootstrapNotice = ` Electron bootstrap refresh skipped: ${String(bootstrapError)}.`;
        }
      }

      const result = await invoke('testbeta_node_control', {
        input: {
          nodeId: selectedNode.id,
          action,
        },
      });
      setControlMessage(`${result?.message || `${action} completed.`}${bootstrapNotice}`);
      await fetchDashboard(true);
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setControlBusy('');
    }
  };

  const metrics = selectedNode
    ? [
        {
          label: 'Node Role',
          value: roleTypeLabel(selectedNode.role_display_name),
          detail: `${classTierLabel(selectedRole)} • ${selectedRole?.authority_plane || 'Role-bound binary'}`,
          icon: ICONS.node,
        },
        {
          label: 'Block Height',
          value: formatNumber(nodeBlockHeightValue(selectedNodeLive, liveStatus)),
          detail: nodeBlockHeightDetail(selectedNodeLive, liveStatus),
          icon: ICONS.chain,
        },
        {
          label: 'Network Peers',
          value: formatNumber(networkVisiblePeerCount),
          detail: liveStatus?.network_peer_count != null
            ? 'Unique peer dial targets currently published by the seed registry.'
            : 'Waiting for a live seed-registry peer count.',
          icon: ICONS.peers,
        },
        {
          label: 'Synergy Score',
          value: formatScoreOutOfHundred(selectedNodeLive?.synergy_score),
          detail: selectedNodeLive?.synergy_score_status || 'Waiting for live chain data',
          icon: ICONS.score,
        },
      ]
    : [
        {
          label: 'Environment',
          value: state?.display_name || 'Testnet-Beta',
          detail: `Chain ID ${network?.chain_id || 338639}`,
          icon: ICONS.chain,
        },
        {
          label: 'Provisioned Nodes',
          value: formatNumber(state?.summary?.total_nodes || 0),
          detail: 'Workspaces already created on this machine',
          icon: ICONS.node,
        },
        {
          label: 'Bootstrap Discovery',
          value: liveStatus?.discovery_status || 'Unknown',
          detail: liveStatus?.discovery_detail || 'Waiting for the first live check',
          icon: ICONS.pulse,
        },
        {
          label: 'Chain Height',
          value: formatNumber(liveStatus?.public_chain_height),
          detail: liveStatus?.chain_detail || 'Waiting for the first live check',
          icon: ICONS.chain,
        },
      ];

  const statusCards = [
    {
      label: 'Bootstrap Discovery',
      value: liveStatus?.discovery_status || 'Unknown',
      detail: liveStatus?.discovery_detail || 'Waiting for live discovery results.',
      tone: formatStatusTone(liveStatus?.discovery_status),
      icon: ICONS.pulse,
    },
    {
      label: 'Chain Height',
      value: formatNumber(nodeBlockHeightValue(selectedNodeLive, liveStatus)),
      detail: selectedNodeLive?.is_running
        ? (selectedNodeLive?.local_rpc_ready === false
          ? (selectedNodeLive?.local_rpc_status || 'Local RPC is not responding.')
          : `${formatNumber(selectedNodeLive?.sync_gap ?? 0)} blocks behind the live chain`)
        : (liveStatus?.chain_status || 'Chain data unavailable'),
      tone: selectedNodeLive?.is_running
        ? nodeRuntimeTone(selectedNodeLive)
        : formatStatusTone(liveStatus?.chain_status),
      icon: ICONS.chain,
    },
    {
      label: 'Sync Gap',
      value: formatNumber(selectedNodeLive?.sync_gap),
      detail: selectedNodeLive?.is_running
        ? (selectedNodeLive?.local_rpc_ready === false
          ? (selectedNodeLive?.local_rpc_status || 'Local RPC is not responding.')
          : selectedNodeLive?.sync_trending === 'synced'
            ? 'Fully synced with the network.'
            : [
                selectedNodeLive?.blocks_per_second > 0 ? `${selectedNodeLive.blocks_per_second.toFixed(1)} blocks/sec` : null,
                selectedNodeLive?.estimated_sync_eta_secs > 0 ? `~${Math.ceil(selectedNodeLive.estimated_sync_eta_secs / 60)} min remaining` : null,
                selectedNodeLive?.sync_trending === 'stalled' ? 'Sync stalled \u2014 try Boost Sync' : null,
              ].filter(Boolean).join(' \u2022 ') || 'Blocks remaining before this node fully catches up.')
        : 'Start the node to measure its local sync position.',
      tone: selectedNodeLive?.local_rpc_ready === false
        ? 'warn'
        : formatStatusTone(selectedNodeLive?.sync_gap > 0 ? 'syncing' : 'running'),
      icon: ICONS.sync,
    },
    {
      label: 'Workspace State',
      value: selectedWorkspaceStatus.label,
      detail: selectedWorkspaceStatus.detail,
      tone: formatStatusTone(selectedWorkspaceStatus.label),
      icon: ICONS.folder,
    },
  ];

  const handleRestart = async () => {
    if (!selectedNode || controlBusy) return;
    setControlBusy('restart');
    try {
      let bootstrapNotice = '';
      try {
        const portConfig = await applyStoredTestnetBetaPortSettings(selectedNode);
        bootstrapNotice = ` Port profile applied: ${formatPortSettingsSummary(portConfig.portSettings)}.`;
        const bootstrapConfig = await refreshTestnetBetaBootstrapConfig(selectedNode, network);
        bootstrapNotice += ` Peers refreshed (${bootstrapConfig.additionalDialTargets.length} targets).`;
      } catch (bootstrapError) {
        bootstrapNotice = ` Bootstrap refresh skipped: ${String(bootstrapError)}.`;
      }
      await invoke('testbeta_node_control', { input: { nodeId: selectedNode.id, action: 'stop' } });
      await invoke('testbeta_node_control', { input: { nodeId: selectedNode.id, action: 'start' } });
      setControlMessage(`Node restarted successfully.${bootstrapNotice}`);
      await fetchDashboard(true);
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setControlBusy('');
    }
  };

  const renderNodeControls = () => {
    const isRunning = Boolean(selectedNodeLive?.is_running);
    const controlDisabled = !selectedNode || Boolean(controlBusy);
    const syncLabel = selectedNode?.role_id === 'validator' ? 'Rejoin' : 'Sync';

    return (
      <section className="nodecp-panel nodecp-controls-card">
        <h3 className="nodecp-panel-title-standalone">Node Controls</h3>
        <div className="nodecp-controls-layout">
          <SNRGButton
            className="nodecp-control-btn nodecp-control-start"
            variant="lime"
            size="sm"
            disabled={controlDisabled || isRunning}
            onClick={() => runNodeControl('start')}
          >
            {controlBusy === 'start' ? 'Starting…' : 'Start'}
          </SNRGButton>
          <SNRGButton
            className="nodecp-control-btn nodecp-control-stop"
            variant="red"
            size="sm"
            disabled={controlDisabled || !isRunning}
            onClick={() => runNodeControl('stop')}
          >
            {controlBusy === 'stop' ? 'Stopping…' : 'Stop'}
          </SNRGButton>
          <SNRGButton
            className="nodecp-control-btn nodecp-control-restart"
            variant="yellow"
            size="sm"
            disabled={controlDisabled || !isRunning}
            onClick={handleRestart}
          >
            {controlBusy === 'restart' ? 'Restarting…' : 'Restart'}
          </SNRGButton>
          <SNRGButton
            className="nodecp-control-btn nodecp-control-sync"
            variant="yellow"
            size="sm"
            disabled={controlDisabled || !selectedNode?.config_paths?.length}
            onClick={() => runNodeControl('sync')}
          >
            {controlBusy === 'sync' ? `${syncLabel}ing…` : syncLabel}
          </SNRGButton>
          <SNRGButton
            className="nodecp-control-btn"
            variant="blue"
            size="sm"
            disabled={!selectedNode}
            onClick={() => selectedNode && openPath(`${selectedNode.workspace_directory}/logs`)}
          >
            Logs
          </SNRGButton>
        </div>
        <div className="nodecp-controls-status">
          <span className={`nodecp-health-pill nodecp-health-${nodeRuntimeTone(selectedNodeLive)}`}>
            {nodeRuntimeLabel(selectedNodeLive)}
          </span>
          <span>{controlMessage || copiedNotice || selectedWorkspaceStatus.detail}</span>
        </div>
      </section>
    );
  };

  const renderOverview = () => {
    const pubHeight = liveChainTip;
    const healthyBootnodes = (liveStatus?.bootnodes || []).filter((b) => b.reachable).length;
    const totalBootnodes = (liveStatus?.bootnodes || []).length;
    const healthySeeds = (liveStatus?.seed_servers || []).filter((s) => s.reachable).length;
    const totalSeeds = (liveStatus?.seed_servers || []).length;
    const networkUp = liveStatus?.public_rpc_online;

    return (
      <div className="nodecp-tab-stack">
        {!nodes.length ? (
          <div className="nodecp-empty-state">
            <div>
              <p className="nodecp-empty-kicker">No nodes on this machine yet</p>
              <h3>Create the first node workspace</h3>
              <p>
                Setup provisions a dedicated workspace, keypair, and bootstrap wiring for a real network node.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* First section: Node Controls + Chain Details side-by-side */}
            <div className="nodecp-overview-first-section">
              {/* Left: Node Controls */}
              {renderNodeControls()}

              {/* Right: Chain Details */}
              <section className="nodecp-panel">
                <h3 className="nodecp-panel-title-standalone">Chain Details</h3>
                <div className="nodecp-chain-details-grid">
                  <div className="nodecp-chain-detail-item">
                    <span className="nodecp-chain-detail-label">Block Height</span>
                    <strong className="nodecp-chain-detail-value">
                      {liveChainTip != null
                        ? formatNumber(liveChainTip)
                        : (effectiveLocalChainHeight(selectedNodeLive) != null
                          ? formatNumber(effectiveLocalChainHeight(selectedNodeLive))
                          : '—')}
                    </strong>
                    <span className="nodecp-chain-detail-sub">
                      {networkChainTipDetail}
                    </span>
                  </div>
                  <div className="nodecp-chain-detail-item">
                    <span className="nodecp-chain-detail-label">Sync Gap</span>
                    <strong className="nodecp-chain-detail-value">
                      {selectedNodeLive?.sync_gap != null ? formatNumber(selectedNodeLive.sync_gap) : '—'}
                    </strong>
                    <span className="nodecp-chain-detail-sub">
                      {selectedNodeLive?.sync_gap === 0
                        ? 'Fully synced with network'
                        : selectedNodeLive?.sync_gap > 0
                          ? 'Blocks behind the network'
                          : 'Start a node to measure sync'}
                    </span>
                  </div>
                  <div className="nodecp-chain-detail-item">
                    <span className="nodecp-chain-detail-label">Active Validators</span>
                    <strong className="nodecp-chain-detail-value">
                      {activeValidatorCount != null ? formatNumber(activeValidatorCount) : '—'}
                    </strong>
                    <span className="nodecp-chain-detail-sub">Validators on the network</span>
                  </div>
                  <div className="nodecp-chain-detail-item">
                    <span className="nodecp-chain-detail-label">Validator Clusters</span>
                    <strong className="nodecp-chain-detail-value">
                      {validatorClusterCount != null ? formatNumber(validatorClusterCount) : '—'}
                    </strong>
                    <span className="nodecp-chain-detail-sub">Distributed validator groups</span>
                  </div>
                </div>
              </section>
            </div>

            {/* All-nodes live state table */}
            <section className="nodecp-panel">
              <div className="nodecp-panel-header">
                <div>
                  <p className="nodecp-panel-kicker">Live node state</p>
                  <h3>All nodes on this machine</h3>
                </div>
              </div>
              <div className="nodecp-nodes-table-wrap">
                <table className="nodecp-nodes-table">
                  <thead>
                    <tr>
                      <th>Node</th>
                      <th>Status</th>
                      <th>PID</th>
                      <th>Local Block</th>
                      <th>Public Block</th>
                      <th>Sync Gap</th>
                      <th>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodes.map((node) => {
                      const live = nodeLiveById[node.id];
                      const status = nodeRuntimeLabel(live);
                      const tone = nodeRuntimeTone(live);
                      const isSelected = selectedNode?.id === node.id;
                      return (
                        <tr
                          key={node.id}
                          className={isSelected ? 'nodecp-nodes-row-selected' : ''}
                          onClick={() => setSelectedNodeId(node.id)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => e.key === 'Enter' && setSelectedNodeId(node.id)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td className="nodecp-nodes-label">
                            {node.display_label || node.role_display_name || node.id}
                          </td>
                          <td>
                            <span className={`nodecp-health-pill nodecp-health-${tone}`}>{status}</span>
                          </td>
                          <td className="nodecp-nodes-mono">{live?.pid ?? '—'}</td>
                          <td className="nodecp-nodes-mono">{formatNumber(effectiveLocalChainHeight(live))}</td>
                          <td className="nodecp-nodes-mono">{formatNumber(pubHeight)}</td>
                          <td className="nodecp-nodes-mono">
                            {formatNumber(live?.sync_gap)}
                            {live?.sync_trending === 'improving' ? ' \u2191' : live?.sync_trending === 'stalled' ? ' \u26A0' : live?.sync_trending === 'synced' ? ' \u2713' : ''}
                          </td>
                          <td className="nodecp-nodes-mono">{formatScoreOutOfHundred(live?.synergy_score)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {/* Network health strip */}
        <div className="nodecp-status-strip">
          <div className={`nodecp-strip-item nodecp-strip-${networkUp ? 'ok' : 'error'}`}>
            <span className="nodecp-strip-label">Network</span>
            <strong>{networkUp ? 'Online' : 'Offline'}</strong>
          </div>
          <div className={`nodecp-strip-item nodecp-strip-${pubHeight != null ? 'ok' : 'warn'}`}>
            <span className="nodecp-strip-label">Block Height</span>
            <strong>{formatNumber(pubHeight)}</strong>
          </div>
          <div className={`nodecp-strip-item nodecp-strip-${chainSummary?.avg_block_time != null ? 'ok' : 'warn'}`}>
            <span className="nodecp-strip-label">Avg Block Time</span>
            <strong>{chainSummary?.avg_block_time != null ? `${chainSummary.avg_block_time}s` : '—'}</strong>
          </div>
          <div className={`nodecp-strip-item nodecp-strip-${networkVisiblePeerCount != null ? 'ok' : 'warn'}`}>
            <span className="nodecp-strip-label">Network Peers</span>
            <strong>{networkVisiblePeerCount != null ? networkVisiblePeerCount : '—'}</strong>
          </div>
          <div className={`nodecp-strip-item nodecp-strip-${totalBootnodes > 0 ? (healthyBootnodes === totalBootnodes ? 'ok' : 'warn') : 'warn'}`}>
            <span className="nodecp-strip-label">Bootnodes</span>
            <strong>{totalBootnodes > 0 ? `${healthyBootnodes}/${totalBootnodes}` : '—'}</strong>
          </div>
          <div className={`nodecp-strip-item nodecp-strip-${totalSeeds > 0 ? (healthySeeds === totalSeeds ? 'ok' : 'warn') : 'warn'}`}>
            <span className="nodecp-strip-label">Seed Servers</span>
            <strong>{totalSeeds > 0 ? `${healthySeeds}/${totalSeeds}` : '—'}</strong>
          </div>
          {chainSummary?.total_transactions != null && (
            <div className="nodecp-strip-item nodecp-strip-ok">
              <span className="nodecp-strip-label">Total Txns</span>
              <strong>{formatNumber(chainSummary.total_transactions)}</strong>
            </div>
          )}
          {chainSummary?.total_stake_snrg != null && (
            <div className="nodecp-strip-item nodecp-strip-ok">
              <span className="nodecp-strip-label">Network Stake</span>
              <strong>{formatWholeSnrg(chainSummary.total_stake_snrg)} SNRG</strong>
            </div>
          )}
          <div className={`nodecp-strip-item nodecp-strip-${selectedNodeLive?.synergy_score != null ? 'ok' : 'warn'}`}>
            <span className="nodecp-strip-label">Synergy Score</span>
            <strong>{formatScoreOutOfHundred(selectedNodeLive?.synergy_score)}</strong>
          </div>
        </div>
      </div>
    );
  };

  const renderConnectivity = () => (
    <div className="nodecp-tab-stack">
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
                <span className={`nodecp-health-pill nodecp-health-${formatStatusTone(entry.status)}`}>
                  {entry.status}
                </span>
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
            <h3>Seed services</h3>
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
                <span className={`nodecp-health-pill nodecp-health-${formatStatusTone(entry.status)}`}>
                  {entry.status}
                </span>
                <span className="nodecp-endpoint-latency">{latencyLabel(entry)}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {developerModeEnabled && (
        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Developer mode</p>
              <h3>Local node peers</h3>
            </div>
            <span className={`nodecp-health-pill nodecp-health-${
              localPeerInfoError
                ? 'bad'
                : selectedNodeLive?.is_running && selectedNodeLive?.local_rpc_ready === true
                  ? 'good'
                  : 'warn'
            }`}>
              {localPeerInfoError
                ? 'Unavailable'
                : selectedNodeLive?.is_running && selectedNodeLive?.local_rpc_ready === true
                  ? `${formatNumber(localPeerInfo?.peerCount ?? selectedNodeLive?.local_peer_count ?? 0)} connected`
                  : 'Waiting for local RPC'}
            </span>
          </div>

          {!selectedNode ? (
            <div className="nodecp-empty-inline">
              Select a node to inspect its live peer set.
            </div>
          ) : !selectedNodeLive?.is_running ? (
            <div className="nodecp-empty-inline">
              Start the selected node to inspect its live peer set.
            </div>
          ) : selectedNodeLive?.local_rpc_ready !== true ? (
            <div className="nodecp-empty-inline">
              {selectedNodeLive?.local_rpc_status || 'Local RPC is not responding yet.'}
            </div>
          ) : localPeerInfoLoading && !localPeerInfo ? (
            <div className="nodecp-peer-loading">
              <div className="spinner" style={{ width: '18px', height: '18px' }}></div>
              <span>Loading live peer connections…</span>
            </div>
          ) : localPeerInfoError ? (
            <div className="nodecp-inline-alert nodecp-inline-alert-bad">
              Could not load live peer connections: {localPeerInfoError}
            </div>
          ) : (localPeerInfo?.peers?.length || 0) === 0 ? (
            <div className="nodecp-empty-inline">
              The selected node is running but currently has no active peer connections.
            </div>
          ) : (
            <div className="nodecp-peer-list">
              {localPeerInfo.peers.map((peer, index) => (
                <article key={`${peer.id}-${index}`} className="nodecp-peer-card">
                  <div className="nodecp-peer-card-header">
                    <div className="nodecp-peer-card-title">
                      <strong>{peer.nodeId || peer.validatorAddress || `Peer ${index + 1}`}</strong>
                      <span>{peer.publicAddress || peer.address || 'Public address unavailable'}</span>
                    </div>
                    <span className="nodecp-health-pill nodecp-health-good">Connected</span>
                  </div>
                  <div className="nodecp-peer-card-grid">
                    <div className="nodecp-peer-metric">
                      <span>Address</span>
                      <code>{peer.address || 'Unknown'}</code>
                    </div>
                    <div className="nodecp-peer-metric">
                      <span>Validator</span>
                      <code>{peer.validatorAddress || 'Unknown'}</code>
                    </div>
                    <div className="nodecp-peer-metric">
                      <span>Last seen</span>
                      <strong>{formatPeerLastSeen(peer.lastSeen)}</strong>
                    </div>
                    <div className="nodecp-peer-metric">
                      <span>Version</span>
                      <strong>{peer.version || 'Unknown'}</strong>
                    </div>
                    <div className="nodecp-peer-metric">
                      <span>Blocks</span>
                      <strong>{formatNumber(peer.blocksReceived)} in / {formatNumber(peer.blocksSent)} out</strong>
                    </div>
                    <div className="nodecp-peer-metric">
                      <span>Transactions</span>
                      <strong>{formatNumber(peer.txsReceived)} in / {formatNumber(peer.txsSent)} out</strong>
                    </div>
                    <div className="nodecp-peer-metric nodecp-peer-metric-wide">
                      <span>Capabilities</span>
                      <strong>{peer.capabilities.length ? peer.capabilities.join(', ') : 'Not advertised'}</strong>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Relayer status</p>
            <h3>SXCP quorum + events</h3>
          </div>
          <span className={`nodecp-health-pill nodecp-health-${sxcpError ? 'bad' : 'good'}`}>
            {sxcpError ? 'Unavailable' : 'Online'}
          </span>
        </div>
        <div className="nodecp-summary-grid">
          <div className="nodecp-stat-card">
            <div className="nodecp-stat-icon">{ICONS.pulse}</div>
            <div className="nodecp-stat-copy">
              <span className="nodecp-stat-label">Quorum</span>
              <span className="nodecp-stat-value">{relayerSummary.quorum}</span>
            </div>
          </div>
          <div className="nodecp-stat-card">
            <div className="nodecp-stat-icon">{ICONS.peers}</div>
            <div className="nodecp-stat-copy">
              <span className="nodecp-stat-label">Relayers online</span>
              <span className="nodecp-stat-value">{formatNumber(relayerSummary.online)} / {formatNumber(relayerSummary.total)}</span>
              <span className="nodecp-stat-detail">Quorum-eligible: {formatNumber(relayerSummary.eligible)}</span>
            </div>
          </div>
          <div className="nodecp-stat-card">
            <div className="nodecp-stat-icon">{ICONS.chain}</div>
            <div className="nodecp-stat-copy">
              <span className="nodecp-stat-label">Pending events</span>
              <span className="nodecp-stat-value">
                {relayerSummary.pending == null ? '—' : formatNumber(relayerSummary.pending)}
              </span>
            </div>
          </div>
          <div className="nodecp-stat-card">
            <div className="nodecp-stat-icon">{ICONS.shield}</div>
            <div className="nodecp-stat-copy">
              <span className="nodecp-stat-label">Finalized events</span>
              <span className="nodecp-stat-value">
                {relayerSummary.finalized == null ? '—' : formatNumber(relayerSummary.finalized)}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Public chain</p>
            <h3>Chain availability</h3>
          </div>
        </div>
        <div className="nodecp-definition-list">
          <div className="nodecp-definition-row">
            <span>Public RPC</span>
            <strong>{liveStatus?.public_rpc_endpoint || 'Not available'}</strong>
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
            <span>Network peers</span>
            <strong>{formatNumber(networkVisiblePeerCount)}</strong>
          </div>
          {(network?.bootstrap_policy?.fallback_sequence || []).length > 0 && (
            <div className="nodecp-definition-row">
              <span>Discovery fallback</span>
              <strong>{(network.bootstrap_policy.fallback_sequence).join(' → ')}</strong>
            </div>
          )}
        </div>
      </section>
    </div>
  );

  const renderWallet = () => (
    <div className="nodecp-tab-stack">
      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Rewards standard</p>
            <h3>Wallet &amp; Rewards by Node Slot</h3>
          </div>
        </div>
        <div className="nodecp-controls-status">
          <span>Total reserved: {formatSnrgFromNwei(totalReservedNwei)}</span>
          <span>{walletLoading ? 'Refreshing…' : 'Wallet telemetry from local node RPC.'}</span>
        </div>
      </section>

      <div className="nodecp-wallet-stack">
        {Array.from({ length: MAX_NODE_SLOTS }, (_, index) => {
          const node = nodes.find((entry) => Number(entry.port_slot ?? -1) === index)
            || nodes[index]
            || null;

          if (!node) {
            return (
              <section key={`wallet-slot-${index + 1}`} className="nodecp-panel nodecp-wallet-slot">
                <div className="nodecp-panel-header">
                  <div>
                    <p className="nodecp-panel-kicker">Node Slot {index + 1}</p>
                    <h3>Not Configured</h3>
                  </div>
                </div>
                <div className="nodecp-empty-inline">
                  This slot does not have a provisioned node yet.
                </div>
              </section>
            );
          }

          const nodeLive = nodeLiveById[node.id] || null;
          const fundingManifest = (network?.funding_manifests || []).find(
            (entry) => entry.id === node.funding_manifest_id,
          ) || null;
          const rewardStandard = roleRewardStandard(node.role_id, node.role_display_name);
          const walletSnapshot = walletSnapshots[node.id] || {};
          const publicHeight = liveStatus?.public_chain_height;
          const networkHeight = nodeLive?.best_network_height ?? publicHeight;
          const catchUpStatus = computeCatchUpStatus(nodeLive, networkHeight);

          return (
            <section key={node.id} className="nodecp-panel nodecp-wallet-slot">
              <div className="nodecp-panel-header">
                <div>
                  <p className="nodecp-panel-kicker">Node Slot {index + 1}</p>
                  <h3>{node.display_label || node.role_display_name}</h3>
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
                      <span className="nodecp-wallet-address-row">
                        <strong className="nodecp-wallet-address">{node.node_address}</strong>
                        <button className="nodecp-copy-btn" title="Copy address" onClick={() => copyToClipboard(node.node_address, 'node address')}>{ICONS.copy}</button>
                      </span>
                    </div>
                    <div className="nodecp-definition-row">
                      <span>Reward payout address</span>
                      <span className="nodecp-wallet-address-row">
                        <strong className="nodecp-wallet-address">{node.reward_payout_address || node.node_address}</strong>
                        <button className="nodecp-copy-btn" title="Copy address" onClick={() => copyToClipboard(node.reward_payout_address || node.node_address, 'payout address')}>{ICONS.copy}</button>
                      </span>
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
                      <span>Sync gap</span>
                      <strong>{formatNumber(nodeLive?.sync_gap)} blocks</strong>
                    </div>
                    {(publicHeight != null && networkHeight != null && networkHeight > publicHeight) && (
                      <div className="nodecp-definition-row">
                        <span>Network tip source</span>
                        <strong>Peers report {formatNumber(networkHeight)} while public RPC is at {formatNumber(publicHeight)}</strong>
                      </div>
                    )}
                  </div>
                </div>

                <div className="nodecp-summary-block">
                  <span className="nodecp-summary-label">Live Rewards</span>
                  <div className="nodecp-definition-list">
                    <div className="nodecp-definition-row">
                      <span>Wallet balance</span>
                      <strong>{formatSnrgFromNwei(walletSnapshot.walletBalanceNwei)}</strong>
                    </div>
                    <div className="nodecp-definition-row">
                      <span>Reserved stake</span>
                      <strong>{formatSnrgFromNwei(walletSnapshot.reservedNwei || fundingManifest?.amount_nwei || fundingManifest?.amount_snrg || 0)}</strong>
                    </div>
                    <div className="nodecp-definition-row">
                      <span>Total reserved (network)</span>
                      <strong>{formatSnrgFromNwei(totalReservedNwei)}</strong>
                    </div>
                    <div className="nodecp-definition-row">
                      <span>Earned rewards</span>
                      <strong>{formatSnrgFromNwei(walletSnapshot.earnedRewardsNwei)}</strong>
                    </div>
                    <div className="nodecp-definition-row">
                      <span>Pending rewards</span>
                      <strong>{formatSnrgFromNwei(walletSnapshot.pendingRewardsNwei)}</strong>
                    </div>
                    <div className="nodecp-definition-row">
                      <span>Lifetime rewards</span>
                      <strong>{formatSnrgFromNwei(walletSnapshot.lifetimeRewardsNwei)}</strong>
                    </div>
                    <div className="nodecp-definition-row">
                      <span>Reward telemetry</span>
                      <strong>{walletSnapshot.lastError ? `Partial data (${walletSnapshot.lastError})` : 'Local RPC + validator stats'}</strong>
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
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );

  const renderFiles = () => (
    <div className="nodecp-tab-stack">
      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Workspace files</p>
            <h3>{selectedNode?.display_label || selectedNode?.role_display_name || 'Node'} Workspace</h3>
          </div>
          {selectedNode && (
            <SNRGButton variant="blue" size="sm" onClick={() => openPath(selectedNode.workspace_directory)}>
              Open Workspace
            </SNRGButton>
          )}
        </div>

        {selectedNode ? (
          <>
            <div className="nodecp-definition-list" style={{ marginBottom: '0.75rem' }}>
              <div className="nodecp-definition-row">
                <span>Workspace root</span>
                <strong style={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all' }}>{selectedNode.workspace_directory}</strong>
              </div>
              <div className="nodecp-definition-row">
                <span>Log directory</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <strong style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{selectedNode.workspace_directory}/logs</strong>
                  <button className="nodecp-copy-btn" title="Open logs folder" onClick={() => openPath(`${selectedNode.workspace_directory}/logs`)}>{ICONS.folder}</button>
                </span>
              </div>
            </div>
            <div className="nodecp-file-grid">
              {(selectedNode.config_paths || []).map((path) => (
                <SNRGButton key={path} as="button" variant="blue" size="sm" className="nodecp-file-card nodecp-file-card-button" onClick={() => openPath(path)}>
                  <span className="nodecp-file-label">{path.split('/').pop()}</span>
                  <strong style={{ fontFamily: 'monospace', fontSize: '0.75rem', opacity: 0.7 }}>{path.split('/').slice(-3).join('/')}</strong>
                </SNRGButton>
              ))}
            </div>
          </>
        ) : (
          <div className="nodecp-empty-inline">
            Start setup to create the first node workspace and config files.
          </div>
        )}
      </section>
    </div>
  );

  const renderChain = () => {
    const formatTs = (ts) => {
      if (!ts) return '—';
      const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
      return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
    };
    const shortHash = (h) => (h && h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : (h || '—'));
    const shortAddr = (a) => (a && a.length > 16 ? `${a.slice(0, 10)}…${a.slice(-6)}` : (a || '—'));

    return (
      <div className="nodecp-tab-stack">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '1rem' }}>Recent Blocks</h4>
            <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--snrg-text-secondary)' }}>
              Live from your node's local chain · syncs from canonical network · refreshes every 5s
            </p>
          </div>
          <SNRGButton
            variant="blue"
            size="sm"
            disabled={chainLoading || !selectedNodeLive?.is_running || selectedNodeLive?.local_rpc_ready !== true}
            onClick={() => {
              if (!selectedNode) return;
              if (!selectedNodeLive?.is_running || selectedNodeLive?.local_rpc_ready !== true) {
                setChainBlocks([]);
                setChainError('');
                return;
              }
              setChainLoading(true);
              invoke('testbeta_get_chain_blocks', { nodeId: selectedNode.id, count: 30 })
                .then((b) => { setChainBlocks(b || []); setChainError(''); })
                .catch((e) => setChainError(String(e)))
                .finally(() => setChainLoading(false));
            }}
          >
            {chainLoading ? 'Loading…' : 'Refresh'}
          </SNRGButton>
        </div>

        {chainError && (
          <div style={{ padding: '0.75rem', background: 'rgba(248,113,113,0.1)', border: '1px solid var(--snrg-status-error,#f87171)', borderRadius: '6px', color: 'var(--snrg-status-error,#f87171)', fontSize: '0.82rem', marginBottom: '0.75rem' }}>
            {selectedNodeLive?.is_running === false
              ? 'Node is not running — start it to see chain data.'
              : selectedNodeLive?.local_rpc_ready === false
                ? (selectedNodeLive?.local_rpc_status || 'Local RPC is not responding yet.')
              : `Could not fetch chain data: ${chainError}`}
          </div>
        )}

        {chainLoading && chainBlocks.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '2rem', justifyContent: 'center', color: 'var(--snrg-text-secondary)' }}>
            <div className="spinner" style={{ width: '20px', height: '20px' }}></div>
            <span>Fetching blocks…</span>
          </div>
        ) : chainBlocks.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--snrg-text-secondary)', fontSize: '0.9rem' }}>
            No blocks yet. {!selectedNode ? 'Select a node.' : 'Start the node to begin block production.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--snrg-border)', textAlign: 'left' }}>
                  <th style={{ padding: '0.4rem 0.6rem', color: 'var(--snrg-text-secondary)', fontWeight: 600, whiteSpace: 'nowrap' }}>Height</th>
                  <th style={{ padding: '0.4rem 0.6rem', color: 'var(--snrg-text-secondary)', fontWeight: 600, whiteSpace: 'nowrap' }}>Time</th>
                  <th style={{ padding: '0.4rem 0.6rem', color: 'var(--snrg-text-secondary)', fontWeight: 600, whiteSpace: 'nowrap' }}>Validator</th>
                  <th style={{ padding: '0.4rem 0.6rem', color: 'var(--snrg-text-secondary)', fontWeight: 600, whiteSpace: 'nowrap' }}>Hash</th>
                  <th style={{ padding: '0.4rem 0.6rem', color: 'var(--snrg-text-secondary)', fontWeight: 600, whiteSpace: 'nowrap' }}>Txns</th>
                </tr>
              </thead>
              <tbody>
                {chainBlocks.map((block) => {
                  const blockId = block.block_index ?? block.height ?? '?';
                  const isExpanded = expandedBlock === blockId;
                  return [
                    <tr
                      key={blockId}
                      onClick={() => setExpandedBlock(isExpanded ? null : blockId)}
                      style={{ borderBottom: '1px solid var(--snrg-border)', cursor: 'pointer', transition: 'background 0.1s' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                    >
                      <td style={{ padding: '0.5rem 0.6rem', fontWeight: 700, color: 'var(--snrg-status-success,#4ade80)', fontFamily: 'monospace' }}>
                        #{blockId}
                      </td>
                      <td style={{ padding: '0.5rem 0.6rem', color: 'var(--snrg-text-secondary)', whiteSpace: 'nowrap' }}>
                        {formatTs(block.timestamp)}
                      </td>
                      <td style={{ padding: '0.5rem 0.6rem', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                        {shortAddr(block.validator_id || block.validator)}
                      </td>
                      <td style={{ padding: '0.5rem 0.6rem', fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--snrg-text-secondary)' }}>
                        {shortHash(block.hash)}
                      </td>
                      <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>
                        {block.tx_count ?? (block.transactions?.length ?? 0)}
                      </td>
                    </tr>,
                    isExpanded && (
                      <tr key={`${blockId}-detail`} style={{ background: 'rgba(255,255,255,0.03)' }}>
                        <td colSpan={5} style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.3rem 1rem', fontSize: '0.78rem', fontFamily: 'monospace' }}>
                            <span style={{ color: 'var(--snrg-text-secondary)' }}>Hash</span>
                            <span style={{ wordBreak: 'break-all' }}>{block.hash || '—'}</span>
                            <span style={{ color: 'var(--snrg-text-secondary)' }}>Parent</span>
                            <span style={{ wordBreak: 'break-all' }}>{block.previous_hash || block.parent_hash || '—'}</span>
                            <span style={{ color: 'var(--snrg-text-secondary)' }}>Validator</span>
                            <span style={{ wordBreak: 'break-all' }}>{block.validator_id || block.validator || '—'}</span>
                            <span style={{ color: 'var(--snrg-text-secondary)' }}>Nonce</span>
                            <span>{block.nonce ?? '—'}</span>
                          </div>
                          {block.transactions?.length > 0 && (
                            <div style={{ marginTop: '0.6rem' }}>
                              <div style={{ fontWeight: 600, fontSize: '0.8rem', marginBottom: '0.3rem', color: 'var(--snrg-text-secondary)' }}>
                                Transactions ({block.transactions.length})
                              </div>
                              {block.transactions.map((tx, i) => (
                                <div key={i} style={{ fontSize: '0.76rem', fontFamily: 'monospace', color: 'var(--snrg-text-secondary)', padding: '0.2rem 0', borderTop: i > 0 ? '1px solid var(--snrg-border)' : 'none' }}>
                                  {tx.hash || tx.tx_hash || JSON.stringify(tx)}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderLogs = () => {
    const logPath = selectedNode
      ? `${selectedNode.workspace_directory}/logs/synergy-testbeta.log`
      : null;

    const filteredLines = (() => {
      const lines = nodeLogs.split('\n');
      return lines
        .filter((line) => {
          if (!line.trim()) return false;
          if (logFilter !== 'all') {
            const lc = line.toLowerCase();
            if (logFilter === 'error' && !lc.includes('error') && !lc.includes('failed')) return false;
            if (logFilter === 'warn' && !lc.includes('warn')) return false;
            if (logFilter === 'info' && !lc.includes('info')) return false;
            if (logFilter === 'block' && !lc.includes('block') && !lc.includes('commit') && !lc.includes('height')) return false;
          }
          if (logSearch && !line.toLowerCase().includes(logSearch.toLowerCase())) return false;
          return true;
        })
        .join('\n');
    })();

    return (
      <div className="nodecp-tab-stack">
        <div className="nodecp-logs-header" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <select
            className="log-filter-select"
            value={logFilter}
            onChange={(e) => setLogFilter(e.target.value)}
            style={{ padding: '0.3rem 0.5rem', borderRadius: '4px', border: '1px solid var(--snrg-border)', background: 'var(--snrg-surface)', color: 'var(--snrg-text)', fontSize: '0.85rem' }}
          >
            <option value="all">All Lines</option>
            <option value="block">Block / Commit</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
          </select>
          <input
            type="text"
            placeholder="Search logs…"
            value={logSearch}
            onChange={(e) => setLogSearch(e.target.value)}
            style={{ padding: '0.3rem 0.5rem', borderRadius: '4px', border: '1px solid var(--snrg-border)', background: 'var(--snrg-surface)', color: 'var(--snrg-text)', fontSize: '0.85rem', flex: '1', minWidth: '160px' }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={logsAutoScroll}
              onChange={(e) => setLogsAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <SNRGButton
            variant="blue"
            size="sm"
            disabled={logsLoading}
            onClick={() => selectedNode && invoke('testbeta_get_node_logs', { nodeId: selectedNode.id, lines: 500 }).then(setNodeLogs).catch(() => {})}
          >
            {logsLoading ? 'Loading…' : 'Refresh'}
          </SNRGButton>
          {logPath && (
            <SNRGButton
              variant="blue"
              size="sm"
              onClick={() => openPath(`${selectedNode.workspace_directory}/logs`)}
            >
              Open Folder
            </SNRGButton>
          )}
        </div>

        {logPath && (
          <p style={{ fontSize: '0.75rem', color: 'var(--snrg-text-secondary)', marginBottom: '0.5rem', wordBreak: 'break-all' }}>
            {logPath}
          </p>
        )}

        <div
          style={{
            background: 'var(--snrg-surface-dark, #0d0d0d)',
            border: '1px solid var(--snrg-border)',
            borderRadius: '6px',
            padding: '0.75rem',
            height: '520px',
            overflowY: 'auto',
            fontFamily: 'monospace',
            fontSize: '0.78rem',
            lineHeight: '1.5',
            color: 'var(--snrg-text)',
          }}
          ref={(el) => {
            if (el && logsAutoScroll) {
              el.scrollTop = el.scrollHeight;
            }
          }}
        >
          {logsLoading && !nodeLogs ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--snrg-text-secondary)' }}>
              <div className="spinner" style={{ width: '16px', height: '16px' }}></div>
              <span>Loading logs…</span>
            </div>
          ) : filteredLines ? (
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {filteredLines.split('\n').map((line, i) => {
                const lc = line.toLowerCase();
                let color = 'inherit';
                if (lc.includes('error') || lc.includes('failed')) color = 'var(--snrg-status-error, #f87171)';
                else if (lc.includes('warn')) color = 'var(--snrg-status-warning, #fbbf24)';
                else if (lc.includes('✅') || lc.includes('committed') || lc.includes('block #') || lc.includes('produced block')) color = 'var(--snrg-status-success, #4ade80)';
                else if (lc.includes('🔧') || lc.includes('info')) color = 'var(--snrg-text-secondary, #94a3b8)';
                return (
                  <span key={i} style={{ display: 'block', color }}>
                    {line}
                  </span>
                );
              })}
            </pre>
          ) : (
            <span style={{ color: 'var(--snrg-text-secondary)' }}>
              {selectedNode ? 'No log output yet. Start the node to see logs.' : 'Select a node to view logs.'}
            </span>
          )}
        </div>

        <div style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--snrg-text-secondary)' }}>
          {filteredLines ? `${filteredLines.split('\n').filter(Boolean).length} lines` : '0 lines'}
          {logFilter !== 'all' || logSearch ? ' (filtered)' : ''}
          {' · '}refreshes every 2s
        </div>
      </div>
    );
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'connectivity':
        return renderConnectivity();
      case 'wallet':
        return renderWallet();
      case 'files':
        return renderFiles();
      case 'chain':
        return renderChain();
      case 'logs':
        return renderLogs();
      case 'overview':
      default:
        return renderOverview();
    }
  };

  return (
    <div className="multi-node-dashboard testbeta-dashboard-shell nodecp-dashboard-shell">
      <div className="dashboard-layout">
        <aside className="node-sidebar nodecp-sidebar">
          <div className="nodecp-sidebar-head">
            <h3 className="sidebar-title nodecp-sidebar-title">Your Nodes</h3>
            <div className="sidebar-separator nodecp-sidebar-divider"></div>
          </div>

          <div className="node-list nodecp-node-list">
            {nodeSlots.map((slot) => (
              <button
                key={slot.id}
                type="button"
                aria-label={slot.isEmpty ? `Empty node slot ${slot.index + 1}` : `${slot.typeLabel} ${slot.statusLabel}`}
                className={[
                  'nodecp-node-row',
                  slot.isEmpty ? 'nodecp-node-row-empty' : '',
                  !slot.isEmpty && slot.isOnline ? 'nodecp-node-row-online' : '',
                  !slot.isEmpty && !slot.isOnline ? 'nodecp-node-row-offline' : '',
                  selectedNode?.id === slot.id ? 'active' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => {
                  if (!slot.isEmpty) {
                    setSelectedNodeId(slot.id);
                  }
                }}
                disabled={slot.isEmpty}
              >
                {slot.isEmpty ? (
                  <span className="nodecp-node-empty-fill" aria-hidden="true"></span>
                ) : (
                  <>
                    <div className="nodecp-node-row-top">
                      <span className="nodecp-node-row-type">{slot.typeLabel}</span>
                      <span className={`nodecp-health-pill nodecp-health-${slot.statusTone}`}>
                        {slot.statusLabel}
                      </span>
                    </div>
                    <span className="nodecp-node-row-class">{slot.classLabel}</span>
                    <div className="nodecp-node-row-bottom">
                      <div className="nodecp-node-row-address-stack">
                        <span className="nodecp-node-row-address">{slot.addressLabel}</span>
                        <span className="nodecp-node-row-height">Block {slot.blockHeightLabel}</span>
                      </div>
                      <div className="nodecp-node-row-score">
                        <span>Synergy Score</span>
                        <strong>{slot.scoreLabel}</strong>
                      </div>
                    </div>
                    <Link
                      to={`/node/${slot.id}`}
                      className="nodecp-node-row-details-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View Details &rarr;
                    </Link>
                  </>
                )}
              </button>
            ))}
          </div>

          <div className="sidebar-footer">
            <SNRGButton className="testbeta-sidebar-action" variant="blue" size="sm" block onClick={onLaunchSetup}>
              Setup a New Node
            </SNRGButton>
          </div>
        </aside>

        <main className="node-content nodecp-content">
          {loading ? (
            <div className="loading-container">
              <div className="spinner"></div>
              <p>Loading node dashboard...</p>
            </div>
          ) : (
            <>
              <div className="dashboard-header testbeta-dashboard-header nodecp-dashboard-header">
                <div>
                  <p className="nodecp-page-kicker">Synergy Testnet-Beta • Chain ID 338639</p>
                  <h2 className="panel-title nodecp-page-title">Node Control Panel Dashboard</h2>
                </div>
                <div className="control-buttons nodecp-control-buttons">
                  <SNRGButton className="nodecp-header-btn nodecp-refresh-btn header-grid-btn" variant="blue" size="sm" onClick={() => fetchDashboard(true)}>
                    Refresh
                  </SNRGButton>
                </div>
              </div>

              <div className="tabs nodecp-tabs">
                {dashboardTabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={[
                      'tab',
                      activeTab === tab.id ? 'active' : '',
                      tab.disabled ? 'nodecp-tab-disabled' : '',
                      tab.separated ? 'nodecp-tab-separated' : '',
                      tab.soon ? 'nodecp-tab-beta' : '',
                    ].filter(Boolean).join(' ')}
                    disabled={tab.disabled}
                    onClick={() => !tab.disabled && setActiveTab(tab.id)}
                  >
                    <span>{tab.label}</span>
                    {tab.soon ? <span className="nodecp-soon-pill">Soon</span> : null}
                  </button>
                ))}
              </div>

              {error ? <div className="error-banner">{error}</div> : null}

              <div className="tab-content nodecp-tab-content">{renderTabContent()}</div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export default TestnetBetaDashboard;
