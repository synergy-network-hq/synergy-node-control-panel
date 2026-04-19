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
import {
  clearTestnetBetaPageDataCache,
  fetchTestnetBetaLiveStatus,
  fetchTestnetBetaState,
  peekTestnetBetaLiveStatus,
  peekTestnetBetaState,
} from '../../lib/testnetBetaPageData';

const POLL_INTERVAL_MS = 8000;
const ControlPanelContext = createContext(null);

export function clearTestnetBetaDashboardCache() {
  clearTestnetBetaPageDataCache();
}

export function ControlPanelProvider({ children }) {
  const [viewMode, setViewMode] = usePanelViewMode();
  const [state, setState] = useState(() => peekTestnetBetaState());
  const [liveStatus, setLiveStatus] = useState(() => peekTestnetBetaLiveStatus());
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [loading, setLoading] = useState(() => peekTestnetBetaState() == null);
  const [error, setError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const nodes = state?.nodes || [];
  const nodeCatalog = state?.node_catalog || [];
  const network = state?.network_profile || {};

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

    return {
      runningNodes,
      syncedNodes,
      healthyBootnodes,
      totalBootnodes: (liveStatus?.bootnodes || []).length,
      totalPeers,
      publicChainHeight: liveStatus?.public_chain_height ?? null,
      discoveryStatus: liveStatus?.discovery_status || 'Unknown',
      publicRpcOnline: liveStatus?.public_rpc_online === true,
    };
  }, [liveStatus]);

  const value = {
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
    state,
    validatorNodesByAddress,
    knownValidatorAddressesByHost,
    viewMode,
    setViewMode,
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
