import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { buildKnownValidatorAddressMap, buildValidatorNodeMap } from '../../lib/testnetBetaPeerInfo';
import { usePanelViewMode } from '../../lib/panelViewMode';
import { getViewProfile } from './viewProfiles';
import {
  clearTestnetBetaPageDataCache,
  fetchTestnetBetaLiveStatus,
  fetchTestnetBetaState,
  peekTestnetBetaLiveStatus,
  peekTestnetBetaState,
} from '../../lib/testnetBetaPageData';

const POLL_INTERVAL_MS = 8000;
const HISTORY_MAX_POINTS = 90;
const ACTION_AUDIT_LIMIT = 120;
const ControlPanelContext = createContext(null);

function appendHistoryPoint(points, point) {
  const safePoints = Array.isArray(points) ? points : [];
  const deduped = safePoints.length && safePoints[safePoints.length - 1]?.at === point.at
    ? safePoints.slice(0, -1)
    : safePoints;
  return [...deduped, point].slice(-HISTORY_MAX_POINTS);
}

function buildTelemetrySnapshot(liveStatus) {
  const timestamp = Date.now();
  const nodes = Array.isArray(liveStatus?.nodes) ? liveStatus.nodes : [];
  return {
    at: timestamp,
    network: {
      at: timestamp,
      runningNodes: nodes.filter((entry) => entry?.is_running).length,
      syncedNodes: nodes.filter((entry) => (
        entry?.is_running
        && entry?.local_rpc_ready !== false
        && (Number(entry?.sync_gap) || 0) <= 32
      )).length,
      totalPeers: nodes.reduce((highest, entry) => {
        const peerCount = Number(entry?.local_peer_count);
        return Number.isFinite(peerCount) ? Math.max(highest, peerCount) : highest;
      }, 0),
      publicChainHeight: Number(
        liveStatus?.public_chain_height
        ?? nodes.reduce((highest, entry) => {
          const candidate = Number(
            entry?.best_network_height
            ?? entry?.local_chain_height
            ?? entry?.log_local_chain_height,
          );
          return Number.isFinite(candidate) ? Math.max(highest, candidate) : highest;
        }, 0),
      ) || 0,
      publicRpcOnline: liveStatus?.public_rpc_online === true,
      discoveryStatus: liveStatus?.discovery_status || 'Unknown',
    },
    nodes: nodes.map((entry) => ({
      at: timestamp,
      nodeId: entry?.node_id,
      isRunning: entry?.is_running === true,
      localPeerCount: Number(entry?.local_peer_count) || 0,
      syncGap: Number(entry?.sync_gap) || 0,
      blockHeight: Number(
        entry?.local_chain_height
        ?? entry?.log_local_chain_height
        ?? entry?.best_network_height,
      ) || 0,
      score: Number(entry?.synergy_score) || 0,
      rpcReady: entry?.local_rpc_ready !== false,
      uptime: Number(entry?.process_uptime_secs) || 0,
      bestNetworkHeight: Number(entry?.best_network_height) || 0,
      rpcLatencyMs: Number(entry?.rpc_latency_ms) || 0,
      cpuPercent: Number(entry?.cpu_percent) || 0,
      memoryMb: Number(entry?.memory_mb) || 0,
      diskPercent: Number(entry?.disk_percent) || 0,
      errorRate: Number(entry?.error_rate) || 0,
    })),
  };
}

function mergeTelemetryHistory(previous, snapshot) {
  if (!snapshot) {
    return previous;
  }

  const nextByNodeId = { ...(previous?.byNodeId || {}) };
  snapshot.nodes.forEach((nodeEntry) => {
    if (!nodeEntry?.nodeId) {
      return;
    }
    nextByNodeId[nodeEntry.nodeId] = appendHistoryPoint(nextByNodeId[nodeEntry.nodeId], nodeEntry);
  });

  return {
    network: appendHistoryPoint(previous?.network, snapshot.network),
    byNodeId: nextByNodeId,
  };
}

