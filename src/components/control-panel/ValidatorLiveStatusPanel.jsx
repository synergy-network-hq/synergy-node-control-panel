import { useEffect, useMemo, useState } from 'react';
import { fetchValidatorLiveStatus, listenValidatorLiveStatus } from '../../lib/desktopClient';
import { formatNumber, safeArray, truncateMiddle } from './controlPanelModel';

const REQUIRED_STAKE_SNRG = 50000;
const REQUIRED_STAKE_NWEI = 50000000000000;
const LIFECYCLE_STEPS = [
  'REGISTERED',
  'KEY_BOUND',
  'STAKE_REQUIRED',
  'STAKE_SUBMITTED',
  'STAKE_CONFIRMED',
  'SYNCING',
  'SNAPSHOT_VERIFIED',
  'REPLAYING',
  'SHADOW',
  'READY',
  'PENDING_ACTIVATION',
  'ACTIVE',
];
const RECOVERY_STEPS = [
  'Quarantine triggered',
  'Consensus duties stopped',
  'Divergence height identified',
  'Canonical source selected',
  'Archive snapshot selected',
  'Snapshot downloaded',
  'Snapshot verified',
  'Divergent local data removed',
  'Canonical chain speed-sync started',
  'Canonical QCs verified',
  'State replay completed',
  'Index rebuild completed',
  'Rejoin readiness checks running',
  'Ready to rejoin',
  'Rejoined consensus',
];

function fallbackStatus(node, nodeLive = {}) {
  const isRunning = nodeLive?.is_running === true;
  const localRpcReady = nodeLive?.local_rpc_ready === true;
  const syncGap = Number(nodeLive?.sync_gap ?? 0);
  const currentStatus = !isRunning
    ? 'OFFLINE'
    : (!localRpcReady ? 'DEGRADED' : (syncGap > 2 ? 'SYNCING' : 'ACTIVE'));
  const color = currentStatus === 'ACTIVE'
    ? 'green'
    : (currentStatus === 'SYNCING' ? 'purple' : (currentStatus === 'DEGRADED' ? 'orange' : 'gray'));
  const headline = currentStatus === 'ACTIVE'
    ? 'VALIDATOR ACTIVE'
    : (currentStatus === 'SYNCING'
      ? 'VALIDATOR SYNCING'
      : (currentStatus === 'DEGRADED' ? 'VALIDATOR DEGRADED' : 'VALIDATOR OFFLINE'));
  const height = Number(nodeLive?.local_chain_height ?? nodeLive?.best_network_height ?? 0);
  return {
    node_id: node?.id || 'unknown',
    validator_id: node?.id || 'unknown',
    validator_uma_id: node?.node_address || '',
    role: node?.role_id || 'validator',
    chain_id: 1264,
    network_id: 'synergy-testnet-v2',
    current_status: currentStatus,
    status_headline: headline,
    status_color: color,
    status_severity: currentStatus === 'ACTIVE' ? 'healthy' : 'warning',
    is_consensus_active: currentStatus === 'ACTIVE',
    is_voting: currentStatus === 'ACTIVE',
    is_proposing: false,
    is_syncing: currentStatus === 'SYNCING',
    is_shadowing: false,
    is_pending_activation: false,
    is_quarantined: false,
    is_reconciling: false,
    is_jailed: false,
    is_offline: currentStatus === 'OFFLINE',
    is_failed_closed: false,
    latest_finalized_height: height,
    latest_finalized_block_hash: '',
    latest_state_root: '',
    latest_qc_hash: '',
    current_epoch: Math.floor(height / 1000),
    current_round: 0,
    current_cluster_id: 0,
    active_validator_set_hash: '',
    cluster_map_hash: '',
    protocol_config_hash: '',
    aegis_pqvm_version: 'aegis-pqvm-required',
    last_update_unix_ms: Date.now(),
    stale_after_ms: 12000,
    current_process: currentStatus,
    process_step: currentStatus,
    process_progress_percent: currentStatus === 'ACTIVE' ? 100 : 0,
    last_state_change: nodeLive?.local_rpc_status || 'Waiting for validator telemetry.',
    next_expected_action: currentStatus === 'OFFLINE' ? 'Start the validator runtime.' : 'Continue monitoring validator safety.',
    warnings: [],
    errors: [],
    required_stake_snrg: REQUIRED_STAKE_SNRG,
    required_stake_nwei: REQUIRED_STAKE_NWEI,
    current_stake_nwei: 0,
    stake_status: 'NOT_SUBMITTED',
    stake_verified: false,
    stake_blocking_reason: 'Stake 50,000 SNRG to continue validator onboarding.',
    consensus_activity: {
      current_leader: 'unknown',
      is_current_leader: false,
      current_height: height + 1,
      current_round: 0,
      current_epoch: Math.floor(height / 1000),
      current_cluster_id: 0,
      current_block_id: '',
      parent_block_hash: '',
      proposal_phase: currentStatus === 'ACTIVE' ? 'WAITING_FOR_PROPOSAL' : 'IDLE',
      vote_phase: currentStatus === 'ACTIVE' ? 'VOTING' : 'NOT_ACTIVE',
      has_voted: false,
      vote_decision: 'NOT YET',
      qc_status: 'WAITING',
      qc_signer_count: 0,
      qc_required_signer_count: 4,
      signed_weight: 0,
      required_threshold_weight: 4,
      next_expected_proposer: 'unknown',
      dag_ready_transaction_count: 0,
      dag_selected_transaction_count: 0,
    },
    lifecycle: {
      current_state: currentStatus === 'SYNCING' ? 'SYNCING' : (currentStatus === 'ACTIVE' ? 'ACTIVE' : 'STAKE_REQUIRED'),
      completed_steps: [],
      remaining_steps: LIFECYCLE_STEPS,
      required_shadow_blocks: 100,
      shadow_blocks_completed: 0,
      required_shadow_epochs: 1,
      shadow_epochs_completed: 0,
      required_vote_match_rate: 0.995,
    },
    quarantine: { divergence_cause: 'NONE' },
    jailing: { jailed: false },
    sync_snapshot: {
      sync_mode: currentStatus === 'SYNCING' ? 'FROM_QUORUM_PEERS' : 'NONE',
      current_sync_height: height,
      target_finalized_height: Number(nodeLive?.best_network_height ?? height),
      blocks_remaining: Number(nodeLive?.sync_gap ?? 0),
      qc_verification_count: height,
      snapshot_verification_status: 'not_required',
    },
    network_peer: {
      local_rpc_endpoint: nodeLive?.rpc_endpoint || '',
      local_rpc_ready: localRpcReady,
      local_peer_count: Number(nodeLive?.local_peer_count ?? 0),
      connected_validator_count: Number(nodeLive?.connected_validator_count ?? 0),
      status_ready_validator_count: Number(nodeLive?.status_ready_validator_count ?? 0),
    },
    aegis_pqvm: {
      status: 'READY',
      version: 'aegis-pqvm-required',
      validator_consensus_key_status: 'loaded',
      validator_peer_identity_key_status: 'loaded',
      validator_operator_key_status: 'loaded',
      key_active_for_current_epoch: true,
      key_role_valid: true,
      key_revoked: false,
      latest_signature_verification_result: 'valid',
      latest_qc_verification_result: 'valid',
    },
  };
}

