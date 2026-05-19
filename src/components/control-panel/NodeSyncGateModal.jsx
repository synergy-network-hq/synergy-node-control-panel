import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SNRGButton } from '../../styles/SNRGButton';
import { useControlPanel } from './ControlPanelProvider';
import {
  effectiveLocalChainHeight,
  formatNumber,
  formatPercent,
  formatRuntimeDuration,
  nodeSyncPercent,
} from './controlPanelModel';
import { runNodeControlAction } from './controlPanelActions';

const SYNC_POLL_MS = 2500;
const SYNC_READY_GAP = 2;

function formatEta(secondsValue) {
  const seconds = Number(secondsValue);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 'Calculating';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return '<1m';
}

function syncStageLabel(syncStatus, nodeLive, syncPercent) {
  if (syncStatus === 'stopped') {
    return 'Sync stopped';
  }
  if (syncStatus === 'error') {
    return 'Sync needs attention';
  }
  if (!nodeLive?.is_running) {
    return 'Starting runtime';
  }
  if (nodeLive.local_rpc_ready === false) {
    return 'Waiting for local RPC';
  }
  if (syncPercent >= 99.5 && (Number(nodeLive?.sync_gap) || 0) <= SYNC_READY_GAP) {
    return 'Chain synced';
  }
  if (nodeLive?.sync_trending === 'stalled') {
    return 'Sync stalled';
  }
  return 'Syncing chain';
}