function createAuditEntry(entry = {}) {
  return {
    id: entry.id || `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: entry.at || Date.now(),
    title: entry.title || 'Control panel action',
    detail: entry.detail || '',
    status: entry.status || 'info',
    source: entry.source || 'control-panel',
    code: entry.code || '',
    command: entry.command || '',
    payload: entry.payload || null,
  };
}

export function clearTestnetBetaDashboardCache() {
  clearTestnetBetaPageDataCache();
}

export function ControlPanelProvider({ children }) {
  const [viewMode, setViewMode] = usePanelViewMode();
  const [state, setState] = useState(() => peekTestnetBetaState());
  const [liveStatus, setLiveStatus] = useState(() => peekTestnetBetaLiveStatus());
  const [telemetryHistory, setTelemetryHistory] = useState(() => {
    const initialLiveStatus = peekTestnetBetaLiveStatus();
    const snapshot = initialLiveStatus ? buildTelemetrySnapshot(initialLiveStatus) : null;
    return snapshot
      ? mergeTelemetryHistory({ network: [], byNodeId: {} }, snapshot)
      : { network: [], byNodeId: {} };
  });
  const [actionAudit, setActionAudit] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [loading, setLoading] = useState(() => peekTestnetBetaState() == null);
  const [error, setError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [timeRange, setTimeRange] = useState('6h');
  const [peerRegionFilter, setPeerRegionFilter] = useState('all');
  const [selectedPeerId, setSelectedPeerId] = useState('');

  const nodes = state?.nodes || [];
  const nodeCatalog = state?.node_catalog || [];
  const network = state?.network_profile || {};
  const viewProfile = useMemo(() => getViewProfile(viewMode), [viewMode]);

  useEffect(() => {
    if (!nodes.length) {
      setSelectedNodeId('');
      return;
    }

    setSelectedNodeId((current) => (
      nodes.some((node) => node.id === current)
        ? current
        : nodes[0].id
    ));
  }, [nodes]);

  const refresh = async ({ silent = false } = {}) => {
    if (!silent && !state) {
      setLoading(true);
    }

    const [stateResult, liveResult] = await Promise.allSettled([
      fetchTestnetBetaState({ force: true }),
      fetchTestnetBetaLiveStatus({ force: true }),
    ]);

    const nextError = [];

    startTransition(() => {
      if (stateResult.status === 'fulfilled') {
        setState(stateResult.value);
      } else {
        nextError.push(String(stateResult.reason));
      }

      if (liveResult.status === 'fulfilled') {
        setLiveStatus(liveResult.value);
        setTelemetryHistory((previous) => (
          mergeTelemetryHistory(previous, buildTelemetrySnapshot(liveResult.value))
        ));
      } else {
        nextError.push(String(liveResult.reason));
      }

      setError(nextError.join(' '));
      setLoading(false);
      setLastUpdatedAt(Date.now());
    });
  };

  useEffect(() => {
    void refresh();

    const intervalId = window.setInterval(() => {
      void refresh({ silent: true });
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const nodeLiveById = useMemo(
    () => (liveStatus?.nodes || []).reduce((accumulator, item) => {
      accumulator[item.node_id] = item;
      return accumulator;
    }, {}),
    [liveStatus?.nodes],
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || nodes[0] || null,
    [nodes, selectedNodeId],
  );

  const selectedNodeLive = useMemo(
    () => (selectedNode ? nodeLiveById[selectedNode.id] || null : null),
    [nodeLiveById, selectedNode],
  );

  const selectedRole = useMemo(
    () => nodeCatalog.find((entry) => entry.id === selectedNode?.role_id) || null,
    [nodeCatalog, selectedNode?.role_id],
  );

  const knownValidatorAddressesByHost = useMemo(
    () => buildKnownValidatorAddressMap(nodes),
    [nodes],
  );

  const validatorNodesByAddress = useMemo(
    () => buildValidatorNodeMap(nodes),
    [nodes],
  );

  const networkStats = useMemo(() => {
    const liveNodes = liveStatus?.nodes || [];
    const runningNodes = liveNodes.filter((entry) => entry?.is_running).length;
    const syncedNodes = liveNodes.filter((entry) => (
      entry?.is_running
      && entry?.local_rpc_ready !== false
      && (Number(entry?.sync_gap) || 0) <= 32
    )).length;
    const healthyBootnodes = (liveStatus?.bootnodes || []).filter((entry) => entry?.reachable).length;
    const totalPeers = liveNodes.reduce((highest, entry) => {
      const peerCount = Number(entry?.local_peer_count);
      return Number.isFinite(peerCount) ? Math.max(highest, peerCount) : highest;
    }, 0);
    const validatorMeshHeight = liveNodes.reduce((highest, entry) => {
      const candidate = Number(
        entry?.best_network_height
          ?? entry?.local_chain_height
          ?? entry?.log_local_chain_height,
      );
      return Number.isFinite(candidate) ? Math.max(highest, candidate) : highest;
    }, 0);
    const publicChainHeight = Number(liveStatus?.public_chain_height);
    const usingMeshHeightFallback = !Number.isFinite(publicChainHeight) || publicChainHeight <= 0;

    return {
      runningNodes,
      syncedNodes,
      healthyBootnodes,
      totalBootnodes: (liveStatus?.bootnodes || []).length,
      totalPeers,
      publicChainHeight: usingMeshHeightFallback
        ? (validatorMeshHeight > 0 ? validatorMeshHeight : null)
        : publicChainHeight,
      publicChainHeightSource: usingMeshHeightFallback ? 'validator-mesh' : 'public-rpc',
      discoveryStatus: liveStatus?.discovery_status || 'Unknown',
      publicRpcOnline: liveStatus?.public_rpc_online === true,
    };
  }, [liveStatus]);

  const recordAction = useMemo(
    () => (entry) => {
      setActionAudit((current) => [
        createAuditEntry(entry),
        ...current,
      ].slice(0, ACTION_AUDIT_LIMIT));
    },
    [],
  );

  const clearActionAudit = useMemo(
    () => () => {
      setActionAudit([]);
    },
    [],
  );

  const value = {
    actionAudit,
    clearActionAudit,
    error,
    lastUpdatedAt,
    liveStatus,
    loading,
    network,
    networkStats,
    nodeCatalog,
    nodes,
    nodeLiveById,
    refresh,
    selectedNode,
    selectedNodeId,
    selectedNodeLive,
    selectedRole,
    setSelectedNodeId,
    setSelectedPeerId,
    setPeerRegionFilter,
    setTimeRange,
    state,
    telemetryHistory,
    timeRange,
    validatorNodesByAddress,
    knownValidatorAddressesByHost,
    viewMode,
    viewProfile,
    setViewMode,
    peerRegionFilter,
    recordAction,
    selectedPeerId,
  };

  return (
    <ControlPanelContext.Provider value={value}>
      {children}
    </ControlPanelContext.Provider>
  );
}

export function useControlPanel() {
  const value = useContext(ControlPanelContext);
  if (!value) {
    throw new Error('useControlPanel must be used inside ControlPanelProvider.');
  }
  return value;
}