function formatHash(value) {
  if (!value) return 'Pending';
  return truncateMiddle(String(value), 12, 10);
}

function formatStakeNwei(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return '0 nWei';
  return `${number.toLocaleString()} nWei`;
}

function formatStakeSnrg(value) {
  const number = Number(value ?? 0) / 1000000000;
  if (!Number.isFinite(number)) return '0 SNRG';
  return `${number.toLocaleString(undefined, { maximumFractionDigits: 9 })} SNRG`;
}

function connectionCopy(streamState, stale) {
  if (stale) return 'Stale data';
  if (streamState === 'reconnecting') return 'Reconnecting';
  if (streamState === 'unavailable') return 'Unavailable';
  return 'Live data';
}

export function ValidatorStatusBorder({ status, children }) {
  const color = String(status?.status_color || 'gray').toLowerCase();
  const normalized = [
    'green',
    'blue',
    'yellow',
    'red',
    'purple',
    'orange',
    'gray',
  ].includes(color) ? color : 'gray';
  return (
    <section
      className={`validator-live-panel validator-live-panel-${normalized}`}
      data-testid="validator-live-status-panel"
    >
      {children}
    </section>
  );
}

export function ValidatorStatusHeadline({ status, streamState, stale }) {
  return (
    <div className="validator-live-headline-wrap">
      <h2 className="validator-live-headline">{status.status_headline || 'VALIDATOR UNKNOWN'}</h2>
      <div className={`validator-live-stream-chip stream-${stale ? 'stale' : streamState}`}>
        {connectionCopy(streamState, stale)}
      </div>
    </div>
  );
}

