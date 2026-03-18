import { useEffect, useMemo, useState } from 'react';
import { invoke, openPath } from '../lib/desktopClient';
import { SNRGButton } from '../styles/SNRGButton';

const COMMON_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'connectivity', label: 'Connectivity' },
  { id: 'wallet', label: 'Rewards' },
  { id: 'files', label: 'Files' },
];
const MAX_NODE_SLOTS = 4;
const DEFAULT_ATLAS_API_BASE = 'https://testbeta-atlas-api.synergy-network.io';

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

function latencyLabel(entry) {
  if (!entry?.reachable || entry?.latency_ms == null) {
    return entry?.detail || 'Unavailable';
  }
  return `${entry.latency_ms} ms`;
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

function roleSpecificTabForRole(role) {
  const roleId = String(role?.id || '');

  if (['validator', 'committee', 'archive_validator', 'audit_validator'].includes(roleId)) {
    return { id: 'role', label: 'Consensus' };
  }
  if (['relayer', 'witness', 'oracle', 'uma_coordinator', 'cross_chain_verifier'].includes(roleId)) {
    return { id: 'role', label: 'Coordination' };
  }
  if (['compute', 'ai_inference', 'pqc_crypto', 'data_availability'].includes(roleId)) {
    return { id: 'role', label: 'Workloads' };
  }
  if (['governance_auditor', 'treasury_controller', 'security_council'].includes(roleId)) {
    return { id: 'role', label: 'Governance' };
  }
  if (['rpc_gateway', 'indexer', 'observer'].includes(roleId)) {
    return { id: 'role', label: 'Access' };
  }
  return { id: 'role', label: 'Role' };
}

function tabsForRole(role) {
  return [
    ...COMMON_TABS.slice(0, 3),
    roleSpecificTabForRole(role),
    COMMON_TABS[3],
    {
      id: 'beta',
      label: 'Beta Features',
      disabled: true,
      separated: true,
      soon: true,
    },
  ];
}

function nodeRuntimeLabel(nodeLive) {
  return nodeLive?.is_running ? 'Online' : 'Offline';
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

function TestnetBetaDashboard({ onLaunchSetup }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [state, setState] = useState(null);
  const [liveStatus, setLiveStatus] = useState(null);
  const [relayerHealth, setRelayerHealth] = useState(null);
  const [sxcpStatus, setSxcpStatus] = useState(null);
  const [sxcpError, setSxcpError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copiedNotice, setCopiedNotice] = useState('');
  const [controlBusy, setControlBusy] = useState('');
  const [controlMessage, setControlMessage] = useState('');

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
      setState(stateResult.value);
    } else {
      nextErrors.push(String(stateResult.reason));
    }

    if (liveResult.status === 'fulfilled') {
      setLiveStatus(liveResult.value);
    } else {
      nextErrors.push(String(liveResult.reason));
    }

    const explorerBase = DEFAULT_ATLAS_API_BASE;
    const [relayerResult, sxcpResult] = await Promise.allSettled([
      fetchExplorerJson(explorerBase, '/relayers/health'),
      fetchExplorerJson(explorerBase, '/sxcp/status'),
    ]);

    if (relayerResult.status === 'fulfilled') {
      setRelayerHealth(relayerResult.value?.health || null);
    } else {
      setRelayerHealth(null);
    }

    if (sxcpResult.status === 'fulfilled') {
      setSxcpStatus(sxcpResult.value?.status || null);
      setSxcpError('');
    } else {
      setSxcpStatus(null);
      setSxcpError('SXCP status unavailable');
    }

    setError(nextErrors.join(' '));
    if (!silent) {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      fetchDashboard(true);
    }, 15000);
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

  const selectedFundingManifest = useMemo(
    () =>
      (network?.funding_manifests || []).find(
        (entry) => entry.id === selectedNode?.funding_manifest_id,
      ) || null,
    [network?.funding_manifests, selectedNode?.funding_manifest_id],
  );

  const rewardProfile = useMemo(
    () => rewardProfileForRole(selectedRole),
    [selectedRole],
  );

  const selectedWorkspaceStatus = useMemo(
    () => nodeWorkspaceStatus(selectedNodeLive),
    [selectedNodeLive],
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

  const nodeLiveById = useMemo(() => {
    const items = liveStatus?.nodes || [];
    return items.reduce((accumulator, item) => {
      accumulator[item.node_id] = item;
      return accumulator;
    }, {});
  }, [liveStatus?.nodes]);

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

  const headerCopy = selectedNode
    ? `Track live chain state, sync progress, rewards, and ${roleSpecificTabForRole(selectedRole).label.toLowerCase()} metrics for ${selectedNode.display_label || roleTypeLabel(selectedNode.role_display_name)}.`
    : 'Set up a node to begin tracking live chain state, peer connectivity, rewards, and role-specific service health.';

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
      const isOnline = Boolean(nodeLive?.is_running);
      return {
        id: node.id,
        index,
        isEmpty: false,
        node,
        nodeLive,
        role,
        isOnline,
        typeLabel: roleTypeLabel(node.role_display_name),
        classLabel: classTierLabel(role),
        addressLabel: truncateAddress(node.node_address),
        blockHeightLabel: isOnline
          ? formatNumber(nodeLive?.local_chain_height)
          : 'Offline',
        scoreLabel: formatCompactScoreOutOfHundred(nodeLive?.synergy_score),
        statusLabel: nodeRuntimeLabel(nodeLive),
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

  const runNodeControl = async (action) => {
    if (!selectedNode) {
      return;
    }

    setControlBusy(action);
    try {
      const result = await invoke('testbeta_node_control', {
        input: {
          nodeId: selectedNode.id,
          action,
        },
      });
      setControlMessage(result?.message || `${action} completed.`);
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
          value: formatNumber(selectedNodeLive?.local_chain_height || liveStatus?.public_chain_height),
          detail: selectedNodeLive?.is_running
            ? `${formatNumber(selectedNodeLive?.sync_gap ?? 0)} blocks behind the live chain`
            : `Public chain currently reports ${formatNumber(liveStatus?.public_chain_height)} blocks`,
          icon: ICONS.chain,
        },
        {
          label: 'Peer Count',
          value: formatNumber(selectedNodeLive?.local_peer_count ?? liveStatus?.public_peer_count),
          detail: selectedNodeLive?.is_running
            ? 'Live peers currently connected to this node'
            : 'Visible network peers from the public control-plane view',
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
      value: formatNumber(selectedNodeLive?.local_chain_height || liveStatus?.public_chain_height),
      detail: selectedNodeLive?.is_running
        ? `Local node sees ${formatNumber(selectedNodeLive?.local_peer_count)} peers.`
        : (liveStatus?.chain_status || 'Chain data unavailable'),
      tone: formatStatusTone(selectedNodeLive?.is_running ? 'running' : liveStatus?.chain_status),
      icon: ICONS.chain,
    },
    {
      label: 'Sync Gap',
      value: formatNumber(selectedNodeLive?.sync_gap),
      detail: selectedNodeLive?.is_running
        ? 'Blocks remaining before this node fully catches up.'
        : 'Start the node to measure its local sync position.',
      tone: formatStatusTone(selectedNodeLive?.sync_gap > 0 ? 'syncing' : 'running'),
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

  const roleTab = roleSpecificTabForRole(selectedRole);

  const renderNodeControls = () => {
    const isRunning = Boolean(selectedNodeLive?.is_running);
    const controlDisabled = !selectedNode || Boolean(controlBusy);
    const nodeTomlPath =
      selectedNode?.config_paths.find((path) => path.endsWith('/node.toml'))
      || selectedNode?.config_paths?.[0];

    return (
      <aside className="nodecp-panel nodecp-controls-card">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Node Controls</p>
            <h3>{selectedNode ? 'Run this node' : 'Select a node'}</h3>
          </div>
        </div>
        <p className="nodecp-controls-copy">
          Start, stop, or fast-sync the selected workspace. Sync stops the node,
          catches it up to the live chain, and starts it again automatically.
        </p>
        <div className="nodecp-controls-layout">
          <SNRGButton
            className="nodecp-control-btn nodecp-control-start"
            variant="lime"
            size="sm"
            disabled={controlDisabled || isRunning}
            onClick={() => runNodeControl('start')}
          >
            <span className="nodecp-action-icon">{ICONS.play}</span>
            <span>{controlBusy === 'start' ? 'Starting...' : 'Start'}</span>
          </SNRGButton>
          <SNRGButton
            className="nodecp-control-btn nodecp-control-stop"
            variant="red"
            size="sm"
            disabled={controlDisabled || !isRunning}
            onClick={() => runNodeControl('stop')}
          >
            <span className="nodecp-action-icon">{ICONS.stop}</span>
            <span>{controlBusy === 'stop' ? 'Stopping...' : 'Stop'}</span>
          </SNRGButton>
          <SNRGButton
            className="nodecp-control-btn nodecp-control-sync nodecp-control-btn-full"
            variant="yellow"
            size="sm"
            disabled={controlDisabled || !selectedNode?.config_paths?.length}
            onClick={() => runNodeControl('sync')}
          >
            <span className="nodecp-action-icon">{ICONS.sync}</span>
            <span>{controlBusy === 'sync' ? 'Syncing...' : 'Speed Sync'}</span>
          </SNRGButton>
          <SNRGButton
            className="nodecp-control-btn"
            variant="blue"
            size="sm"
            disabled={!selectedNode}
            onClick={async () => {
              if (!selectedNode) return;
              await navigator.clipboard.writeText(selectedNode.node_address);
              setCopiedNotice('Wallet copied');
            }}
          >
            <span className="nodecp-action-icon">{ICONS.copy}</span>
            <span>Copy Wallet</span>
          </SNRGButton>
          <SNRGButton
            className="nodecp-control-btn"
            variant="blue"
            size="sm"
            disabled={!selectedNode}
            onClick={() => selectedNode && openPath(selectedNode.workspace_directory)}
          >
            <span className="nodecp-action-icon">{ICONS.folder}</span>
            <span>Open Workspace</span>
          </SNRGButton>
          <SNRGButton
            className="nodecp-control-btn"
            variant="blue"
            size="sm"
            disabled={!nodeTomlPath}
            onClick={() => nodeTomlPath && openPath(nodeTomlPath)}
          >
            <span className="nodecp-action-icon">{ICONS.file}</span>
            <span>Open Config</span>
          </SNRGButton>
          <SNRGButton
            className="nodecp-control-btn"
            variant="blue"
            size="sm"
            disabled={!selectedNode}
            onClick={() => selectedNode && openPath(`${selectedNode.workspace_directory}/logs`)}
          >
            <span className="nodecp-action-icon">{ICONS.folder}</span>
            <span>Open Logs</span>
          </SNRGButton>
        </div>
        <div className="nodecp-controls-status">
          <span className={`nodecp-health-pill nodecp-health-${formatStatusTone(selectedWorkspaceStatus.label)}`}>
            {selectedWorkspaceStatus.label}
          </span>
          <span>{controlMessage || copiedNotice || selectedWorkspaceStatus.detail}</span>
        </div>
      </aside>
    );
  };

  const renderOverview = () => (
    <div className="nodecp-tab-stack">
      {!selectedNode ? (
        <div className="nodecp-empty-state">
          <div>
            <p className="nodecp-empty-kicker">No nodes on this machine yet</p>
            <h3>Create the first node workspace</h3>
            <p>
              Setup provisions a dedicated workspace, keypair, and bootstrap wiring for a real network node.
            </p>
          </div>
        </div>
      ) : null}

      <div className="nodecp-overview-top">
        <div className="nodecp-overview-main">
          <div className="nodecp-stats-grid">
            {metrics.map((card) => (
              <article key={card.label} className="nodecp-stat-card">
                <div className="nodecp-stat-icon">{card.icon}</div>
                <div className="nodecp-stat-copy">
                  <span className="nodecp-stat-label">{card.label}</span>
                  <strong className="nodecp-stat-value">{card.value}</strong>
                  <span className="nodecp-stat-detail">{card.detail}</span>
                </div>
              </article>
            ))}
          </div>

          {selectedNode ? (
            <section className="nodecp-panel">
              <div className="nodecp-panel-header">
                <div>
                  <p className="nodecp-panel-kicker">Selected node</p>
                  <h3>{selectedNode.display_label || selectedNode.role_display_name}</h3>
                </div>
              </div>

              <div className="nodecp-summary-grid">
                <div className="nodecp-summary-block">
                  <span className="nodecp-summary-label">Node Wallet</span>
                  <p>{truncateAddress(selectedNode.node_address)}</p>
                </div>
                <div className="nodecp-summary-block">
                  <span className="nodecp-summary-label">Reserved Stake</span>
                  <p>{formatWholeSnrg(selectedFundingManifest?.amount_snrg || 5000)} SNRG</p>
                </div>
                <div className="nodecp-summary-block">
                  <span className="nodecp-summary-label">Block Production</span>
                  <p>{validatorQuorumCopy}</p>
                </div>
                <div className="nodecp-summary-block">
                  <span className="nodecp-summary-label">Role Summary</span>
                  <p>{selectedRole?.summary || 'This role is ready for setup on this computer.'}</p>
                </div>
                <div className="nodecp-summary-block">
                  <span className="nodecp-summary-label">Reward Tier</span>
                  <p>{rewardProfile.tier} earning profile at {rewardProfile.multiplier}.</p>
                </div>
                <div className="nodecp-summary-block">
                  <span className="nodecp-summary-label">Public Endpoint</span>
                  <p>{selectedNode.public_host || 'Auto-detect pending'}</p>
                </div>
              </div>
            </section>
          ) : null}
        </div>

        {renderNodeControls()}
      </div>

      <div className="nodecp-status-grid">
        {statusCards.map((card) => (
          <article key={card.label} className={`nodecp-status-card nodecp-status-${card.tone}`}>
            <div className="nodecp-status-head">
              <span className="nodecp-status-icon">{card.icon}</span>
              <span className="nodecp-status-label">{card.label}</span>
            </div>
            <strong className="nodecp-status-value">{card.value}</strong>
            <p className="nodecp-status-detail">{card.detail}</p>
          </article>
        ))}
      </div>

      {selectedRole ? (
        <div className="nodecp-panel-grid">
          <section className="nodecp-panel">
            <div className="nodecp-panel-header">
              <div>
                <p className="nodecp-panel-kicker">Shared responsibilities</p>
                <h3>What this node handles</h3>
              </div>
            </div>
            <ul className="nodecp-list">
              {(selectedRole.responsibilities || []).slice(0, 5).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section className="nodecp-panel">
            <div className="nodecp-panel-header">
              <div>
                <p className="nodecp-panel-kicker">SNRG rewards</p>
                <h3>How this node earns</h3>
              </div>
            </div>
            <p className="nodecp-panel-copy">{rewardProfile.summary}</p>
            <ul className="nodecp-list">
              {rewardProfile.sources.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  );

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
              <span className="nodecp-stat-detail">Threshold required for SXCP finality.</span>
            </div>
          </div>
          <div className="nodecp-stat-card">
            <div className="nodecp-stat-icon">{ICONS.peers}</div>
            <div className="nodecp-stat-copy">
              <span className="nodecp-stat-label">Relayers online</span>
              <span className="nodecp-stat-value">{formatNumber(relayerSummary.online)} / {formatNumber(relayerSummary.total)}</span>
              <span className="nodecp-stat-detail">Eligible: {formatNumber(relayerSummary.eligible)}</span>
            </div>
          </div>
          <div className="nodecp-stat-card">
            <div className="nodecp-stat-icon">{ICONS.chain}</div>
            <div className="nodecp-stat-copy">
              <span className="nodecp-stat-label">Pending events</span>
              <span className="nodecp-stat-value">
                {relayerSummary.pending == null ? '—' : formatNumber(relayerSummary.pending)}
              </span>
              <span className="nodecp-stat-detail">Awaiting quorum attestations.</span>
            </div>
          </div>
          <div className="nodecp-stat-card">
            <div className="nodecp-stat-icon">{ICONS.shield}</div>
            <div className="nodecp-stat-copy">
              <span className="nodecp-stat-label">Finalized events</span>
              <span className="nodecp-stat-value">
                {relayerSummary.finalized == null ? '—' : formatNumber(relayerSummary.finalized)}
              </span>
              <span className="nodecp-stat-detail">Confirmed SXCP settlements.</span>
            </div>
          </div>
        </div>
      </section>

      <div className="nodecp-panel-grid">
        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Discovery order</p>
              <h3>What new nodes try first</h3>
            </div>
          </div>
          <ol className="nodecp-list nodecp-list-numbered">
            {(network?.bootstrap_policy?.fallback_sequence || []).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Current network state</p>
              <h3>Chain availability</h3>
            </div>
          </div>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Public RPC endpoint</span>
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
              <span>Visible peers</span>
              <strong>{formatNumber(liveStatus?.public_peer_count)}</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  );

  const renderWallet = () => (
    <div className="nodecp-tab-stack">
      <div className="nodecp-panel-grid">
        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Selected node wallet</p>
              <h3>Address and score</h3>
            </div>
          </div>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Node wallet</span>
              <strong>{truncateAddress(selectedNode?.node_address)}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Reserved stake</span>
              <strong>{formatWholeSnrg(selectedFundingManifest?.amount_snrg || 5000)} SNRG</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Synergy score</span>
              <strong>{formatScoreOutOfHundred(selectedNodeLive?.synergy_score)}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Reward weighting</span>
              <strong>{rewardProfile.multiplier}</strong>
            </div>
          </div>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">SNRG rewards</p>
              <h3>Role-specific earning profile</h3>
            </div>
          </div>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Reward tier</span>
              <strong>{rewardProfile.tier}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Reserved stake</span>
              <strong>{formatWholeSnrg(selectedFundingManifest?.amount_snrg || 5000)} SNRG</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Total reserved network stake</span>
              <strong>{formatWholeSnrg(state?.summary?.total_sponsored_stake_snrg || 0)} SNRG</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>How this node earns</span>
              <strong>{rewardProfile.sources.join(' / ')}</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  );

  const renderRoleTab = () => (
    <div className="nodecp-tab-stack">
      <div className="nodecp-panel-grid">
        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">{roleTab.label}</p>
              <h3>Role-specific services</h3>
            </div>
          </div>
          <ul className="nodecp-list">
            {(selectedRole?.service_surface || []).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">{roleTab.label}</p>
              <h3>Operator KPIs</h3>
            </div>
          </div>
          <ul className="nodecp-list">
            {(selectedRole?.operator_kpis || []).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">{roleTab.label}</p>
              <h3>Policy guardrails</h3>
            </div>
          </div>
          <ul className="nodecp-list">
            {(selectedRole?.policy_highlights || []).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">{roleTab.label}</p>
              <h3>Storage profile</h3>
            </div>
          </div>
          <p className="nodecp-panel-copy">{selectedRole?.storage_profile || 'Role-specific storage guidance is not available yet.'}</p>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Authority plane</span>
              <strong>{selectedRole?.authority_plane || 'Unknown'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Local runtime state</span>
              <strong>{selectedWorkspaceStatus.label}</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  );

  const renderFiles = () => (
    <div className="nodecp-tab-stack">
      <section className="nodecp-panel">
        <div className="nodecp-panel-header">
          <div>
            <p className="nodecp-panel-kicker">Workspace files</p>
            <h3>Where to inspect this node</h3>
          </div>
        </div>

        {selectedNode ? (
          <div className="nodecp-file-grid">
            <div className="nodecp-file-card">
              <span className="nodecp-file-label">Workspace</span>
              <strong>{selectedNode.workspace_directory}</strong>
            </div>
            {(selectedNode.config_paths || []).map((path) => (
              <SNRGButton key={path} as="button" variant="blue" size="sm" className="nodecp-file-card nodecp-file-card-button" onClick={() => openPath(path)}>
                <span className="nodecp-file-label">{path.split('/').slice(-2).join('/')}</span>
                <strong>{path}</strong>
              </SNRGButton>
            ))}
          </div>
        ) : (
          <div className="nodecp-empty-inline">
            Start setup to create the first node workspace and config files.
          </div>
        )}
      </section>
    </div>
  );

  const renderTabContent = () => {
    switch (activeTab) {
      case 'connectivity':
        return renderConnectivity();
      case 'wallet':
        return renderWallet();
      case 'role':
        return renderRoleTab();
      case 'files':
        return renderFiles();
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
                      <span className={`nodecp-health-pill ${slot.isOnline ? 'nodecp-health-good' : 'nodecp-health-bad'}`}>
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
                  <h2 className="panel-title nodecp-page-title">Node Overview</h2>
                  <p className="nodecp-page-copy">{headerCopy}</p>
                </div>
                <div className="control-buttons nodecp-control-buttons">
                  <SNRGButton className="nodecp-header-btn nodecp-refresh-btn" variant="blue" size="sm" onClick={() => fetchDashboard(true)}>
                    <span className="nodecp-action-icon">{ICONS.refresh}</span>
                    <span>Refresh</span>
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