export default function NodeSyncGateModal({ nodeId, onComplete }) {
  const {
    liveStatus,
    network,
    nodeLiveById,
    nodes,
    recordAction,
    refresh,
    selectedNode,
    setSelectedNodeId,
  } = useControlPanel();
  const [syncStatus, setSyncStatus] = useState('waiting');
  const [detail, setDetail] = useState('Waiting for the node registry to refresh.');
  const [busy, setBusy] = useState(false);
  const startAttemptedRef = useRef(false);
  const completedRef = useRef(false);

  const targetNode = useMemo(() => {
    if (!nodeId) {
      return null;
    }
    return nodes.find((node) => node.id === nodeId) || null;
  }, [nodeId, nodes]);

  const nodeLive = targetNode ? nodeLiveById[targetNode.id] || null : null;
  const localHeight = effectiveLocalChainHeight(nodeLive);
  const networkHeight = Number(nodeLive?.sync_target_height ?? liveStatus?.public_chain_height);
  const syncPercent = nodeSyncPercent(nodeLive, liveStatus);
  const syncGap = Number(nodeLive?.sync_gap);
  const syncReady = Boolean(
    targetNode
      && nodeLive?.is_running
      && nodeLive.local_rpc_ready !== false
      && syncPercent >= 99.5
      && (!Number.isFinite(syncGap) || syncGap <= SYNC_READY_GAP),
  );
  const stage = syncStageLabel(syncStatus, nodeLive, syncPercent);
  const progressStyle = { '--sync-progress': `${Math.max(0, Math.min(100, syncPercent))}%` };

  const startSync = useCallback(async () => {
    if (!targetNode || busy) {
      return;
    }

    setBusy(true);
    setSyncStatus('starting');
    setDetail('Starting the validator runtime and refreshing peer targets.');
    try {
      const response = await runNodeControlAction({
        node: targetNode,
        network,
        action: 'start',
      });
      const message = response?.message || 'Node runtime started. Watching chain sync now.';
      setDetail(message);
      setSyncStatus('running');
      recordAction({
        title: 'Mandatory chain sync started',
        detail: message,
        status: 'info',
        source: 'sync-gate',
        command: 'testnet_node_control:start',
        payload: { nodeId: targetNode.id },
      });
      await refresh({ silent: true });
    } catch (error) {
      const message = String(error);
      setDetail(message);
      setSyncStatus('error');
      recordAction({
        title: 'Mandatory chain sync failed to start',
        detail: message,
        status: 'error',
        source: 'sync-gate',
        command: 'testnet_node_control:start',
        payload: { nodeId: targetNode.id },
      });
    } finally {
      setBusy(false);
    }
  }, [busy, network, recordAction, refresh, targetNode]);

  const stopSync = useCallback(async () => {
    if (!targetNode || busy) {
      return;
    }

    setBusy(true);
    setSyncStatus('stopping');
    setDetail('Stopping sync and shutting down the node runtime.');
    try {
      const response = await runNodeControlAction({
        node: targetNode,
        network,
        action: 'stop',
      });
      const message = response?.message || 'Node stopped. Chain sync must be restarted before setup can finish.';
      setDetail(message);
      setSyncStatus('stopped');
      recordAction({
        title: 'Mandatory chain sync stopped',
        detail: message,
        status: 'warn',
        source: 'sync-gate',
        command: 'testnet_node_control:stop',
        payload: { nodeId: targetNode.id },
      });
      await refresh({ silent: true });
    } catch (error) {
      const message = String(error);
      setDetail(message);
      setSyncStatus('error');
    } finally {
      setBusy(false);
    }
  }, [busy, network, recordAction, refresh, targetNode]);

  useEffect(() => {
    if (!nodeId) {
      return;
    }
    startAttemptedRef.current = false;
    completedRef.current = false;
    setSyncStatus('waiting');
    setDetail('Waiting for the node registry to refresh.');
  }, [nodeId]);

  useEffect(() => {
    if (targetNode?.id && selectedNode?.id !== targetNode.id) {
      setSelectedNodeId(targetNode.id);
    }
  }, [selectedNode?.id, setSelectedNodeId, targetNode?.id]);

  useEffect(() => {
    if (!nodeId || !targetNode || startAttemptedRef.current) {
      return;
    }
    startAttemptedRef.current = true;
    void startSync();
  }, [nodeId, startSync, targetNode]);

  useEffect(() => {
    if (!nodeId || completedRef.current) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void refresh({ silent: true });
    }, SYNC_POLL_MS);

    void refresh({ silent: true });

    return () => {
      window.clearInterval(intervalId);
    };
  }, [nodeId, refresh]);

  useEffect(() => {
    if (!syncReady || completedRef.current) {
      return;
    }

    completedRef.current = true;
    setSyncStatus('complete');
    setDetail('The node is caught up enough to enter the control panel.');
    recordAction({
      title: 'Mandatory chain sync completed',
      detail: `${targetNode?.display_label || targetNode?.id || 'Node'} reached ${formatNumber(localHeight)} with ${formatNumber(syncGap || 0)} block gap.`,
      status: 'success',
      source: 'sync-gate',
      command: 'sync-gate:complete',
      payload: { nodeId: targetNode?.id || null },
    });
    window.setTimeout(() => {
      onComplete?.();
    }, 900);
  }, [localHeight, onComplete, recordAction, syncGap, syncReady, targetNode]);

  if (!nodeId) {
    return null;
  }

  return (
    <div className="cp-sync-gate" role="dialog" aria-modal="true" aria-labelledby="cp-sync-gate-title">
      <section className="cp-sync-gate-card">
        <div className="cp-sync-gate-head">
          <div>
            <span className="cp-eyebrow">Mandatory chain sync</span>
            <h2 id="cp-sync-gate-title">{stage}</h2>
            <p>
              {targetNode
                ? `${targetNode.display_label || targetNode.id} must catch up before validator operations are enabled.`
                : 'The new node is being loaded from the local registry.'}
            </p>
          </div>
          <button
            type="button"
            className="cp-sync-gate-close"
            onClick={() => void stopSync()}
            disabled={!targetNode || busy || syncStatus === 'stopped' || syncStatus === 'complete'}
            title="Stop syncing"
            aria-label="Stop syncing"
          >
            <span className="material-icons" aria-hidden="true">close</span>
          </button>
        </div>

        <div className="cp-sync-gate-progress" style={progressStyle}>
          <span></span>
        </div>

        <div className="cp-sync-gate-metrics">
          <article>
            <small>Local height</small>
            <strong>{formatNumber(localHeight)}</strong>
          </article>
          <article>
            <small>Network tip</small>
            <strong>{formatNumber(Number.isFinite(networkHeight) ? networkHeight : liveStatus?.public_chain_height)}</strong>
          </article>
          <article>
            <small>Verified source</small>
            <strong>{nodeLive?.sync_target_verified ? (nodeLive?.sync_target_source || 'Verified') : 'Blocked'}</strong>
          </article>
          <article>
            <small>Sync progress</small>
            <strong>{formatPercent(syncPercent, 1)}</strong>
          </article>
          <article>
            <small>Gap</small>
            <strong>{Number.isFinite(syncGap) ? `${formatNumber(syncGap)} blocks` : 'Waiting'}</strong>
          </article>
        </div>
        {nodeLive?.sync_target_error ? (
          <p className="cp-sync-gate-warning">{nodeLive.sync_target_error}</p>
        ) : null}

        <div className="cp-sync-gate-status">
          <span className={`cp-sync-dot is-${syncStatus}`}></span>
          <div>
            <strong>{detail}</strong>
            <p>
              Runtime: {nodeLive?.is_running ? `running for ${formatRuntimeDuration(nodeLive?.process_uptime_secs)}` : 'stopped'}.
              {' '}RPC: {nodeLive?.local_rpc_status || 'waiting for status'}.
            </p>
          </div>
        </div>

        <div className="cp-sync-gate-foot">
          <div>
            <small>Estimated time remaining</small>
            <strong>{formatEta(nodeLive?.estimated_sync_eta_secs)}</strong>
          </div>
          <div className="cp-sync-gate-actions">
            {syncStatus === 'stopped' || syncStatus === 'error' ? (
              <SNRGButton variant="purple" size="sm" onClick={() => void startSync()} disabled={!targetNode || busy}>
                {busy ? 'Starting...' : 'Restart Chain Sync'}
              </SNRGButton>
            ) : (
              <SNRGButton variant="red" size="sm" onClick={() => void stopSync()} disabled={!targetNode || busy || syncStatus === 'complete'}>
                {busy ? 'Stopping...' : 'Stop Syncing'}
              </SNRGButton>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