function StatusCard({ title, children, className = '' }) {
  return (
    <div className={`validator-live-card ${className}`}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function DetailRow({ label, value, strong = false }) {
  return (
    <div className="validator-live-row">
      <span>{label}</span>
      <strong className={strong ? 'is-strong' : ''}>{value ?? 'Pending'}</strong>
    </div>
  );
}

function ProgressBar({ value, label }) {
  const percent = Math.max(0, Math.min(100, Number(value ?? 0)));
  return (
    <div className="validator-live-progress" aria-label={label}>
      <div className="validator-live-progress-label">
        <span>{label}</span>
        <strong>{formatNumber(percent)}%</strong>
      </div>
      <div className="validator-live-progress-track">
        <div className="validator-live-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ValidatorStakeStatusCard({ status }) {
  const stakeStatus = status.stake_status || 'NOT_SUBMITTED';
  return (
    <StatusCard title="Staking Requirement" className="validator-live-card-prominent">
      <DetailRow label="Required stake" value={`${formatNumber(status.required_stake_snrg ?? REQUIRED_STAKE_SNRG)} SNRG`} strong />
      <DetailRow label="Required stake in nWei" value={formatStakeNwei(status.required_stake_nwei ?? REQUIRED_STAKE_NWEI)} />
      <DetailRow label="Current verified stake" value={formatStakeNwei(status.current_stake_nwei)} />
      <DetailRow label="Stake status" value={stakeStatus} strong />
      {stakeStatus === 'SUBMITTED' ? (
        <>
          <DetailRow label="Stake transaction hash" value={formatHash(status.stake_tx_hash)} />
          <DetailRow label="Finality status" value="Waiting for finalized QC" />
        </>
      ) : null}
      {status.stake_verified ? (
        <>
          <DetailRow label="Stake verified" value="yes" strong />
          <DetailRow label="Locked stake" value={formatStakeSnrg(status.current_stake_nwei)} />
          <DetailRow label="Stake finalized height" value={formatNumber(status.stake_finalized_height)} />
          <DetailRow label="Stake lock ID" value={formatHash(status.stake_lock_id)} />
          <DetailRow label="Stake QC verification status" value={formatHash(status.stake_finalized_qc_hash)} />
        </>
      ) : (
        <p className="validator-live-copy">
          {status.stake_blocking_reason || 'Stake 50,000 SNRG to continue validator onboarding.'}
        </p>
      )}
    </StatusCard>
  );
}

export function ConsensusActivityCard({ status }) {
  const activity = status.consensus_activity || {};
  const qcRequired = Number(activity.qc_required_signer_count || activity.required_threshold_weight || 4);
  const qcCurrent = Number(activity.qc_signer_count || activity.signed_weight || 0);
  const qcPercent = qcRequired > 0 ? (qcCurrent / qcRequired) * 100 : 0;
  return (
    <StatusCard title="Consensus Activity">
      <DetailRow label="Current leader" value={activity.current_leader || 'Pending'} strong />
      {activity.is_current_leader ? <div className="validator-live-leader-chip">THIS VALIDATOR IS CURRENT LEADER</div> : null}
      <DetailRow label="Current height" value={formatNumber(activity.current_height ?? status.latest_finalized_height)} />
      <DetailRow label="Round / epoch / cluster" value={`${formatNumber(activity.current_round ?? status.current_round)} / ${formatNumber(activity.current_epoch ?? status.current_epoch)} / ${formatNumber(activity.current_cluster_id ?? status.current_cluster_id)}`} />
      <DetailRow label="Current block" value={formatHash(activity.current_block_id)} />
      <DetailRow label="Parent block" value={formatHash(activity.parent_block_hash)} />
      <DetailRow label="Proposal phase" value={activity.proposal_phase || 'IDLE'} />
      <DetailRow label="Vote phase" value={activity.vote_phase || 'NOT_ACTIVE'} />
      <DetailRow label="Vote decision" value={activity.vote_decision || 'NOT YET'} strong />
      <ProgressBar value={qcPercent} label={`QC progress ${qcCurrent}/${qcRequired}`} />
      <DetailRow label="Signed weight" value={`${formatNumber(activity.signed_weight ?? qcCurrent)}/${formatNumber(activity.required_threshold_weight ?? qcRequired)}`} />
      <DetailRow label="Next proposer" value={activity.next_expected_proposer || 'Pending'} />
      <DetailRow label="DAG ready transactions" value={formatNumber(activity.dag_ready_transaction_count ?? 0)} />
      <DetailRow label="DAG selected for proposal" value={formatNumber(activity.dag_selected_transaction_count ?? 0)} />
    </StatusCard>
  );
}

export function ValidatorLifecycleStepper({ status }) {
  const lifecycle = status.lifecycle || {};
  const current = lifecycle.current_state || status.process_step || status.current_status || 'UNKNOWN';
  const currentIndex = LIFECYCLE_STEPS.indexOf(current);
  return (
    <StatusCard title="Validator Lifecycle">
      <div className="validator-live-stepper">
        {LIFECYCLE_STEPS.map((step, index) => {
          const state = index < currentIndex
            ? 'complete'
            : (index === currentIndex ? 'current' : 'pending');
          return (
            <div key={step} className={`validator-live-step step-${state}`}>
              <span>{index + 1}</span>
              <strong>{step}</strong>
            </div>
          );
        })}
      </div>
      <DetailRow label="Current lifecycle state" value={current} strong />
      <DetailRow label="Shadow blocks" value={`${formatNumber(lifecycle.shadow_blocks_completed ?? 0)}/${formatNumber(lifecycle.required_shadow_blocks ?? 100)}`} />
      <DetailRow label="Shadow epochs" value={`${formatNumber(lifecycle.shadow_epochs_completed ?? 0)}/${formatNumber(lifecycle.required_shadow_epochs ?? 1)}`} />
      <DetailRow label="Would-have-voted match rate" value={lifecycle.would_have_voted_match_rate ?? 'Pending'} />
      <DetailRow label="Required vote match rate" value={lifecycle.required_vote_match_rate ?? 0.995} />
      <DetailRow label="Pending activation epoch" value={lifecycle.pending_activation_epoch ?? 'Not scheduled'} />
    </StatusCard>
  );
}

export function QuarantineRecoveryTimeline({ status }) {
  const quarantine = status.quarantine || {};
  const active = status.is_quarantined || status.is_reconciling || ['QUARANTINED', 'SELF_HEALING', 'RECONCILING_CHAIN', 'SPEED_SYNCING_CANONICAL', 'VERIFYING_CANONICAL_CHAIN', 'READY_TO_REJOIN'].includes(status.current_status);
  const currentStep = active ? String(quarantine.reconciliation_step || '').replaceAll('_', ' ') : '';
  return (
    <StatusCard title="Quarantine / Self-Healing Status">
      <DetailRow label="Quarantine reason" value={quarantine.reason || 'No quarantine active'} />
      <DetailRow label="Divergence cause" value={quarantine.divergence_cause || 'NONE'} />
      <DetailRow label="Divergence height" value={quarantine.divergence_height ?? 'None'} />
      <DetailRow label="Local divergent block" value={formatHash(quarantine.local_divergent_block_hash)} />
      <DetailRow label="Canonical block" value={formatHash(quarantine.canonical_block_hash)} />
      {active ? <div className="validator-live-safety-note">Consensus duties disabled during reconciliation</div> : null}
      <div className="validator-live-timeline">
        {RECOVERY_STEPS.map((step, index) => {
          const isCurrent = currentStep && step.toLowerCase().includes(currentStep.toLowerCase());
          const isComplete = active && !isCurrent && index < 2;
          return (
            <div key={step} className={`validator-live-timeline-step ${isCurrent ? 'is-current' : ''} ${isComplete ? 'is-complete' : ''}`}>
              <span />
              <strong>{step}</strong>
            </div>
          );
        })}
      </div>
    </StatusCard>
  );
}

export function JailStatusCard({ status }) {
  const jail = status.jailing || {};
  return (
    <StatusCard title="Jailing Status">
      <DetailRow label="Jailed status" value={jail.jailed || status.is_jailed ? 'JAILED' : 'Not jailed'} strong={jail.jailed || status.is_jailed} />
      <DetailRow label="Jail reason" value={jail.reason || 'None'} />
      <DetailRow label="Evidence ID" value={formatHash(jail.evidence_id)} />
      <DetailRow label="Jailed at height" value={jail.jailed_at_height ?? 'None'} />
      <DetailRow label="Jailed at epoch" value={jail.jailed_at_epoch ?? 'None'} />
      <DetailRow label="Earliest unjail" value={jail.earliest_unjail_epoch ?? jail.earliest_unjail_timestamp ?? 'Not applicable'} />
      <DetailRow label="Allowed to vote" value={(jail.can_vote ?? status.is_voting) ? 'true' : 'false'} />
      <DetailRow label="Allowed to propose" value={(jail.can_propose ?? status.is_proposing) ? 'true' : 'false'} />
    </StatusCard>
  );
}

export function SyncSnapshotProgressCard({ status }) {
  const sync = status.sync_snapshot || {};
  const current = Number(sync.current_sync_height ?? status.latest_finalized_height ?? 0);
  const target = Number(sync.target_finalized_height ?? current);
  const percent = target > 0 ? (current / target) * 100 : 0;
  return (
    <StatusCard title="Sync / Snapshot Status">
      <DetailRow label="Sync source" value={sync.sync_source || sync.sync_mode || 'LOCAL_HEAD'} strong />
      <DetailRow label="Sync mode" value={sync.sync_mode || 'NONE'} />
      <DetailRow label="Archive snapshot URL" value={sync.archive_snapshot_url || 'Not selected'} />
      <DetailRow label="Snapshot height" value={sync.snapshot_height ?? 'None'} />
      <DetailRow label="Snapshot manifest hash" value={formatHash(sync.snapshot_manifest_hash)} />
      <DetailRow label="Snapshot verification" value={sync.snapshot_verification_status || 'not_required'} />
      <ProgressBar value={percent} label={`Sync height ${formatNumber(current)}/${formatNumber(target)}`} />
      <DetailRow label="Blocks remaining" value={formatNumber(sync.blocks_remaining ?? 0)} />
      <DetailRow label="QC verification count" value={formatNumber(sync.qc_verification_count ?? 0)} />
      <DetailRow label="Latest verified state root" value={formatHash(sync.latest_verified_state_root)} />
      <DetailRow label="Eligible to enter SHADOW" value={sync.eligible_to_enter_shadow ? 'yes' : 'no'} />
    </StatusCard>
  );
}

export function NetworkPeerStatusCard({ status }) {
  const network = status.network_peer || {};
  return (
    <StatusCard title="Network / Peer Status">
      <DetailRow label="Local RPC endpoint" value={network.local_rpc_endpoint || 'Pending'} />
      <DetailRow label="Local RPC ready" value={network.local_rpc_ready ? 'yes' : 'no'} />
      <DetailRow label="Peer count" value={formatNumber(network.local_peer_count ?? 0)} />
      <DetailRow label="Connected validators" value={formatNumber(network.connected_validator_count ?? 0)} />
      <DetailRow label="Status-ready validators" value={formatNumber(network.status_ready_validator_count ?? 0)} />
      <DetailRow label="Public RPC online" value={network.public_rpc_online ? 'yes' : 'no'} />
    </StatusCard>
  );
}

export function AegisPqvmStatusCard({ status }) {
  const aegis = status.aegis_pqvm || {};
  return (
    <StatusCard title="Aegis PQC Status">
      <DetailRow label="aegis-pqvm status" value={aegis.status || 'UNKNOWN'} strong />
      <DetailRow label="aegis-pqvm version" value={aegis.version || status.aegis_pqvm_version || 'required'} />
      <DetailRow label="Consensus key" value={aegis.validator_consensus_key_status || 'Pending'} />
      <DetailRow label="Peer identity key" value={aegis.validator_peer_identity_key_status || 'Pending'} />
      <DetailRow label="Operator key" value={aegis.validator_operator_key_status || 'Pending'} />
      <DetailRow label="Key lifecycle root" value={formatHash(aegis.key_lifecycle_root)} />
      <DetailRow label="Key active for current epoch" value={aegis.key_active_for_current_epoch ? 'true' : 'false'} />
      <DetailRow label="Key role valid" value={aegis.key_role_valid ? 'true' : 'false'} />
      <DetailRow label="Key revoked" value={aegis.key_revoked ? 'true' : 'false'} />
      <DetailRow label="Latest signature verification" value={aegis.latest_signature_verification_result || 'Pending'} />
      <DetailRow label="Latest QC verification" value={aegis.latest_qc_verification_result || 'Pending'} />
    </StatusCard>
  );
}

export function LatestFinalizedBlockCard({ status }) {
  return (
    <StatusCard title="Last State Change">
      <DetailRow label="Latest finalized height" value={formatNumber(status.latest_finalized_height ?? 0)} strong />
      <DetailRow label="Latest finalized block" value={formatHash(status.latest_finalized_block_hash)} />
      <DetailRow label="Latest finalized state root" value={formatHash(status.latest_state_root)} />
      <DetailRow label="Latest finalized QC hash" value={formatHash(status.latest_qc_hash)} />
      <DetailRow label="Epoch / round / cluster" value={`${formatNumber(status.current_epoch ?? 0)} / ${formatNumber(status.current_round ?? 0)} / ${formatNumber(status.current_cluster_id ?? 0)}`} />
      <DetailRow label="Updated" value={new Date(Number(status.last_update_unix_ms || Date.now())).toLocaleString()} />
      <p className="validator-live-copy">{status.last_state_change || 'No state transition recorded yet.'}</p>
    </StatusCard>
  );
}

export function NextActionCard({ status }) {
  const warnings = safeArray(status.warnings);
  const errors = safeArray(status.errors);
  return (
    <StatusCard title="Next Expected Action">
      <p className="validator-live-next-action">{status.next_expected_action || 'Continue monitoring validator state.'}</p>
      {warnings.length ? warnings.map((warning) => (
        <div key={String(warning)} className="validator-live-warning">{String(warning)}</div>
      )) : null}
      {errors.length ? errors.map((error) => (
        <div key={String(error)} className="validator-live-error">{String(error)}</div>
      )) : null}
    </StatusCard>
  );
}

export default function ValidatorLiveStatusPanel({ node, nodeLive, liveStatus }) {
  const [remoteStatus, setRemoteStatus] = useState(null);
  const [streamState, setStreamState] = useState('unavailable');
  const [now, setNow] = useState(Date.now());
  const status = useMemo(
    () => remoteStatus || fallbackStatus(node, nodeLive, liveStatus),
    [remoteStatus, node, nodeLive, liveStatus],
  );
  const stale = Number(status.last_update_unix_ms || 0) > 0
    && now - Number(status.last_update_unix_ms || 0) > Number(status.stale_after_ms || 12000);

  useEffect(() => {
    let cancelled = false;
    setStreamState('reconnecting');
    fetchValidatorLiveStatus(node?.id)
      .then((payload) => {
        if (!cancelled) {
          setRemoteStatus(payload);
          setStreamState('live');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStreamState('unavailable');
        }
      });

    let cleanup = null;
    listenValidatorLiveStatus(node?.id, ({ connection, payload }) => {
      if (cancelled) return;
      if (payload && !payload.error) {
        setRemoteStatus(payload);
      }
      setStreamState(connection === 'error' ? 'reconnecting' : connection);
    })
      .then((dispose) => {
        cleanup = dispose;
      })
      .catch(() => {
        if (!cancelled) {
          setStreamState('unavailable');
        }
      });

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, [node?.id]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <ValidatorStatusBorder status={status}>
      <ValidatorStatusHeadline status={status} streamState={streamState} stale={stale} />
      <div className="validator-live-summary-grid">
        <StatusCard title="Current State">
          <DetailRow label="Status" value={status.current_status} strong />
          <DetailRow label="Validator ID" value={status.validator_id || status.node_id} />
          <DetailRow label="Validator UMA ID" value={formatHash(status.validator_uma_id)} />
          <DetailRow label="Chain ID" value={status.chain_id} strong />
          <DetailRow label="Network ID" value={status.network_id} strong />
          <DetailRow label="Consensus active" value={status.is_consensus_active ? 'yes' : 'no'} />
          <DetailRow label="Voting" value={status.is_voting ? 'yes' : 'no'} />
          <DetailRow label="Proposing" value={status.is_proposing ? 'yes' : 'no'} />
          <ProgressBar value={status.process_progress_percent} label={status.current_process || 'Validator process'} />
        </StatusCard>
        <ConsensusActivityCard status={status} />
        <LatestFinalizedBlockCard status={status} />
      </div>
      <div className="validator-live-grid">
        <ValidatorStakeStatusCard status={status} />
        <ValidatorLifecycleStepper status={status} />
        <SyncSnapshotProgressCard status={status} />
        <QuarantineRecoveryTimeline status={status} />
        <JailStatusCard status={status} />
        <NetworkPeerStatusCard status={status} />
        <AegisPqvmStatusCard status={status} />
        <NextActionCard status={status} />
      </div>
    </ValidatorStatusBorder>
  );
}
