import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke } from '../../lib/desktopClient';
import { normalizePeerInfoPayload } from '../../lib/testnetBetaPeerInfo';
import { SNRGButton } from '../../styles/SNRGButton';
import { useControlPanel } from './ControlPanelProvider';
import {
  buildLatencyBars,
  buildTopologyModel,
  formatNumber,
  localRpcEndpointForNode,
  queryLocalRpc,
  safeArray,
  statusTone,
} from './controlPanelModel';
import {
  JarvisCard,
  MetricBars,
  MetricCard,
  PanelCard,
  SectionHeader,
  StatusPill,
  TopologyMap,
} from './ControlPanelShared';
import { boostSyncAction, registerWithSeedsAction } from './controlPanelActions';

export default function ControlPanelConnectivityPage() {
  const {
    error,
    knownValidatorAddressesByHost,
    liveStatus,
    networkStats,
    nodeLiveById,
    refresh,
    selectedNode,
    selectedNodeLive,
    validatorNodesByAddress,
    viewMode,
  } = useControlPanel();

  const [localPeerInfo, setLocalPeerInfo] = useState(null);
  const [localPeerInfoError, setLocalPeerInfoError] = useState('');
  const [localPeerLoading, setLocalPeerLoading] = useState(false);
  const [readinessReport, setReadinessReport] = useState(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [notice, setNotice] = useState('');

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
    if (!selectedNode || !selectedNodeLive?.is_running || selectedNodeLive?.local_rpc_ready !== true) {
      setLocalPeerInfo(null);
      setLocalPeerInfoError('');
      setLocalPeerLoading(false);
      return undefined;
    }

    let cancelled = false;
    const endpoint = localRpcEndpointForNode(selectedNode, selectedNodeLive);

    const fetchPeerInfo = async (showSpinner = false) => {
      if (showSpinner && !cancelled) {
        setLocalPeerLoading(true);
      }

      try {
        const peerInfo = await queryLocalRpc(endpoint, 'synergy_getPeerInfo', []);
        if (!cancelled) {
          setLocalPeerInfo(normalizePeerInfoPayload(peerInfo, knownValidatorAddressesByHost));
          setLocalPeerInfoError('');
        }
      } catch (peerError) {
        if (!cancelled) {
          setLocalPeerInfo(null);
          setLocalPeerInfoError(String(peerError));
        }
      } finally {
        if (!cancelled) {
          setLocalPeerLoading(false);
        }
      }
    };

    void fetchPeerInfo(true);
    const intervalId = window.setInterval(() => {
      void fetchPeerInfo(false);
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [knownValidatorAddressesByHost, selectedNode, selectedNodeLive]);

  useEffect(() => {
    if (!selectedNode) {
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
        const report = await invoke('testbeta_get_node_readiness', { nodeId: selectedNode.id });
        if (!cancelled) {
          setReadinessReport(report);
        }
      } catch (readinessError) {
        if (!cancelled) {
          setReadinessReport(null);
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
  }, [selectedNode]);

  const handleAction = async (kind) => {
    if (!selectedNode) {
      return;
    }

    setActionBusy(kind);
    try {
      const message = kind === 'boost'
        ? await boostSyncAction(selectedNode.id)
        : await registerWithSeedsAction(selectedNode.id);
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
      selectedNode,
      selectedNodeLive,
      localPeerInfo,
      liveStatus,
      validatorNodesByAddress,
      nodeLiveById,
      viewMode,
    }),
    [liveStatus, localPeerInfo, nodeLiveById, selectedNode, selectedNodeLive, validatorNodesByAddress, viewMode],
  );

  const latencyBars = useMemo(
    () => buildLatencyBars({ localPeerInfo, liveStatus }),
    [liveStatus, localPeerInfo],
  );

  const readinessHeadline = readinessReport
    ? `${readinessReport.ready_count}/${readinessReport.total_count} checks passed`
    : (readinessLoading ? 'Checking node readiness…' : 'Readiness not loaded');

  const livePeerCards = safeArray(localPeerInfo?.peers).slice(0, viewMode === 'developer' ? 8 : 5);

  return (
    <div className="cp-page-stack">
      <SectionHeader
        eyebrow={viewMode === 'basic' ? 'Network View' : 'Connectivity View'}
        title={viewMode === 'basic' ? 'Connection Map' : viewMode === 'expert' ? 'Peer Topology' : 'P2P Telemetry'}
        copy={viewMode === 'basic'
          ? 'A simpler view of how this node is connected to the wider Synergy network.'
          : 'Mesh status, route quality, bootstrap health, and node readiness in one place.'}
        actions={(
          <>
            <SNRGButton variant="blue" size="sm" onClick={() => void refresh()}>
              Refresh
            </SNRGButton>
            <SNRGButton
              variant="blue"
              size="sm"
              disabled={actionBusy === 'boost' || !selectedNode}
              onClick={() => void handleAction('boost')}
            >
              {actionBusy === 'boost' ? 'Boosting...' : 'Boost Sync'}
            </SNRGButton>
          </>
        )}
      />

      {(notice || error || localPeerInfoError) ? (
        <div className={`cp-inline-notice tone-${statusTone(notice || error || localPeerInfoError)}`}>
          {notice || error || localPeerInfoError}
        </div>
      ) : null}

      <div className="cp-dashboard-grid">
        <div className="cp-dashboard-main">
          <TopologyMap
            title={viewMode === 'basic' ? 'Who your node sees' : 'Live topology map'}
            detail={localPeerLoading
              ? 'Refreshing live peer sessions…'
              : (localPeerInfo?.peerCount
                ? `${formatNumber(localPeerInfo.peerCount)} peers visible from the selected node`
                : 'Falling back to bootstrap reachability and public network probes.')}
            model={topologyModel}
            action={(
              <SNRGButton
                variant="blue"
                size="sm"
                disabled={actionBusy === 'register' || !selectedNode}
                onClick={() => void handleAction('register')}
              >
                {actionBusy === 'register' ? 'Registering...' : 'Re-register'}
              </SNRGButton>
            )}
          />

          <MetricBars
            title={viewMode === 'basic' ? 'Connection quality' : 'Route quality bars'}
            detail={viewMode === 'basic'
              ? 'Healthy links stay bright. Weak or stale links fade toward warning states.'
              : 'Derived from live peer heartbeats or bootstrap relay latency when local peer info is unavailable.'}
            items={latencyBars}
          />

          <PanelCard
            title="Bootstrap services"
            detail="These public network entry points are the first layer of connectivity."
          >
            <div className="cp-endpoint-list">
              {safeArray(liveStatus?.bootnodes).map((entry, index) => (
                <div key={`${entry?.host || 'bootnode'}-${index}`} className="cp-endpoint-item">
                  <div>
                    <strong>{entry?.host || `Bootnode ${index + 1}`}</strong>
                    <span>{entry?.detail || 'Bootstrap relay probe'}</span>
                  </div>
                  <div className="cp-endpoint-meta">
                    <StatusPill tone={entry?.reachable ? 'good' : 'warn'}>
                      {entry?.reachable ? 'Reachable' : 'Pending'}
                    </StatusPill>
                    <small>{entry?.latency_ms != null ? `${entry.latency_ms} ms` : 'Waiting'}</small>
                  </div>
                </div>
              ))}
            </div>
          </PanelCard>

          {viewMode !== 'basic' && readinessReport ? (
            <PanelCard
              title="Readiness checks"
              detail={readinessHeadline}
              action={(
                <StatusPill tone={statusTone(readinessReport?.overall_status)}>
                  {readinessReport?.overall_status || 'Unknown'}
                </StatusPill>
              )}
            >
              <div className="cp-checklist">
                {safeArray(readinessReport?.checks).slice(0, viewMode === 'developer' ? 8 : 5).map((check) => (
                  <div key={check.id} className={`cp-checklist-item tone-${statusTone(check.status)}`}>
                    <strong>{check.label}</strong>
                    <p>{check.detail}</p>
                    {check.suggestion ? <small>{check.suggestion}</small> : null}
                  </div>
                ))}
              </div>
            </PanelCard>
          ) : null}
        </div>

        <div className="cp-dashboard-side">
          <JarvisCard
            mode={viewMode}
            title="Network Assistant"
            detailText="Guidance for Node Operations"
            message={viewMode === 'basic'
              ? 'Good news: your node is out there making friends instead of sulking in a digital corner. Keep an eye on bright links and peer count. If they start disappearing, the network is basically sending you a passive-aggressive text.'
              : viewMode === 'expert'
                ? 'Your node is mingling with the mesh like it actually read the invitation. Watch relay health, peer volume, and readiness together. If one starts acting dramatic, assume the others are about to join the show.'
                : 'The gossip layer is doing its thing, which is adorable when it works. If routes thin out or readiness drops, that is the network politely handing you homework with extra sarcasm.'}
            chips={[
              `${formatNumber(networkStats.healthyBootnodes)}/${formatNumber(networkStats.totalBootnodes)} relays`,
              `${formatNumber(localPeerInfo?.peerCount ?? 0)} peers`,
              readinessReport?.overall_status || 'Readiness pending',
            ]}
          />

          <div className="cp-metric-grid">
            <MetricCard
              label="Peer sessions"
              value={formatNumber(localPeerInfo?.peerCount ?? selectedNodeLive?.local_peer_count)}
              detail="Visible active peers from the selected node"
              tone="cyan"
              icon="hub"
            />
            <MetricCard
              label="Discovery"
              value={liveStatus?.discovery_status || 'Unknown'}
              detail={liveStatus?.discovery_detail || 'Waiting for the next probe'}
              tone={statusTone(liveStatus?.discovery_status)}
              icon="travel_explore"
            />
            <MetricCard
              label="Readiness"
              value={readinessReport?.overall_status || 'Pending'}
              detail={readinessHeadline}
              tone={statusTone(readinessReport?.overall_status)}
              icon="fact_check"
            />
            <MetricCard
              label="Public RPC"
              value={networkStats.publicRpcOnline ? 'Online' : 'Checking'}
              detail={liveStatus?.public_rpc_endpoint || 'Endpoint not reported'}
              tone={networkStats.publicRpcOnline ? 'good' : 'warn'}
              icon="lan"
            />
          </div>

          <PanelCard
            title={viewMode === 'basic' ? 'Nearby nodes' : 'Visible peers'}
            detail={livePeerCards.length ? 'Sample of the live peer sessions currently visible from this node.' : 'No local peer sessions are visible yet.'}
            action={selectedNode ? (
              <SNRGButton as={Link} to={`/node/${selectedNode.id}`} variant="blue" size="sm">
                Node Details
              </SNRGButton>
            ) : null}
          >
            <div className="cp-peer-list">
              {livePeerCards.length ? livePeerCards.map((peer) => (
                <article key={peer.id} className="cp-peer-item">
                  <div>
                    <strong>{peer.validatorAddress || peer.publicAddress || peer.address || 'Peer'}</strong>
                    <span>{peer.publicAddress || peer.address || 'No dial target reported'}</span>
                  </div>
                  <StatusPill tone="good">{peer.version || 'v?'}</StatusPill>
                </article>
              )) : <div className="cp-empty-inline">Run the node and allow peer discovery to populate this list.</div>}
            </div>
          </PanelCard>
        </div>
      </div>
    </div>
  );
}
