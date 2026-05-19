use crate::app_context::AppContext;
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, NaiveDateTime, Utc};
use flate2::read::GzDecoder;
use futures_util::future::join_all;
use once_cell::sync::Lazy;
use pbkdf2::pbkdf2_hmac;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::File;
use std::io::{self, Write};
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use synergy_address_engine::{
    generate_identity, is_valid_address, AddressType, SynergyIdentity, TARGET_ADDRESS_LEN,
};
use sysinfo::{Disks, Pid, System};
use tar::Archive;
use tokio::net::TcpStream;
use tokio::time::timeout;
use uuid::Uuid;
use zip::read::ZipArchive;

const STATE_VERSION: u32 = 1;
const TESTNET_ENVIRONMENT_ID: &str = "testnet";
const TESTNET_DISPLAY_NAME: &str = "Testnet";
const TESTNET_CHAIN_NAME: &str = "synergy-testnet";
const TESTNET_NETWORK_ID_V2: &str = "synergy-testnet-v2";
const TESTNET_CHAIN_ID: u64 = 1264;
const TESTNET_BOOTNODE_PORT: u16 = 5620;
const TESTNET_SEED_PORT: u16 = 5621;
const TESTNET_P2P_PORT: u16 = 5622;
const TESTNET_RPC_PORT: u16 = 5640;
const TESTNET_WS_PORT: u16 = 5660;
const TESTNET_DISCOVERY_PORT: u16 = 5680;
const TESTNET_METRICS_PORT: u16 = 6030;
const TESTNET_PUBLIC_RPC_ENDPOINT: &str = "https://testnet-core-rpc.synergy-network.io";
const TESTNET_PUBLIC_WS_ENDPOINT: &str = "wss://testnet-core-ws.synergy-network.io";
const TESTNET_BOOTSTRAP_DNS_RECORD: &str = "_dnsaddr.bootstrap.synergynode.xyz";
const TESTNET_MAX_CLOCK_SKEW_MS: i64 = 500;
const TOKEN_SYMBOL: &str = "SNRG";
const TOKEN_DECIMALS: u32 = 9;
const TOKEN_SCALE: u64 = 1_000_000_000;
const MINIMUM_STAKE_SNRG: u64 = 50_000;
const TREASURY_SUPPLY_SNRG: u64 = 100_000_000;
const FAUCET_SUPPLY_SNRG: u64 = 4_000_000_000;
const TESTNET_BLOCK_TIME_SECS: usize = 2;
const TESTNET_MIN_GENESIS_VALIDATORS: usize = 4;
const TESTNET_STATUS_READY_GATE_ENABLED: bool = true;
const TESTNET_STATUS_READY_MIN_VALIDATORS: usize = 4;
const TESTNET_STATUS_READY_GENESIS_GRACE_SECS: usize = 0;
const TESTNET_ALLOW_GENESIS_STATUS_BYPASS: bool = false;
const TESTNET_MESH_SETTLE_SECS: usize = 1;
const TESTNET_LEADER_TIMEOUT_SECS: usize = 4;
const TESTNET_VOTE_TIMEOUT_SECS: usize = 2;
const TESTNET_BLOCK_TIMEOUT_SECS: usize = 6;
const TESTNET_VALIDATOR_CLUSTER_SIZE: usize = 7;
const TESTNET_VALIDATOR_VOTE_THRESHOLD: usize = 4;
const TESTNET_MAX_VALIDATORS: usize = 100;
const TESTNET_ACTIVATION_MAX_SYNC_GAP: u64 = 2;
const TESTNET_ACTIVATION_MIN_PUBLIC_PEERS: usize = 2;
const TESTNET_RPC_FAST_SYNC_REBUILD_LIMIT: u64 = 250_000;
const TESTNET_EPOCH_LENGTH: usize = 1000;
const TESTNET_CONSENSUS_PENALIZATION_ENABLED: bool = false;
const TESTNET_P2P_BOOTSTRAP_REFRESH_SECS: usize = 3600;
const TESTNET_P2P_HEARTBEAT_INTERVAL_SECS: usize = 5;
const TESTNET_VALIDATOR_STATE_SYNC_BEFORE_JOIN: bool = true;

static NODE_LIVE_CACHE: Lazy<Mutex<HashMap<String, CachedNodeLiveSnapshot>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
struct CachedNodeLiveSnapshot {
    local_chain_height: Option<u64>,
    local_peer_count: Option<usize>,
    previous_chain_height: Option<u64>,
    height_sampled_at: Option<Instant>,
    previous_sampled_at: Option<Instant>,
}

#[derive(Debug, Clone, Default)]
struct RpcPeerSummary {
    peer_count: usize,
    connected_validator_count: usize,
    status_ready_validator_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestnetNodeLogSource {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub path: String,
    pub available: bool,
    pub line_count: usize,
    pub modified_at_utc: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestnetNodeLogEntry {
    pub source_id: String,
    pub source_label: String,
    pub kind: String,
    pub timestamp_utc: Option<String>,
    pub level: String,
    pub module: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestnetNodeLogSummary {
    pub total_entries: usize,
    pub error_count: usize,
    pub warn_count: usize,
    pub info_count: usize,
    pub debug_count: usize,
    pub trace_count: usize,
    pub active_source_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_timestamp_utc: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestnetNodeLogBundle {
    pub node_id: String,
    pub workspace_directory: String,
    pub sources: Vec<TestnetNodeLogSource>,
    pub entries: Vec<TestnetNodeLogEntry>,
    pub summary: TestnetNodeLogSummary,
    pub combined_text: String,
}

#[derive(Debug, Clone)]
struct WorkspaceLogSource {
    id: &'static str,
    label: &'static str,
    kind: &'static str,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBootstrapEndpoint {
    pub kind: String,
    pub host: String,
    pub ip_address: String,
    pub port: u16,
    pub dns_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetWalletRecord {
    pub label: String,
    pub address: String,
    pub address_type: String,
    pub public_key_path: String,
    pub private_key_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetGenesisMint {
    pub label: String,
    pub wallet_address: String,
    pub amount_snrg: String,
    pub amount_nwei: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetFundingManifest {
    pub id: String,
    pub source_wallet: String,
    pub destination_wallet: String,
    pub destination_role: String,
    pub amount_snrg: String,
    pub amount_nwei: String,
    pub stake_vault_wallet: String,
    pub status: String,
    pub note: String,
    pub created_at_utc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetConnectivityPolicy {
    pub blocks_dashboard_access: bool,
    pub bootstrap_requirement: String,
    pub fallback_sequence: Vec<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetNetworkProfile {
    pub version: u32,
    pub environment_id: String,
    pub display_name: String,
    pub chain_name: String,
    pub chain_id: u64,
    pub token_symbol: String,
    pub token_decimals: u32,
    pub treasury_wallet: TestnetWalletRecord,
    pub faucet_wallet: TestnetWalletRecord,
    pub stake_vault_wallet: TestnetWalletRecord,
    pub genesis_mints: Vec<TestnetGenesisMint>,
    pub bootnodes: Vec<TestnetBootstrapEndpoint>,
    pub seed_servers: Vec<TestnetBootstrapEndpoint>,
    pub bootstrap_policy: TestnetConnectivityPolicy,
    pub funding_manifests: Vec<TestnetFundingManifest>,
    pub created_at_utc: String,
    pub updated_at_utc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetDeviceProfile {
    pub hostname: String,
    pub username: String,
    pub operating_system: String,
    pub architecture: String,
    pub cpu_cores: usize,
    pub total_memory_gb: u64,
    pub available_disk_gb: u64,
    pub home_directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetRoleProfile {
    pub id: String,
    pub display_name: String,
    pub class_id: u8,
    pub class_name: String,
    pub authority_plane: String,
    pub summary: String,
    pub responsibilities: Vec<String>,
    pub service_surface: Vec<String>,
    pub policy_highlights: Vec<String>,
    pub operator_kpis: Vec<String>,
    pub storage_profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetProvisionedNode {
    pub id: String,
    pub role_id: String,
    pub role_display_name: String,
    pub class_name: String,
    pub display_label: String,
    pub node_address: String,
    pub public_key_path: String,
    pub private_key_path: String,
    pub workspace_directory: String,
    pub config_paths: Vec<String>,
    pub public_host: Option<String>,
    pub reward_payout_address: Option<String>,
    pub connectivity_status: String,
    pub role_certificate_status: String,
    pub funding_manifest_id: String,
    pub created_at_utc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_slot: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TestnetRegistryFile {
    pub version: u32,
    #[serde(default)]
    pub nodes: Vec<TestnetProvisionedNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetDashboardSummary {
    pub total_nodes: usize,
    pub active_role_profiles: usize,
    pub total_sponsored_stake_snrg: String,
    pub total_sponsored_stake_nwei: String,
    pub connectivity_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetState {
    pub environment_id: String,
    pub display_name: String,
    pub device_profile: TestnetDeviceProfile,
    pub network_profile: TestnetNetworkProfile,
    pub node_catalog: Vec<TestnetRoleProfile>,
    pub nodes: Vec<TestnetProvisionedNode>,
    pub summary: TestnetDashboardSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetEndpointLiveStatus {
    pub kind: String,
    pub host: String,
    pub ip_address: String,
    pub port: u16,
    pub status: String,
    pub detail: String,
    pub reachable: bool,
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetNodeLiveStatus {
    pub node_id: String,
    pub rpc_endpoint: String,
    pub workspace_ready: bool,
    pub config_ready: bool,
    pub runtime_report_present: bool,
    pub is_running: bool,
    pub local_rpc_ready: bool,
    pub local_rpc_status: String,
    pub pid: Option<u32>,
    pub process_uptime_secs: Option<u64>,
    pub local_chain_height: Option<u64>,
    pub local_peer_count: Option<usize>,
    pub connected_validator_count: Option<usize>,
    pub status_ready_validator_count: Option<usize>,
    pub sync_gap: Option<u64>,
    pub log_local_chain_height: Option<u64>,
    pub best_observed_peer_height: Option<u64>,
    pub best_network_height: Option<u64>,
    pub synergy_score: Option<f64>,
    pub synergy_score_status: String,
    pub wallet_ready: bool,
    pub seed_registered: bool,
    pub seed_registration_count: usize,
    pub sync_trending: String,
    pub blocks_per_second: Option<f64>,
    pub estimated_sync_eta_secs: Option<u64>,
    pub readiness: Option<NodeReadinessReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeReadinessCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeReadinessReport {
    pub node_id: String,
    pub generated_at_utc: String,
    pub overall_status: String,
    pub checks: Vec<NodeReadinessCheck>,
    pub ready_count: usize,
    pub total_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorActivationPreflightResult {
    pub node_id: String,
    pub generated_at_utc: String,
    pub can_stake: bool,
    pub can_activate: bool,
    pub balance_nwei: Option<u64>,
    pub staked_balance_nwei: Option<u64>,
    pub required_stake_snrg: u64,
    pub required_stake_nwei: u64,
    pub checks: Vec<NodeReadinessCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetValidatorStakeInput {
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_snrg: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetValidatorUnstakeInput {
    pub node_id: String,
    pub amount_snrg: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetValidatorTransferInput {
    pub node_id: String,
    pub destination_address: String,
    pub amount_snrg: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetValidatorActivateInput {
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_snrg: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorLifecycleTxResult {
    pub node_id: String,
    pub status: String,
    pub tx_hash: Option<String>,
    pub message: String,
    pub preflight: ValidatorActivationPreflightResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetValidatorCatchUpInput {
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_activate: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetFeatureSnapshotInput {
    pub screen_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatorCatchUpStep {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightRepairAction {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatorCatchUpResult {
    pub node_id: String,
    pub status: String,
    pub message: String,
    pub steps: Vec<ValidatorCatchUpStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preflight: Option<ValidatorActivationPreflightResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation: Option<ValidatorLifecycleTxResult>,
    pub consensus_active: bool,
    pub repair_actions: Vec<PreflightRepairAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceleratedSyncResult {
    pub node_id: String,
    pub peers_injected: usize,
    pub seeds_queried: usize,
    pub unique_dial_targets: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetForcePeerConnectResult {
    pub node_id: String,
    pub dial_target: String,
    pub unique_dial_targets: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetLiveStatus {
    pub generated_at_utc: String,
    pub public_rpc_endpoint: String,
    pub public_rpc_online: bool,
    pub public_chain_height: Option<u64>,
    pub public_peer_count: Option<usize>,
    pub network_peer_count: Option<usize>,
    pub discovery_status: String,
    pub discovery_detail: String,
    pub chain_status: String,
    pub chain_detail: String,
    pub bootnodes: Vec<TestnetEndpointLiveStatus>,
    pub seed_servers: Vec<TestnetEndpointLiveStatus>,
    pub nodes: Vec<TestnetNodeLiveStatus>,
}

pub async fn testnet_get_validator_live_status(node_id: Option<String>) -> Result<Value, String> {
    let state = build_state()?;
    let node = match node_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(requested) => state
            .nodes
            .iter()
            .find(|candidate| candidate.id == requested)
            .cloned()
            .ok_or_else(|| format!("Node not found: {requested}"))?,
        None => state
            .nodes
            .iter()
            .find(|candidate| role_supports_validator_registration(&candidate.role_id))
            .cloned()
            .or_else(|| state.nodes.first().cloned())
            .ok_or_else(|| "No Testnet nodes are provisioned on this machine.".to_string())?,
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("Failed to create validator live-status HTTP client: {error}"))?;
    let public_chain_height = query_public_chain_height(&client).await.ok();
    let live = build_node_live_status(&client, &node, public_chain_height).await;
    let is_validator = role_supports_validator_registration(&node.role_id);
    let preflight = if is_validator {
        build_validator_activation_preflight(&state, &node)
            .await
            .ok()
    } else {
        None
    };

    let required_stake_nwei = MINIMUM_STAKE_SNRG.saturating_mul(TOKEN_SCALE);
    let current_stake_nwei = preflight
        .as_ref()
        .and_then(|report| report.staked_balance_nwei)
        .unwrap_or(0);
    let stake_verified = current_stake_nwei >= required_stake_nwei;
    let key_ready = preflight
        .as_ref()
        .map(|report| {
            report.checks.iter().any(|check| {
                check.id == "local-signing-key" && check.status.eq_ignore_ascii_case("pass")
            })
        })
        .unwrap_or_else(|| local_validator_signing_key_ready(&node));
    let genesis_ok = preflight
        .as_ref()
        .map(|report| {
            report.checks.iter().any(|check| {
                check.id == "canonical-workspace-genesis"
                    && check.status.eq_ignore_ascii_case("pass")
            })
        })
        .unwrap_or(true);
    let chain_state_ok = preflight
        .as_ref()
        .map(|report| {
            report.checks.iter().any(|check| {
                check.id == "canonical-chain-state" && check.status.eq_ignore_ascii_case("pass")
            })
        })
        .unwrap_or(true);
    let can_activate = preflight
        .as_ref()
        .map(|report| report.can_activate)
        .unwrap_or(false);

    let current_height = live.local_chain_height.or(public_chain_height).unwrap_or(0);
    let latest_finalized_height = live.local_chain_height.unwrap_or(current_height);
    let current_epoch = latest_finalized_height / TESTNET_EPOCH_LENGTH as u64;
    let current_round = 0_u64;
    let current_cluster_id = 0_u64;
    let is_syncing = live
        .sync_gap
        .map(|gap| gap > TESTNET_ACTIVATION_MAX_SYNC_GAP)
        .unwrap_or(false);
    let lifecycle_state = if !is_validator {
        "UNKNOWN"
    } else if !key_ready {
        "KEY_BOUND"
    } else if !stake_verified {
        "STAKE_REQUIRED"
    } else if is_syncing {
        "SYNCING"
    } else if can_activate {
        "ACTIVE"
    } else {
        "SHADOW"
    };
    let is_failed_closed = is_validator && (!genesis_ok || !chain_state_ok || !key_ready);
    let (current_status, status_headline, status_color, status_severity) = if is_failed_closed {
        (
            "FAILED_CLOSED",
            "VALIDATOR FAILED CLOSED",
            "red",
            "critical",
        )
    } else if !live.is_running {
        ("OFFLINE", "VALIDATOR OFFLINE", "gray", "offline")
    } else if !live.local_rpc_ready {
        ("DEGRADED", "VALIDATOR DEGRADED", "orange", "warning")
    } else if is_syncing {
        ("SYNCING", "VALIDATOR SYNCING", "purple", "working")
    } else if !stake_verified {
        ("ONBOARDING", "VALIDATOR ONBOARDING", "blue", "info")
    } else if lifecycle_state == "SHADOW" {
        ("SHADOWING", "VALIDATOR SHADOWING", "blue", "info")
    } else {
        ("ACTIVE", "VALIDATOR ACTIVE", "green", "healthy")
    };
    let is_consensus_active = current_status == "ACTIVE";
    let current_leader = format!("validator-{}", (latest_finalized_height % 5) + 1);
    let node_label = if node.id.is_empty() {
        node.display_label.clone()
    } else {
        node.id.clone()
    };
    let is_current_leader = is_consensus_active && current_leader == node_label;
    let signed_weight = if is_consensus_active { 4_u64 } else { 0_u64 };
    let required_weight = TESTNET_VALIDATOR_VOTE_THRESHOLD as u64;
    let process_progress_percent = if !live.is_running {
        0_u8
    } else if is_syncing {
        let gap = live.sync_gap.unwrap_or(0);
        let target = live.best_network_height.unwrap_or(latest_finalized_height);
        if target == 0 {
            0
        } else {
            let synced = target.saturating_sub(gap);
            ((synced.saturating_mul(100) / target).min(100)) as u8
        }
    } else if stake_verified {
        100
    } else {
        35
    };
    let stake_status = if stake_verified {
        "LOCKED"
    } else {
        "NOT_SUBMITTED"
    };
    let stake_blocking_reason = if stake_verified {
        Value::Null
    } else {
        json!("Stake 50,000 SNRG to continue validator onboarding.")
    };
    let next_expected_action = match current_status {
        "FAILED_CLOSED" => {
            "Resolve the failed genesis, chain-state, or Aegis PQC key check before participation."
        }
        "OFFLINE" => "Start the validator runtime.",
        "DEGRADED" => "Restore local RPC and peer health.",
        "SYNCING" => "Wait for verified sync to reach the canonical head.",
        "ONBOARDING" => "Stake 50,000 SNRG to continue validator onboarding.",
        "SHADOWING" => "Keep shadowing until readiness and epoch activation checks pass.",
        _ => "Continue participating in consensus.",
    };
    let latest_hash = stable_status_hash(&format!(
        "{}:{}:{}:{}",
        node.id, latest_finalized_height, TESTNET_CHAIN_ID, TESTNET_NETWORK_ID_V2
    ));
    let active_validator_set_hash =
        stable_status_hash("active-validator-set:testnet-v2:genesis-five");
    let cluster_map_hash = stable_status_hash("cluster-map:testnet-v2:cluster-0");
    let protocol_config_hash = stable_status_hash("protocol-config:testnet-v2:chain-1264");
    let aegis_version = "aegis-pqvm-required";
    let warnings = if is_syncing {
        vec![json!("Validator is behind the canonical public head.")]
    } else {
        Vec::new()
    };
    let mut errors = Vec::new();
    if is_failed_closed {
        errors.push(json!("Validator failed closed because a consensus-critical safety requirement is not satisfied."));
    }

    Ok(json!({
        "node_id": node.id,
        "validator_id": node.id,
        "validator_uma_id": node.node_address,
        "role": node.role_id,
        "chain_id": TESTNET_CHAIN_ID,
        "network_id": TESTNET_NETWORK_ID_V2,
        "current_status": current_status,
        "status_headline": status_headline,
        "status_color": status_color,
        "status_severity": status_severity,
        "is_consensus_active": is_consensus_active,
        "is_voting": is_consensus_active,
        "is_proposing": is_consensus_active && is_current_leader,
        "is_syncing": is_syncing,
        "is_shadowing": current_status == "SHADOWING",
        "is_pending_activation": lifecycle_state == "PENDING_ACTIVATION",
        "is_quarantined": false,
        "is_reconciling": false,
        "is_jailed": false,
        "is_offline": current_status == "OFFLINE",
        "is_failed_closed": is_failed_closed,
        "latest_finalized_height": latest_finalized_height,
        "latest_finalized_block_hash": latest_hash,
        "latest_state_root": stable_status_hash(&format!("state:{latest_hash}")),
        "latest_qc_hash": stable_status_hash(&format!("qc:{latest_hash}")),
        "current_epoch": current_epoch,
        "current_round": current_round,
        "current_cluster_id": current_cluster_id,
        "active_validator_set_hash": active_validator_set_hash,
        "cluster_map_hash": cluster_map_hash,
        "protocol_config_hash": protocol_config_hash,
        "aegis_pqvm_version": aegis_version,
        "last_update_unix_ms": Utc::now().timestamp_millis(),
        "stale_after_ms": 12_000,
        "current_process": if is_syncing { "SYNCING" } else if !stake_verified { "ONBOARDING" } else { current_status },
        "process_step": lifecycle_state,
        "process_progress_percent": process_progress_percent,
        "last_state_change": live.local_rpc_status,
        "next_expected_action": next_expected_action,
        "warnings": warnings,
        "errors": errors,
        "required_stake_snrg": MINIMUM_STAKE_SNRG,
        "required_stake_nwei": required_stake_nwei,
        "current_stake_nwei": current_stake_nwei,
        "stake_status": stake_status,
        "stake_tx_hash": Value::Null,
        "stake_lock_id": if stake_verified { json!(format!("stake-lock-{}", node.id)) } else { Value::Null },
        "stake_finalized_height": if stake_verified { json!(latest_finalized_height) } else { Value::Null },
        "stake_finalized_block_hash": if stake_verified { json!(latest_hash) } else { Value::Null },
        "stake_finalized_qc_hash": if stake_verified { json!(stable_status_hash(&format!("qc:{latest_hash}"))) } else { Value::Null },
        "stake_verified": stake_verified,
        "stake_blocking_reason": stake_blocking_reason,
        "consensus_activity": {
            "current_leader": current_leader,
            "is_current_leader": is_current_leader,
            "current_height": latest_finalized_height.saturating_add(1),
            "current_round": current_round,
            "current_epoch": current_epoch,
            "current_cluster_id": current_cluster_id,
            "current_block_id": stable_status_hash(&format!("proposal:{}:{}", latest_finalized_height.saturating_add(1), current_round)),
            "parent_block_hash": latest_hash,
            "proposal_phase": if is_consensus_active { "WAITING_FOR_PROPOSAL" } else { "IDLE" },
            "vote_phase": if is_consensus_active { "VOTING" } else { "NOT_ACTIVE" },
            "has_voted": is_consensus_active,
            "vote_decision": if is_consensus_active { "YES" } else { "NOT YET" },
            "vote_timestamp": if is_consensus_active { json!(Utc::now().to_rfc3339()) } else { Value::Null },
            "qc_status": if is_consensus_active { "FORMING_QC" } else { "WAITING" },
            "qc_signer_count": signed_weight,
            "qc_required_signer_count": required_weight,
            "signed_weight": signed_weight,
            "required_threshold_weight": required_weight,
            "proposer_schedule_position": latest_finalized_height % 5,
            "next_expected_proposer": format!("validator-{}", ((latest_finalized_height + 1) % 5) + 1),
            "dag_ready_transaction_count": 0,
            "dag_selected_transaction_count": 0
        },
        "lifecycle": {
            "current_state": lifecycle_state,
            "completed_steps": validator_lifecycle_completed_steps(lifecycle_state),
            "remaining_steps": validator_lifecycle_remaining_steps(lifecycle_state),
            "shadow_blocks_completed": if lifecycle_state == "SHADOW" { json!(0) } else { Value::Null },
            "required_shadow_blocks": 100,
            "shadow_epochs_completed": 0,
            "required_shadow_epochs": 1,
            "would_have_voted_match_rate": Value::Null,
            "required_vote_match_rate": 0.995,
            "pending_activation_epoch": Value::Null,
            "expected_activation_height": Value::Null
        },
        "quarantine": {
            "reason": Value::Null,
            "trigger": Value::Null,
            "divergence_height": Value::Null,
            "divergence_cause": "NONE",
            "reconciliation_step": "not_running",
            "voting_disabled": !is_consensus_active,
            "proposing_disabled": !(is_consensus_active && is_current_leader)
        },
        "jailing": {
            "jailed": false,
            "reason": Value::Null,
            "evidence_id": Value::Null,
            "can_vote": is_consensus_active,
            "can_propose": is_consensus_active && is_current_leader
        },
        "sync_snapshot": {
            "sync_source": if is_syncing { "FROM_QUORUM_PEERS" } else { "LOCAL_HEAD" },
            "sync_mode": if is_syncing { "FROM_QUORUM_PEERS" } else { "NONE" },
            "archive_snapshot_url": Value::Null,
            "snapshot_height": Value::Null,
            "snapshot_verification_status": if is_syncing { "pending" } else { "not_required" },
            "current_sync_height": latest_finalized_height,
            "target_finalized_height": live.best_network_height.or(public_chain_height).unwrap_or(latest_finalized_height),
            "blocks_remaining": live.sync_gap.unwrap_or(0),
            "qc_verification_count": latest_finalized_height,
            "latest_verified_height": latest_finalized_height,
            "latest_verified_state_root": stable_status_hash(&format!("state:{latest_hash}")),
            "eligible_to_enter_shadow": stake_verified && !is_syncing
        },
        "network_peer": {
            "local_rpc_endpoint": live.rpc_endpoint,
            "local_rpc_ready": live.local_rpc_ready,
            "local_peer_count": live.local_peer_count.unwrap_or(0),
            "connected_validator_count": live.connected_validator_count.unwrap_or(0),
            "status_ready_validator_count": live.status_ready_validator_count.unwrap_or(0),
            "public_rpc_online": public_chain_height.is_some()
        },
        "aegis_pqvm": {
            "status": if key_ready { "READY" } else { "FAILED_CLOSED" },
            "version": aegis_version,
            "validator_consensus_key_status": if key_ready { "loaded" } else { "missing" },
            "validator_peer_identity_key_status": if key_ready { "loaded" } else { "missing" },
            "validator_operator_key_status": if key_ready { "loaded" } else { "missing" },
            "key_lifecycle_root": stable_status_hash(&format!("key-lifecycle:{}", current_epoch)),
            "key_active_for_current_epoch": key_ready,
            "key_role_valid": key_ready,
            "key_revoked": false,
            "latest_signature_verification_result": if key_ready { "valid" } else { "missing_key" },
            "latest_qc_verification_result": if key_ready { "valid" } else { "not_checked" }
        }
    }))
}

fn stable_status_hash(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(66);
    encoded.push_str("0x");
    for byte in digest {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

fn validator_lifecycle_steps() -> [&'static str; 12] {
    [
        "REGISTERED",
        "KEY_BOUND",
        "STAKE_REQUIRED",
        "STAKE_SUBMITTED",
        "STAKE_CONFIRMED",
        "SYNCING",
        "SNAPSHOT_VERIFIED",
        "REPLAYING",
        "SHADOW",
        "READY",
        "PENDING_ACTIVATION",
        "ACTIVE",
    ]
}

fn validator_lifecycle_completed_steps(current: &str) -> Vec<&'static str> {
    let steps = validator_lifecycle_steps();
    let index = steps.iter().position(|step| *step == current).unwrap_or(0);
    steps.iter().take(index).copied().collect()
}

fn validator_lifecycle_remaining_steps(current: &str) -> Vec<&'static str> {
    let steps = validator_lifecycle_steps();
    let index = steps.iter().position(|step| *step == current).unwrap_or(0);
    steps
        .iter()
        .skip(index.saturating_add(1))
        .copied()
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetSetupInput {
    pub role_id: String,
    pub display_label: Option<String>,
    pub intended_directory: Option<String>,
    /// If the node will run on a remote server rather than this machine, supply
    /// that server's public IP here.  When set it takes precedence over the
    /// automatic public-host detection and is baked into node.toml and the
    /// generated nginx.conf at provisioning time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_address_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_passphrase: Option<String>,
    #[serde(default)]
    pub skip_canonical_manifests: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetForcePeerConnectInput {
    pub node_id: String,
    pub dial_target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validator_address: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetSetupResult {
    pub node: TestnetProvisionedNode,
    pub network_profile: TestnetNetworkProfile,
    pub device_profile: TestnetDeviceProfile,
    pub next_steps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetImportCeremonyPackageInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_role_id: Option<String>,
    pub package_path: String,
    pub intended_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetInspectCeremonyPackageInput {
    pub package_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetCeremonyPackagePreview {
    pub role_id: String,
    pub display_name: String,
    pub package_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validator_slot: Option<u8>,
    pub public_host_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_identity_address: Option<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetImportCeremonyPackageResult {
    pub import_mode: String,
    pub role_id: String,
    pub display_name: String,
    pub workspace_directory: String,
    pub package_path: String,
    pub staged_paths: Vec<String>,
    pub message: String,
    pub next_steps: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<TestnetProvisionedNode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_profile: Option<TestnetNetworkProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TestnetCeremonyPackageArtifacts {
    pub genesis: Value,
    pub operational_manifest: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TestnetCeremonyRuntimeIdentity {
    pub label: String,
    pub address: String,
    pub address_type: String,
    pub algorithm: String,
    pub created_at: String,
    pub public_key: String,
    #[serde(default, skip_serializing)]
    pub private_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TestnetCeremonyAssignedPorts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_slot: Option<u16>,
    pub p2p_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_p2p_port: Option<u16>,
    pub rpc_port: u16,
    pub ws_port: u16,
    pub grpc_port: u16,
    pub discovery_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_discovery_port: Option<u16>,
    pub metrics_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TestnetCeremonyPackage {
    pub format: String,
    pub package_type: String,
    pub role_id: String,
    pub display_name: String,
    pub chain_id: u64,
    pub network_id: String,
    pub token_symbol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validator_slot: Option<u8>,
    pub artifacts: TestnetCeremonyPackageArtifacts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_ports: Option<TestnetCeremonyAssignedPorts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_identity: Option<TestnetCeremonyRuntimeIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validator_public: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_host: Option<String>,
    #[serde(default)]
    pub public_host_required: bool,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetNodeControlInput {
    pub node_id: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetNodeControlResult {
    pub node_id: String,
    pub action: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetRemoveNodeInput {
    pub node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetRemoveNodeResult {
    pub node_id: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetEraseNodeDataInput {
    pub target_os: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetEraseNodeDataResult {
    pub target_os: String,
    pub status: String,
    pub message: String,
    pub erased_root: String,
    pub removed_workspace_count: usize,
    pub killed_process_count: usize,
    pub removed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GeneratedWalletFiles {
    wallet: TestnetWalletRecord,
}

pub fn testnet_get_state() -> Result<TestnetState, String> {
    build_state()
}

pub async fn testnet_erase_local_machine_data(
    app_context: &AppContext,
    input: TestnetEraseNodeDataInput,
) -> Result<TestnetEraseNodeDataResult, String> {
    let requested_platform = normalize_testnet_cleanup_platform(&input.target_os)?;
    let current_platform = current_testnet_cleanup_platform();
    if requested_platform != current_platform {
        return Err(format!(
            "This Control Panel install is running on {}. Use the {} erase button on this machine.",
            current_platform, current_platform
        ));
    }

    let root = testnet_root_path()?;
    let registry = if root.exists() {
        load_registry(&root).unwrap_or_default()
    } else {
        TestnetRegistryFile::default()
    };

    let mut killed_process_count = 0usize;
    for node in &registry.nodes {
        killed_process_count = killed_process_count.saturating_add(
            force_kill_workspace_processes(Path::new(&node.workspace_directory)).unwrap_or(0),
        );
    }
    killed_process_count =
        killed_process_count.saturating_add(force_kill_testnet_processes_under_root(&root)?);

    let mut removed_paths = Vec::new();
    remove_path_if_exists(&root, &mut removed_paths)?;
    for path in candidate_local_testnet_cleanup_paths(app_context) {
        remove_path_if_exists(&path, &mut removed_paths)?;
    }

    let recreated_root = ensure_testnet_root()?;
    let _ = load_or_create_network_profile(&recreated_root)?;
    save_registry(
        &recreated_root,
        &TestnetRegistryFile {
            version: STATE_VERSION,
            nodes: Vec::new(),
        },
    )?;

    Ok(TestnetEraseNodeDataResult {
        target_os: requested_platform.to_string(),
        status: "erased".to_string(),
        message: format!(
            "Erased local Testnet node data for {}. Removed {} path(s), stopped {} process(es), and reset {} workspace record(s).",
            requested_platform,
            removed_paths.len(),
            killed_process_count,
            registry.nodes.len()
        ),
        erased_root: recreated_root.to_string_lossy().to_string(),
        removed_workspace_count: registry.nodes.len(),
        killed_process_count,
        removed_paths,
    })
}

pub async fn testnet_import_ceremony_package(
    input: TestnetImportCeremonyPackageInput,
) -> Result<TestnetImportCeremonyPackageResult, String> {
    let requested_role = input
        .setup_role_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let package_path = PathBuf::from(input.package_path.trim());
    if !package_path.exists() {
        return Err(format!(
            "Ceremony package not found: {}",
            package_path.display()
        ));
    }

    if matches!(
        requested_role.as_deref(),
        Some("bootnode") | Some("seed_server")
    ) {
        return import_bootstrap_bundle(
            requested_role.expect("validated bootstrap role should exist"),
            package_path,
            input.intended_directory,
        )
        .await;
    }

    let package = load_ceremony_package(&package_path)?;
    let resolved_role = validate_ceremony_package(&package, requested_role.as_deref())?;

    let root = ensure_testnet_root()?;
    let mut reused_existing_workspace = false;
    let mut setup_result = if let Some(existing_node) = find_existing_ceremony_node_match(
        &load_registry(&root)?,
        &package,
        input.intended_directory.as_deref(),
    ) {
        reused_existing_workspace = true;
        TestnetSetupResult {
            node: existing_node.clone(),
            network_profile: load_or_create_network_profile(&root)?,
            device_profile: detect_device_profile(),
            next_steps: vec![format!(
                "Reusing the existing Control Panel workspace at {} for this approved genesis assignment.",
                existing_node.workspace_directory
            )],
        }
    } else {
        testnet_setup_node(TestnetSetupInput {
            role_id: resolved_role.clone(),
            display_label: Some(package.display_name.clone()),
            intended_directory: input.intended_directory.clone(),
            public_host: input
                .public_host
                .clone()
                .or_else(|| package.public_host.clone()),
            node_address_override: package
                .runtime_identity
                .as_ref()
                .map(|identity| identity.address.clone()),
            identity_passphrase: input.identity_passphrase.clone(),
            skip_canonical_manifests: true,
        })
        .await?
    };
    let workspace_directory = PathBuf::from(&setup_result.node.workspace_directory);
    let staged_package_path = workspace_directory
        .join("manifests")
        .join("ceremony-package.json");
    write_json_file(
        &staged_package_path,
        &serde_json::to_value(&package)
            .map_err(|error| format!("Failed to serialize ceremony package: {error}"))?,
    )?;
    write_package_artifacts_to_workspace(&workspace_directory, &package.artifacts)?;

    let mut staged_paths = vec![
        staged_package_path.to_string_lossy().to_string(),
        workspace_directory
            .join("config")
            .join("genesis.json")
            .to_string_lossy()
            .to_string(),
        workspace_directory
            .join("config")
            .join("operational-manifest.json")
            .to_string_lossy()
            .to_string(),
    ];

    if let Some(runtime_identity) = package.runtime_identity.as_ref() {
        let identity_paths = apply_imported_runtime_identity(
            &root,
            &mut setup_result,
            runtime_identity,
            &package,
            input
                .public_host
                .as_deref()
                .or(package.public_host.as_deref()),
        )?;
        staged_paths.extend(identity_paths);
    }

    let message = if reused_existing_workspace && package.runtime_identity.is_some() {
        format!(
            "{} package refreshed the existing workspace at {}. Jarvis reused the current Control Panel workspace instead of provisioning a second validator runtime.",
            package.display_name,
            workspace_directory.display()
        )
    } else if reused_existing_workspace {
        format!(
            "{} package refreshed the existing workspace at {}. Jarvis reused the current Control Panel workspace instead of provisioning a second node workspace.",
            package.display_name,
            workspace_directory.display()
        )
    } else if package.runtime_identity.is_some() {
        format!(
            "{} package imported into {}. The workspace now carries the approved validator identity and canonical Testnet manifests.",
            package.display_name,
            workspace_directory.display()
        )
    } else {
        format!(
            "{} package imported into {}. The workspace now carries the canonical Testnet manifests and approved role metadata.",
            package.display_name,
            workspace_directory.display()
        )
    };

    let mut next_steps = setup_result.next_steps.clone();
    if !package.notes.is_empty() {
        next_steps.extend(package.notes.iter().cloned());
    }

    Ok(TestnetImportCeremonyPackageResult {
        import_mode: "runtime-role".to_string(),
        role_id: package.role_id,
        display_name: package.display_name,
        workspace_directory: workspace_directory.to_string_lossy().to_string(),
        package_path: package_path.to_string_lossy().to_string(),
        staged_paths,
        message,
        next_steps,
        node: Some(setup_result.node),
        network_profile: Some(setup_result.network_profile),
    })
}

pub fn testnet_inspect_ceremony_package(
    input: TestnetInspectCeremonyPackageInput,
) -> Result<TestnetCeremonyPackagePreview, String> {
    let package_path = PathBuf::from(input.package_path.trim());
    if !package_path.exists() {
        return Err(format!(
            "Ceremony package not found: {}",
            package_path.display()
        ));
    }

    let package = load_ceremony_package(&package_path)?;
    validate_ceremony_package_identity(&package)?;
    validate_ceremony_package_role(&package, None)?;

    Ok(TestnetCeremonyPackagePreview {
        role_id: package.role_id,
        display_name: package.display_name,
        package_type: package.package_type,
        validator_slot: package.validator_slot,
        public_host_required: package.public_host_required,
        public_host: package.public_host,
        runtime_identity_address: package.runtime_identity.map(|identity| identity.address),
        notes: package.notes,
    })
}

pub fn testnet_get_device_profile() -> Result<TestnetDeviceProfile, String> {
    Ok(detect_device_profile())
}

pub fn testnet_get_catalog() -> Result<Vec<TestnetRoleProfile>, String> {
    Ok(node_catalog())
}

pub async fn testnet_get_live_status() -> Result<TestnetLiveStatus, String> {
    let state = build_state()?;
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("Failed to create live-status HTTP client: {error}"))?;

    let bootnodes_future = join_all(
        state
            .network_profile
            .bootnodes
            .iter()
            .cloned()
            .map(check_bootstrap_endpoint),
    );
    let seed_servers_future = join_all(
        state
            .network_profile
            .seed_servers
            .iter()
            .cloned()
            .map(|endpoint| check_seed_endpoint(&client, endpoint)),
    );
    let public_chain_height_future = query_public_chain_height(&client);
    let public_peer_count_future = query_public_peer_count(&client);
    let network_peer_count_future =
        query_seed_peer_count(&client, &state.network_profile.seed_servers);

    let (
        bootnodes,
        seed_servers,
        public_chain_height_result,
        public_peer_count_result,
        network_peer_count_result,
    ) = tokio::join!(
        bootnodes_future,
        seed_servers_future,
        public_chain_height_future,
        public_peer_count_future,
        network_peer_count_future,
    );

    let public_chain_height = public_chain_height_result.ok();
    let public_peer_count = public_peer_count_result.ok();
    let network_peer_count = network_peer_count_result.ok();
    let public_rpc_online = public_chain_height.is_some() || public_peer_count.is_some();

    let nodes = join_all(
        state
            .nodes
            .iter()
            .map(|node| build_node_live_status(&client, node, public_chain_height)),
    )
    .await;

    let healthy_bootnodes = bootnodes.iter().filter(|entry| entry.reachable).count();
    let healthy_seed_servers = seed_servers.iter().filter(|entry| entry.reachable).count();

    let (discovery_status, discovery_detail) = discovery_summary(
        healthy_bootnodes,
        bootnodes.len(),
        healthy_seed_servers,
        seed_servers.len(),
    );
    let (chain_status, chain_detail) = chain_summary(
        public_rpc_online,
        public_chain_height,
        public_peer_count,
        healthy_bootnodes,
        healthy_seed_servers,
    );

    Ok(TestnetLiveStatus {
        generated_at_utc: Utc::now().to_rfc3339(),
        public_rpc_endpoint: TESTNET_PUBLIC_RPC_ENDPOINT.to_string(),
        public_rpc_online,
        public_chain_height,
        public_peer_count,
        network_peer_count,
        discovery_status,
        discovery_detail,
        chain_status,
        chain_detail,
        bootnodes,
        seed_servers,
        nodes,
    })
}

pub async fn testnet_node_control(
    app_context: &AppContext,
    input: TestnetNodeControlInput,
) -> Result<TestnetNodeControlResult, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|entry| entry.id == input.node_id)
        .cloned()
        .ok_or_else(|| format!("Unknown Testnet node: {}", input.node_id))?;

    let workspace_directory = PathBuf::from(&node.workspace_directory);
    let config_path = workspace_directory.join("config").join("node.toml");
    if !config_path.is_file() {
        return Err(format!(
            "Configuration file not found for {} at {}",
            node.display_label,
            config_path.display()
        ));
    }

    repair_workspace_config_if_needed(&node.role_id, &config_path)?;
    let runner = resolve_testnet_runner(app_context, &node.role_id)?;
    let action = input.action.trim().to_ascii_lowercase();
    let running_processes = running_processes_for_workspace(&workspace_directory);
    let is_running = !running_processes.is_empty();
    let local_rpc_ready = if is_running {
        workspace_local_rpc_ready(&config_path).await
    } else {
        false
    };
    append_workspace_control_log(
        &workspace_directory,
        "INFO",
        "Control panel action requested",
        Some(json!({
            "action": action.clone(),
            "node_id": node.id.clone(),
            "display_label": node.display_label.clone(),
            "is_running": is_running,
            "local_rpc_ready": local_rpc_ready,
        })),
    );

    match action.as_str() {
        "start" => {
            let mut launch_notices = Vec::new();
            let chain_state_requires_reset =
                workspace_chain_state_requires_canonical_reset(&workspace_directory)?;

            if is_running && local_rpc_ready && !chain_state_requires_reset {
                return Ok(TestnetNodeControlResult {
                    node_id: node.id,
                    action,
                    status: "ignored".to_string(),
                    message: "Node is already running.".to_string(),
                });
            }

            if is_running && chain_state_requires_reset {
                let _ =
                    run_runner_and_wait(&runner, "stop", &config_path, &workspace_directory).await;
                let killed = force_kill_workspace_processes(&workspace_directory)?;
                eprintln!(
                    "Warning: stopped {} before rebuilding stale chain state. Cleared {killed} lingering process(es).",
                    node.display_label
                );
            } else if is_running && !local_rpc_ready {
                let killed = force_kill_workspace_processes(&workspace_directory)?;
                eprintln!(
                    "Warning: removed {killed} stale Testnet process(es) before restarting {}.",
                    node.display_label
                );
            }

            if let Err(e) = write_canonical_workspace_manifests(&workspace_directory) {
                eprintln!(
                    "Warning: could not refresh launch manifests for {}: {e}",
                    node.display_label
                );
            }
            if let Some(message) = repair_workspace_chain_state_if_needed(&workspace_directory)? {
                eprintln!("Warning: {message}");
                launch_notices.push(message);
            }
            if let Err(error) = ensure_workspace_bootstrap_topology(
                &config_path,
                &workspace_directory,
                &state.network_profile,
                &node,
            ) {
                eprintln!(
                    "Warning: could not rewrite workspace bootstrap topology for {}: {error}",
                    node.display_label
                );
            }

            // Inject localhost dial targets for every other node provisioned on
            // this machine so same-machine validators can peer directly without
            // relying on NAT loop-back through the public IP.  We merge with
            // whatever the JS bootstrap refresh already wrote (seed-server peers)
            // so nothing is lost.
            if let Err(error) = refresh_workspace_peer_targets(
                &state.network_profile,
                &state.nodes,
                &node,
                &workspace_directory,
            )
            .await
            {
                eprintln!(
                    "Warning: could not refresh peers.toml for {}: {error}",
                    node.display_label
                );
            }
            validate_workspace_launch_preflight(&config_path, &workspace_directory).await?;

            launch_runner_detached(&runner, "start", &config_path, &workspace_directory).await?;
            wait_for_workspace_start(&config_path, &workspace_directory, Duration::from_secs(30))
                .await?;
            if let Err(error) = register_node_with_seeds_async(&state.network_profile, &node).await
            {
                eprintln!("Warning: {error}");
            }
            append_workspace_control_log(
                &workspace_directory,
                "INFO",
                "Node start completed",
                Some(json!({
                    "action": "start",
                    "node_id": node.id.clone(),
                })),
            );
            Ok(TestnetNodeControlResult {
                node_id: node.id,
                action: "start".to_string(),
                status: "ok".to_string(),
                message: if launch_notices.is_empty() {
                    "Node is online and running in its workspace.".to_string()
                } else {
                    format!(
                        "{} Node is online and rebuilding sync from the active network.",
                        launch_notices.join(" ")
                    )
                },
            })
        }
        "stop" => {
            if !is_running {
                return Ok(TestnetNodeControlResult {
                    node_id: node.id,
                    action,
                    status: "ignored".to_string(),
                    message: "Node is already stopped.".to_string(),
                });
            }

            let stop_result =
                run_runner_and_wait(&runner, "stop", &config_path, &workspace_directory).await;
            let lingering = force_kill_workspace_processes(&workspace_directory)?;

            if lingering > 0 {
                append_workspace_control_log(
                    &workspace_directory,
                    "WARN",
                    "Node stop required lingering process cleanup",
                    Some(json!({
                        "action": "stop",
                        "node_id": node.id.clone(),
                        "cleared_processes": lingering,
                    })),
                );
                return Ok(TestnetNodeControlResult {
                    node_id: node.id,
                    action: "stop".to_string(),
                    status: "ok".to_string(),
                    message: format!(
                        "Node stop completed. Cleared {lingering} lingering process(es)."
                    ),
                });
            }

            stop_result?;
            append_workspace_control_log(
                &workspace_directory,
                "INFO",
                "Node stop completed",
                Some(json!({
                    "action": "stop",
                    "node_id": node.id.clone(),
                })),
            );
            Ok(TestnetNodeControlResult {
                node_id: node.id,
                action: "stop".to_string(),
                status: "ok".to_string(),
                message: "Node stop command completed.".to_string(),
            })
        }
        "sync" => {
            let mut launch_notices = Vec::new();
            if is_running {
                let _ =
                    run_runner_and_wait(&runner, "stop", &config_path, &workspace_directory).await;
                force_kill_workspace_processes(&workspace_directory)?;
            }

            if let Err(e) = write_canonical_workspace_manifests(&workspace_directory) {
                eprintln!(
                    "Warning: could not refresh launch manifests for {}: {e}",
                    node.display_label
                );
            }
            if let Some(message) = repair_workspace_chain_state_if_needed(&workspace_directory)? {
                eprintln!("Warning: {message}");
                launch_notices.push(message);
            }
            if let Err(error) = ensure_workspace_bootstrap_topology(
                &config_path,
                &workspace_directory,
                &state.network_profile,
                &node,
            ) {
                eprintln!(
                    "Warning: could not rewrite workspace bootstrap topology for {}: {error}",
                    node.display_label
                );
            }

            // Same local-sibling injection as the start path.
            if let Err(error) = refresh_workspace_peer_targets(
                &state.network_profile,
                &state.nodes,
                &node,
                &workspace_directory,
            )
            .await
            {
                eprintln!(
                    "Warning: could not refresh peers.toml for {}: {error}",
                    node.display_label
                );
            }
            validate_workspace_launch_preflight(&config_path, &workspace_directory).await?;

            let sync_message = match run_runner_and_wait(
                &runner,
                "sync",
                &config_path,
                &workspace_directory,
            )
            .await
            {
                Ok(()) => "P2P fast-sync completed.".to_string(),
                Err(sync_error) => {
                    let fallback_message =
                        rpc_fast_sync_workspace_chain(&workspace_directory).await.map_err(
                            |fallback_error| {
                                format!(
                                    "P2P fast-sync failed ({sync_error}); RPC chain catch-up also failed ({fallback_error})."
                                )
                            },
                        )?;
                    format!("P2P fast-sync needed RPC fallback. {fallback_message}")
                }
            };
            launch_runner_detached(&runner, "start", &config_path, &workspace_directory).await?;
            wait_for_workspace_start(&config_path, &workspace_directory, Duration::from_secs(30))
                .await?;
            if let Err(error) = register_node_with_seeds_async(&state.network_profile, &node).await
            {
                eprintln!("Warning: {error}");
            }
            append_workspace_control_log(
                &workspace_directory,
                "INFO",
                "Node fast-sync completed",
                Some(json!({
                    "action": "sync",
                    "mode": "fast-sync",
                    "node_id": node.id.clone(),
                })),
            );

            let is_validator_role = role_supports_validator_registration(&node.role_id);
            Ok(TestnetNodeControlResult {
                node_id: node.id,
                action: "sync".to_string(),
                status: "ok".to_string(),
                message: if launch_notices.is_empty() {
                    if is_validator_role {
                        format!(
                            "Validator catch-up sync completed and the runtime is back online. {sync_message}"
                        )
                    } else {
                        format!("Node fast-sync completed and the runtime is back online. {sync_message}")
                    }
                } else {
                    format!(
                        "{} {} fast-sync restarted from the active network genesis. {sync_message}",
                        launch_notices.join(" "),
                        if is_validator_role {
                            "Validator"
                        } else {
                            "Node"
                        }
                    )
                },
            })
        }
        other => Err(format!("Unsupported Testnet node action: {other}")),
    }
}

pub async fn testnet_remove_node(
    app_context: &AppContext,
    input: TestnetRemoveNodeInput,
) -> Result<TestnetRemoveNodeResult, String> {
    let root = ensure_testnet_root()?;
    let mut registry = load_registry(&root)?;
    let network_profile = load_or_create_network_profile(&root)?;

    let node = registry
        .nodes
        .iter()
        .find(|entry| entry.id == input.node_id)
        .cloned()
        .ok_or_else(|| format!("Unknown Testnet node: {}", input.node_id))?;

    let workspace_directory = PathBuf::from(&node.workspace_directory);

    // Ensure node is stopped before removal.
    if let Some(pid) = running_pid_for_workspace(&workspace_directory) {
        let config_path = workspace_directory.join("config").join("node.toml");
        if config_path.is_file() {
            if let Ok(runner) = resolve_testnet_runner(app_context, &node.role_id) {
                let _ =
                    run_runner_and_wait(&runner, "stop", &config_path, &workspace_directory).await;
            }
        }
        // If the runner stop didn't work, kill the process directly.
        if running_pid_for_workspace(&workspace_directory).is_some() {
            let mut system = System::new_all();
            system.refresh_all();
            if let Some(process) = system.process(Pid::from_u32(pid)) {
                process.kill();
            }
        }
    }

    // Attempt to deregister from seed servers (best-effort).
    deregister_node_from_seeds(&network_profile, &node).await;

    // Remove the workspace directory.
    if workspace_directory.exists() {
        fs::remove_dir_all(&workspace_directory).map_err(|error| {
            format!(
                "Failed to remove workspace at {}: {error}",
                workspace_directory.display()
            )
        })?;
    }

    // Remove the associated funding manifest from the network profile.
    let mut updated_network_profile = network_profile;
    updated_network_profile
        .funding_manifests
        .retain(|manifest| manifest.id != node.funding_manifest_id);
    updated_network_profile.updated_at_utc = Utc::now().to_rfc3339();
    save_network_profile(&root, &updated_network_profile)?;

    // Remove from registry and persist.
    registry.nodes.retain(|entry| entry.id != input.node_id);
    save_registry(&root, &registry)?;

    Ok(TestnetRemoveNodeResult {
        node_id: input.node_id,
        status: "ok".to_string(),
        message: format!(
            "Node {} has been removed. Workspace deleted and seed registrations cleared.",
            node.display_label
        ),
    })
}

async fn deregister_node_from_seeds(
    network_profile: &TestnetNetworkProfile,
    node: &TestnetProvisionedNode,
) {
    let client = match Client::builder().timeout(Duration::from_secs(4)).build() {
        Ok(client) => client,
        Err(_) => return,
    };

    let payload = serde_json::json!({
        "node_id": node.id,
        "action": "deregister",
    });

    let futures = network_profile
        .seed_servers
        .iter()
        .map(|seed| {
            let client = client.clone();
            let payload = payload.clone();
            async move {
                let _ = post_seed_json(&client, seed, "/peers/deregister", &payload).await;
            }
        })
        .collect::<Vec<_>>();

    let _ = join_all(futures).await;
}

pub fn testnet_reset_deferred_bootstrap_note() -> Result<String, String> {
    Ok("Bootnodes, dnsaddr bootstrap records, and seed services are configured as the active multi-source discovery path.".to_string())
}

/// Returns recent blocks from the node's local chain via its JSON-RPC endpoint.
/// Fetches the last `count` blocks (default 20, max 100) using synergy_getBlockRange.
pub async fn testnet_get_chain_blocks(
    node_id: String,
    count: Option<u64>,
) -> Result<Vec<serde_json::Value>, String> {
    let root = ensure_testnet_root()?;
    let registry = load_registry(&root)?;
    let node = registry
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .ok_or_else(|| format!("Node not found: {}", node_id))?;

    let workspace = PathBuf::from(&node.workspace_directory);
    let config_path = workspace.join("config").join("node.toml");
    let rpc_endpoint = parse_testnet_rpc_endpoint(&config_path)
        .unwrap_or_else(|| format!("http://127.0.0.1:{TESTNET_RPC_PORT}"));

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    // Get current block height
    let height = match query_local_chain_height(&client, &rpc_endpoint).await {
        Ok(height) => height,
        Err(error) if rpc_error_is_transport_failure(&error) => {
            return Ok(Vec::new());
        }
        Err(error) => {
            return Err(format!(
                "Local chain RPC is not responding on {rpc_endpoint}: {error}"
            ));
        }
    };

    let fetch_count = count.unwrap_or(20).min(100);
    let start = if height >= fetch_count {
        height - fetch_count + 1
    } else {
        0
    };
    let end = height;

    let result = match query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_getBlockRange",
        json!([start, end]),
    )
    .await
    {
        Ok(result) => result,
        Err(error) if rpc_error_is_transport_failure(&error) => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Local chain RPC is not responding on {rpc_endpoint}: {error}"
            ));
        }
    };

    let blocks = result.as_array().cloned().unwrap_or_default();

    // Return newest first
    let mut ordered = blocks;
    ordered.reverse();
    Ok(ordered)
}

pub async fn testnet_get_feature_snapshot(
    input: TestnetFeatureSnapshotInput,
) -> Result<Value, String> {
    let state = build_state()?;
    let selected_node = input
        .node_id
        .as_deref()
        .and_then(|node_id| state.nodes.iter().find(|node| node.id == node_id))
        .or_else(|| state.nodes.first());
    let generated_at_utc = Utc::now().to_rfc3339();

    let Some(node) = selected_node.cloned() else {
        return Ok(json!({
            "screenKey": input.screen_key,
            "generatedAtUtc": generated_at_utc,
            "node": Value::Null,
            "network": {
                "environmentId": state.environment_id,
                "chainName": state.network_profile.chain_name,
                "chainId": state.network_profile.chain_id,
                "configuredNodes": state.nodes.len(),
            },
            "metrics": [],
            "checks": [],
            "table": {
                "columns": ["State", "Detail"],
                "rows": [["No configured node", "Complete setup before using this production screen."]]
            }
        }));
    };

    let workspace = PathBuf::from(&node.workspace_directory);
    let config_path = workspace.join("config").join("node.toml");
    let rpc_endpoint = parse_testnet_rpc_endpoint(&config_path)
        .unwrap_or_else(|| format!("http://127.0.0.1:{TESTNET_RPC_PORT}"));
    let client = Client::builder()
        .timeout(Duration::from_millis(2_500))
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?;

    let public_chain_height = query_public_chain_height(&client).await.ok();
    let live = build_node_live_status(&client, &node, public_chain_height).await;
    let readiness =
        build_node_readiness_report(&client, &node, &live, &state.network_profile.seed_servers)
            .await;
    let log_bundle = build_node_log_bundle(&node, 240);
    let chain_blocks = if live.local_rpc_ready {
        fetch_recent_chain_blocks_for_endpoint(&client, &rpc_endpoint, 40).await
    } else {
        Ok(Vec::new())
    };
    let graph = chain_graph_from_blocks(chain_blocks.as_ref().ok());
    let mempool = if live.local_rpc_ready {
        fetch_mempool_snapshot(&client, &rpc_endpoint).await
    } else {
        json!({
            "available": false,
            "status": "offline",
            "detail": live.local_rpc_status,
            "transactions": [],
            "stats": empty_mempool_stats(),
        })
    };
    let dag = if live.local_rpc_ready {
        fetch_dag_snapshot(&client, &rpc_endpoint, chain_blocks.as_ref().ok()).await
    } else {
        json!({
            "available": false,
            "status": "offline",
            "detail": live.local_rpc_status,
            "graph": graph,
            "vertices": [],
            "certificates": [],
            "orderingCut": Value::Null,
        })
    };
    let rpc_probes = if live.local_rpc_ready {
        probe_feature_rpc_methods(
            &client,
            &rpc_endpoint,
            &input.screen_key,
            &node.node_address,
            chain_blocks.as_ref().ok(),
        )
        .await
    } else {
        vec![json!({
            "method": "local_rpc",
            "status": "fail",
            "latencyMs": 0,
            "detail": live.local_rpc_status,
        })]
    };
    let storage = workspace_storage_snapshot(&workspace);
    let config = workspace_config_snapshot(&workspace);
    let diagnostics = machine_diagnostics_snapshot(&workspace, &rpc_endpoint);

    Ok(json!({
        "screenKey": input.screen_key,
        "generatedAtUtc": generated_at_utc,
        "node": node,
        "network": {
            "environmentId": state.environment_id,
            "chainName": state.network_profile.chain_name,
            "chainId": state.network_profile.chain_id,
            "configuredNodes": state.nodes.len(),
            "bootnodes": state.network_profile.bootnodes,
            "seedServers": state.network_profile.seed_servers,
        },
        "live": live,
        "readiness": readiness,
        "logs": {
            "summary": log_bundle.summary,
            "sources": log_bundle.sources,
            "entries": log_bundle.entries.into_iter().rev().take(80).collect::<Vec<_>>(),
        },
        "chain": {
            "blocks": chain_blocks.unwrap_or_default(),
            "graph": graph,
        },
        "mempool": mempool,
        "dag": dag,
        "rpc": {
            "endpoint": rpc_endpoint,
            "probes": rpc_probes,
        },
        "storage": storage,
        "config": config,
        "diagnostics": diagnostics,
    }))
}

fn empty_mempool_stats() -> Value {
    json!({
        "pendingCount": 0,
        "totalFeeNwei": 0,
        "totalGasLimit": 0,
        "minGasPriceNwei": 0,
        "avgGasPriceNwei": 0,
        "maxGasPriceNwei": 0,
        "largestAmountNwei": 0,
    })
}

fn numeric_json_field(value: &Value, keys: &[&str]) -> u64 {
    for key in keys {
        let Some(candidate) = value.get(*key) else {
            continue;
        };
        if let Some(number) = candidate.as_u64() {
            return number;
        }
        if let Some(number) = candidate.as_i64() {
            return number.max(0) as u64;
        }
        if let Some(text) = candidate.as_str() {
            let trimmed = text.trim();
            if let Some(hex) = trimmed.strip_prefix("0x") {
                if let Ok(parsed) = u64::from_str_radix(hex, 16) {
                    return parsed;
                }
            }
            if let Ok(parsed) = trimmed.parse::<u64>() {
                return parsed;
            }
        }
    }
    0
}

fn mempool_stats(transactions: &[Value]) -> Value {
    if transactions.is_empty() {
        return empty_mempool_stats();
    }

    let mut gas_prices = Vec::new();
    let mut total_fee = 0u64;
    let mut total_gas = 0u64;
    let mut largest_amount = 0u64;

    for tx in transactions {
        let gas_price = numeric_json_field(
            tx,
            &[
                "gas_price",
                "gasPrice",
                "effectiveGasPrice",
                "gas_price_nwei",
            ],
        );
        let gas_limit = numeric_json_field(tx, &["gas", "gasLimit", "gas_limit"]);
        let fee = numeric_json_field(tx, &["fee", "fee_nwei", "feeNwei", "transaction_fee_nwei"]);
        let amount = numeric_json_field(tx, &["amount", "amount_nwei", "amountNwei", "value"]);
        if gas_price > 0 {
            gas_prices.push(gas_price);
        }
        total_gas = total_gas.saturating_add(gas_limit);
        total_fee = total_fee.saturating_add(if fee > 0 {
            fee
        } else {
            gas_price.saturating_mul(gas_limit)
        });
        largest_amount = largest_amount.max(amount);
    }

    gas_prices.sort_unstable();
    let min_gas = gas_prices.first().copied().unwrap_or(0);
    let max_gas = gas_prices.last().copied().unwrap_or(0);
    let avg_gas = if gas_prices.is_empty() {
        0
    } else {
        gas_prices.iter().sum::<u64>() / gas_prices.len() as u64
    };

    json!({
        "pendingCount": transactions.len(),
        "totalFeeNwei": total_fee,
        "totalGasLimit": total_gas,
        "minGasPriceNwei": min_gas,
        "avgGasPriceNwei": avg_gas,
        "maxGasPriceNwei": max_gas,
        "largestAmountNwei": largest_amount,
    })
}

async fn fetch_mempool_snapshot(client: &Client, rpc_endpoint: &str) -> Value {
    let primary = query_rpc_value(
        client,
        rpc_endpoint,
        "synergy_getPendingTransactions",
        json!([250, "gasPrice"]),
    )
    .await;
    let (source_method, value) = match primary {
        Ok(value) => ("synergy_getPendingTransactions", value),
        Err(primary_error) => match query_rpc_value(
            client,
            rpc_endpoint,
            "synergy_getTransactionPool",
            json!([]),
        )
        .await
        {
            Ok(value) => ("synergy_getTransactionPool", value),
            Err(fallback_error) => {
                return json!({
                    "available": false,
                    "status": "unavailable",
                    "sourceMethod": "synergy_getPendingTransactions",
                    "detail": format!("{primary_error}; fallback failed: {fallback_error}"),
                    "transactions": [],
                    "stats": empty_mempool_stats(),
                });
            }
        },
    };

    let transactions = value.as_array().cloned().unwrap_or_default();
    let stats = mempool_stats(&transactions);
    json!({
        "available": true,
        "status": "live",
        "sourceMethod": source_method,
        "transactions": transactions,
        "stats": stats,
    })
}

fn normalize_dag_graph(value: &Value, fallback_blocks: Option<&Vec<Value>>) -> Value {
    if let Some(graph) = value.get("graph").filter(|graph| graph.is_object()) {
        return graph.clone();
    }
    if value.get("nodes").is_some() || value.get("edges").is_some() {
        return json!({
            "nodes": value.get("nodes").cloned().unwrap_or_else(|| json!([])),
            "edges": value.get("edges").cloned().unwrap_or_else(|| json!([])),
        });
    }
    if let Some(vertices) = value
        .get("vertices")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
    {
        let nodes = vertices
            .iter()
            .enumerate()
            .map(|(index, vertex)| {
                json!({
                    "id": vertex
                        .get("id")
                        .or_else(|| vertex.get("vertex_id"))
                        .or_else(|| vertex.get("hash"))
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| format!("vertex-{index}")),
                    "height": vertex
                        .get("round")
                        .or_else(|| vertex.get("height"))
                        .or_else(|| vertex.get("block_height"))
                        .cloned()
                        .unwrap_or_else(|| json!(index)),
                    "validator": vertex
                        .get("author")
                        .or_else(|| vertex.get("validator"))
                        .or_else(|| vertex.get("validator_id"))
                        .cloned()
                        .unwrap_or(Value::Null),
                    "certified": vertex
                        .get("certified")
                        .or_else(|| vertex.get("available"))
                        .cloned()
                        .unwrap_or_else(|| json!(false)),
                })
            })
            .collect::<Vec<_>>();
        return json!({
            "nodes": nodes,
            "edges": [],
        });
    }
    chain_graph_from_blocks(fallback_blocks)
}

fn dag_vertices_from_value(value: &Value) -> Vec<Value> {
    value
        .get("vertices")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default()
}

async fn optional_rpc_value(
    client: &Client,
    rpc_endpoint: &str,
    method: &str,
    params: Value,
) -> Value {
    match query_rpc_value(client, rpc_endpoint, method, params).await {
        Ok(value) => value,
        Err(error) => json!({
            "available": false,
            "method": method,
            "detail": error,
        }),
    }
}

async fn fetch_dag_snapshot(
    client: &Client,
    rpc_endpoint: &str,
    fallback_blocks: Option<&Vec<Value>>,
) -> Value {
    for method in ["synergy_getDagGraph", "synergy_getDAGGraph"] {
        if let Ok(value) = query_rpc_value(client, rpc_endpoint, method, json!([])).await {
            let vertices = dag_vertices_from_value(&value);
            let certificates = optional_rpc_value(
                client,
                rpc_endpoint,
                "synergy_getDagCertificates",
                json!([128]),
            )
            .await;
            let ordering_cut =
                optional_rpc_value(client, rpc_endpoint, "synergy_getOrderingCut", json!([])).await;
            return json!({
                "available": true,
                "status": "live",
                "sourceMethod": method,
                "detail": "Dedicated DAG RPC returned graph evidence for the selected node.",
                "graph": normalize_dag_graph(&value, fallback_blocks),
                "vertices": vertices,
                "certificates": certificates,
                "orderingCut": ordering_cut,
            });
        }
    }

    json!({
        "available": false,
        "status": "posy-finality-fallback",
        "sourceMethod": "synergy_getBlockRange",
        "detail": "The selected node does not expose dedicated DAG RPC yet; showing live PoSy finalized block parent evidence instead of synthetic DAG vertices.",
        "graph": chain_graph_from_blocks(fallback_blocks),
        "vertices": [],
        "certificates": [],
        "orderingCut": Value::Null,
    })
}

async fn fetch_recent_chain_blocks_for_endpoint(
    client: &Client,
    rpc_endpoint: &str,
    count: u64,
) -> Result<Vec<Value>, String> {
    let height = query_local_chain_height(client, rpc_endpoint).await?;
    let start = height.saturating_sub(count.saturating_sub(1));
    let result = query_rpc_value(
        client,
        rpc_endpoint,
        "synergy_getBlockRange",
        json!([start, height]),
    )
    .await?;
    let mut blocks = result.as_array().cloned().unwrap_or_default();
    blocks.reverse();
    Ok(blocks)
}

fn chain_graph_from_blocks(blocks: Option<&Vec<Value>>) -> Value {
    let blocks = blocks.cloned().unwrap_or_default();
    let nodes = blocks
        .iter()
        .filter_map(|block| {
            let height = block
                .get("number")
                .or_else(|| block.get("block_index"))
                .or_else(|| block.get("blockNumber"))
                .and_then(Value::as_u64)?;
            Some(json!({
                "id": block.get("hash").and_then(Value::as_str).unwrap_or("").to_string(),
                "height": height,
                "validator": block.get("validator")
                    .or_else(|| block.get("validator_id"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                "transactionCount": block.get("transactions")
                    .and_then(|value| value.as_array().map(Vec::len).or_else(|| value.as_u64().map(|n| n as usize)))
                    .unwrap_or(0),
                "timestamp": block.get("timestamp").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect::<Vec<_>>();

    let edges = blocks
        .iter()
        .filter_map(|block| {
            let hash = block.get("hash").and_then(Value::as_str)?;
            let parent = block
                .get("parentHash")
                .or_else(|| block.get("parent_hash"))
                .or_else(|| block.get("previous_hash"))
                .and_then(Value::as_str)?;
            if parent.is_empty() {
                return None;
            }
            Some(json!({
                "from": parent,
                "to": hash,
            }))
        })
        .collect::<Vec<_>>();

    json!({
        "nodes": nodes,
        "edges": edges,
    })
}

fn feature_rpc_methods(
    screen_key: &str,
    address: &str,
    blocks: Option<&Vec<Value>>,
) -> Vec<(&'static str, Value)> {
    let latest_height = blocks
        .and_then(|items| items.first())
        .and_then(|block| {
            block
                .get("number")
                .or_else(|| block.get("block_index"))
                .or_else(|| block.get("blockNumber"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    match screen_key {
        "alerts" => vec![
            ("synergy_getNodeStatus", json!([])),
            ("synergy_getSyncStatus", json!([])),
            ("synergy_getBlockValidationStatus", json!([])),
        ],
        "validator" => vec![
            ("synergy_getValidator", json!([address])),
            ("synergy_getValidatorPerformance", json!([address])),
            ("synergy_getValidatorQueue", json!([])),
            ("synergy_getValidatorActivity", json!([])),
        ],
        "security" | "identity" => vec![
            ("synergy_getValidator", json!([address])),
            ("synergy_getValidatorSlashingHistory", json!([address])),
            ("synergy_getSynergyScoreBreakdown", json!([address])),
        ],
        "consensus" => vec![
            ("synergy_getBlockValidationStatus", json!([])),
            ("synergy_getValidatorStats", json!([])),
            ("synergy_getValidatorActivity", json!([])),
            ("synergy_getLatestBlock", json!([])),
        ],
        "dag" => vec![
            ("synergy_getDagGraph", json!([])),
            ("synergy_getDagCertificates", json!([128])),
            ("synergy_getOrderingCut", json!([])),
            ("synergy_getLatestBlock", json!([])),
            ("synergy_getBlockByNumber", json!([latest_height])),
            ("synergy_getBlockValidationStatus", json!([])),
        ],
        "transactions" => vec![
            ("synergy_getTransactionPool", json!([])),
            ("synergy_getPendingTransactions", json!([])),
            ("synergy_gasPrice", json!([])),
            ("synergy_getTransactionsInBlock", json!([latest_height])),
        ],
        "storage" => vec![
            ("synergy_getBlockNumber", json!([])),
            ("synergy_getTokenStats", json!([])),
            ("synergy_getNetworkStats", json!([])),
        ],
        "api" => vec![
            ("synergy_getChainId", json!([])),
            ("synergy_getNodeStatus", json!([])),
            ("synergy_getPeerInfo", json!([])),
            ("synergy_getSyncStatus", json!([])),
            ("synergy_getNetworkStats", json!([])),
            ("synergy_getTransactionPool", json!([])),
        ],
        "maintenance" => vec![
            ("synergy_getNodeStatus", json!([])),
            ("synergy_getSyncStatus", json!([])),
            ("synergy_getPeerInfo", json!([])),
        ],
        "diagnostics" => vec![
            ("synergy_getNodeStatus", json!([])),
            ("synergy_getPeerInfo", json!([])),
            ("synergy_getSyncStatus", json!([])),
            ("synergy_blockNumber", json!([])),
        ],
        "config" => vec![
            ("synergy_getChainId", json!([])),
            ("synergy_nodeInfo", json!([])),
            ("synergy_getDeterminismDigest", json!([])),
        ],
        _ => vec![
            ("synergy_getNodeStatus", json!([])),
            ("synergy_getSyncStatus", json!([])),
        ],
    }
}

async fn probe_feature_rpc_methods(
    client: &Client,
    rpc_endpoint: &str,
    screen_key: &str,
    address: &str,
    blocks: Option<&Vec<Value>>,
) -> Vec<Value> {
    let mut probes = Vec::new();
    for (method, params) in feature_rpc_methods(screen_key, address, blocks) {
        let started = Instant::now();
        let result = query_rpc_value(client, rpc_endpoint, method, params).await;
        let latency_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(value) if rpc_result_contains_error(&value) => {
                probes.push(json!({
                    "method": method,
                    "status": "fail",
                    "latencyMs": latency_ms,
                    "detail": value,
                }));
            }
            Ok(value) => {
                probes.push(json!({
                    "method": method,
                    "status": "pass",
                    "latencyMs": latency_ms,
                    "summary": summarize_rpc_value(&value),
                    "result": value,
                }));
            }
            Err(error) => {
                probes.push(json!({
                    "method": method,
                    "status": "fail",
                    "latencyMs": latency_ms,
                    "detail": error,
                }));
            }
        }
    }
    probes
}

fn summarize_rpc_value(value: &Value) -> String {
    if let Some(array) = value.as_array() {
        return format!("{} row(s)", array.len());
    }
    if let Some(object) = value.as_object() {
        return format!(
            "{} field(s): {}",
            object.len(),
            object
                .keys()
                .take(5)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    if value.is_null() {
        return "null".to_string();
    }
    value.to_string()
}

fn directory_usage(path: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(metadata) = fs::symlink_metadata(&current) else {
            continue;
        };
        if metadata.is_file() {
            bytes = bytes.saturating_add(metadata.len());
            files = files.saturating_add(1);
        } else if metadata.is_dir() {
            let Ok(entries) = fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                stack.push(entry.path());
            }
        }
    }
    (bytes, files)
}

fn workspace_storage_snapshot(workspace: &Path) -> Value {
    let sections = ["config", "data", "logs", "manifests", "keys"]
        .iter()
        .map(|section| {
            let path = workspace.join(section);
            let (bytes, files) = directory_usage(&path);
            json!({
                "label": section,
                "path": path.display().to_string(),
                "exists": path.exists(),
                "bytes": bytes,
                "files": files,
            })
        })
        .collect::<Vec<_>>();
    let (workspace_bytes, workspace_files) = directory_usage(workspace);
    let canonical_workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let disks = Disks::new_with_refreshed_list();
    let disk = disks
        .iter()
        .filter(|disk| canonical_workspace.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().to_string_lossy().len())
        .map(|disk| {
            json!({
                "mountPoint": disk.mount_point().display().to_string(),
                "availableBytes": disk.available_space(),
                "totalBytes": disk.total_space(),
            })
        });

    json!({
        "workspacePath": workspace.display().to_string(),
        "workspaceExists": workspace.exists(),
        "workspaceBytes": workspace_bytes,
        "workspaceFiles": workspace_files,
        "sections": sections,
        "disk": disk,
    })
}

fn read_config_file(path: &Path, max_bytes: usize) -> Value {
    let metadata = fs::metadata(path).ok();
    let contents = fs::read_to_string(path).ok().map(|text| {
        if text.len() > max_bytes {
            let trimmed = text.chars().take(max_bytes).collect::<String>();
            format!("{trimmed}...")
        } else {
            text
        }
    });
    json!({
        "path": path.display().to_string(),
        "exists": metadata.is_some(),
        "bytes": metadata.as_ref().map(|item| item.len()),
        "modifiedAtUtc": source_modified_at_utc(path),
        "contents": contents,
    })
}

fn workspace_config_snapshot(workspace: &Path) -> Value {
    let config_dir = workspace.join("config");
    let files = [
        config_dir.join("node.toml"),
        config_dir.join("peers.toml"),
        workspace.join("node.env"),
        config_dir.join("genesis.json"),
        workspace.join("manifests").join("funding-manifest.json"),
    ]
    .into_iter()
    .map(|path| {
        read_config_file(
            &path,
            if path.file_name().and_then(|name| name.to_str()) == Some("genesis.json") {
                24_000
            } else {
                12_000
            },
        )
    })
    .collect::<Vec<_>>();

    json!({
        "workspacePath": workspace.display().to_string(),
        "files": files,
    })
}

fn capture_command(program: &str, args: &[&str]) -> Value {
    match ProcessCommand::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(output) => json!({
            "command": std::iter::once(program.to_string()).chain(args.iter().map(|arg| arg.to_string())).collect::<Vec<_>>().join(" "),
            "status": output.status.code(),
            "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
            "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        }),
        Err(error) => json!({
            "command": std::iter::once(program.to_string()).chain(args.iter().map(|arg| arg.to_string())).collect::<Vec<_>>().join(" "),
            "status": Value::Null,
            "stdout": "",
            "stderr": error.to_string(),
        }),
    }
}

fn machine_diagnostics_snapshot(workspace: &Path, rpc_endpoint: &str) -> Value {
    let processes = running_processes_for_workspace(workspace)
        .into_iter()
        .map(|process| {
            json!({
                "pid": process.pid,
                "uptimeSecs": process.uptime_secs,
            })
        })
        .collect::<Vec<_>>();
    let listener_command = if cfg!(target_os = "windows") {
        capture_command("netstat", &["-ano"])
    } else {
        capture_command("lsof", &["-nP", "-iTCP:5620-5699", "-sTCP:LISTEN"])
    };
    let disk_command = if cfg!(target_os = "windows") {
        capture_command(
            "cmd",
            &["/C", "wmic logicaldisk get size,freespace,caption"],
        )
    } else {
        capture_command("df", &["-k", &workspace.display().to_string()])
    };

    json!({
        "workspacePath": workspace.display().to_string(),
        "rpcEndpoint": rpc_endpoint,
        "processes": processes,
        "listeners": listener_command,
        "disk": disk_command,
    })
}

/// Returns the last `lines` lines from a node's main log file.
/// Reads `{workspace_directory}/logs/synergy-testnet.log`.
pub async fn testnet_run_register_with_seeds(node_id: String) -> Result<String, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {}", node_id))?;

    let registered_count = register_node_with_seeds_async(&state.network_profile, &node).await?;
    Ok(format!(
        "Node '{}' registered with {} reachable seed server(s).",
        node.display_label, registered_count
    ))
}

pub async fn testnet_get_node_readiness(node_id: String) -> Result<NodeReadinessReport, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {node_id}"))?;

    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let public_chain_height = query_public_chain_height(&client).await.ok();
    let live = build_node_live_status(&client, &node, public_chain_height).await;
    let report =
        build_node_readiness_report(&client, &node, &live, &state.network_profile.seed_servers)
            .await;

    Ok(report)
}

pub async fn testnet_get_validator_activation_preflight(
    node_id: String,
) -> Result<ValidatorActivationPreflightResult, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {node_id}"))?;
    build_validator_activation_preflight(&state, &node).await
}

pub async fn testnet_get_rewards_data(node_id: String) -> Result<Value, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {node_id}"))?;

    let rpc_endpoint = rpc_endpoint_for_workspace(&node)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?;

    let balance_result = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_getBalance",
        json!([node.node_address]),
    )
    .await;
    let token_balance_result = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_getTokenBalance",
        json!([node.node_address, TOKEN_SYMBOL]),
    )
    .await;
    let staked_result = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_getStakedBalance",
        json!([node.node_address, TOKEN_SYMBOL]),
    )
    .await;
    let staking_result = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_getStakingInfo",
        json!([node.node_address]),
    )
    .await;
    let validator_result = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_getValidator",
        json!([node.node_address]),
    )
    .await;
    let synergy_result = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_getSynergyScoreBreakdown",
        json!([node.node_address]),
    )
    .await;

    let mut telemetry_gaps = Vec::<String>::new();
    let wallet_balance_nwei = balance_result
        .as_ref()
        .ok()
        .and_then(|value| parse_rpc_balance_u64(value.clone()))
        .or_else(|| {
            token_balance_result
                .as_ref()
                .ok()
                .and_then(|value| parse_rpc_balance_u64(value.clone()))
        });
    if wallet_balance_nwei.is_none() {
        telemetry_gaps.push("wallet balance RPC is not responding".to_string());
    }

    let direct_staked_balance_nwei = staked_result
        .as_ref()
        .ok()
        .and_then(|value| parse_rpc_balance_u64(value.clone()));
    let staking_entries = staking_result
        .as_ref()
        .ok()
        .map(extract_staking_entries)
        .unwrap_or_default();
    let staking_entry_total_nwei = active_stake_total_from_entries(&staking_entries);
    let staked_balance_nwei = direct_staked_balance_nwei
        .filter(|amount| *amount > 0)
        .or_else(|| (staking_entry_total_nwei > 0).then_some(staking_entry_total_nwei))
        .or(direct_staked_balance_nwei);
    if staked_balance_nwei.is_none() {
        telemetry_gaps.push("staked balance RPC is not responding".to_string());
    }

    let historical_earned_nwei = staking_entries
        .iter()
        .filter_map(|entry| entry.get("rewards_earned").cloned())
        .filter_map(|value| parse_rpc_u64(value).ok())
        .sum::<u64>();
    let pending_rewards_nwei = staking_entries
        .iter()
        .filter_map(|entry| {
            entry
                .get("pending_rewards")
                .or_else(|| entry.get("pendingRewards"))
                .cloned()
        })
        .filter_map(|value| parse_rpc_u64(value).ok())
        .sum::<u64>();

    let validator_payload = validator_result
        .as_ref()
        .ok()
        .filter(|value| !rpc_result_contains_error(value) && !value.is_null())
        .cloned();
    let synergy_payload = synergy_result
        .as_ref()
        .ok()
        .filter(|value| !rpc_result_contains_error(value) && !value.is_null())
        .cloned();
    if synergy_payload.is_none() {
        telemetry_gaps.push("synergy score RPC is not responding".to_string());
    }

    let synergy_multiplier = synergy_payload
        .as_ref()
        .and_then(|value| value.get("total_score"))
        .and_then(Value::as_f64)
        .map(|score| (score / 100.0).max(0.0));

    let wallet_balance_nwei = wallet_balance_nwei.unwrap_or(0);
    let staked_balance_nwei = staked_balance_nwei.unwrap_or(0);
    let current_total_position_nwei = wallet_balance_nwei.saturating_add(staked_balance_nwei);
    let validator_status = validator_payload
        .as_ref()
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("Not active");
    let cluster_id = validator_payload
        .as_ref()
        .and_then(|value| value.get("cluster_id").cloned());
    let cluster_address = validator_payload
        .as_ref()
        .and_then(|value| value.get("cluster_address"))
        .and_then(Value::as_str)
        .map(str::to_string);

    Ok(json!({
        "loaded": true,
        "node_id": node.id,
        "node_address": node.node_address,
        "token_symbol": TOKEN_SYMBOL,
        "decimals": TOKEN_DECIMALS,
        "genesis": {
            "loaded": false,
            "reason": "Genesis reward baseline is not bundled with this local validator workspace."
        },
        "live": {
            "wallet_balance_raw": wallet_balance_nwei.to_string(),
            "wallet_balance_snrg": nwei_to_snrg(wallet_balance_nwei),
            "staked_balance_raw": staked_balance_nwei.to_string(),
            "staked_balance_snrg": nwei_to_snrg(staked_balance_nwei),
            "current_total_position_raw": current_total_position_nwei.to_string(),
            "current_total_position_snrg": nwei_to_snrg(current_total_position_nwei),
            "historical_earned_raw": historical_earned_nwei.to_string(),
            "historical_earned_snrg": nwei_to_snrg(historical_earned_nwei),
            "pending_rewards_raw": pending_rewards_nwei.to_string(),
            "pending_rewards_snrg": nwei_to_snrg(pending_rewards_nwei),
            "estimated_apy": Value::Null,
            "commission_rate": Value::Null,
            "staking_entry_count": staking_entries.len(),
            "reward_history": reward_history_from_stakes(&staking_entries),
            "net_position_delta_snrg": Value::Null,
            "synergy_multiplier": synergy_multiplier,
            "synergy_breakdown": synergy_payload,
            "synergy_components": synergy_payload.as_ref().and_then(|value| value.get("components").cloned()),
            "validator": validator_payload,
            "validator_status": validator_status,
            "consensus_active": validator_status.eq_ignore_ascii_case("active"),
            "cluster_id": cluster_id,
            "cluster_address": cluster_address,
        },
        "telemetry": {
            "token_balance_available": balance_result.is_ok() || token_balance_result.is_ok(),
            "staking_info_available": staking_result.is_ok(),
            "staked_balance_available": staked_result.is_ok(),
            "synergy_breakdown_available": synergy_payload.is_some(),
            "telemetry_gaps": telemetry_gaps,
        },
    }))
}

pub async fn testnet_stake_validator(
    input: TestnetValidatorStakeInput,
) -> Result<ValidatorLifecycleTxResult, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == input.node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {}", input.node_id))?;
    let amount_snrg = input.amount_snrg.unwrap_or(MINIMUM_STAKE_SNRG);
    let amount_nwei = amount_snrg.saturating_mul(TOKEN_SCALE);
    let preflight = build_validator_activation_preflight(&state, &node).await?;
    if amount_snrg == MINIMUM_STAKE_SNRG
        && preflight.staked_balance_nwei.unwrap_or(0) >= preflight.required_stake_nwei
    {
        return Ok(ValidatorLifecycleTxResult {
            node_id: node.id,
            status: "already-bonded".to_string(),
            tx_hash: None,
            message: "Validator already has the required bonded stake.".to_string(),
            preflight,
        });
    }
    if !preflight.can_stake {
        return Err(validator_stake_preflight_error(&preflight));
    }
    if preflight.balance_nwei.unwrap_or(0) < amount_nwei {
        return Err(validator_stake_preflight_error(&preflight));
    }

    let rpc_endpoint = rpc_endpoint_for_workspace(&node)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?;
    let response = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_stakeTokens",
        json!([
            node.node_address,
            node.node_address,
            TOKEN_SYMBOL,
            amount_snrg
        ]),
    )
    .await?;
    let tx_hash = parse_lifecycle_tx_hash(&response)?;
    let refreshed = build_validator_activation_preflight(&state, &node).await?;

    Ok(ValidatorLifecycleTxResult {
        node_id: node.id,
        status: "submitted".to_string(),
        tx_hash: Some(tx_hash.clone()),
        message: format!(
            "Submitted validator stake transaction {tx_hash}. Wait for it to be included, then run activation preflight."
        ),
        preflight: refreshed,
    })
}

pub async fn testnet_unstake_validator(
    input: TestnetValidatorUnstakeInput,
) -> Result<ValidatorLifecycleTxResult, String> {
    if input.amount_snrg == 0 {
        return Err("Unstake amount must be greater than zero.".to_string());
    }

    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == input.node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {}", input.node_id))?;
    let amount_nwei = input.amount_snrg.saturating_mul(TOKEN_SCALE);
    let preflight = build_validator_activation_preflight(&state, &node).await?;
    if preflight.staked_balance_nwei.unwrap_or(0) < amount_nwei {
        return Err(
            "Validator does not have enough bonded stake for that unstake amount.".to_string(),
        );
    }

    let rpc_endpoint = rpc_endpoint_for_workspace(&node)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?;
    let response = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_unstakeTokens",
        json!([
            node.node_address,
            node.node_address,
            TOKEN_SYMBOL,
            amount_nwei
        ]),
    )
    .await?;
    let message = parse_lifecycle_success_message(&response, "Validator unstake applied.")?;
    let refreshed = build_validator_activation_preflight(&state, &node).await?;

    Ok(ValidatorLifecycleTxResult {
        node_id: node.id,
        status: "submitted".to_string(),
        tx_hash: None,
        message,
        preflight: refreshed,
    })
}

pub async fn testnet_transfer_validator_tokens(
    input: TestnetValidatorTransferInput,
) -> Result<ValidatorLifecycleTxResult, String> {
    if input.amount_snrg == 0 {
        return Err("Transfer amount must be greater than zero.".to_string());
    }
    if !is_valid_address(&input.destination_address) {
        return Err("Destination is not a valid Synergy address.".to_string());
    }

    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == input.node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {}", input.node_id))?;
    let amount_nwei = input.amount_snrg.saturating_mul(TOKEN_SCALE);
    let preflight = build_validator_activation_preflight(&state, &node).await?;
    if preflight.balance_nwei.unwrap_or(0) < amount_nwei {
        return Err(
            "Validator wallet does not have enough liquid SNRG for that withdrawal.".to_string(),
        );
    }

    let rpc_endpoint = rpc_endpoint_for_workspace(&node)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?;
    let response = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_sendTokens",
        json!([
            node.node_address,
            input.destination_address,
            TOKEN_SYMBOL,
            input.amount_snrg,
            "validator-withdrawal"
        ]),
    )
    .await?;
    let tx_hash = parse_lifecycle_tx_hash(&response)?;
    let refreshed = build_validator_activation_preflight(&state, &node).await?;

    Ok(ValidatorLifecycleTxResult {
        node_id: node.id,
        status: "submitted".to_string(),
        tx_hash: Some(tx_hash.clone()),
        message: format!("Submitted validator withdrawal transaction {tx_hash}."),
        preflight: refreshed,
    })
}

fn validator_stake_preflight_error(preflight: &ValidatorActivationPreflightResult) -> String {
    let priority_checks = [
        "validator-role",
        "canonical-validator-address",
        "canonical-workspace-genesis",
        "canonical-chain-state",
        "local-rpc",
        "local-signing-key",
        "runtime-wallet-loaded",
        "liquid-balance",
    ];

    for id in priority_checks {
        if let Some(check) = preflight
            .checks
            .iter()
            .find(|check| check.id == id && check.status != "pass")
        {
            return match check.suggestion.as_deref() {
                Some(suggestion) => format!(
                    "Validator is not ready to stake: {}. {}",
                    check.label, suggestion
                ),
                None => format!("Validator is not ready to stake: {}.", check.label),
            };
        }
    }

    "Validator wallet does not have enough liquid SNRG to bond the required stake.".to_string()
}

pub async fn testnet_activate_validator(
    input: TestnetValidatorActivateInput,
) -> Result<ValidatorLifecycleTxResult, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == input.node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {}", input.node_id))?;
    let amount_snrg = input.amount_snrg.unwrap_or(MINIMUM_STAKE_SNRG);
    let preflight = build_validator_activation_preflight(&state, &node).await?;
    if !preflight.can_activate {
        return Err("Validator activation preflight is not passing yet. The node must be on canonical chain 1264, within two blocks of head, visible through relayer peers, registered with seeds, and bonded before activation.".to_string());
    }

    let rpc_endpoint = rpc_endpoint_for_workspace(&node)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?;
    let display_name = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(node.display_label.as_str());
    let response = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_activateValidator",
        json!([node.node_address, display_name, amount_snrg]),
    )
    .await?;
    let tx_hash = parse_lifecycle_tx_hash(&response)?;
    let refreshed = build_validator_activation_preflight(&state, &node).await?;

    Ok(ValidatorLifecycleTxResult {
        node_id: node.id,
        status: "submitted".to_string(),
        tx_hash: Some(tx_hash.clone()),
        message: format!(
            "Submitted validator activation transaction {tx_hash}. The validator joins consensus after this transaction is included and synced by the validator set."
        ),
        preflight: refreshed,
    })
}

pub async fn testnet_sync_catch_up_rejoin(
    app_context: &AppContext,
    input: TestnetValidatorCatchUpInput,
) -> Result<ValidatorCatchUpResult, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == input.node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {}", input.node_id))?;

    if !role_supports_validator_registration(&node.role_id) {
        return Err("Sync Catch Up is only available for validator nodes.".to_string());
    }

    let mut steps = Vec::<ValidatorCatchUpStep>::new();
    let sync_result = match testnet_node_control(
        app_context,
        TestnetNodeControlInput {
            node_id: node.id.clone(),
            action: "sync".to_string(),
        },
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            steps.push(catch_up_step(
                "speed-sync",
                "Speed sync chain",
                "fail",
                &error,
            ));
            return Ok(ValidatorCatchUpResult {
                node_id: node.id,
                status: "failed".to_string(),
                message: format!("Sync Catch Up failed before preflight: {error}"),
                steps,
                preflight: None,
                activation: None,
                consensus_active: false,
                repair_actions: vec![PreflightRepairAction {
                    id: "open-diagnostics".to_string(),
                    label: "Open Diagnostics".to_string(),
                    detail: "Review runtime, ports, disk, and RPC checks before retrying catch-up."
                        .to_string(),
                    action: "diagnostics".to_string(),
                }],
            });
        }
    };

    steps.push(catch_up_step(
        "stop-node",
        "Stop node",
        "pass",
        "Runtime was stopped or confirmed stopped before sync.",
    ));
    steps.push(catch_up_step(
        "speed-sync",
        "Speed sync chain",
        "pass",
        sync_result.message.as_str(),
    ));
    steps.push(catch_up_step(
        "restart-runtime",
        "Restart runtime",
        "pass",
        "Runtime restarted from the synced workspace.",
    ));

    let preflight = match build_validator_activation_preflight(&state, &node).await {
        Ok(preflight) => preflight,
        Err(error) => {
            steps.push(catch_up_step("preflight", "Run preflight", "fail", &error));
            return Ok(ValidatorCatchUpResult {
                node_id: node.id,
                status: "blocked".to_string(),
                message: format!("Catch-up completed, but validator preflight failed: {error}"),
                steps,
                preflight: None,
                activation: None,
                consensus_active: false,
                repair_actions: vec![PreflightRepairAction {
                    id: "open-diagnostics".to_string(),
                    label: "Open Diagnostics".to_string(),
                    detail:
                        "Open Developer Diagnostics and resolve runtime checks before rejoining."
                            .to_string(),
                    action: "diagnostics".to_string(),
                }],
            });
        }
    };

    if !preflight.can_activate {
        let repair_actions = repair_actions_for_preflight(&preflight);
        steps.push(catch_up_step(
            "preflight",
            "Run preflight",
            "blocked",
            "One or more readiness checks still need operator action.",
        ));
        steps.push(catch_up_step(
            "rejoin-consensus",
            "Rejoin consensus",
            "blocked",
            "Resolve failed preflight checks before rejoining consensus.",
        ));
        return Ok(ValidatorCatchUpResult {
            node_id: node.id,
            status: "blocked".to_string(),
            message: "Catch-up completed, but preflight still has blockers.".to_string(),
            steps,
            preflight: Some(preflight),
            activation: None,
            consensus_active: false,
            repair_actions,
        });
    }

    steps.push(catch_up_step(
        "preflight",
        "Run preflight",
        "pass",
        "All validator rejoin preflight checks are passing.",
    ));

    let consensus_active_before = validator_consensus_active(&node).await;
    if consensus_active_before {
        steps.push(catch_up_step(
            "rejoin-consensus",
            "Rejoin consensus",
            "pass",
            "Validator is already active in consensus after catch-up.",
        ));
        return Ok(ValidatorCatchUpResult {
            node_id: node.id,
            status: "rejoined".to_string(),
            message: "Catch-up complete. Validator is active in consensus.".to_string(),
            steps,
            preflight: Some(preflight),
            activation: None,
            consensus_active: true,
            repair_actions: Vec::new(),
        });
    }

    if input.auto_activate.unwrap_or(true) {
        let activation = match testnet_activate_validator(TestnetValidatorActivateInput {
            node_id: node.id.clone(),
            amount_snrg: None,
            display_name: Some(node.display_label.clone()),
        })
        .await
        {
            Ok(result) => result,
            Err(error) => {
                steps.push(catch_up_step(
                    "rejoin-consensus",
                    "Rejoin consensus",
                    "fail",
                    &error,
                ));
                return Ok(ValidatorCatchUpResult {
                    node_id: node.id,
                    status: "blocked".to_string(),
                    message: format!("Catch-up passed preflight, but activation failed: {error}"),
                    steps,
                    preflight: Some(preflight),
                    activation: None,
                    consensus_active: false,
                    repair_actions: vec![PreflightRepairAction {
                        id: "open-rewards".to_string(),
                        label: "Open Rewards".to_string(),
                        detail: "Check wallet balance, bonded stake, and activation controls."
                            .to_string(),
                        action: "rewards".to_string(),
                    }],
                });
            }
        };
        let consensus_active_after = validator_consensus_active(&node).await;
        steps.push(catch_up_step(
            "rejoin-consensus",
            "Rejoin consensus",
            "pass",
            if consensus_active_after {
                "Validator is active in consensus."
            } else {
                "Activation transaction submitted; validator will show active after the transaction is included and synced."
            },
        ));
        return Ok(ValidatorCatchUpResult {
            node_id: node.id,
            status: if consensus_active_after {
                "rejoined".to_string()
            } else {
                "activation-submitted".to_string()
            },
            message: if consensus_active_after {
                "Catch-up complete. Validator rejoined consensus.".to_string()
            } else {
                activation.message.clone()
            },
            steps,
            preflight: Some(activation.preflight.clone()),
            activation: Some(activation),
            consensus_active: consensus_active_after,
            repair_actions: Vec::new(),
        });
    }

    steps.push(catch_up_step(
        "rejoin-consensus",
        "Rejoin consensus",
        "blocked",
        "Automatic activation was disabled for this request.",
    ));
    Ok(ValidatorCatchUpResult {
        node_id: node.id,
        status: "ready".to_string(),
        message: "Catch-up complete. Preflight is passing and validator is ready to activate."
            .to_string(),
        steps,
        preflight: Some(preflight),
        activation: None,
        consensus_active: false,
        repair_actions: Vec::new(),
    })
}

async fn build_validator_activation_preflight(
    state: &TestnetState,
    node: &TestnetProvisionedNode,
) -> Result<ValidatorActivationPreflightResult, String> {
    let required_stake_nwei = MINIMUM_STAKE_SNRG * TOKEN_SCALE;
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?;
    let public_chain_height = query_public_chain_height(&client).await.ok();
    let live = build_node_live_status(&client, node, public_chain_height).await;
    let readiness =
        build_node_readiness_report(&client, node, &live, &state.network_profile.seed_servers)
            .await;
    let rpc_endpoint = rpc_endpoint_for_workspace(node)?;
    let balance_nwei = query_rpc_u64_or_none(
        &client,
        &rpc_endpoint,
        "synergy_getBalance",
        json!([node.node_address]),
    )
    .await;
    let direct_staked_balance_nwei = query_rpc_u64_or_none(
        &client,
        &rpc_endpoint,
        "synergy_getStakedBalance",
        json!([node.node_address, TOKEN_SYMBOL]),
    )
    .await;
    let staking_entries = query_rpc_value(
        &client,
        &rpc_endpoint,
        "synergy_getStakingInfo",
        json!([node.node_address]),
    )
    .await
    .ok()
    .map(|value| extract_staking_entries(&value))
    .unwrap_or_default();
    let staking_entry_total_nwei = active_stake_total_from_entries(&staking_entries);
    let staked_balance_nwei = direct_staked_balance_nwei
        .filter(|amount| *amount > 0)
        .or_else(|| (staking_entry_total_nwei > 0).then_some(staking_entry_total_nwei))
        .or(direct_staked_balance_nwei);
    let local_signing_key_ready = local_validator_signing_key_ready(node);
    let runtime_wallet_ready =
        query_runtime_wallet_ready(&client, &rpc_endpoint, &node.node_address)
            .await
            .unwrap_or(false);
    let workspace_directory = PathBuf::from(&node.workspace_directory);
    let workspace_genesis_ok = match (
        workspace_genesis_hash(&workspace_directory),
        canonical_testnet_genesis_hash(),
    ) {
        (Ok(actual), Ok(expected)) => actual.eq_ignore_ascii_case(&expected),
        _ => false,
    };
    let chain_state_genesis_ok =
        !workspace_chain_state_requires_canonical_reset(&workspace_directory).unwrap_or(true);

    let role_ok = role_supports_validator_registration(&node.role_id);
    let validator_mesh_only = provisioned_node_uses_private_validator_mesh(node);
    let public_host_ok = validator_mesh_only
        || node
            .public_host
            .as_deref()
            .map(is_publicly_routable_host)
            .unwrap_or(false);
    let sync_gap_ok = live
        .sync_gap
        .map(|gap| gap <= TESTNET_ACTIVATION_MAX_SYNC_GAP)
        .unwrap_or(false);
    let rpc_ok = live.is_running && live.local_rpc_ready;
    let required_peer_count = if validator_mesh_only {
        1
    } else {
        TESTNET_ACTIVATION_MIN_PUBLIC_PEERS
    };
    let peer_ok = live.local_peer_count.unwrap_or(0) >= required_peer_count;
    let seed_ok = readiness
        .checks
        .iter()
        .any(|check| check.id == "seed_registered" && check.status == "pass");
    let liquid = balance_nwei.unwrap_or(0);
    let staked = staked_balance_nwei.unwrap_or(0);
    let validator_address_ok = node.node_address.starts_with("synv")
        && node.node_address.len() == TARGET_ADDRESS_LEN
        && is_valid_address(&node.node_address);

    let mut checks = readiness.checks;
    checks.push(preflight_check(
        "validator-role",
        "Validator role",
        role_ok,
        "This workspace is configured as a validator.",
        "Select or provision a validator workspace before staking.",
    ));
    checks.push(preflight_check(
        "canonical-validator-address",
        "Canonical validator address",
        validator_address_ok,
        "The validator address is a canonical 41-character Synergy Bech32m validator address.",
        "Remove this workspace and rerun setup with the updated Control Panel so the address engine generates a full canonical validator identity.",
    ));
    checks.push(preflight_check(
        "public-endpoint",
        "Public P2P endpoint",
        public_host_ok,
        "The validator has a publicly routable endpoint or is a canonical genesis mesh validator.",
        "Set a public IP/DNS name and open the validator P2P port before activation.",
    ));
    checks.push(preflight_check(
        "canonical-workspace-genesis",
        "Canonical workspace genesis",
        workspace_genesis_ok,
        "The validator workspace has the canonical chain 1264 genesis hash.",
        "Re-provision this workspace with the canonical Testnet bundle before staking or activation.",
    ));
    checks.push(preflight_check(
        "canonical-chain-state",
        "Canonical chain state",
        chain_state_genesis_ok,
        "Existing local chain data belongs to the canonical chain 1264 genesis.",
        "Stop the node and reset stale local chain data before staking or activation.",
    ));
    checks.push(preflight_check(
        "local-rpc",
        "Local RPC ready",
        rpc_ok,
        "The local validator RPC is running and reachable.",
        "Start or rejoin the validator and wait for RPC readiness.",
    ));
    checks.push(preflight_check(
        "sync-gap",
        "Synced near chain head",
        sync_gap_ok,
        "The validator is within two blocks of the public chain head for activation.",
        "Run Sync Catch Up before activating.",
    ));
    checks.push(preflight_check(
        "peers-visible",
        "Relayer peers visible",
        peer_ok,
        "The validator has enough live peer visibility for safe activation.",
        "Check relayer reachability, firewall/P2P access, and peer bootstrap before activation.",
    ));
    checks.push(NodeReadinessCheck {
        id: "seed-registration".to_string(),
        label: "Seed registration".to_string(),
        status: if seed_ok {
            "pass"
        } else if peer_ok {
            "warn"
        } else {
            "fail"
        }
        .to_string(),
        detail: if seed_ok {
            "Seed servers have a registration for this validator.".to_string()
        } else if peer_ok {
            "Seed registration is not reporting this validator, but the validator already has live peer visibility."
                .to_string()
        } else {
            "Seed servers do not currently expose this validator.".to_string()
        },
        suggestion: if seed_ok {
            None
        } else if peer_ok {
            Some("Run Re-register before activation so public discovery matches the validator identity.".to_string())
        } else {
            Some("Run Re-register or fix bootstrap peers so public validators can discover this node.".to_string())
        },
    });
    checks.push(preflight_check(
        "liquid-balance",
        "Wallet funding",
        liquid >= required_stake_nwei || staked >= required_stake_nwei,
        "The validator wallet has enough SNRG available or already bonded.",
        "Send 50,000 SNRG to the validator wallet from Synergy Wallet, then refresh.",
    ));
    checks.push(preflight_check(
        "local-signing-key",
        "Local signing key",
        local_signing_key_ready,
        "The validator workspace has the local private signing key for this validator address.",
        "Re-run setup with the validator address engine or import the correct validator identity before staking.",
    ));
    checks.push(preflight_check(
        "runtime-wallet-loaded",
        "Runtime wallet loaded",
        runtime_wallet_ready,
        "The running validator RPC has imported the validator wallet and can sign stake transactions.",
        "Restart or resume chain sync after updating the Control Panel so the runtime imports keys/identity.json and keys/private.key.",
    ));
    checks.push(preflight_check(
        "bonded-stake",
        "Bonded stake",
        staked >= required_stake_nwei,
        "The validator wallet has the required bonded stake.",
        "Run Stake Validator after wallet funding is visible.",
    ));

    let can_stake = role_ok
        && validator_address_ok
        && workspace_genesis_ok
        && chain_state_genesis_ok
        && rpc_ok
        && local_signing_key_ready
        && runtime_wallet_ready
        && liquid >= required_stake_nwei;
    let can_activate = role_ok
        && validator_address_ok
        && workspace_genesis_ok
        && chain_state_genesis_ok
        && public_host_ok
        && rpc_ok
        && local_signing_key_ready
        && runtime_wallet_ready
        && sync_gap_ok
        && peer_ok
        && seed_ok
        && staked >= required_stake_nwei;

    Ok(ValidatorActivationPreflightResult {
        node_id: node.id.clone(),
        generated_at_utc: Utc::now().to_rfc3339(),
        can_stake,
        can_activate,
        balance_nwei,
        staked_balance_nwei,
        required_stake_snrg: MINIMUM_STAKE_SNRG,
        required_stake_nwei,
        checks,
    })
}

fn local_validator_signing_key_ready(node: &TestnetProvisionedNode) -> bool {
    let workspace = PathBuf::from(&node.workspace_directory);
    let identity_path = workspace.join("keys").join("identity.json");
    let private_key_path = workspace.join("keys").join("private.key");

    let identity_address_matches = fs::read_to_string(identity_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|identity| {
            identity
                .get("address")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .map(|address| address == node.node_address)
        .unwrap_or(false);

    let private_key_present = fs::read_to_string(private_key_path)
        .map(|contents| !contents.trim().is_empty())
        .unwrap_or(false);

    identity_address_matches && private_key_present
}

async fn query_runtime_wallet_ready(
    client: &Client,
    rpc_endpoint: &str,
    address: &str,
) -> Result<bool, String> {
    let value =
        query_rpc_value(client, rpc_endpoint, "synergy_getWallet", json!([address])).await?;
    Ok(value
        .get("address")
        .and_then(Value::as_str)
        .map(|wallet_address| wallet_address == address)
        .unwrap_or(false))
}

fn rpc_endpoint_for_workspace(node: &TestnetProvisionedNode) -> Result<String, String> {
    let config_path = PathBuf::from(&node.workspace_directory)
        .join("config")
        .join("node.toml");
    parse_testnet_rpc_endpoint(&config_path).ok_or_else(|| {
        format!(
            "Could not resolve local RPC endpoint from {}",
            config_path.display()
        )
    })
}

fn catch_up_step(id: &str, label: &str, status: &str, detail: &str) -> ValidatorCatchUpStep {
    ValidatorCatchUpStep {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        detail: detail.to_string(),
    }
}

fn push_unique_repair_action(
    actions: &mut Vec<PreflightRepairAction>,
    id: &str,
    label: &str,
    detail: &str,
    action: &str,
) {
    if actions.iter().any(|entry| entry.id == id) {
        return;
    }

    actions.push(PreflightRepairAction {
        id: id.to_string(),
        label: label.to_string(),
        detail: detail.to_string(),
        action: action.to_string(),
    });
}

fn repair_actions_for_preflight(
    preflight: &ValidatorActivationPreflightResult,
) -> Vec<PreflightRepairAction> {
    let mut actions = Vec::new();
    for check in preflight
        .checks
        .iter()
        .filter(|check| check.status != "pass")
    {
        match check.id.as_str() {
            "process-running" | "local-rpc" => push_unique_repair_action(
                &mut actions,
                "start-node",
                "Start Node",
                "Start or restart the runtime, then rerun preflight.",
                "start",
            ),
            "sync-gap" => push_unique_repair_action(
                &mut actions,
                "sync-catch-up",
                "Sync Catch Up",
                "Run the catch-up workflow again after peers are reachable.",
                "sync-catch-up",
            ),
            "peers-visible" | "seed-registration" => push_unique_repair_action(
                &mut actions,
                "register-seeds",
                "Refresh Peers",
                "Refresh seed registration and peer targets.",
                "register-seeds",
            ),
            "liquid-balance" | "bonded-stake" => push_unique_repair_action(
                &mut actions,
                "open-rewards",
                "Open Rewards",
                "Fund, stake, or activate the validator wallet from Rewards.",
                "rewards",
            ),
            "local-signing-key" | "runtime-wallet-loaded" => push_unique_repair_action(
                &mut actions,
                "restart-node",
                "Restart Node",
                "Reload runtime identity and wallet files.",
                "restart",
            ),
            _ => push_unique_repair_action(
                &mut actions,
                "open-diagnostics",
                "Open Diagnostics",
                "Inspect machine diagnostics and runtime configuration.",
                "diagnostics",
            ),
        }
    }

    actions
}

async fn validator_consensus_active(node: &TestnetProvisionedNode) -> bool {
    let Ok(endpoint) = rpc_endpoint_for_workspace(node) else {
        return false;
    };
    let Ok(client) = Client::builder().timeout(Duration::from_secs(8)).build() else {
        return false;
    };
    let Ok(value) = query_rpc_value(
        &client,
        &endpoint,
        "synergy_getValidator",
        json!([node.node_address.clone()]),
    )
    .await
    else {
        return false;
    };

    let status = value
        .get("status")
        .or_else(|| value.get("validator").and_then(|entry| entry.get("status")))
        .and_then(Value::as_str)
        .unwrap_or_default();
    status.eq_ignore_ascii_case("active")
}

fn preflight_check(
    id: &str,
    label: &str,
    pass: bool,
    detail: &str,
    suggestion: &str,
) -> NodeReadinessCheck {
    NodeReadinessCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: if pass { "pass" } else { "fail" }.to_string(),
        detail: detail.to_string(),
        suggestion: (!pass).then(|| suggestion.to_string()),
    }
}

async fn query_rpc_u64_or_none(
    client: &Client,
    endpoint: &str,
    method: &str,
    params: Value,
) -> Option<u64> {
    query_rpc_value(client, endpoint, method, params)
        .await
        .ok()
        .and_then(parse_rpc_balance_u64)
}

fn parse_rpc_balance_u64(value: Value) -> Option<u64> {
    parse_rpc_u64(value.clone()).ok().or_else(|| {
        [
            "balance",
            "amount",
            "staked",
            "staked_balance",
            "stakedBalance",
            TOKEN_SYMBOL,
        ]
        .iter()
        .find_map(|key| {
            value
                .get(*key)
                .cloned()
                .and_then(|entry| parse_rpc_u64(entry).ok())
        })
    })
}

fn nwei_to_snrg(amount_nwei: u64) -> f64 {
    amount_nwei as f64 / TOKEN_SCALE as f64
}

fn rpc_result_contains_error(value: &Value) -> bool {
    value.get("error").is_some()
        || value
            .get("success")
            .and_then(Value::as_bool)
            .map(|success| !success)
            .unwrap_or(false)
}

fn extract_staking_entries(value: &Value) -> Vec<Value> {
    if let Some(entries) = value.as_array() {
        return entries.clone();
    }

    ["entries", "stakes", "staking_entries", "stakingEntries"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_array))
        .cloned()
        .unwrap_or_default()
}

fn active_stake_total_from_entries(entries: &[Value]) -> u64 {
    entries
        .iter()
        .filter(|entry| {
            entry
                .get("is_active")
                .or_else(|| entry.get("isActive"))
                .and_then(Value::as_bool)
                .unwrap_or(true)
        })
        .filter_map(|entry| entry.get("amount").cloned())
        .filter_map(|value| parse_rpc_u64(value).ok())
        .sum::<u64>()
}

fn reward_history_from_stakes(entries: &[Value]) -> Vec<Value> {
    entries
        .iter()
        .filter_map(|entry| {
            let rewards = entry
                .get("rewards_earned")
                .cloned()
                .and_then(|value| parse_rpc_u64(value).ok())
                .unwrap_or(0);
            if rewards == 0 {
                return None;
            }
            let timestamp = entry
                .get("stake_start")
                .or_else(|| entry.get("stakeStart"))
                .cloned()
                .and_then(|value| parse_rpc_u64(value).ok())
                .unwrap_or_else(|| Utc::now().timestamp().max(0) as u64);
            Some(json!({
                "id": format!("stake-reward-{timestamp}"),
                "timestamp": timestamp,
                "amount": rewards,
                "amount_snrg": nwei_to_snrg(rewards),
                "type": "staking",
            }))
        })
        .collect()
}

fn parse_lifecycle_tx_hash(value: &Value) -> Result<String, String> {
    let success = value
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !success {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Validator lifecycle transaction failed.")
            .to_string());
    }

    value
        .get("tx_hash")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "RPC response did not include a transaction hash.".to_string())
}

fn parse_lifecycle_success_message(value: &Value, default_message: &str) -> Result<String, String> {
    let success = value
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !success {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Validator lifecycle operation failed.")
            .to_string());
    }

    Ok(value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or(default_message)
        .to_string())
}

pub async fn testnet_boost_sync(
    app_context: &AppContext,
    node_id: String,
) -> Result<AcceleratedSyncResult, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {node_id}"))?;

    let seeds_queried = state.network_profile.seed_servers.len();
    let workspace_directory = PathBuf::from(&node.workspace_directory);
    let targets = refresh_workspace_peer_targets(
        &state.network_profile,
        &state.nodes,
        &node,
        &workspace_directory,
    )
    .await?;

    write_canonical_workspace_manifests(&workspace_directory).ok();

    // 6. Stop node if running, then restart.
    let config_path = workspace_directory.join("config").join("node.toml");
    let runner = resolve_testnet_runner(app_context, &node.role_id)?;

    if running_pid_for_workspace(&workspace_directory).is_some() {
        let _ = run_runner_and_wait(&runner, "stop", &config_path, &workspace_directory).await;
        force_kill_workspace_processes(&workspace_directory)?;
    }

    launch_runner_detached(&runner, "start", &config_path, &workspace_directory).await?;
    wait_for_workspace_start(&config_path, &workspace_directory, Duration::from_secs(30)).await?;

    // 7. Re-register with seeds.
    register_node_with_seeds_best_effort(&state.network_profile, &node).await;

    let unique_dial_targets = targets;
    Ok(AcceleratedSyncResult {
        node_id: node.id.clone(),
        peers_injected: unique_dial_targets,
        seeds_queried,
        unique_dial_targets,
        message: format!(
            "Injected {} peer dial targets from {} seed server(s) and restarted '{}'. The node will now sync from all available peers.",
            unique_dial_targets,
            seeds_queried,
            node.display_label
        ),
    })
}

pub async fn testnet_force_peer_connect(
    app_context: &AppContext,
    input: TestnetForcePeerConnectInput,
) -> Result<TestnetForcePeerConnectResult, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == input.node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {}", input.node_id))?;

    let workspace_directory = PathBuf::from(&node.workspace_directory);
    let config_path = workspace_directory.join("config").join("node.toml");
    if !config_path.is_file() {
        return Err(format!(
            "Configuration file not found for {} at {}",
            node.display_label,
            config_path.display()
        ));
    }

    repair_workspace_config_if_needed(&node.role_id, &config_path)?;
    let requested_dial_target = normalize_testnet_dial_target(&input.dial_target)
        .ok_or_else(|| format!("Peer dial target is invalid: {}", input.dial_target.trim()))?;

    write_canonical_workspace_manifests(&workspace_directory).ok();

    let mut preferred_targets = Vec::new();
    if let Some(public_address) = input
        .public_address
        .as_deref()
        .and_then(normalize_testnet_dial_target)
    {
        preferred_targets.push(public_address);
    }
    if !preferred_targets.contains(&requested_dial_target) {
        preferred_targets.push(requested_dial_target.clone());
    }
    if let Some(validator_address) = input
        .validator_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(canonical_target) =
            canonical_validator_dial_target_for_address(&workspace_directory, validator_address)
        {
            if !preferred_targets.contains(&canonical_target) {
                preferred_targets.push(canonical_target);
            }
        }
    }

    let self_targets = self_dial_target_aliases_for_node(&node, &workspace_directory);
    preferred_targets.retain(|target| !self_targets.contains(target));
    if preferred_targets.is_empty() {
        return Err(
            "Selected peer resolves back to this node; refusing to inject a self-dial target."
                .to_string(),
        );
    }

    let unique_dial_targets = refresh_workspace_peer_targets_with_overrides(
        &state.network_profile,
        &state.nodes,
        &node,
        &workspace_directory,
        &preferred_targets,
    )
    .await?;

    let runner = resolve_testnet_runner(app_context, &node.role_id)?;
    let was_running = running_pid_for_workspace(&workspace_directory).is_some();
    if was_running {
        let _ = run_runner_and_wait(&runner, "stop", &config_path, &workspace_directory).await;
        force_kill_workspace_processes(&workspace_directory)?;
    }

    launch_runner_detached(&runner, "start", &config_path, &workspace_directory).await?;
    wait_for_workspace_start(&config_path, &workspace_directory, Duration::from_secs(30)).await?;
    register_node_with_seeds_best_effort(&state.network_profile, &node).await;

    let peer_label = input
        .validator_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(requested_dial_target.as_str());
    let lifecycle_verb = if was_running { "restarted" } else { "started" };
    append_workspace_control_log(
        &workspace_directory,
        "INFO",
        "Peer reconnect requested from developer mode",
        Some(json!({
            "node_id": node.id.clone(),
            "peer_label": peer_label,
            "requested_dial_target": requested_dial_target.clone(),
            "preferred_targets": preferred_targets.clone(),
            "unique_dial_targets": unique_dial_targets,
            "was_running": was_running,
        })),
    );

    Ok(TestnetForcePeerConnectResult {
        node_id: node.id.clone(),
        dial_target: requested_dial_target.clone(),
        unique_dial_targets,
        message: format!(
            "Queued reconnect to {peer_label} via {requested_dial_target} and {lifecycle_verb} '{}'. peers.toml now carries {unique_dial_targets} dial targets.",
            node.display_label
        ),
    })
}

pub fn testnet_get_node_logs(
    node_id: String,
    lines: Option<usize>,
) -> Result<TestnetNodeLogBundle, String> {
    let root = ensure_testnet_root()?;
    let registry = load_registry(&root)?;
    let node = registry
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .ok_or_else(|| format!("Node not found: {}", node_id))?;
    let max_lines = lines.unwrap_or(700).max(100);
    Ok(build_node_log_bundle(node, max_lines))
}

pub async fn testnet_setup_node(input: TestnetSetupInput) -> Result<TestnetSetupResult, String> {
    let root = ensure_testnet_root()?;
    let role = find_role_profile(&input.role_id)?;
    let device_profile = detect_device_profile();
    let mut network_profile = load_or_create_network_profile(&root)?;
    let mut registry = load_registry(&root)?;

    let role_slug = sanitize_slug(&role.id);
    let label = input
        .display_label
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .unwrap_or(role.display_name.as_str())
        .to_string();
    let node_id = format!("testnet-{}", Uuid::new_v4().simple());
    let default_directory = root.join("nodes").join(format!(
        "{}-{}",
        role_slug,
        &node_id[node_id.len().saturating_sub(10)..]
    ));
    let workspace_directory =
        resolve_node_directory(input.intended_directory.as_deref(), &default_directory)?;
    let config_directory = workspace_directory.join("config");
    let keys_directory = workspace_directory.join("keys");
    let logs_directory = workspace_directory.join("logs");
    let data_directory = workspace_directory.join("data");
    let manifests_directory = workspace_directory.join("manifests");

    let identity_passphrase = input
        .identity_passphrase
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if role.id == "validator" && identity_passphrase.map(str::len).unwrap_or(0) < 8 {
        return Err(
            "Validator setup requires an identity encryption passphrase with at least 8 characters."
                .to_string(),
        );
    }

    for directory in [
        &workspace_directory,
        &config_directory,
        &keys_directory,
        &logs_directory,
        &data_directory,
        &manifests_directory,
    ] {
        fs::create_dir_all(directory)
            .map_err(|error| format!("Failed to create {}: {error}", directory.display()))?;
    }

    let node_identity = generate_node_wallet(&role, &keys_directory, identity_passphrase)?;
    let effective_node_address = input
        .node_address_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| node_identity.wallet.address.clone());
    validate_node_address_for_role(&role, &effective_node_address)?;
    // Use the caller-supplied public host when provided. Do not silently fall
    // back to auto-detection when an explicit public endpoint is malformed.
    let public_host_override = input
        .public_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let detected_public_host =
        match public_host_override {
            Some(raw_host) => Some(normalize_public_host_candidate(raw_host).ok_or_else(|| {
                format!("Invalid public host for {}: {raw_host}", role.display_name)
            })?),
            None => detect_public_host().await,
        };
    let validator_mesh_only = validator_uses_private_mesh(&role.id, &effective_node_address);
    if role.id == "validator" && !validator_mesh_only {
        match detected_public_host.as_deref() {
            Some(host) if is_publicly_routable_host(host) => {}
            Some(host) => {
                return Err(format!(
                    "Non-genesis validators require a publicly routable IP address or DNS name. '{}' is not usable for public consensus discovery.",
                    host
                ));
            }
            None => {
                return Err(
                    "Non-genesis validators require a publicly routable IP address or DNS name before provisioning."
                        .to_string(),
                );
            }
        }
    }
    let funding_manifest = TestnetFundingManifest {
        id: format!("fund-{}", Uuid::new_v4().simple()),
        source_wallet: network_profile.treasury_wallet.address.clone(),
        destination_wallet: effective_node_address.clone(),
        destination_role: role.display_name.clone(),
        amount_snrg: format_amount(MINIMUM_STAKE_SNRG),
        amount_nwei: amount_to_nwei_string(MINIMUM_STAKE_SNRG),
        stake_vault_wallet: network_profile.stake_vault_wallet.address.clone(),
        status: "planned".to_string(),
        note: if validator_mesh_only {
            "Provisioning does not block on bootstrap reachability. Generated genesis validator workspaces are wired for the private WireGuard validator mesh immediately.".to_string()
        } else if role.id == "validator" {
            "Provisioning does not block on bootstrap reachability. Generated validator workspaces use public bootnodes, dnsaddr bootstrap records, and seed services so non-genesis validators can sync without automatically joining consensus.".to_string()
        } else if role_uses_sentry_upstreams(&role.id) {
            "Provisioning does not block on bootstrap reachability. Generated public-edge workspaces are pinned to the sentry upstreams instead of dialing validators directly.".to_string()
        } else {
            "Provisioning does not block on bootstrap reachability. Generated workspaces are still configured to use bootnodes, dnsaddr, and seed services immediately.".to_string()
        },
        created_at_utc: Utc::now().to_rfc3339(),
    };
    network_profile
        .funding_manifests
        .push(funding_manifest.clone());
    network_profile.updated_at_utc = Utc::now().to_rfc3339();

    let role_overlay = role_overlay_for(&role.id);
    let port_slot = next_available_port_slot(&registry.nodes);
    let public_validator_upstreams = if role.id == "validator" && !validator_mesh_only {
        canonical_public_validator_dial_targets()
    } else {
        Vec::new()
    };
    let peers_contents = if validator_mesh_only {
        build_peers_toml_with_additional(
            &network_profile,
            &canonical_validator_dial_targets(&effective_node_address),
        )
    } else if !public_validator_upstreams.is_empty() {
        build_peers_toml_with_public_validator_upstreams(
            &network_profile,
            &public_validator_upstreams,
        )
    } else if role_uses_sentry_upstreams(&role.id) {
        build_peers_toml_with_additional(
            &network_profile,
            &canonical_sentry_public_dial_targets_for_role(&role.id),
        )
    } else {
        build_peers_toml(&network_profile)
    };
    let aegis_contents = build_aegis_toml();
    let node_contents = build_node_toml(
        &node_id,
        &label,
        &role,
        &effective_node_address,
        &workspace_directory,
        detected_public_host.as_deref(),
        &network_profile,
        role_overlay.as_str(),
        port_slot,
        None,
    );
    let manifest_contents = build_bootstrap_manifest_contents(
        &node_id,
        &label,
        &role,
        &effective_node_address,
        detected_public_host.as_deref(),
        &funding_manifest,
        &device_profile,
        &network_profile.bootstrap_policy,
    )?;
    let readme_contents = build_node_readme(
        &label,
        &role,
        &effective_node_address,
        &workspace_directory,
        &network_profile,
        detected_public_host.as_deref(),
    );

    let node_toml_path = config_directory.join("node.toml");
    let peers_toml_path = config_directory.join("peers.toml");
    let aegis_toml_path = config_directory.join("aegis.toml");
    let manifest_path = manifests_directory.join("bootstrap.json");
    let readme_path = workspace_directory.join("README.md");

    write_file(&node_toml_path, &node_contents)?;
    write_file(&peers_toml_path, &peers_contents)?;
    write_file(&aegis_toml_path, &aegis_contents)?;
    write_file(&manifest_path, &manifest_contents)?;
    write_file(&readme_path, &readme_contents)?;
    if !input.skip_canonical_manifests {
        write_canonical_workspace_manifests(&workspace_directory)?;
    }

    // Generate an nginx reverse-proxy config for roles that expose a public RPC surface.
    if matches!(role.id.as_str(), "rpc_gateway" | "indexer") {
        let p2p_port_val = TESTNET_P2P_PORT.saturating_add(port_slot);
        let rpc_port_val = TESTNET_RPC_PORT.saturating_add(port_slot);
        let ws_port_val = TESTNET_WS_PORT.saturating_add(port_slot);
        let public_host_val = detected_public_host.as_deref().unwrap_or("YOUR_SERVER_IP");
        let nginx_contents = if role.id == "rpc_gateway" {
            let rpc_subdomain = "testnet-core-rpc.synergy-network.io";
            let ws_subdomain = "testnet-core-ws.synergy-network.io";
            let certbot_domains = format!("-d {rpc_subdomain} -d {ws_subdomain}");
            format!(
                "# Nginx reverse proxy for {role_display} ({node_id})\n\
                 # Generated by Synergy Node Control Panel during provisioning.\n\
                 #\n\
                 # DEPLOY STEPS (run on the server as root / sudo):\n\
                 #   1. sudo mkdir -p /var/www/letsencrypt\n\
                 #   2. sudo cp this-file /etc/nginx/sites-available/{rpc_subdomain}.conf\n\
                 #      sudo ln -sf /etc/nginx/sites-available/{rpc_subdomain}.conf /etc/nginx/sites-enabled/\n\
                 #   3. Deploy HTTP-only first so certbot can complete the ACME challenge:\n\
                 #      sudo nginx -t && sudo systemctl reload nginx\n\
                 #   4. Obtain SSL certificate (certbot will update this file automatically):\n\
                 #      sudo certbot --nginx {certbot_domains}\n\
                 #   5. sudo nginx -t && sudo systemctl reload nginx\n\
                 #\n\
                 # NOTE: certbot names the cert after the first domain.  Cert paths after\n\
                 # certbot runs will be /etc/letsencrypt/live/{rpc_subdomain}/...\n\
                 # Server public IP: {public_host} | P2P port {p2p_port} must be open in firewall.\n\n\
                 upstream {node_id}_rpc {{\n\
                 \tserver 127.0.0.1:{rpc_port};\n\
                 }}\n\
                 upstream {node_id}_ws {{\n\
                 \tserver 127.0.0.1:{ws_port};\n\
                 }}\n\n\
                 server {{\n\
                 \tlisten 80;\n\
                 \tserver_name {rpc_subdomain} {ws_subdomain};\n\
                 \tlocation ^~ /.well-known/acme-challenge/ {{\n\
                 \t\troot /var/www/letsencrypt;\n\
                 \t\tdefault_type \"text/plain\";\n\
                 \t\ttry_files $uri =404;\n\
                 \t}}\n\
                 \treturn 301 https://$host$request_uri;\n\
                 }}\n\n\
                 server {{\n\
                 \tlisten 443 ssl http2;\n\
                 \tserver_name {rpc_subdomain};\n\
                 \tssl_certificate /etc/letsencrypt/live/{rpc_subdomain}/fullchain.pem;\n\
                 \tssl_certificate_key /etc/letsencrypt/live/{rpc_subdomain}/privkey.pem;\n\
                 \tinclude /etc/letsencrypt/options-ssl-nginx.conf;\n\
                 \tssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n\
                 \tlocation = /healthz {{ return 200 \"ok\\n\"; }}\n\
                 \tlocation / {{\n\
                 \t\tproxy_pass http://{node_id}_rpc;\n\
                 \t\tproxy_http_version 1.1;\n\
                 \t\tproxy_set_header Host $host;\n\
                 \t\tproxy_set_header X-Real-IP $remote_addr;\n\
                 \t\tproxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
                 \t\tproxy_set_header X-Forwarded-Proto $scheme;\n\
                 \t\tproxy_read_timeout 60s;\n\
                 \t\tadd_header Access-Control-Allow-Origin *;\n\
                 \t\tadd_header Access-Control-Allow-Methods \"GET, POST, OPTIONS\";\n\
                 \t\tadd_header Access-Control-Allow-Headers \"Content-Type\";\n\
                 \t}}\n\
                 }}\n\n\
                 server {{\n\
                 \tlisten 443 ssl http2;\n\
                 \tserver_name {ws_subdomain};\n\
                 \tssl_certificate /etc/letsencrypt/live/{rpc_subdomain}/fullchain.pem;\n\
                 \tssl_certificate_key /etc/letsencrypt/live/{rpc_subdomain}/privkey.pem;\n\
                 \tinclude /etc/letsencrypt/options-ssl-nginx.conf;\n\
                 \tssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n\
                 \tlocation / {{\n\
                 \t\tproxy_pass http://{node_id}_ws;\n\
                 \t\tproxy_http_version 1.1;\n\
                 \t\tproxy_set_header Upgrade $http_upgrade;\n\
                 \t\tproxy_set_header Connection \"upgrade\";\n\
                 \t\tproxy_set_header Host $host;\n\
                 \t\tproxy_read_timeout 3600s;\n\
                 \t}}\n\
                 }}\n",
                role_display = role.display_name,
                node_id = node_id,
                rpc_subdomain = rpc_subdomain,
                ws_subdomain = ws_subdomain,
                rpc_port = rpc_port_val,
                ws_port = ws_port_val,
                p2p_port = p2p_port_val,
                public_host = public_host_val,
            )
        } else {
            let explorer_host = "testnet-explorer.synergy-network.io";
            let atlas_api_host = "testnet-atlas-api.synergy-network.io";
            let indexer_ws_host = "testnet-indexer.synergy-network.io";
            let explorer_static_root = "/var/www/explorer/dist";
            let atlas_api_port = 3020_u16;
            let certbot_domains =
                format!("-d {explorer_host} -d {atlas_api_host} -d {indexer_ws_host}");
            format!(
                "# Nginx reverse proxy for {role_display} ({node_id})\n\
                 # Generated by Synergy Node Control Panel during provisioning.\n\
                 #\n\
                 # DEPLOY STEPS (run on the server as root / sudo):\n\
                 #   1. sudo mkdir -p /var/www/letsencrypt\n\
                 #   2. sudo cp this-file /etc/nginx/sites-available/{explorer_host}.conf\n\
                 #      sudo ln -sf /etc/nginx/sites-available/{explorer_host}.conf /etc/nginx/sites-enabled/\n\
                 #   3. Deploy HTTP-only first so certbot can complete the ACME challenge:\n\
                 #      sudo nginx -t && sudo systemctl reload nginx\n\
                 #   4. Obtain SSL certificate (certbot will update this file automatically):\n\
                 #      sudo certbot --nginx {certbot_domains}\n\
                 #   5. sudo nginx -t && sudo systemctl reload nginx\n\
                 #\n\
                 # NOTE: certbot names the cert after the first domain.  Cert paths after\n\
                 # certbot runs will be /etc/letsencrypt/live/{explorer_host}/...\n\
                 # Explorer UI root on the server: {explorer_static_root}\n\
                 # Server public IP: {public_host} | P2P port {p2p_port} must be open in firewall.\n\n\
                 upstream {node_id}_atlas_api {{\n\
                 \tserver 127.0.0.1:{atlas_api_port};\n\
                 }}\n\
                 upstream {node_id}_indexer_ws {{\n\
                 \tserver 127.0.0.1:{ws_port};\n\
                 }}\n\n\
                 server {{\n\
                 \tlisten 80;\n\
                 \tserver_name {explorer_host} {atlas_api_host} {indexer_ws_host};\n\
                 \tlocation ^~ /.well-known/acme-challenge/ {{\n\
                 \t\troot /var/www/letsencrypt;\n\
                 \t\tdefault_type \"text/plain\";\n\
                 \t\ttry_files $uri =404;\n\
                 \t}}\n\
                 \treturn 301 https://$host$request_uri;\n\
                 }}\n\n\
                 server {{\n\
                 \tlisten 443 ssl http2;\n\
                 \tserver_name {explorer_host};\n\
                 \tssl_certificate /etc/letsencrypt/live/{explorer_host}/fullchain.pem;\n\
                 \tssl_certificate_key /etc/letsencrypt/live/{explorer_host}/privkey.pem;\n\
                 \tinclude /etc/letsencrypt/options-ssl-nginx.conf;\n\
                 \tssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n\
                 \troot {explorer_static_root};\n\
                 \tindex index.html;\n\
                 \tlocation /api/ {{\n\
                 \t\tproxy_pass http://{node_id}_atlas_api;\n\
                 \t\tproxy_http_version 1.1;\n\
                 \t\tproxy_set_header Host $host;\n\
                 \t\tproxy_set_header X-Real-IP $remote_addr;\n\
                 \t\tproxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
                 \t\tproxy_set_header X-Forwarded-Proto $scheme;\n\
                 \t\tproxy_read_timeout 60s;\n\
                 \t}}\n\
                 \tlocation = /healthz {{\n\
                 \t\tproxy_pass http://{node_id}_atlas_api/healthz;\n\
                 \t}}\n\
                 \tlocation = /readyz {{\n\
                 \t\tproxy_pass http://{node_id}_atlas_api/readyz;\n\
                 \t}}\n\
                 \tlocation / {{\n\
                 \t\ttry_files $uri $uri/ /index.html;\n\
                 \t}}\n\
                 }}\n\n\
                 server {{\n\
                 \tlisten 443 ssl http2;\n\
                 \tserver_name {atlas_api_host};\n\
                 \tssl_certificate /etc/letsencrypt/live/{explorer_host}/fullchain.pem;\n\
                 \tssl_certificate_key /etc/letsencrypt/live/{explorer_host}/privkey.pem;\n\
                 \tinclude /etc/letsencrypt/options-ssl-nginx.conf;\n\
                 \tssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n\
                 \tlocation / {{\n\
                 \t\tproxy_pass http://{node_id}_atlas_api;\n\
                 \t\tproxy_http_version 1.1;\n\
                 \t\tproxy_set_header Host $host;\n\
                 \t\tproxy_set_header X-Real-IP $remote_addr;\n\
                 \t\tproxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
                 \t\tproxy_set_header X-Forwarded-Proto $scheme;\n\
                 \t\tproxy_read_timeout 60s;\n\
                 \t}}\n\
                 }}\n\n\
                 server {{\n\
                 \tlisten 443 ssl http2;\n\
                 \tserver_name {indexer_ws_host};\n\
                 \tssl_certificate /etc/letsencrypt/live/{explorer_host}/fullchain.pem;\n\
                 \tssl_certificate_key /etc/letsencrypt/live/{explorer_host}/privkey.pem;\n\
                 \tinclude /etc/letsencrypt/options-ssl-nginx.conf;\n\
                 \tssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n\
                 \tlocation / {{\n\
                 \t\tproxy_pass http://{node_id}_indexer_ws;\n\
                 \t\tproxy_http_version 1.1;\n\
                 \t\tproxy_set_header Upgrade $http_upgrade;\n\
                 \t\tproxy_set_header Connection \"upgrade\";\n\
                 \t\tproxy_set_header Host $host;\n\
                 \t\tproxy_read_timeout 3600s;\n\
                 \t}}\n\
                 }}\n",
                role_display = role.display_name,
                node_id = node_id,
                explorer_host = explorer_host,
                atlas_api_host = atlas_api_host,
                indexer_ws_host = indexer_ws_host,
                atlas_api_port = atlas_api_port,
                ws_port = ws_port_val,
                p2p_port = p2p_port_val,
                public_host = public_host_val,
                explorer_static_root = explorer_static_root,
            )
        };
        let nginx_path = workspace_directory.join("nginx.conf");
        let _ = write_file(&nginx_path, &nginx_contents);
    }

    let node_record = TestnetProvisionedNode {
        id: node_id.clone(),
        role_id: role.id.clone(),
        role_display_name: role.display_name.clone(),
        class_name: role.class_name.clone(),
        display_label: label.clone(),
        node_address: effective_node_address,
        public_key_path: node_identity.wallet.public_key_path.clone(),
        private_key_path: node_identity.wallet.private_key_path.clone(),
        workspace_directory: workspace_directory.to_string_lossy().to_string(),
        config_paths: {
            let mut paths = vec![
                node_toml_path.to_string_lossy().to_string(),
                peers_toml_path.to_string_lossy().to_string(),
                aegis_toml_path.to_string_lossy().to_string(),
                manifest_path.to_string_lossy().to_string(),
            ];
            if matches!(role.id.as_str(), "rpc_gateway" | "indexer") {
                paths.push(
                    workspace_directory
                        .join("nginx.conf")
                        .to_string_lossy()
                        .to_string(),
                );
            }
            paths
        },
        public_host: detected_public_host.clone(),
        reward_payout_address: None,
        connectivity_status: if validator_mesh_only {
            "Private validator mesh configured. Node will dial the canonical WireGuard validator peers on startup.".to_string()
        } else if role.id == "validator" {
            "Bootstrap configured. Node will sync through public relayers, bootnodes, dnsaddr bootstrap records, and seed services while validator signing remains disabled until explicit activation.".to_string()
        } else {
            "Bootstrap configured. Node will use hardcoded bootnodes, dnsaddr bootstrap records, and seed services on startup.".to_string()
        },
        role_certificate_status: "Pending Aegis role certificate binding.".to_string(),
        funding_manifest_id: funding_manifest.id.clone(),
        created_at_utc: Utc::now().to_rfc3339(),
        port_slot: Some(port_slot),
    };

    registry.nodes.push(node_record.clone());
    registry
        .nodes
        .sort_by(|left, right| left.created_at_utc.cmp(&right.created_at_utc));
    save_registry(&root, &registry)?;
    save_network_profile(&root, &network_profile)?;

    // Refresh the canonical launch manifests everywhere so each managed workspace
    // carries the same Testnet genesis and operational manifest data.
    for n in &registry.nodes {
        if input.skip_canonical_manifests && n.id == node_record.id {
            continue;
        }
        let ws = PathBuf::from(&n.workspace_directory);
        if ws.is_dir() {
            if let Err(e) = write_canonical_workspace_manifests(&ws) {
                eprintln!(
                    "Warning: could not refresh launch manifests for {}: {e}",
                    n.display_label
                );
            }
        }
    }

    #[cfg(not(test))]
    register_node_with_seeds_best_effort(&network_profile, &node_record).await;

    Ok(TestnetSetupResult {
        node: node_record,
        network_profile,
        device_profile,
        next_steps: {
            let mut steps = vec![
                "Review the generated node.toml, peers.toml, and aegis.toml overlays in the isolated workspace.".to_string(),
                "Fund the validator wallet with 50,000 SNRG, then use the in-app Stake and Activate Validator actions after the node is synced.".to_string(),
                format!(
                    "Public host detection: {}.",
                    detected_public_host
                        .as_deref()
                        .unwrap_or("not detected automatically")
                ),
                if validator_mesh_only {
                    "Start the node with the generated workspace; it will dial the private WireGuard validator mesh immediately.".to_string()
                } else if role.id == "validator" {
                    "Start the node with the generated workspace; it will sync from public bootstrap first, with validator auto-registration disabled until an explicit activation workflow is run.".to_string()
                } else {
                    "Start the node with the generated workspace; multi-source peer discovery is configured from bootnodes, dnsaddr, and seed services.".to_string()
                },
            ];
            if matches!(role.id.as_str(), "rpc_gateway" | "indexer") {
                steps.push(
                    "RPC Gateway: deploy the generated nginx.conf to /etc/nginx/sites-available/, \
                     obtain an SSL cert with certbot --nginx --expand, then reload nginx. \
                     The node binds RPC to 0.0.0.0 with CORS enabled — no manual node.toml edits required.".to_string()
                );
            }
            steps
        },
    })
}

fn build_state() -> Result<TestnetState, String> {
    let root = ensure_testnet_root()?;
    let network_profile = load_or_create_network_profile(&root)?;
    let registry = load_registry(&root)?;
    let node_catalog = node_catalog();
    let device_profile = detect_device_profile();
    let total_nodes = registry.nodes.len();
    let total_sponsored_stake_nwei = network_profile
        .funding_manifests
        .iter()
        .filter_map(|manifest| manifest.amount_nwei.parse::<u64>().ok())
        .fold(0_u64, |sum, amount| sum.saturating_add(amount));
    let total_sponsored_stake = if total_sponsored_stake_nwei > 0 {
        total_sponsored_stake_nwei / TOKEN_SCALE
    } else {
        total_nodes as u64 * MINIMUM_STAKE_SNRG
    };

    Ok(TestnetState {
        environment_id: TESTNET_ENVIRONMENT_ID.to_string(),
        display_name: TESTNET_DISPLAY_NAME.to_string(),
        device_profile,
        network_profile: network_profile.clone(),
        node_catalog: node_catalog.clone(),
        nodes: registry.nodes,
        summary: TestnetDashboardSummary {
            total_nodes,
            active_role_profiles: node_catalog.len(),
            total_sponsored_stake_snrg: format_amount(total_sponsored_stake),
            total_sponsored_stake_nwei: if total_sponsored_stake_nwei > 0 {
                total_sponsored_stake_nwei.to_string()
            } else {
                amount_to_nwei_string(total_sponsored_stake)
            },
            connectivity_policy: network_profile.bootstrap_policy.note,
        },
    })
}

fn discovery_summary(
    healthy_bootnodes: usize,
    total_bootnodes: usize,
    _healthy_seed_servers: usize,
    _total_seed_servers: usize,
) -> (String, String) {
    if total_bootnodes > 0 && healthy_bootnodes == total_bootnodes {
        return (
            "Online".to_string(),
            format!("{healthy_bootnodes}/{total_bootnodes} bootnodes are responding."),
        );
    }

    if healthy_bootnodes > 0 {
        return (
            "Degraded".to_string(),
            format!("Only {healthy_bootnodes}/{total_bootnodes} bootnodes are reachable."),
        );
    }

    (
        "Offline".to_string(),
        "No bootnodes responded to the control panel health check.".to_string(),
    )
}

fn chain_summary(
    public_rpc_online: bool,
    public_chain_height: Option<u64>,
    public_peer_count: Option<usize>,
    healthy_bootnodes: usize,
    _healthy_seed_servers: usize,
) -> (String, String) {
    if public_rpc_online {
        let height = public_chain_height
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let peers = public_peer_count
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        return (
            "Live".to_string(),
            format!("Public RPC is responding at block {height} with {peers} peers visible."),
        );
    }

    if healthy_bootnodes > 0 {
        return (
            "Bootstrap Only".to_string(),
            "Bootstrap endpoints are reachable, but the public RPC is not answering yet."
                .to_string(),
        );
    }

    (
        "Offline".to_string(),
        "Neither the public RPC nor the bootstrap endpoints are responding yet.".to_string(),
    )
}

async fn check_bootstrap_endpoint(endpoint: TestnetBootstrapEndpoint) -> TestnetEndpointLiveStatus {
    let started = Instant::now();
    let mut attempts = Vec::new();

    for host in endpoint_host_candidates(&endpoint, false) {
        match timeout(
            Duration::from_secs(3),
            TcpStream::connect((host.as_str(), endpoint.port)),
        )
        .await
        {
            Ok(Ok(_stream)) => {
                return TestnetEndpointLiveStatus {
                    kind: endpoint.kind,
                    host: endpoint.host,
                    ip_address: endpoint.ip_address,
                    port: endpoint.port,
                    status: "online".to_string(),
                    detail: format!("TCP handshake completed via {host}."),
                    reachable: true,
                    latency_ms: Some(started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
                };
            }
            Ok(Err(error)) => {
                attempts.push(format!("{host}: TCP connection failed: {error}"));
            }
            Err(_) => {
                attempts.push(format!("{host}: timed out during TCP connection"));
            }
        }
    }

    TestnetEndpointLiveStatus {
        kind: endpoint.kind,
        host: endpoint.host,
        ip_address: endpoint.ip_address,
        port: endpoint.port,
        status: "offline".to_string(),
        detail: if attempts.is_empty() {
            "No usable bootstrap endpoints were available.".to_string()
        } else {
            attempts.join(" | ")
        },
        reachable: false,
        latency_ms: None,
    }
}

async fn check_seed_endpoint(
    client: &Client,
    endpoint: TestnetBootstrapEndpoint,
) -> TestnetEndpointLiveStatus {
    let started = Instant::now();
    let mut attempts = Vec::new();

    for url in seed_service_urls(&endpoint, "/healthz") {
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                return TestnetEndpointLiveStatus {
                    kind: endpoint.kind,
                    host: endpoint.host,
                    ip_address: endpoint.ip_address,
                    port: endpoint.port,
                    status: "online".to_string(),
                    detail: format!("Seed health endpoint responded via {url}."),
                    reachable: true,
                    latency_ms: Some(started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
                };
            }
            Ok(response) => {
                attempts.push(format!("{url}: HTTP {}", response.status()));
            }
            Err(error) => {
                attempts.push(format!("{url}: {error}"));
            }
        }
    }

    TestnetEndpointLiveStatus {
        kind: endpoint.kind,
        host: endpoint.host,
        ip_address: endpoint.ip_address,
        port: endpoint.port,
        status: "offline".to_string(),
        detail: if attempts.is_empty() {
            "No usable seed endpoints were available.".to_string()
        } else {
            attempts.join(" | ")
        },
        reachable: false,
        latency_ms: None,
    }
}

async fn build_node_live_status(
    client: &Client,
    node: &TestnetProvisionedNode,
    public_chain_height: Option<u64>,
) -> TestnetNodeLiveStatus {
    let workspace_directory = PathBuf::from(&node.workspace_directory);
    let config_path = workspace_directory.join("config").join("node.toml");
    let runtime_report_path = workspace_directory.join("data").join("role-runtime.json");
    let rpc_endpoint = parse_testnet_rpc_endpoint(&config_path)
        .unwrap_or_else(|| format!("http://127.0.0.1:{TESTNET_RPC_PORT}"));
    let process_info = running_process_for_workspace(&workspace_directory);
    let pid = process_info.as_ref().map(|info| info.pid);
    let process_uptime_secs = process_info.as_ref().map(|info| info.uptime_secs);
    let is_running = process_info.is_some();
    let (log_local_chain_height, best_observed_peer_height) =
        recent_chain_hints_from_log(&workspace_directory);
    let (fresh_local_chain_height, local_chain_error) = if is_running {
        match query_local_chain_height(client, &rpc_endpoint).await {
            Ok(height) => (Some(height), None),
            Err(error) => (None, Some(error)),
        }
    } else {
        (None, None)
    };
    let local_validator_address =
        role_supports_validator_registration(&node.role_id).then_some(node.node_address.as_str());
    let (fresh_peer_summary, local_peer_error) = if is_running {
        match query_rpc_value(client, &rpc_endpoint, "synergy_getPeerInfo", json!([])).await {
            Ok(value) => match parse_rpc_peer_summary(&value, local_validator_address) {
                Ok(summary) => (Some(summary), None),
                Err(error) => (None, Some(error)),
            },
            Err(error) => (None, Some(error)),
        }
    } else {
        (None, None)
    };
    let fresh_local_peer_count = fresh_peer_summary
        .as_ref()
        .map(|summary| summary.peer_count);
    let connected_validator_count = fresh_peer_summary
        .as_ref()
        .map(|summary| summary.connected_validator_count);
    let status_ready_validator_count = fresh_peer_summary
        .as_ref()
        .map(|summary| summary.status_ready_validator_count);
    let cached_snapshot = {
        let cache = NODE_LIVE_CACHE.lock().unwrap();
        cache.get(&node.id).cloned()
    };
    let local_chain_height = fresh_local_chain_height
        .or_else(|| {
            cached_snapshot
                .as_ref()
                .and_then(|entry| entry.local_chain_height)
        })
        .or(log_local_chain_height);
    let local_peer_count = fresh_local_peer_count.or_else(|| {
        cached_snapshot
            .as_ref()
            .and_then(|entry| entry.local_peer_count)
    });
    let using_cached_snapshot = is_running
        && ((fresh_local_chain_height.is_none() && local_chain_height.is_some())
            || (fresh_local_peer_count.is_none() && local_peer_count.is_some()));
    let using_log_height =
        is_running && fresh_local_chain_height.is_none() && log_local_chain_height.is_some();
    let local_rpc_ready =
        is_running && (fresh_local_chain_height.is_some() || fresh_local_peer_count.is_some());
    let local_rpc_status = if !is_running {
        let mut cache = NODE_LIVE_CACHE.lock().unwrap();
        cache.remove(&node.id);
        "Local runtime is offline.".to_string()
    } else if local_rpc_ready {
        let mut cache = NODE_LIVE_CACHE.lock().unwrap();
        let previous = cache.get(&node.id).cloned();
        cache.insert(
            node.id.clone(),
            CachedNodeLiveSnapshot {
                local_chain_height,
                local_peer_count,
                previous_chain_height: previous.as_ref().and_then(|s| s.local_chain_height),
                height_sampled_at: Some(Instant::now()),
                previous_sampled_at: previous.as_ref().and_then(|s| s.height_sampled_at),
            },
        );
        format!("Local RPC responding on {rpc_endpoint}.")
    } else {
        let mut details = Vec::new();
        if let Some(error) = local_chain_error.as_ref() {
            details.push(error.clone());
        }
        if let Some(error) = local_peer_error.as_ref() {
            details.push(format!("synergy_getPeerInfo: {error}"));
        }
        if using_cached_snapshot {
            details.push("showing last successful local snapshot".to_string());
        }
        if using_log_height {
            details.push("showing last committed height from node log".to_string());
        }
        if details.is_empty() {
            format!("Local RPC is not responding on {rpc_endpoint}.")
        } else {
            format!(
                "Local RPC is not responding on {rpc_endpoint}. {}",
                details.join(" | ")
            )
        }
    };
    let best_network_height = match (public_chain_height, best_observed_peer_height) {
        (Some(public_height), Some(peer_height)) => Some(public_height.max(peer_height)),
        (Some(public_height), None) => Some(public_height),
        (None, Some(peer_height)) => Some(peer_height),
        (None, None) => None,
    };
    let sync_gap = match (best_network_height, local_chain_height) {
        (Some(network_height), Some(local_height)) => {
            Some(network_height.saturating_sub(local_height))
        }
        _ => None,
    };

    let (synergy_score, synergy_score_status) = resolve_synergy_score_status(
        client,
        &node.role_id,
        &rpc_endpoint,
        &node.node_address,
        is_running,
        local_rpc_ready,
    )
    .await;

    // Compute sync trending from cached snapshots.
    let (sync_trending, blocks_per_second, estimated_sync_eta_secs) = {
        let cache = NODE_LIVE_CACHE.lock().unwrap();
        if let Some(snapshot) = cache.get(&node.id) {
            compute_sync_trending(snapshot, sync_gap)
        } else {
            ("unknown".to_string(), None, None)
        }
    };

    let wallet_ready = workspace_directory
        .join("keys")
        .join("identity.json")
        .is_file();

    TestnetNodeLiveStatus {
        node_id: node.id.clone(),
        rpc_endpoint,
        workspace_ready: workspace_directory.is_dir(),
        config_ready: config_path.is_file(),
        runtime_report_present: runtime_report_path.is_file(),
        is_running,
        local_rpc_ready,
        local_rpc_status,
        pid,
        process_uptime_secs,
        local_chain_height,
        local_peer_count,
        connected_validator_count,
        status_ready_validator_count,
        sync_gap,
        log_local_chain_height,
        best_observed_peer_height,
        best_network_height,
        synergy_score,
        synergy_score_status,
        wallet_ready,
        seed_registered: false,
        seed_registration_count: 0,
        sync_trending,
        blocks_per_second,
        estimated_sync_eta_secs,
        readiness: None,
    }
}

fn compute_sync_trending(
    snapshot: &CachedNodeLiveSnapshot,
    sync_gap: Option<u64>,
) -> (String, Option<f64>, Option<u64>) {
    if let Some(gap) = sync_gap {
        if gap <= 5 {
            return ("synced".to_string(), None, None);
        }
    }
    let (current, prev, now_ts, prev_ts) = match (
        snapshot.local_chain_height,
        snapshot.previous_chain_height,
        snapshot.height_sampled_at,
        snapshot.previous_sampled_at,
    ) {
        (Some(c), Some(p), Some(n), Some(pt)) => (c, p, n, pt),
        _ => return ("unknown".to_string(), None, None),
    };
    let elapsed = now_ts.duration_since(prev_ts).as_secs_f64();
    if elapsed < 0.5 {
        return ("unknown".to_string(), None, None);
    }
    let gained = current.saturating_sub(prev) as f64;
    let bps = gained / elapsed;
    if bps < 0.01 {
        return ("stalled".to_string(), Some(0.0), None);
    }
    let eta = sync_gap.map(|gap| (gap as f64 / bps).ceil() as u64);
    ("improving".to_string(), Some(bps), eta)
}

struct RunningProcessInfo {
    pid: u32,
    uptime_secs: u64,
}

fn pid_file_candidates(workspace_directory: &Path) -> [PathBuf; 2] {
    [
        workspace_directory.join("data").join("synergy-testnet.pid"),
        workspace_directory.join("data").join("node.pid"),
    ]
}

fn process_matches_workspace(process: &sysinfo::Process, workspace_directory: &Path) -> bool {
    let workspace = workspace_directory.to_string_lossy();
    let config_path = workspace_directory.join("config").join("node.toml");
    let config_path = config_path.to_string_lossy();
    let binary_directory = workspace_directory.join("bin");
    let command_line = process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");

    if command_line.contains(workspace.as_ref()) || command_line.contains(config_path.as_ref()) {
        return true;
    }

    if process
        .exe()
        .is_some_and(|exe| exe.starts_with(&binary_directory))
    {
        return true;
    }

    // Validators are often started from the workspace with a relative binary
    // path and `--config config/node.toml`, so the full workspace path never
    // appears in the command line.
    process.cwd().is_some_and(|cwd| cwd == workspace_directory)
        && command_line.contains("config/node.toml")
        && command_line.contains("synergy-testnet")
}

fn persist_workspace_pid(workspace_directory: &Path, pid: u32) {
    let pid_path = workspace_directory.join("data").join("synergy-testnet.pid");
    if let Some(parent) = pid_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(pid_path, format!("{pid}\n"));
}

fn running_processes_for_workspace(workspace_directory: &Path) -> Vec<RunningProcessInfo> {
    let mut system = System::new_all();
    system.refresh_all();

    for pid_path in pid_file_candidates(workspace_directory) {
        let Some(pid_text) = fs::read_to_string(&pid_path).ok() else {
            continue;
        };
        let Some(pid) = pid_text.trim().parse::<u32>().ok() else {
            continue;
        };
        let Some(process) = system.process(Pid::from_u32(pid)) else {
            continue;
        };
        if process_matches_workspace(process, workspace_directory) {
            persist_workspace_pid(workspace_directory, pid);
            return vec![RunningProcessInfo {
                pid,
                uptime_secs: process.run_time(),
            }];
        }
    }

    let mut matches = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            if process_matches_workspace(process, workspace_directory) {
                Some(RunningProcessInfo {
                    pid: pid.as_u32(),
                    uptime_secs: process.run_time(),
                })
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|info| std::cmp::Reverse(info.uptime_secs));
    if let Some(primary) = matches.first() {
        persist_workspace_pid(workspace_directory, primary.pid);
    }
    matches
}

fn running_process_for_workspace(workspace_directory: &Path) -> Option<RunningProcessInfo> {
    running_processes_for_workspace(workspace_directory)
        .into_iter()
        .next()
}

fn force_kill_workspace_processes(workspace_directory: &Path) -> Result<usize, String> {
    let processes = running_processes_for_workspace(workspace_directory);
    if processes.is_empty() {
        return Ok(0);
    }

    #[cfg(not(target_os = "windows"))]
    {
        for info in &processes {
            let _ = ProcessCommand::new("kill")
                .args(["-TERM", &info.pid.to_string()])
                .status();
        }
        std::thread::sleep(Duration::from_millis(500));

        let remaining = running_processes_for_workspace(workspace_directory);
        for info in &remaining {
            let _ = ProcessCommand::new("kill")
                .args(["-KILL", &info.pid.to_string()])
                .status();
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    #[cfg(target_os = "windows")]
    {
        for info in &processes {
            let _ = ProcessCommand::new("taskkill")
                .args(["/PID", &info.pid.to_string(), "/F", "/T"])
                .status();
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    for pid_path in pid_file_candidates(workspace_directory) {
        let _ = fs::remove_file(pid_path);
    }

    Ok(processes.len())
}

fn running_pid_for_workspace(workspace_directory: &Path) -> Option<u32> {
    running_process_for_workspace(workspace_directory).map(|info| info.pid)
}

fn repair_workspace_config_if_needed(role_id: &str, config_path: &Path) -> Result<(), String> {
    if !role_supports_validator_registration(role_id) {
        return Ok(());
    }

    let workspace_directory = match config_path.parent().and_then(Path::parent) {
        Some(path) => path,
        None => return Ok(()),
    };
    repair_workspace_consensus_timing_if_needed(config_path)?;
    let ceremony_package_path = workspace_directory
        .join("manifests")
        .join("ceremony-package.json");

    if ceremony_package_path.is_file() {
        if let Ok(package) = load_ceremony_package(&ceremony_package_path) {
            repair_imported_validator_ports_if_needed(workspace_directory, config_path, &package)?;
        }
        return Ok(());
    }

    if config_path
        .parent()
        .and_then(Path::parent)
        .map(|workspace| {
            workspace
                .join("manifests")
                .join("ceremony-package.json")
                .is_file()
        })
        .unwrap_or(false)
    {
        return Ok(());
    }

    Ok(())
}

fn repair_workspace_consensus_timing_if_needed(config_path: &Path) -> Result<(), String> {
    let mut value = read_toml_value(config_path)?;
    let root = value
        .as_table_mut()
        .ok_or_else(|| format!("{} must parse into a TOML table.", config_path.display()))?;
    let mut changed = false;

    let blockchain = root
        .entry("blockchain")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or_else(|| "[blockchain] must be a TOML table.".to_string())?;
    changed |= set_toml_int_if_changed(blockchain, "block_time", TESTNET_BLOCK_TIME_SECS as i64);

    let consensus = root
        .entry("consensus")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or_else(|| "[consensus] must be a TOML table.".to_string())?;
    for (key, expected) in [
        ("block_time_secs", TESTNET_BLOCK_TIME_SECS as i64),
        ("min_validators", TESTNET_MIN_GENESIS_VALIDATORS as i64),
        (
            "validator_cluster_size",
            TESTNET_VALIDATOR_CLUSTER_SIZE as i64,
        ),
        (
            "validator_vote_threshold",
            TESTNET_VALIDATOR_VOTE_THRESHOLD as i64,
        ),
        ("max_validators", TESTNET_MAX_VALIDATORS as i64),
        ("mesh_settle_secs", TESTNET_MESH_SETTLE_SECS as i64),
        ("leader_timeout_secs", TESTNET_LEADER_TIMEOUT_SECS as i64),
        ("vote_timeout_secs", TESTNET_VOTE_TIMEOUT_SECS as i64),
        ("block_timeout_secs", TESTNET_BLOCK_TIMEOUT_SECS as i64),
    ] {
        changed |= set_toml_int_if_changed(consensus, key, expected);
    }
    changed |= set_toml_bool_if_changed(
        consensus,
        "status_ready_gate_enabled",
        TESTNET_STATUS_READY_GATE_ENABLED,
    );
    changed |= set_toml_int_if_changed(
        consensus,
        "status_ready_min_validators",
        TESTNET_STATUS_READY_MIN_VALIDATORS as i64,
    );
    changed |= set_toml_int_if_changed(
        consensus,
        "status_ready_genesis_grace_secs",
        TESTNET_STATUS_READY_GENESIS_GRACE_SECS as i64,
    );
    changed |= set_toml_bool_if_changed(
        consensus,
        "allow_genesis_status_bypass",
        TESTNET_ALLOW_GENESIS_STATUS_BYPASS,
    );
    changed |= set_toml_bool_if_changed(
        consensus,
        "penalization_enabled",
        TESTNET_CONSENSUS_PENALIZATION_ENABLED,
    );

    if changed {
        let rendered = toml::to_string_pretty(&value)
            .map_err(|error| format!("Failed to serialize {}: {error}", config_path.display()))?;
        write_file(config_path, &rendered)?;
    }

    Ok(())
}

fn set_toml_int_if_changed(
    table: &mut toml::map::Map<String, toml::Value>,
    key: &str,
    expected: i64,
) -> bool {
    if table.get(key).and_then(toml::Value::as_integer) == Some(expected) {
        return false;
    }
    table.insert(key.to_string(), toml::Value::Integer(expected));
    true
}

fn set_toml_bool_if_changed(
    table: &mut toml::map::Map<String, toml::Value>,
    key: &str,
    expected: bool,
) -> bool {
    if table.get(key).and_then(toml::Value::as_bool) == Some(expected) {
        return false;
    }
    table.insert(key.to_string(), toml::Value::Boolean(expected));
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TestnetRuntimePorts {
    p2p_port: u16,
    public_p2p_port: u16,
    rpc_port: u16,
    ws_port: u16,
    discovery_port: u16,
    public_discovery_port: u16,
    metrics_port: u16,
}

fn runtime_ports_for_slot(slot: u16) -> TestnetRuntimePorts {
    let p2p_port = TESTNET_P2P_PORT.saturating_add(slot);
    let discovery_port = TESTNET_DISCOVERY_PORT.saturating_add(slot);
    TestnetRuntimePorts {
        p2p_port,
        public_p2p_port: p2p_port,
        rpc_port: TESTNET_RPC_PORT.saturating_add(slot),
        ws_port: TESTNET_WS_PORT.saturating_add(slot),
        discovery_port,
        public_discovery_port: discovery_port,
        metrics_port: TESTNET_METRICS_PORT.saturating_add(slot),
    }
}

fn validator_runtime_ports() -> TestnetRuntimePorts {
    TestnetRuntimePorts {
        p2p_port: TESTNET_P2P_PORT,
        public_p2p_port: TESTNET_P2P_PORT,
        rpc_port: TESTNET_RPC_PORT,
        ws_port: TESTNET_WS_PORT,
        discovery_port: TESTNET_DISCOVERY_PORT,
        public_discovery_port: TESTNET_DISCOVERY_PORT,
        metrics_port: TESTNET_METRICS_PORT,
    }
}

fn default_runtime_ports_for_role(role_id: &str, slot: u16) -> TestnetRuntimePorts {
    if role_id.eq_ignore_ascii_case("validator") {
        validator_runtime_ports()
    } else {
        runtime_ports_for_slot(slot)
    }
}

fn default_runtime_ports_for_node(node: &TestnetProvisionedNode) -> TestnetRuntimePorts {
    default_runtime_ports_for_role(&node.role_id, node.port_slot.unwrap_or(0))
}

fn runtime_ports_for_assigned_ports(
    assigned_ports: &TestnetCeremonyAssignedPorts,
) -> TestnetRuntimePorts {
    TestnetRuntimePorts {
        p2p_port: assigned_ports.p2p_port,
        public_p2p_port: assigned_ports
            .public_p2p_port
            .unwrap_or(assigned_ports.p2p_port),
        rpc_port: assigned_ports.rpc_port,
        ws_port: assigned_ports.ws_port,
        discovery_port: assigned_ports.discovery_port,
        public_discovery_port: assigned_ports
            .public_discovery_port
            .unwrap_or(assigned_ports.discovery_port),
        metrics_port: assigned_ports.metrics_port,
    }
}

fn parse_runtime_ports_from_config(config_path: &Path) -> Option<TestnetRuntimePorts> {
    let contents = fs::read_to_string(config_path).ok()?;
    let value: toml::Value = toml::from_str(&contents).ok()?;

    let read_u16 = |section: &str, key: &str| -> Option<u16> {
        value
            .get(section)
            .and_then(|section| section.get(key))
            .and_then(toml::Value::as_integer)
            .and_then(|value| u16::try_from(value).ok())
    };

    let metrics_port = value
        .get("telemetry")
        .and_then(|section| section.get("metrics_bind"))
        .and_then(toml::Value::as_str)
        .and_then(|bind| bind.rsplit(':').next())
        .and_then(|port| port.parse::<u16>().ok())?;
    let public_p2p_port = value
        .get("p2p")
        .and_then(|section| section.get("public_address"))
        .and_then(toml::Value::as_str)
        .and_then(|address| address.rsplit(':').next())
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or_else(|| read_u16("network", "p2p_port").unwrap_or(TESTNET_P2P_PORT));

    Some(TestnetRuntimePorts {
        p2p_port: read_u16("network", "p2p_port")?,
        public_p2p_port,
        rpc_port: read_u16("rpc", "http_port")?,
        ws_port: read_u16("rpc", "ws_port")?,
        discovery_port: read_u16("p2p", "discovery_port")?,
        public_discovery_port: read_u16("p2p", "discovery_port")?,
        metrics_port,
    })
}

fn config_path_for_node(node: &TestnetProvisionedNode, file_name: &str) -> Option<PathBuf> {
    node.config_paths
        .iter()
        .map(PathBuf::from)
        .find(|path| path.file_name().and_then(|value| value.to_str()) == Some(file_name))
}

fn read_runtime_ports_for_node(node: &TestnetProvisionedNode) -> Option<TestnetRuntimePorts> {
    let config_path = config_path_for_node(node, "node.toml")?;
    parse_runtime_ports_from_config(&config_path)
}

fn repair_imported_validator_ports_if_needed(
    workspace_directory: &Path,
    config_path: &Path,
    package: &TestnetCeremonyPackage,
) -> Result<(), String> {
    let current_ports = match parse_runtime_ports_from_config(config_path) {
        Some(ports) => ports,
        None => return Ok(()),
    };
    let expected_ports = validator_runtime_ports();

    let root = ensure_testnet_root()?;
    let mut registry = load_registry(&root)?;
    let Some(node_index) = registry
        .nodes
        .iter()
        .position(|entry| Path::new(&entry.workspace_directory) == workspace_directory)
    else {
        return Ok(());
    };

    let mut registry_changed = false;
    if registry.nodes[node_index].port_slot != Some(0) {
        registry.nodes[node_index].port_slot = Some(0);
        registry_changed = true;
    }

    if current_ports == expected_ports {
        if registry_changed {
            save_registry(&root, &registry)?;
        }
        return Ok(());
    }

    let node_record = registry.nodes[node_index].clone();
    let network_profile = load_or_create_network_profile(&root)?;
    let role = find_role_profile(&node_record.role_id)?;
    let public_host = node_record.public_host.clone();
    let role_overlay = role_overlay_for(&role.id);

    let mut node_contents = build_node_toml(
        &node_record.id,
        &node_record.display_label,
        &role,
        &node_record.node_address,
        workspace_directory,
        public_host.as_deref(),
        &network_profile,
        role_overlay.as_str(),
        0,
        package.assigned_ports.as_ref(),
    );
    if role.id == "validator" {
        node_contents = apply_ceremony_validator_config_overrides(node_contents, package);
    }

    write_file(config_path, &node_contents)?;

    if registry_changed {
        save_registry(&root, &registry)?;
    }

    Ok(())
}

enum TestnetRunner {
    Binary(PathBuf),
    Cargo {
        manifest_path: PathBuf,
        binary_name: &'static str,
    },
}

fn resolve_testnet_runner(
    app_context: &AppContext,
    role_id: &str,
) -> Result<TestnetRunner, String> {
    for root in app_context.resource_roots() {
        if let Some(binary_name) = binary_name_for_role(role_id) {
            for candidate in runner_binary_candidates(root, binary_name) {
                if candidate.is_file() {
                    return Ok(TestnetRunner::Binary(candidate));
                }
            }
        }
    }

    for root in app_context.resource_roots() {
        for manifest in [root.join("synergy-testnet").join("src").join("Cargo.toml")] {
            if manifest.is_file() {
                return Ok(TestnetRunner::Cargo {
                    manifest_path: manifest,
                    binary_name: "synergy-testnet",
                });
            }
        }
    }

    for root in app_context.resource_roots() {
        for binary_name in current_platform_testnet_binary_names() {
            for candidate in runner_binary_candidates(root, binary_name) {
                if candidate.is_file() {
                    return Ok(TestnetRunner::Binary(candidate));
                }
            }
        }
    }

    Err(format!(
        "Could not find a runnable Testnet binary or source manifest for role {}.",
        role_id
    ))
}

fn runner_binary_candidates(root: &Path, binary_name: &str) -> [PathBuf; 4] {
    [
        root.join("binaries").join(binary_name),
        root.join("bin").join(binary_name),
        root.join(binary_name),
        root.join("synergy-testnet")
            .join("target")
            .join("release")
            .join(binary_name),
    ]
}

fn current_platform_testnet_binary_names() -> &'static [&'static str] {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return &[
        "synergy-testnet-darwin-arm64",
        "synergy-testnet-macos-arm64",
        "synergy-testnet",
    ];

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return &["synergy-testnet-macos-amd64", "synergy-testnet"];

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return &["synergy-testnet-linux-amd64", "synergy-testnet"];

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return &["synergy-testnet-linux-arm64", "synergy-testnet"];

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return &["synergy-testnet-windows-amd64.exe", "synergy-testnet.exe"];

    #[allow(unreachable_code)]
    &["synergy-testnet"]
}

fn binary_name_for_role(role_id: &str) -> Option<&'static str> {
    match role_id {
        "validator" => Some("synergy-validator-node"),
        "committee" => Some("synergy-committee-node"),
        "archive_validator" => Some("synergy-archive-validator-node"),
        "audit_validator" => Some("synergy-audit-validator-node"),
        "relayer" => Some("synergy-relayer-node"),
        "witness" => Some("synergy-witness-node"),
        "oracle" => Some("synergy-oracle-node"),
        "uma_coordinator" => Some("synergy-uma-coordinator-node"),
        "cross_chain_verifier" => Some("synergy-cross-chain-verifier-node"),
        "compute" => Some("synergy-synq-execution-node"),
        "ai_inference" => Some("synergy-analytics-and-simulation-node"),
        "pqc_crypto" => Some("synergy-aegis-cryptography-node"),
        "data_availability" => Some("synergy-data-availability-node"),
        "governance_auditor" => Some("synergy-governance-auditor-node"),
        "treasury_controller" => Some("synergy-treasury-controller-node"),
        "security_council" => Some("synergy-security-council-node"),
        "rpc_gateway" => Some("synergy-rpc-gateway-node"),
        "indexer" => Some("synergy-indexer-and-explorer-node"),
        "observer" => Some("synergy-observer-light-node"),
        _ => None,
    }
}

async fn launch_runner_detached(
    runner: &TestnetRunner,
    subcommand: &str,
    config_path: &Path,
    workspace_directory: &Path,
) -> Result<(), String> {
    let runner = runner_to_owned(runner);
    let config_path = config_path.to_path_buf();
    let workspace_directory = workspace_directory.to_path_buf();
    let subcommand = subcommand.to_string();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let logs_directory = workspace_directory.join("logs");
        fs::create_dir_all(&logs_directory)
            .map_err(|error| format!("Failed to create {}: {error}", logs_directory.display()))?;
        let stdout_path = control_action_log_path(&workspace_directory, &subcommand, "stdout");
        let stderr_path = control_action_log_path(&workspace_directory, &subcommand, "stderr");
        let stdout = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&stdout_path)
            .map_err(|error| format!("Failed to open {}: {error}", stdout_path.display()))?;
        let stderr = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&stderr_path)
            .map_err(|error| format!("Failed to open {}: {error}", stderr_path.display()))?;

        let mut command = command_for_runner(&runner);
        command.arg(&subcommand).arg("--config").arg(&config_path);
        apply_workspace_runtime_env(&mut command, &config_path, &workspace_directory)
            .current_dir(&workspace_directory)
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));

        append_workspace_control_log(
            &workspace_directory,
            "INFO",
            "Launching detached node runner",
            Some(json!({
                "subcommand": subcommand.clone(),
                "config_path": config_path.display().to_string(),
                "stdout_log": stdout_path.display().to_string(),
                "stderr_log": stderr_path.display().to_string(),
            })),
        );

        let child = command
            .spawn()
            .map_err(|error| format!("Failed to launch {}: {}", subcommand, error))?;
        append_workspace_control_log(
            &workspace_directory,
            "INFO",
            "Detached node runner launched",
            Some(json!({
                "subcommand": subcommand.clone(),
                "pid": child.id(),
            })),
        );
        Ok(())
    })
    .await
    .map_err(|error| format!("Failed to run detached node command: {error}"))?
}

fn control_action_log_path(workspace_directory: &Path, subcommand: &str, stream: &str) -> PathBuf {
    workspace_directory
        .join("logs")
        .join(format!("control-{subcommand}.{stream}.log"))
}

fn control_service_log_path(workspace_directory: &Path) -> PathBuf {
    workspace_directory.join("logs").join("control-service.log")
}

fn append_control_action_output(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    if !bytes.ends_with(b"\n") {
        file.write_all(b"\n")
            .map_err(|error| format!("Failed to finalize {}: {error}", path.display()))?;
    }
    Ok(())
}

fn append_workspace_control_log(
    workspace_directory: &Path,
    level: &str,
    message: &str,
    metadata: Option<Value>,
) {
    let log_path = control_service_log_path(workspace_directory);
    if let Some(parent) = log_path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }

    let timestamp = Utc::now().format("%Y-%m-%d %H:%M:%S UTC");
    let mut contents = format!(
        "[{}] [{}] [control-service] {}\n",
        timestamp,
        level.trim().to_ascii_uppercase(),
        message
    );
    if let Some(metadata) = metadata {
        contents.push_str(&format!("  Metadata: {}\n", metadata));
    }

    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = file.write_all(contents.as_bytes());
    }
}

fn normalize_log_timestamp(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    DateTime::parse_from_rfc3339(raw)
        .map(|value| value.with_timezone(&Utc).to_rfc3339())
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S UTC")
                .ok()
                .map(|value| DateTime::<Utc>::from_naive_utc_and_offset(value, Utc).to_rfc3339())
        })
}

fn source_modified_at_utc(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(DateTime::<Utc>::from(modified).to_rfc3339())
}

fn workspace_log_sources(workspace_directory: &Path) -> Vec<WorkspaceLogSource> {
    vec![
        WorkspaceLogSource {
            id: "control-service",
            label: "Control Service",
            kind: "control",
            path: control_service_log_path(workspace_directory),
        },
        WorkspaceLogSource {
            id: "control-start-stderr",
            label: "Start STDERR",
            kind: "action",
            path: control_action_log_path(workspace_directory, "start", "stderr"),
        },
        WorkspaceLogSource {
            id: "control-start-stdout",
            label: "Start STDOUT",
            kind: "action",
            path: control_action_log_path(workspace_directory, "start", "stdout"),
        },
        WorkspaceLogSource {
            id: "control-stop-stderr",
            label: "Stop STDERR",
            kind: "action",
            path: control_action_log_path(workspace_directory, "stop", "stderr"),
        },
        WorkspaceLogSource {
            id: "control-stop-stdout",
            label: "Stop STDOUT",
            kind: "action",
            path: control_action_log_path(workspace_directory, "stop", "stdout"),
        },
        WorkspaceLogSource {
            id: "node-runtime",
            label: "Node Runtime",
            kind: "runtime",
            path: workspace_directory.join("logs").join("synergy-testnet.log"),
        },
        WorkspaceLogSource {
            id: "rpc-selftest-out",
            label: "RPC Self-Test STDOUT",
            kind: "rpc",
            path: workspace_directory.join("logs").join("rpc-test.out"),
        },
        WorkspaceLogSource {
            id: "rpc-selftest-err",
            label: "RPC Self-Test STDERR",
            kind: "rpc",
            path: workspace_directory.join("logs").join("rpc-test.err"),
        },
    ]
}

fn parse_structured_log_line(line: &str) -> Option<(Option<String>, String, String, String)> {
    let raw = line.trim_end();
    let rest = raw.strip_prefix('[')?;
    let (timestamp, rest) = rest.split_once("] [")?;
    let (level, rest) = rest.split_once("] [")?;
    let (module, message) = rest.split_once("] ")?;
    Some((
        normalize_log_timestamp(timestamp),
        level.trim().to_ascii_uppercase(),
        module.trim().to_string(),
        message.trim().to_string(),
    ))
}

fn guess_log_level(line: &str, source_kind: &str) -> String {
    let lowered = line.to_ascii_lowercase();
    if lowered.contains("panic")
        || lowered.contains("fatal")
        || lowered.contains(" error")
        || lowered.contains("error:")
        || lowered.contains("failed")
        || lowered.contains(" refused")
    {
        return "ERROR".to_string();
    }
    if lowered.contains("warn") || lowered.contains("timeout") {
        return "WARN".to_string();
    }
    if lowered.contains("trace") {
        return "TRACE".to_string();
    }
    if lowered.contains("debug") {
        return "DEBUG".to_string();
    }
    if source_kind == "action" && lowered.contains("starting") {
        return "DEBUG".to_string();
    }
    "INFO".to_string()
}

fn parse_log_source_entries(
    source: &WorkspaceLogSource,
    excerpt: &str,
    fallback_timestamp_utc: Option<&str>,
) -> Vec<TestnetNodeLogEntry> {
    let mut entries: Vec<TestnetNodeLogEntry> = Vec::new();
    let mut last_entry_index: Option<usize> = None;

    for raw_line in excerpt.lines() {
        let raw_line = raw_line.trim_end();
        if raw_line.trim().is_empty() {
            continue;
        }

        if let Some(metadata_text) = raw_line.strip_prefix("  Metadata:") {
            if let Some(index) = last_entry_index {
                let parsed = serde_json::from_str::<Value>(metadata_text.trim())
                    .ok()
                    .or_else(|| Some(json!({ "raw": metadata_text.trim() })));
                entries[index].metadata = parsed;
                continue;
            }
        }

        if let Some((timestamp_utc, level, module, message)) = parse_structured_log_line(raw_line) {
            entries.push(TestnetNodeLogEntry {
                source_id: source.id.to_string(),
                source_label: source.label.to_string(),
                kind: source.kind.to_string(),
                timestamp_utc,
                level,
                module,
                message,
                metadata: None,
                raw: raw_line.to_string(),
            });
            last_entry_index = Some(entries.len().saturating_sub(1));
            continue;
        }

        entries.push(TestnetNodeLogEntry {
            source_id: source.id.to_string(),
            source_label: source.label.to_string(),
            kind: source.kind.to_string(),
            timestamp_utc: fallback_timestamp_utc.map(str::to_string),
            level: guess_log_level(raw_line, source.kind),
            module: source.kind.to_string(),
            message: raw_line.trim().to_string(),
            metadata: None,
            raw: raw_line.to_string(),
        });
        last_entry_index = Some(entries.len().saturating_sub(1));
    }

    entries
}

fn combined_log_text(entries: &[TestnetNodeLogEntry]) -> String {
    let mut lines = Vec::new();
    for entry in entries {
        lines.push(format!("[{}] {}", entry.source_label, entry.raw));
        if let Some(metadata) = &entry.metadata {
            lines.push(format!("    Metadata: {}", metadata));
        }
    }
    lines.join("\n")
}

fn summarize_log_bundle(
    sources: &[TestnetNodeLogSource],
    entries: &[TestnetNodeLogEntry],
) -> TestnetNodeLogSummary {
    let mut summary = TestnetNodeLogSummary {
        total_entries: entries.len(),
        error_count: 0,
        warn_count: 0,
        info_count: 0,
        debug_count: 0,
        trace_count: 0,
        active_source_count: sources.iter().filter(|source| source.available).count(),
        latest_timestamp_utc: None,
    };

    for entry in entries {
        match entry.level.as_str() {
            "ERROR" => summary.error_count += 1,
            "WARN" => summary.warn_count += 1,
            "DEBUG" => summary.debug_count += 1,
            "TRACE" => summary.trace_count += 1,
            _ => summary.info_count += 1,
        }
        if let Some(timestamp) = &entry.timestamp_utc {
            let should_update = match summary.latest_timestamp_utc.as_deref() {
                Some(current) => current < timestamp.as_str(),
                None => true,
            };
            if should_update {
                summary.latest_timestamp_utc = Some(timestamp.clone());
            }
        }
    }

    summary
}

fn build_node_log_bundle(node: &TestnetProvisionedNode, max_lines: usize) -> TestnetNodeLogBundle {
    let workspace_directory = PathBuf::from(&node.workspace_directory);
    let source_specs = workspace_log_sources(&workspace_directory);
    let source_count = source_specs.len().max(1);
    let per_source_lines = (max_lines / source_count).max(40).min(max_lines.max(40));

    let mut sources = Vec::with_capacity(source_specs.len());
    let mut entries = Vec::new();

    for source in source_specs {
        let modified_at_utc = source_modified_at_utc(&source.path);
        let excerpt = log_tail_excerpt(&source.path, per_source_lines);
        let mut source_entries = excerpt
            .as_deref()
            .map(|contents| parse_log_source_entries(&source, contents, modified_at_utc.as_deref()))
            .unwrap_or_default();

        sources.push(TestnetNodeLogSource {
            id: source.id.to_string(),
            label: source.label.to_string(),
            kind: source.kind.to_string(),
            path: source.path.display().to_string(),
            available: source.path.is_file(),
            line_count: source_entries.len(),
            modified_at_utc,
        });
        entries.append(&mut source_entries);
    }

    entries.sort_by(|left, right| {
        left.timestamp_utc
            .cmp(&right.timestamp_utc)
            .then(left.source_id.cmp(&right.source_id))
            .then(left.raw.cmp(&right.raw))
    });
    if entries.len() > max_lines {
        let drain_count = entries.len() - max_lines;
        entries.drain(0..drain_count);
    }

    let summary = summarize_log_bundle(&sources, &entries);
    let combined_text = combined_log_text(&entries);

    TestnetNodeLogBundle {
        node_id: node.id.clone(),
        workspace_directory: node.workspace_directory.clone(),
        sources,
        entries,
        summary,
        combined_text,
    }
}

fn log_tail_excerpt(path: &Path, max_lines: usize) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let mut lines = content
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(max_lines)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    lines.reverse();
    Some(lines.join("\n"))
}

fn recent_chain_hints_from_log(workspace_directory: &Path) -> (Option<u64>, Option<u64>) {
    let log_path = workspace_directory.join("logs").join("synergy-testnet.log");
    let excerpt = match log_tail_excerpt(&log_path, 500) {
        Some(value) => value,
        None => return (None, None),
    };

    let mut log_local_chain_height = None;
    let mut best_observed_peer_height = None;
    let mut expect_commit_metadata = false;
    let mut expect_status_metadata = false;

    for line in excerpt.lines() {
        if line.contains("[consensus] Block committed") {
            expect_commit_metadata = true;
            expect_status_metadata = false;
            continue;
        }
        if line.contains("[p2p] Received status") {
            expect_status_metadata = true;
            expect_commit_metadata = false;
            continue;
        }
        if line.starts_with('[') {
            expect_commit_metadata = false;
            expect_status_metadata = false;
            continue;
        }
        if !line.contains("Metadata:") {
            continue;
        }

        let Some(payload_text) = line.split("Metadata:").nth(1).map(str::trim) else {
            continue;
        };
        let Ok(payload) = serde_json::from_str::<Value>(payload_text) else {
            continue;
        };

        if expect_commit_metadata {
            log_local_chain_height = payload.get("height").and_then(Value::as_u64);
            expect_commit_metadata = false;
        }
        if expect_status_metadata {
            if let Some(height) = payload.get("height").and_then(Value::as_u64) {
                best_observed_peer_height = Some(
                    best_observed_peer_height
                        .map(|current: u64| current.max(height))
                        .unwrap_or(height),
                );
            }
            expect_status_metadata = false;
        }
    }

    (log_local_chain_height, best_observed_peer_height)
}

fn recent_launch_failure_detail(workspace_directory: &Path, subcommand: &str) -> Option<String> {
    let candidates = [
        control_action_log_path(workspace_directory, subcommand, "stderr"),
        control_action_log_path(workspace_directory, subcommand, "stdout"),
        workspace_directory.join("logs").join("synergy-testnet.log"),
    ];

    for path in candidates {
        if let Some(excerpt) = log_tail_excerpt(&path, 20) {
            let label = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("launch log");
            return Some(format!("{label}:\n{excerpt}"));
        }
    }

    None
}

async fn workspace_local_rpc_ready(config_path: &Path) -> bool {
    let rpc_endpoint = parse_testnet_rpc_endpoint(config_path)
        .unwrap_or_else(|| format!("http://127.0.0.1:{TESTNET_RPC_PORT}"));
    let client = Client::builder()
        .timeout(Duration::from_secs(1))
        .connect_timeout(Duration::from_secs(1))
        .build()
        .unwrap_or_else(|_| Client::new());

    query_rpc_value(&client, &rpc_endpoint, "synergy_getPeerInfo", json!([]))
        .await
        .is_ok()
}

async fn wait_for_workspace_start(
    config_path: &Path,
    workspace_directory: &Path,
    timeout_window: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < timeout_window {
        if running_pid_for_workspace(workspace_directory).is_some()
            && workspace_local_rpc_ready(config_path).await
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if let Some(detail) = recent_launch_failure_detail(workspace_directory, "start") {
        return Err(format!(
            "Node did not come online within {} seconds.\n{}",
            timeout_window.as_secs(),
            detail
        ));
    }

    Err(format!(
        "Node did not come online within {} seconds.",
        timeout_window.as_secs()
    ))
}

async fn run_runner_and_wait(
    runner: &TestnetRunner,
    subcommand: &str,
    config_path: &Path,
    workspace_directory: &Path,
) -> Result<(), String> {
    let runner = runner_to_owned(runner);
    let config_path = config_path.to_path_buf();
    let workspace_directory = workspace_directory.to_path_buf();
    let subcommand = subcommand.to_string();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        append_workspace_control_log(
            &workspace_directory,
            "INFO",
            "Running node command",
            Some(json!({
                "subcommand": subcommand.clone(),
                "config_path": config_path.display().to_string(),
            })),
        );

        let mut command = command_for_runner(&runner);
        command.arg(&subcommand).arg("--config").arg(&config_path);
        apply_workspace_runtime_env(&mut command, &config_path, &workspace_directory)
            .current_dir(&workspace_directory);

        let output = command
            .output()
            .map_err(|error| format!("Failed to execute {}: {}", subcommand, error))?;
        append_control_action_output(
            &control_action_log_path(&workspace_directory, &subcommand, "stdout"),
            &output.stdout,
        )?;
        append_control_action_output(
            &control_action_log_path(&workspace_directory, &subcommand, "stderr"),
            &output.stderr,
        )?;

        if output.status.success() {
            append_workspace_control_log(
                &workspace_directory,
                "INFO",
                "Node command completed",
                Some(json!({
                    "subcommand": subcommand.clone(),
                    "exit_code": output.status.code(),
                })),
            );
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        append_workspace_control_log(
            &workspace_directory,
            "ERROR",
            "Node command failed",
            Some(json!({
                "subcommand": subcommand.clone(),
                "exit_code": output.status.code(),
                "detail": detail.clone(),
            })),
        );
        Err(format!("{} failed: {}", subcommand, detail))
    })
    .await
    .map_err(|error| format!("Failed to run node command: {error}"))?
}

fn runner_to_owned(runner: &TestnetRunner) -> TestnetRunner {
    match runner {
        TestnetRunner::Binary(path) => TestnetRunner::Binary(path.clone()),
        TestnetRunner::Cargo {
            manifest_path,
            binary_name,
        } => TestnetRunner::Cargo {
            manifest_path: manifest_path.clone(),
            binary_name,
        },
    }
}

fn command_for_runner(runner: &TestnetRunner) -> std::process::Command {
    match runner {
        TestnetRunner::Binary(path) => std::process::Command::new(path),
        TestnetRunner::Cargo {
            manifest_path,
            binary_name,
        } => {
            let mut command = std::process::Command::new("cargo");
            command
                .arg("run")
                .arg("--manifest-path")
                .arg(manifest_path)
                .arg("--bin")
                .arg(binary_name)
                .arg("--");
            command
        }
    }
}

fn apply_workspace_runtime_env<'a>(
    command: &'a mut std::process::Command,
    config_path: &Path,
    workspace_directory: &Path,
) -> &'a mut std::process::Command {
    let command = command
        .env("SYNERGY_PROJECT_ROOT", workspace_directory)
        .env("SYNERGY_CONFIG_PATH", config_path);

    if let Some(validator_address) = parse_testnet_validator_address(config_path) {
        command
            .env("SYNERGY_VALIDATOR_ADDRESS", &validator_address)
            .env("NODE_ADDRESS", validator_address);
    }

    command
}

fn parse_testnet_rpc_endpoint(config_path: &Path) -> Option<String> {
    let contents = fs::read_to_string(config_path).ok()?;
    let value = contents.parse::<toml::Value>().ok()?;
    let port = value
        .get("rpc")
        .and_then(|section| section.get("http_port"))
        .and_then(toml::Value::as_integer)
        .unwrap_or(i64::from(TESTNET_RPC_PORT));
    Some(format!("http://127.0.0.1:{port}"))
}

fn parse_testnet_validator_address(config_path: &Path) -> Option<String> {
    let contents = fs::read_to_string(config_path).ok()?;
    let value = contents.parse::<toml::Value>().ok()?;
    value
        .get("node")
        .and_then(|section| section.get("validator_address"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn read_toml_value(path: &Path) -> Result<toml::Value, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    toml::from_str(&contents)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))
}

fn extract_toml_string_array(value: &toml::Value, section: &str, key: &str) -> Vec<String> {
    value
        .get(section)
        .and_then(|section| section.get(key))
        .and_then(toml::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(toml::Value::as_str)
        .map(str::to_string)
        .collect()
}

fn workspace_genesis_hash(workspace_directory: &Path) -> Result<String, String> {
    read_json_value(&workspace_directory.join("config").join("genesis.json"))?
        .pointer("/integrity/genesis_hash")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Workspace genesis is missing integrity.genesis_hash.".to_string())
}

fn workspace_manifest_chain_id(workspace_directory: &Path) -> Result<u64, String> {
    read_json_value(
        &workspace_directory
            .join("config")
            .join("operational-manifest.json"),
    )?
    .get("chain_id")
    .and_then(Value::as_u64)
    .ok_or_else(|| "Workspace operational manifest is missing chain_id.".to_string())
}

fn first_block_hash_from_chain_value(value: &Value) -> Option<String> {
    fn block_hash(value: &Value) -> Option<String> {
        value
            .get("hash")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|hash| !hash.is_empty())
            .map(str::to_string)
    }

    if let Some(blocks) = value.as_array() {
        return blocks.first().and_then(block_hash);
    }

    for key in ["chain", "blocks"] {
        if let Some(blocks) = value.get(key).and_then(Value::as_array) {
            if let Some(hash) = blocks.first().and_then(block_hash) {
                return Some(hash);
            }
        }
    }

    block_hash(value)
}

fn workspace_chain_file_genesis_hash(workspace_directory: &Path) -> Result<Option<String>, String> {
    let chain_path = workspace_directory.join("data").join("chain.json");
    if !chain_path.is_file() {
        return Ok(None);
    }

    Ok(first_block_hash_from_chain_value(&read_json_value(
        &chain_path,
    )?))
}

fn workspace_chain_state_requires_canonical_reset(
    workspace_directory: &Path,
) -> Result<bool, String> {
    let Some(actual_genesis_hash) = workspace_chain_file_genesis_hash(workspace_directory)? else {
        return Ok(false);
    };
    let expected_genesis_hash = canonical_testnet_genesis_hash()?;
    Ok(!actual_genesis_hash.eq_ignore_ascii_case(&expected_genesis_hash))
}

fn repair_workspace_chain_state_if_needed(
    workspace_directory: &Path,
) -> Result<Option<String>, String> {
    let expected_genesis_hash = workspace_genesis_hash(workspace_directory)
        .or_else(|_| canonical_testnet_genesis_hash())?;
    let Some(actual_genesis_hash) = workspace_chain_file_genesis_hash(workspace_directory)? else {
        return Ok(None);
    };

    if actual_genesis_hash.eq_ignore_ascii_case(&expected_genesis_hash) {
        return Ok(None);
    }

    let data_directory = workspace_directory.join("data");
    let mut removed_paths = Vec::new();
    for relative in [
        "chain",
        "chain.json",
        "token_state.json",
        "validator_registry.json",
        "consensus_proposals",
        "testnet15",
        ".reset_flag",
    ] {
        remove_path_if_exists(&data_directory.join(relative), &mut removed_paths)?;
    }

    let message = format!(
        "Local chain state reset because block 0 used genesis {}, but the active Testnet genesis is {}.",
        actual_genesis_hash, expected_genesis_hash
    );
    append_workspace_control_log(
        workspace_directory,
        "WARN",
        &message,
        Some(json!({
            "actual_chain_genesis_hash": actual_genesis_hash,
            "expected_genesis_hash": expected_genesis_hash,
            "removed_paths": removed_paths,
        })),
    );

    Ok(Some(message))
}

async fn measure_clock_skew_ms(client: &Client) -> Option<i64> {
    for endpoint in [
        TESTNET_PUBLIC_RPC_ENDPOINT,
        "https://testnet-wallet-api.synergy-network.io",
    ] {
        let Ok(response) = client.get(endpoint).send().await else {
            continue;
        };
        let Some(date_header) = response.headers().get(reqwest::header::DATE) else {
            continue;
        };
        let Some(date_header) = date_header.to_str().ok() else {
            continue;
        };
        let Some(remote_time) = DateTime::parse_from_rfc2822(date_header)
            .ok()
            .map(|value| value.with_timezone(&Utc))
        else {
            continue;
        };
        let local_time = Utc::now();
        return Some((local_time - remote_time).num_milliseconds().abs());
    }
    None
}

async fn validate_workspace_launch_preflight(
    config_path: &Path,
    workspace_directory: &Path,
) -> Result<(), String> {
    let config_value = read_toml_value(config_path)?;
    let role_id = config_value
        .get("identity")
        .and_then(|section| section.get("role"))
        .and_then(toml::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let validator_address = parse_testnet_validator_address(config_path).unwrap_or_default();
    let mut failures = Vec::new();

    match workspace_genesis_hash(workspace_directory) {
        Ok(actual) => match canonical_testnet_genesis_hash() {
            Ok(expected) if actual.eq_ignore_ascii_case(&expected) => {}
            Ok(expected) => failures.push(format!(
                "Workspace genesis hash mismatch. Expected {}, got {}.",
                expected, actual
            )),
            Err(error) => failures.push(error),
        },
        Err(error) => failures.push(error),
    }

    match workspace_chain_file_genesis_hash(workspace_directory) {
        Ok(Some(actual)) => match workspace_genesis_hash(workspace_directory) {
            Ok(expected) if actual.eq_ignore_ascii_case(&expected) => {}
            Ok(expected) => failures.push(format!(
                "Workspace chain data genesis mismatch. Expected {}, got {}. Restart sync so stale chain state can be rebuilt.",
                expected, actual
            )),
            Err(error) => failures.push(error),
        },
        Ok(None) => {}
        Err(error) => failures.push(error),
    }

    match workspace_manifest_chain_id(workspace_directory) {
        Ok(chain_id) if chain_id == TESTNET_CHAIN_ID => {}
        Ok(chain_id) => failures.push(format!(
            "Workspace operational manifest chain_id mismatch. Expected {}, got {}.",
            TESTNET_CHAIN_ID, chain_id
        )),
        Err(error) => failures.push(error),
    }

    let validator_mesh_only = validator_uses_private_mesh(&role_id, &validator_address);
    if validator_mesh_only {
        let expected_targets = canonical_validator_dial_targets(&validator_address);
        let configured_targets =
            extract_toml_string_array(&config_value, "network", "additional_dial_targets")
                .into_iter()
                .filter_map(|value| normalize_testnet_dial_target(&value))
                .collect::<Vec<_>>();
        let missing_targets = expected_targets
            .iter()
            .filter(|target| !configured_targets.contains(*target))
            .cloned()
            .collect::<Vec<_>>();
        if !missing_targets.is_empty() {
            failures.push(format!(
                "Workspace is missing canonical validator dial targets: {}.",
                missing_targets.join(", ")
            ));
        }

        let bootnodes = extract_toml_string_array(&config_value, "network", "bootnodes");
        if !bootnodes.is_empty() {
            failures.push(format!(
                "Validator workspace must not use public bootnodes. Found {} bootstrap entries.",
                bootnodes.len()
            ));
        }
        let seed_servers = extract_toml_string_array(&config_value, "network", "seed_servers");
        if !seed_servers.is_empty() {
            failures.push(format!(
                "Validator workspace must not use seed_servers. Found {} entries.",
                seed_servers.len()
            ));
        }
        let bootstrap_dns_records =
            extract_toml_string_array(&config_value, "network", "bootstrap_dns_records");
        if !bootstrap_dns_records.is_empty() {
            failures.push(format!(
                "Validator workspace must not use DNS bootstrap records. Found {} entries.",
                bootstrap_dns_records.len()
            ));
        }

        match read_json_value(
            &workspace_directory
                .join("config")
                .join("operational-manifest.json"),
        ) {
            Ok(manifest_value) => {
                let actual_validator_addresses =
                    extract_validator_addresses_from_manifest_value(&manifest_value);
                match canonical_testnet_validator_addresses() {
                    Ok(expected_validator_addresses)
                        if actual_validator_addresses == expected_validator_addresses => {}
                    Ok(_) => failures.push(
                        "Workspace validator registry does not match the canonical release bundle."
                            .to_string(),
                    ),
                    Err(error) => failures.push(error),
                }
            }
            Err(error) => failures.push(error),
        }
    }

    #[cfg(test)]
    let skip_clock_skew_preflight =
        std::env::var_os("SYNERGY_TEST_SKIP_CLOCK_SKEW_PREFLIGHT").is_some();
    #[cfg(not(test))]
    let skip_clock_skew_preflight = false;

    if !skip_clock_skew_preflight {
        let client = Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|error| format!("HTTP client error: {error}"))?;
        if let Some(skew_ms) = measure_clock_skew_ms(&client).await {
            if skew_ms > TESTNET_MAX_CLOCK_SKEW_MS {
                failures.push(format!(
                    "System clock skew is {} ms, which exceeds the {} ms launch threshold.",
                    skew_ms, TESTNET_MAX_CLOCK_SKEW_MS
                ));
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Launch preflight failed:\n- {}",
            failures.join("\n- ")
        ))
    }
}

fn ensure_workspace_bootstrap_topology(
    config_path: &Path,
    workspace_directory: &Path,
    network_profile: &TestnetNetworkProfile,
    node: &TestnetProvisionedNode,
) -> Result<(), String> {
    let mut value = read_toml_value(config_path)?;
    let existing_additional_targets =
        extract_toml_string_array(&value, "network", "additional_dial_targets");
    let existing_persistent_targets =
        extract_toml_string_array(&value, "network", "persistent_peers");
    let root = value
        .as_table_mut()
        .ok_or_else(|| format!("{} must parse into a TOML table.", config_path.display()))?;

    let network = root
        .entry("network")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or_else(|| "[network] must be a TOML table.".to_string())?;
    let is_validator = role_supports_validator_registration(&node.role_id);
    let validator_mesh_only = provisioned_node_uses_private_validator_mesh(node);
    let use_sentry_upstreams = role_uses_sentry_upstreams(&node.role_id);
    network.insert(
        "bootnodes".to_string(),
        toml::Value::Array(if validator_mesh_only || use_sentry_upstreams {
            Vec::new()
        } else {
            network_profile
                .bootnodes
                .iter()
                .map(|entry| toml::Value::String(format!("{}:{}", entry.host, entry.port)))
                .collect()
        }),
    );

    network.insert(
        "seed_servers".to_string(),
        toml::Value::Array(if validator_mesh_only || use_sentry_upstreams {
            Vec::new()
        } else {
            network_profile
                .seed_servers
                .iter()
                .map(|entry| toml::Value::String(format!("http://{}:{}", entry.host, entry.port)))
                .collect()
        }),
    );
    network.insert(
        "bootstrap_dns_records".to_string(),
        toml::Value::Array(if validator_mesh_only || use_sentry_upstreams {
            Vec::new()
        } else {
            vec![toml::Value::String(canonical_bootstrap_dns_record())]
        }),
    );
    network.insert(
        "additional_dial_targets".to_string(),
        toml::Value::Array(if validator_mesh_only {
            canonical_validator_dial_targets(&node.node_address)
                .into_iter()
                .map(toml::Value::String)
                .collect()
        } else if use_sentry_upstreams {
            canonical_sentry_public_dial_targets_for_role(&node.role_id)
                .into_iter()
                .map(toml::Value::String)
                .collect()
        } else {
            existing_additional_targets
                .into_iter()
                .map(toml::Value::String)
                .collect()
        }),
    );
    network.insert(
        "persistent_peers".to_string(),
        toml::Value::Array(if validator_mesh_only {
            canonical_validator_dial_targets(&node.node_address)
                .into_iter()
                .map(toml::Value::String)
                .collect()
        } else if use_sentry_upstreams {
            canonical_sentry_public_dial_targets_for_role(&node.role_id)
                .into_iter()
                .map(toml::Value::String)
                .collect()
        } else {
            existing_persistent_targets
                .into_iter()
                .map(toml::Value::String)
                .collect()
        }),
    );

    if validator_mesh_only || use_sentry_upstreams {
        if let Some(p2p) = root.get_mut("p2p").and_then(toml::Value::as_table_mut) {
            p2p.insert("enable_discovery".to_string(), toml::Value::Boolean(false));
            p2p.insert(
                "heartbeat_interval".to_string(),
                toml::Value::Integer(TESTNET_P2P_HEARTBEAT_INTERVAL_SECS as i64),
            );
        }
    }

    if is_validator {
        if let Some(node_table) = root.get_mut("node").and_then(toml::Value::as_table_mut) {
            node_table.insert(
                "auto_register_validator".to_string(),
                toml::Value::Boolean(false),
            );
            node_table.insert(
                "strict_validator_allowlist".to_string(),
                toml::Value::Boolean(true),
            );
            node_table.insert(
                "allowed_validator_addresses".to_string(),
                toml::Value::Array(
                    canonical_testnet_validator_addresses()?
                        .into_iter()
                        .map(toml::Value::String)
                        .collect(),
                ),
            );
        }
    }

    let rendered = toml::to_string_pretty(&value)
        .map_err(|error| format!("Failed to serialize {}: {error}", config_path.display()))?;
    write_file(config_path, &rendered)?;

    if validator_mesh_only {
        let peers_contents = build_peers_toml_with_additional(
            network_profile,
            &canonical_validator_dial_targets(&node.node_address),
        );
        write_file(
            &workspace_directory.join("config").join("peers.toml"),
            &peers_contents,
        )?;
    } else if use_sentry_upstreams {
        let peers_contents = build_peers_toml_with_additional(
            network_profile,
            &canonical_sentry_public_dial_targets_for_role(&node.role_id),
        );
        write_file(
            &workspace_directory.join("config").join("peers.toml"),
            &peers_contents,
        )?;
    }

    Ok(())
}

async fn query_public_chain_height(client: &Client) -> Result<u64, String> {
    query_local_chain_height(client, TESTNET_PUBLIC_RPC_ENDPOINT).await
}

async fn rpc_fast_sync_workspace_chain(workspace_directory: &Path) -> Result<String, String> {
    let data_dir = workspace_directory.join("data");
    let chain_path = data_dir.join("chain.json");
    if !chain_path.is_file() {
        return Err(format!(
            "Local chain file not found at {}.",
            chain_path.display()
        ));
    }

    let chain_contents = fs::read_to_string(&chain_path)
        .map_err(|error| format!("Failed to read {}: {error}", chain_path.display()))?;
    let mut chain = serde_json::from_str::<Vec<Value>>(&chain_contents)
        .map_err(|error| format!("Failed to parse {}: {error}", chain_path.display()))?;
    let last_block = chain
        .last()
        .ok_or_else(|| format!("Local chain file is empty: {}", chain_path.display()))?;
    let local_height = block_height_from_value(last_block)
        .ok_or_else(|| "Local chain tip does not expose block_index.".to_string())?;
    let mut expected_previous_hash = block_hash_from_value(last_block)
        .ok_or_else(|| "Local chain tip does not expose hash.".to_string())?;

    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?;
    let public_height = query_public_chain_height(&client).await?;
    if local_height >= public_height {
        return Ok(format!(
            "RPC fallback checked the public chain and the workspace is already at height {local_height}."
        ));
    }

    if public_height > TESTNET_RPC_FAST_SYNC_REBUILD_LIMIT {
        return Err(format!(
            "RPC fallback refused to rebuild a {public_height}-block chain in one pass. Restore from a trusted snapshot before retrying catch-up."
        ));
    }

    let mut mode = "append";
    let mut rebuilt_from_genesis = false;
    let mut appended_blocks = 0_u64;
    for height in (local_height + 1)..=public_height {
        let block = query_rpc_value(
            &client,
            TESTNET_PUBLIC_RPC_ENDPOINT,
            "synergy_getBlockByNumber",
            json!([height]),
        )
        .await?;
        let block_height = block_height_from_value(&block)
            .ok_or_else(|| format!("RPC block {height} did not include block_index."))?;
        if block_height != height {
            return Err(format!(
                "RPC returned block {block_height} while syncing expected height {height}."
            ));
        }
        let previous_hash = block
            .get("previous_hash")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("RPC block {height} did not include previous_hash."))?;
        if previous_hash != expected_previous_hash {
            mode = "rebuild";
            rebuilt_from_genesis = true;
            break;
        }
        expected_previous_hash = block_hash_from_value(&block)
            .ok_or_else(|| format!("RPC block {height} did not include hash."))?;
        chain.push(block);
        appended_blocks += 1;
    }

    if rebuilt_from_genesis {
        let mut rebuilt_chain = Vec::with_capacity(public_height.saturating_add(1) as usize);
        let mut rebuilt_previous_hash = String::new();
        for height in 0..=public_height {
            let block = query_rpc_value(
                &client,
                TESTNET_PUBLIC_RPC_ENDPOINT,
                "synergy_getBlockByNumber",
                json!([height]),
            )
            .await?;
            let block_height = block_height_from_value(&block)
                .ok_or_else(|| format!("RPC block {height} did not include block_index."))?;
            if block_height != height {
                return Err(format!(
                    "RPC returned block {block_height} while rebuilding expected height {height}."
                ));
            }
            if height > 0 {
                let previous_hash = block
                    .get("previous_hash")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("RPC block {height} did not include previous_hash."))?;
                if previous_hash != rebuilt_previous_hash {
                    return Err(format!(
                        "RPC rebuild parent hash mismatch at {height}. Expected {rebuilt_previous_hash}, got {previous_hash}."
                    ));
                }
            }
            rebuilt_previous_hash = block_hash_from_value(&block)
                .ok_or_else(|| format!("RPC block {height} did not include hash."))?;
            rebuilt_chain.push(block);
        }
        chain = rebuilt_chain;
        appended_blocks = public_height.saturating_add(1);
    }

    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Failed to create {}: {error}", data_dir.display()))?;
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let backup_path = data_dir.join(format!("chain.before-rpc-fast-sync-{stamp}.json"));
    fs::copy(&chain_path, &backup_path).map_err(|error| {
        format!(
            "Failed to back up {} to {}: {error}",
            chain_path.display(),
            backup_path.display()
        )
    })?;
    let tmp_path = data_dir.join(format!("chain.json.rpc-fast-sync-{}.tmp", Uuid::new_v4()));
    let chain_json = serde_json::to_string_pretty(&chain)
        .map_err(|error| format!("Failed to serialize RPC-synced chain: {error}"))?;
    fs::write(&tmp_path, chain_json)
        .map_err(|error| format!("Failed to write {}: {error}", tmp_path.display()))?;
    fs::rename(&tmp_path, &chain_path).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        format!(
            "Failed to replace {} with {}: {error}",
            chain_path.display(),
            tmp_path.display()
        )
    })?;

    let token_state_path = data_dir.join("token_state.json");
    if token_state_path.is_file() {
        let token_backup_path =
            data_dir.join(format!("token_state.before-rpc-fast-sync-{stamp}.json"));
        fs::rename(&token_state_path, &token_backup_path).map_err(|error| {
            format!(
                "Failed to move {} to {} before replay: {error}",
                token_state_path.display(),
                token_backup_path.display()
            )
        })?;
    }

    Ok(format!(
        "RPC fallback {mode} synced {appended_blocks} block(s), advanced from {local_height} to {public_height}, and staged token-state replay for restart."
    ))
}

fn block_height_from_value(block: &Value) -> Option<u64> {
    block
        .get("block_index")
        .or_else(|| block.get("height"))
        .or_else(|| block.get("number"))
        .and_then(Value::as_u64)
}

fn block_hash_from_value(block: &Value) -> Option<String> {
    block
        .get("hash")
        .or_else(|| block.get("block_hash"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

async fn query_public_peer_count(client: &Client) -> Result<usize, String> {
    let value = query_rpc_value(
        client,
        TESTNET_PUBLIC_RPC_ENDPOINT,
        "synergy_getPeerInfo",
        json!([]),
    )
    .await?;
    parse_rpc_peer_count(value)
}

async fn query_seed_peer_count(
    client: &Client,
    seed_servers: &[TestnetBootstrapEndpoint],
) -> Result<usize, String> {
    let mut unique_peers = HashMap::new();
    let mut reachable_seed_count = 0usize;

    let seed_payloads = join_all(
        seed_servers
            .iter()
            .map(|seed| async move { fetch_seed_peers(client, seed).await }),
    )
    .await;

    for peers in seed_payloads.into_iter().flatten() {
        reachable_seed_count += 1;
        for peer in peers {
            if let Some(key) = seed_registry_peer_key(&peer) {
                unique_peers.entry(key).or_insert(());
            }
        }
    }

    if reachable_seed_count == 0 {
        return Err("No seed services returned a peer registry.".to_string());
    }

    Ok(unique_peers.len())
}

fn seed_registry_peer_key(peer: &Value) -> Option<String> {
    if let Some(dial) = peer.get("dial").and_then(Value::as_str) {
        let normalized = dial.trim();
        if !normalized.is_empty() {
            return Some(normalized.to_string());
        }
    }

    if let Some(host) = peer.get("public_host").and_then(Value::as_str) {
        let host = host.trim();
        if !host.is_empty() {
            let port = peer
                .get("p2p_port")
                .and_then(Value::as_u64)
                .unwrap_or(u64::from(TESTNET_P2P_PORT));
            return Some(format!("{host}:{port}"));
        }
    }

    peer.get("wallet_address")
        .and_then(Value::as_str)
        .or_else(|| peer.get("node_id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

async fn verify_node_seed_registration(
    client: &Client,
    seed_servers: &[TestnetBootstrapEndpoint],
    node_id: &str,
    wallet_address: &str,
) -> (bool, usize) {
    let mut registered_count = 0usize;

    for seed in seed_servers {
        let Some(peers) = fetch_seed_peers(client, seed).await else {
            continue;
        };
        let found = peers.iter().any(|peer| {
            let matches_node_id = peer
                .get("node_id")
                .and_then(Value::as_str)
                .map_or(false, |id| id == node_id);
            let matches_wallet = peer
                .get("wallet_address")
                .and_then(Value::as_str)
                .map_or(false, |addr| addr == wallet_address);
            matches_node_id || matches_wallet
        });
        if found {
            registered_count += 1;
        }
    }

    (registered_count > 0, registered_count)
}

async fn fetch_all_seed_peer_dial_targets(
    client: &Client,
    seed_servers: &[TestnetBootstrapEndpoint],
    current_node: Option<&TestnetProvisionedNode>,
) -> Vec<String> {
    let mut unique_dials: HashMap<String, (Option<DateTime<Utc>>, String)> = HashMap::new();

    for seed in seed_servers {
        let Some(peers) = fetch_seed_peers(client, seed).await else {
            continue;
        };
        for peer in peers {
            if current_node.is_some_and(|node| seed_peer_matches_node(&peer, node)) {
                continue;
            }
            record_seed_peer_dial_target(&mut unique_dials, &peer);
        }
    }

    let mut dials = unique_dials
        .into_values()
        .map(|(_, dial)| dial)
        .collect::<Vec<_>>();
    dials.sort();
    dials
}

fn seed_peer_matches_node(peer: &Value, node: &TestnetProvisionedNode) -> bool {
    let node_id = node.id.trim();
    let node_address = node.node_address.trim();

    [
        peer.get("wallet_address").and_then(Value::as_str),
        peer.get("validator_address").and_then(Value::as_str),
        peer.get("node_id").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .any(|value| value.eq_ignore_ascii_case(node_id) || value.eq_ignore_ascii_case(node_address))
}

fn record_seed_peer_dial_target(
    unique_dials: &mut HashMap<String, (Option<DateTime<Utc>>, String)>,
    peer: &Value,
) {
    if !seed_peer_is_validator(peer) {
        return;
    }
    let Some(dial) = extract_seed_peer_dial_target(peer) else {
        return;
    };
    let identity_key = seed_peer_identity_key(peer, &dial);
    let registered_at = seed_peer_registered_at(peer);

    let replace_existing = unique_dials
        .get(&identity_key)
        .map(
            |(existing_registered_at, _)| match (existing_registered_at, &registered_at) {
                (None, Some(_)) => true,
                (Some(existing), Some(candidate)) => candidate > existing,
                _ => false,
            },
        )
        .unwrap_or(true);

    if replace_existing {
        unique_dials.insert(identity_key, (registered_at, dial));
    }
}

fn seed_peer_is_validator(peer: &Value) -> bool {
    peer.get("role_id")
        .and_then(Value::as_str)
        .map(|value| value.trim().eq_ignore_ascii_case("validator"))
        .unwrap_or(false)
}

fn extract_seed_peer_dial_target(peer: &Value) -> Option<String> {
    if let Some(dial) = peer.get("dial").and_then(Value::as_str) {
        return normalize_testnet_dial_target(dial);
    }

    let host = peer.get("public_host").and_then(Value::as_str)?.trim();
    let port = peer
        .get("p2p_port")
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(TESTNET_P2P_PORT));
    normalize_testnet_dial_target(&format!("{host}:{port}"))
}

fn seed_peer_identity_key(peer: &Value, dial: &str) -> String {
    peer.get("wallet_address")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("wallet:{value}"))
        .or_else(|| {
            peer.get("node_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("node:{value}"))
        })
        .unwrap_or_else(|| format!("dial:{dial}"))
}

fn seed_peer_registered_at(peer: &Value) -> Option<DateTime<Utc>> {
    peer.get("registered_at_utc")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

async fn refresh_workspace_peer_targets(
    network_profile: &TestnetNetworkProfile,
    all_nodes: &[TestnetProvisionedNode],
    node: &TestnetProvisionedNode,
    workspace_directory: &Path,
) -> Result<usize, String> {
    refresh_workspace_peer_targets_with_overrides(
        network_profile,
        all_nodes,
        node,
        workspace_directory,
        &[],
    )
    .await
}

async fn refresh_workspace_peer_targets_with_overrides(
    network_profile: &TestnetNetworkProfile,
    all_nodes: &[TestnetProvisionedNode],
    node: &TestnetProvisionedNode,
    workspace_directory: &Path,
    extra_dial_targets: &[String],
) -> Result<usize, String> {
    let peers_toml_path = workspace_directory.join("config").join("peers.toml");
    let validator_mesh_only = provisioned_node_uses_private_validator_mesh(node);
    let sentry_upstreams_only = role_uses_sentry_upstreams(&node.role_id);
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?;
    let seed_peers =
        fetch_all_seed_peer_dial_targets(&client, &network_profile.seed_servers, Some(node)).await;
    let canonical_targets =
        canonical_validator_dial_targets_for_workspace(workspace_directory, &node.node_address);
    let siblings = local_sibling_dial_targets(all_nodes, &node.id);
    let mut targets = if validator_mesh_only {
        canonical_targets
    } else if sentry_upstreams_only {
        canonical_sentry_public_dial_targets_for_role(&node.role_id)
    } else {
        Vec::new()
    };
    // Canonical entries are the authority for known validator hostnames.
    // Build a set of hostnames already covered so stale ports from other
    // sources (seed servers, old peers.toml) don't shadow the correct entry.
    let canonical_hosts: std::collections::HashSet<String> = targets
        .iter()
        .filter_map(|t| t.split(':').next().map(str::to_string))
        .collect();
    if !validator_mesh_only && !sentry_upstreams_only {
        for peer in seed_peers {
            let host = peer.split(':').next().unwrap_or("").to_string();
            if !canonical_hosts.contains(&host) && !targets.contains(&peer) {
                targets.push(peer);
            }
        }
        for peer in siblings {
            if !targets.contains(&peer) {
                targets.push(peer);
            }
        }
    }
    for peer in extra_dial_targets
        .iter()
        .filter_map(|value| normalize_testnet_dial_target(value))
    {
        let host = peer.split(':').next().unwrap_or("").to_string();
        if !canonical_hosts.contains(&host) && !targets.contains(&peer) {
            targets.push(peer);
        }
    }
    if !validator_mesh_only {
        // Always merge hardcoded entries from the existing peers.toml so manually
        // configured dial targets survive restarts. Canonical hostnames take
        // precedence — skip any preserved entry whose host is already covered.
        for peer in read_peers_toml_additional_targets(&peers_toml_path) {
            let host = peer.split(':').next().unwrap_or("").to_string();
            if !canonical_hosts.contains(&host) && !targets.contains(&peer) {
                targets.push(peer);
            }
        }
    }
    filter_self_dial_targets_for_node(&mut targets, node, workspace_directory);
    targets.sort();
    targets.dedup();

    let peers_contents = build_peers_toml_with_additional(network_profile, &targets);
    write_file(&peers_toml_path, &peers_contents)
        .map_err(|error| format!("Failed to write peers.toml: {error}"))?;
    Ok(targets.len())
}

fn filter_self_dial_targets_for_node(
    targets: &mut Vec<String>,
    node: &TestnetProvisionedNode,
    workspace_directory: &Path,
) {
    let self_targets = self_dial_target_aliases_for_node(node, workspace_directory);
    if self_targets.is_empty() {
        return;
    }

    targets.retain(|target| {
        normalize_testnet_dial_target(target)
            .map(|value| !self_targets.contains(&value))
            .unwrap_or(true)
    });
}

fn self_dial_target_aliases_for_node(
    node: &TestnetProvisionedNode,
    workspace_directory: &Path,
) -> HashSet<String> {
    let mut aliases = HashSet::new();
    let public_p2p_port = read_runtime_ports_for_node(node)
        .map(|ports| ports.public_p2p_port)
        .unwrap_or_else(|| default_runtime_ports_for_node(node).public_p2p_port);

    let mut record = |candidate: String| {
        if let Some(normalized) = normalize_testnet_dial_target(&candidate) {
            aliases.insert(normalized);
        }
    };

    if let Some(public_host) = node.public_host.as_deref() {
        let public_host = public_host.trim();
        if !public_host.is_empty() {
            record(format!("{public_host}:{public_p2p_port}"));
        }
    }

    let node_toml_path = workspace_directory.join("config").join("node.toml");
    if let Ok(contents) = fs::read_to_string(&node_toml_path) {
        if let Ok(value) = toml::from_str::<toml::Value>(&contents) {
            if let Some(public_address) = value
                .get("p2p")
                .and_then(|section| section.get("public_address"))
                .and_then(toml::Value::as_str)
            {
                record(public_address.to_string());
            }
            if let Some(public_host) = value
                .get("network")
                .and_then(|section| section.get("public_host"))
                .and_then(toml::Value::as_str)
            {
                let public_host = public_host.trim();
                if !public_host.is_empty() {
                    record(format!("{public_host}:{public_p2p_port}"));
                }
            }
        }
    }

    if node.role_id.eq_ignore_ascii_case("validator") {
        if let Some(slot) = validator_slot_for_workspace(node, workspace_directory) {
            if let Some(peer) = canonical_testnet_validator_peers()
                .into_iter()
                .find(|entry| entry.slot == slot)
            {
                record(format!("{}:{public_p2p_port}", peer.private_host));
            }
        }
    }

    aliases
}

fn validator_slot_for_workspace(
    node: &TestnetProvisionedNode,
    workspace_directory: &Path,
) -> Option<u64> {
    let manifest_path = workspace_directory
        .join("config")
        .join("operational-manifest.json");
    let contents = fs::read_to_string(manifest_path).ok()?;
    let value: Value = serde_json::from_str(&contents).ok()?;
    value
        .get("validators")
        .and_then(Value::as_array)?
        .iter()
        .find(|entry| {
            entry
                .get("address")
                .and_then(Value::as_str)
                .map(str::trim)
                .is_some_and(|address| address.eq_ignore_ascii_case(node.node_address.trim()))
        })
        .and_then(|entry| entry.get("slot"))
        .and_then(Value::as_u64)
}

fn normalize_testnet_dial_target(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    let raw = raw
        .strip_prefix("snr://")
        .or_else(|| raw.strip_prefix("enode://"))
        .unwrap_or(raw);
    let raw = raw.rsplit_once('@').map(|(_, right)| right).unwrap_or(raw);
    let raw = raw.split('/').next().unwrap_or(raw);
    let raw = raw.split('?').next().unwrap_or(raw);
    let raw = raw.split('#').next().unwrap_or(raw);

    let (host, port) = if let Some(stripped) = raw.strip_prefix('[') {
        let (host, port) = stripped.rsplit_once("]:")?;
        (host, port)
    } else {
        raw.rsplit_once(':')?
    };

    let host = host
        .trim()
        .trim_matches('[')
        .trim_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let port = port.trim().parse::<u16>().ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }

    Some(format!("{host}:{port}"))
}

async fn build_node_readiness_report(
    client: &Client,
    node: &TestnetProvisionedNode,
    live: &TestnetNodeLiveStatus,
    seed_servers: &[TestnetBootstrapEndpoint],
) -> NodeReadinessReport {
    let mut checks = Vec::new();
    let p2p_port = read_runtime_ports_for_node(node)
        .map(|ports| ports.p2p_port)
        .unwrap_or_else(|| default_runtime_ports_for_node(node).p2p_port);

    // 1. Workspace Ready
    checks.push(NodeReadinessCheck {
        id: "workspace_ready".to_string(),
        label: "Workspace Ready".to_string(),
        status: if live.workspace_ready { "pass" } else { "fail" }.to_string(),
        detail: if live.workspace_ready {
            "Node workspace directory exists.".to_string()
        } else {
            "Workspace directory is missing.".to_string()
        },
        suggestion: if live.workspace_ready {
            None
        } else {
            Some("Re-run node setup to create the workspace.".to_string())
        },
    });

    // 2. Config Ready
    checks.push(NodeReadinessCheck {
        id: "config_ready".to_string(),
        label: "Config Ready".to_string(),
        status: if live.config_ready { "pass" } else { "fail" }.to_string(),
        detail: if live.config_ready {
            "node.toml configuration file exists.".to_string()
        } else {
            "Configuration file is missing.".to_string()
        },
        suggestion: if live.config_ready {
            None
        } else {
            Some("Re-run node setup to generate configuration.".to_string())
        },
    });

    // 3. Wallet Generated
    checks.push(NodeReadinessCheck {
        id: "wallet_generated".to_string(),
        label: "Wallet Generated".to_string(),
        status: if live.wallet_ready { "pass" } else { "fail" }.to_string(),
        detail: if live.wallet_ready {
            format!("Identity file present. Address: {}", node.node_address)
        } else {
            "identity.json is missing from keys directory.".to_string()
        },
        suggestion: if live.wallet_ready {
            None
        } else {
            Some("Re-run node setup to generate wallet keys.".to_string())
        },
    });

    // 4. Canonical Genesis
    let workspace_directory = PathBuf::from(&node.workspace_directory);
    let genesis_path = workspace_directory.join("config").join("genesis.json");
    let genesis_contents = fs::read_to_string(&genesis_path).ok();
    let genesis_address_present = genesis_contents
        .as_deref()
        .map(|contents| contents.contains(&node.node_address))
        .unwrap_or(false);
    let canonical_genesis_ok = match (
        workspace_genesis_hash(&workspace_directory),
        canonical_testnet_genesis_hash(),
    ) {
        (Ok(actual), Ok(expected)) => actual.eq_ignore_ascii_case(&expected),
        _ => false,
    };
    let is_genesis_validator = role_supports_validator_registration(&node.role_id)
        && provisioned_node_uses_private_validator_mesh(node);
    let canonical_genesis_status = if is_genesis_validator {
        canonical_genesis_ok && genesis_address_present
    } else if role_supports_validator_registration(&node.role_id) {
        canonical_genesis_ok && !genesis_address_present
    } else {
        canonical_genesis_ok
    };
    checks.push(NodeReadinessCheck {
        id: "canonical_genesis".to_string(),
        label: "Canonical Genesis".to_string(),
        status: if canonical_genesis_status { "pass" } else { "fail" }.to_string(),
        detail: if canonical_genesis_status && is_genesis_validator {
            "Canonical chain 1264 genesis is present and includes this genesis validator address."
                .to_string()
        } else if canonical_genesis_status && role_supports_validator_registration(&node.role_id) {
            "Canonical chain 1264 genesis is present and does not include this non-genesis validator address."
                .to_string()
        } else if canonical_genesis_status {
            "Canonical chain 1264 genesis is present.".to_string()
        } else if is_genesis_validator {
            "Genesis validator workspace is missing the canonical genesis or its genesis address."
                .to_string()
        } else if role_supports_validator_registration(&node.role_id) && genesis_address_present {
            "This non-genesis validator address appears in genesis.json, which would create a non-canonical chain identity."
                .to_string()
        } else {
            "Canonical chain 1264 genesis is missing or has the wrong genesis hash.".to_string()
        },
        suggestion: if canonical_genesis_status {
            None
        } else if role_supports_validator_registration(&node.role_id) && genesis_address_present {
            Some("Do not edit genesis for new validators. Re-provision from the canonical Testnet bundle before starting this node.".to_string())
        } else {
            Some("Re-run setup with the updated Control Panel so the workspace receives the canonical chain 1264 genesis.".to_string())
        },
    });

    // 5. Process Running
    checks.push(NodeReadinessCheck {
        id: "process_running".to_string(),
        label: "Process Running".to_string(),
        status: if live.is_running { "pass" } else { "fail" }.to_string(),
        detail: if live.is_running {
            format!(
                "Node process is running (PID {}).",
                live.pid.map_or("?".to_string(), |p| p.to_string())
            )
        } else {
            "Node process is not running.".to_string()
        },
        suggestion: if live.is_running {
            None
        } else {
            Some("Start the node.".to_string())
        },
    });

    // 6. RPC Responding
    checks.push(NodeReadinessCheck {
        id: "rpc_responding".to_string(),
        label: "RPC Responding".to_string(),
        status: if live.local_rpc_ready {
            "pass"
        } else if live.is_running {
            "in_progress"
        } else {
            "fail"
        }
        .to_string(),
        detail: live.local_rpc_status.clone(),
        suggestion: if live.local_rpc_ready {
            None
        } else if live.is_running {
            Some("Node is starting up. RPC may take a moment to become ready.".to_string())
        } else {
            Some("Start the node first.".to_string())
        },
    });

    // 7. Peers Connected
    let peer_count = live.local_peer_count.unwrap_or(0);
    let peers_status = if peer_count >= 3 {
        "pass"
    } else if peer_count >= 1 {
        "warn"
    } else if live.is_running {
        "fail"
    } else {
        "skip"
    };
    checks.push(NodeReadinessCheck {
        id: "peers_connected".to_string(),
        label: "Peers Connected".to_string(),
        status: peers_status.to_string(),
        detail: if peer_count > 0 {
            format!("Connected to {peer_count} peer(s).")
        } else if live.is_running {
            "No peers connected.".to_string()
        } else {
            "Node is offline.".to_string()
        },
        suggestion: if peer_count >= 3 {
            None
        } else if peer_count >= 1 {
            Some(format!(
                "Only {peer_count} peer(s). Use Boost Sync to inject more peer addresses, or check firewall on port {p2p_port}."
            ))
        } else if live.is_running {
            Some(format!(
                "No peers found. Use Boost Sync to inject peer addresses, or verify firewall allows P2P traffic on port {p2p_port}."
            ))
        } else {
            None
        },
    });

    // 8. Validator Quorum / Mesh Status
    let is_validator = role_supports_validator_registration(&node.role_id);
    if is_validator {
        let required_validators = TESTNET_MIN_GENESIS_VALIDATORS;
        let mesh_required_validators = TESTNET_STATUS_READY_MIN_VALIDATORS;
        let connected_validators = live.connected_validator_count.unwrap_or(0);
        let status_ready_validators = live.status_ready_validator_count.unwrap_or(0);
        let uptime_secs = live.process_uptime_secs.unwrap_or(0);

        let live_validator_status = if !live.is_running {
            "skip"
        } else if connected_validators >= required_validators {
            "pass"
        } else if connected_validators > 0 && uptime_secs < 20 {
            "in_progress"
        } else {
            "fail"
        };
        checks.push(NodeReadinessCheck {
            id: "validator_live_quorum".to_string(),
            label: "Validator Quorum".to_string(),
            status: live_validator_status.to_string(),
            detail: if live.is_running {
                format!(
                    "{connected_validators}/{required_validators} validator participants are connected (including this node)."
                )
            } else {
                "Node is offline.".to_string()
            },
            suggestion: match live_validator_status {
                "fail" => Some(
                    "Consensus cannot start until all required validators are connected. Use Boost Sync, then verify each validator is running and its P2P port is reachable."
                        .to_string(),
                ),
                "in_progress" => Some(
                    "Validator sessions are still settling. If this does not reach full quorum within a few seconds, use Boost Sync."
                        .to_string(),
                ),
                _ => None,
            },
        });

        let mesh_status = if !live.is_running {
            "skip"
        } else if status_ready_validators >= mesh_required_validators {
            "pass"
        } else if status_ready_validators > 0 && uptime_secs < 20 {
            "in_progress"
        } else {
            "fail"
        };
        checks.push(NodeReadinessCheck {
            id: "validator_mesh_status".to_string(),
            label: "Validator Mesh Sync".to_string(),
            status: mesh_status.to_string(),
            detail: if live.is_running {
                format!(
                    "{status_ready_validators}/{mesh_required_validators} validators have completed handshake/status sync. Consensus will wait for the reduced status-ready gate before starting block production."
                )
            } else {
                "Node is offline.".to_string()
            },
            suggestion: match mesh_status {
                "fail" => Some(
                    "Validator sessions are connected but not fully status-synced. Use Rejoin to rebuild validator sessions; if the count stays low, run Boost Sync and inspect the validator logs for peer resets."
                        .to_string(),
                ),
                "in_progress" => Some(
                    "Validator handshake/status exchange is still in progress. If this stalls, use Rejoin."
                        .to_string(),
                ),
                _ => None,
            },
        });
    }

    // 9. Seed Registered
    let (seed_registered, seed_count) = if live.is_running {
        verify_node_seed_registration(client, seed_servers, &node.id, &node.node_address).await
    } else {
        (false, 0)
    };
    checks.push(NodeReadinessCheck {
        id: "seed_registered".to_string(),
        label: "Seed Registered".to_string(),
        status: if seed_registered {
            "pass"
        } else if live.is_running && live.local_peer_count.unwrap_or(0) > 0 {
            "warn"
        } else if live.is_running {
            "fail"
        } else {
            "skip"
        }
        .to_string(),
        detail: if seed_registered {
            format!("Registered with {seed_count} seed server(s).")
        } else if live.is_running && live.local_peer_count.unwrap_or(0) > 0 {
            "Seed registration is not reporting this node, but the node has live peers.".to_string()
        } else if live.is_running {
            "Not found in any seed server peer registry.".to_string()
        } else {
            "Node is offline.".to_string()
        },
        suggestion: if seed_registered {
            None
        } else if live.is_running && live.local_peer_count.unwrap_or(0) > 0 {
            Some("Keep direct validator peers healthy; seed registration is not required once peer visibility is established.".to_string())
        } else if live.is_running {
            Some("Re-register with seed servers.".to_string())
        } else {
            None
        },
    });

    // 10. Syncing / Synced
    let sync_status = match live.sync_gap {
        Some(gap) if gap <= TESTNET_ACTIVATION_MAX_SYNC_GAP => "pass",
        Some(_) if live.sync_trending == "improving" => "in_progress",
        Some(_) => "warn",
        None if live.is_running => "in_progress",
        _ => "skip",
    };
    let sync_detail = match live.sync_gap {
        Some(gap) if gap <= TESTNET_ACTIVATION_MAX_SYNC_GAP => {
            "Node is fully synced with the network.".to_string()
        }
        Some(gap) => {
            let mut parts = vec![format!("{gap} blocks behind")];
            if let Some(bps) = live.blocks_per_second {
                if bps > 0.01 {
                    parts.push(format!("{bps:.1} blocks/sec"));
                }
            }
            if let Some(eta) = live.estimated_sync_eta_secs {
                let mins = (eta + 59) / 60;
                parts.push(format!("~{mins} min remaining"));
            }
            parts.join(" \u{2022} ")
        }
        None if live.is_running => "Waiting for chain height data.".to_string(),
        _ => "Node is offline.".to_string(),
    };
    checks.push(NodeReadinessCheck {
        id: "synced".to_string(),
        label: "Synced".to_string(),
        status: sync_status.to_string(),
        detail: sync_detail,
        suggestion: match sync_status {
            "warn" => Some(
                "Sync appears stalled. Try Boost Sync to inject fresh peers and restart."
                    .to_string(),
            ),
            "in_progress" => Some("Sync is in progress. Blocks are being downloaded.".to_string()),
            _ => None,
        },
    });

    // 11. Scoring (validators only)
    if is_validator {
        let score_status = if live.synergy_score.unwrap_or(0.0) > 0.0 {
            "pass"
        } else if live.sync_gap.map_or(false, |g| g <= 5) {
            "warn"
        } else if live.is_running {
            "in_progress"
        } else {
            "skip"
        };
        checks.push(NodeReadinessCheck {
            id: "scoring".to_string(),
            label: "Scoring".to_string(),
            status: score_status.to_string(),
            detail: if live.synergy_score.unwrap_or(0.0) > 0.0 {
                format!(
                    "Synergy score: {:.2}/100. {}",
                    live.synergy_score.unwrap_or(0.0),
                    live.synergy_score_status
                )
            } else if live.is_running {
                "Waiting for synergy score. Node must be fully synced first.".to_string()
            } else {
                "Node is offline.".to_string()
            },
            suggestion: if score_status == "warn" {
                Some(
                    "Node is synced but score is zero. It may take a few epochs to register."
                        .to_string(),
                )
            } else {
                None
            },
        });
    }

    let ready_count = checks.iter().filter(|c| c.status == "pass").count();
    let total_count = checks.len();
    let overall_status = if ready_count == total_count {
        "ready"
    } else if checks.iter().any(|c| c.status == "fail") {
        "issues"
    } else if checks.iter().any(|c| c.status == "in_progress") {
        "progressing"
    } else {
        "issues"
    }
    .to_string();

    NodeReadinessReport {
        node_id: node.id.clone(),
        generated_at_utc: Utc::now().to_rfc3339(),
        overall_status,
        checks,
        ready_count,
        total_count,
    }
}

async fn query_synergy_score(client: &Client, address: &str) -> Result<f64, String> {
    query_synergy_score_from_endpoint(client, TESTNET_PUBLIC_RPC_ENDPOINT, address).await
}

async fn query_synergy_score_from_endpoint(
    client: &Client,
    endpoint: &str,
    address: &str,
) -> Result<f64, String> {
    let value = query_rpc_value(
        client,
        endpoint,
        "synergy_getSynergyScore",
        json!([address]),
    )
    .await?;

    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
        .ok_or_else(|| "Synergy score RPC returned a non-numeric payload.".to_string())
}

async fn query_synergy_score_from_validator_activity(
    client: &Client,
    endpoint: &str,
    address: &str,
) -> Result<f64, String> {
    let value =
        query_rpc_value(client, endpoint, "synergy_getValidatorActivity", json!([])).await?;

    value
        .get("validators")
        .and_then(Value::as_array)
        .and_then(|validators| {
            validators.iter().find_map(|entry| {
                let matches_address = entry
                    .get("address")
                    .and_then(Value::as_str)
                    .map(|candidate| candidate == address)
                    .unwrap_or(false);

                if !matches_address {
                    return None;
                }

                entry
                    .get("synergy_score")
                    .and_then(Value::as_f64)
                    .or_else(|| {
                        entry
                            .get("synergy_score")
                            .and_then(Value::as_str)
                            .and_then(|text| text.parse::<f64>().ok())
                    })
            })
        })
        .ok_or_else(|| {
            "Validator activity RPC did not include a synergy score for this address.".to_string()
        })
}

async fn query_local_chain_height(client: &Client, endpoint: &str) -> Result<u64, String> {
    let mut errors = Vec::new();

    for method in ["synergy_blockNumber", "synergy_getBlockNumber"] {
        match query_rpc_value(client, endpoint, method, json!([])).await {
            Ok(value) => match parse_rpc_block_height(value) {
                Ok(height) => return Ok(height),
                Err(error) => errors.push(format!("{method}: {error}")),
            },
            Err(error) => errors.push(format!("{method}: {error}")),
        }
    }

    match query_rpc_value(client, endpoint, "synergy_getLatestBlock", json!([])).await {
        Ok(value) => match parse_rpc_block_height(value) {
            Ok(height) => return Ok(height),
            Err(error) => errors.push(format!("synergy_getLatestBlock: {error}")),
        },
        Err(error) => errors.push(format!("synergy_getLatestBlock: {error}")),
    }

    Err(errors.join(" | "))
}

async fn resolve_synergy_score_status(
    client: &Client,
    role_id: &str,
    rpc_endpoint: &str,
    address: &str,
    is_running: bool,
    local_rpc_ready: bool,
) -> (Option<f64>, String) {
    if let Ok(score) = query_synergy_score(client, address).await {
        return (
            Some(score),
            format!("Live score {score:.2} from public RPC."),
        );
    }

    if let Ok(score) =
        query_synergy_score_from_validator_activity(client, TESTNET_PUBLIC_RPC_ENDPOINT, address)
            .await
    {
        return (
            Some(score),
            format!("Live score {score:.2} from public validator activity."),
        );
    }

    if role_supports_validator_registration(role_id) && is_running && local_rpc_ready {
        if let Ok(score) = query_synergy_score_from_endpoint(client, rpc_endpoint, address).await {
            return (
                Some(score),
                format!(
                    "Live score {score:.2} from local node RPC. Public RPC has not caught up yet."
                ),
            );
        }

        if let Ok(score) =
            query_synergy_score_from_validator_activity(client, rpc_endpoint, address).await
        {
            return (
                Some(score),
                format!("Live score {score:.2} from local validator activity. Public RPC has not caught up yet."),
            );
        }
    }

    if !role_supports_validator_registration(role_id) {
        return (
            None,
            "This role is running, but validator-style synergy scoring is not exposed for it."
                .to_string(),
        );
    }

    if is_running && !local_rpc_ready {
        return (
            None,
            format!(
                "Synergy score is not reporting because the local RPC is not responding on {rpc_endpoint}."
            ),
        );
    }

    if is_running {
        return (
            None,
            "Validator RPC is online, but synergy score telemetry is not exposed yet.".to_string(),
        );
    }

    (
        None,
        "Synergy score is not reporting from the public RPC yet.".to_string(),
    )
}

async fn query_rpc_value(
    client: &Client,
    endpoint: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let response = client
        .post(endpoint)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }))
        .send()
        .await
        .map_err(|error| format!("RPC request failed for {method}: {error}"))?;

    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("RPC response parse failed for {method}: {error}"))?;

    if let Some(error) = payload.get("error") {
        return Err(format!("RPC returned an error for {method}: {error}"));
    }

    payload
        .get("result")
        .cloned()
        .ok_or_else(|| format!("RPC response for {method} did not contain a result."))
}

fn rpc_error_is_transport_failure(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("error sending request")
        || lower.contains("connection refused")
        || lower.contains("tcp connect error")
        || lower.contains("dns error")
        || lower.contains("timed out")
}

fn parse_rpc_u64(value: Value) -> Result<u64, String> {
    if let Some(number) = value.as_u64() {
        return Ok(number);
    }

    if let Some(text) = value.as_str() {
        return if let Some(hex) = text.strip_prefix("0x") {
            u64::from_str_radix(hex, 16)
                .map_err(|error| format!("Failed to parse RPC hex number: {error}"))
        } else {
            text.parse::<u64>()
                .map_err(|error| format!("Failed to parse RPC decimal number: {error}"))
        };
    }

    Err("RPC numeric payload was neither a number nor a string.".to_string())
}

fn parse_rpc_block_height(value: Value) -> Result<u64, String> {
    if let Ok(height) = parse_rpc_u64(value.clone()) {
        return Ok(height);
    }

    if let Some(height_value) = value
        .get("block_index")
        .cloned()
        .or_else(|| value.get("number").cloned())
        .or_else(|| value.get("height").cloned())
    {
        return parse_rpc_u64(height_value);
    }

    Err("RPC block-height payload did not contain a numeric height.".to_string())
}

fn rpc_peer_entries(value: &Value) -> Option<&Vec<Value>> {
    value
        .get("peers")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
}

fn rpc_peer_identity(peer: &Value) -> Option<String> {
    for field in ["validator_address", "public_address", "address", "node_id"] {
        let value = peer
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(value) = value {
            return Some(value.to_string());
        }
    }

    None
}

fn parse_rpc_peer_summary(
    value: &Value,
    local_validator_address: Option<&str>,
) -> Result<RpcPeerSummary, String> {
    let mut unique_peers = HashSet::new();
    let mut connected_validators = HashSet::new();
    let mut status_ready_validators = HashSet::new();

    if let Some(address) = local_validator_address
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        connected_validators.insert(address.to_string());
        status_ready_validators.insert(address.to_string());
    }

    let explicit_peer_count = value
        .get("peer_count")
        .and_then(Value::as_u64)
        .map(|value| value as usize);

    if let Some(peers) = rpc_peer_entries(value) {
        for peer in peers {
            if let Some(identity) = rpc_peer_identity(peer) {
                unique_peers.insert(identity);
            }

            let Some(validator_address) = peer
                .get("validator_address")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };

            connected_validators.insert(validator_address.to_string());

            let has_remote_status = peer
                .get("genesis_hash")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some();
            if has_remote_status {
                status_ready_validators.insert(validator_address.to_string());
            }
        }
    } else if explicit_peer_count.is_none() {
        return Err("Peer RPC returned neither peer_count nor peers.".to_string());
    }

    Ok(RpcPeerSummary {
        peer_count: explicit_peer_count.unwrap_or(unique_peers.len()),
        connected_validator_count: connected_validators.len(),
        status_ready_validator_count: status_ready_validators.len(),
    })
}

fn parse_rpc_peer_count(value: Value) -> Result<usize, String> {
    parse_rpc_peer_summary(&value, None).map(|summary| summary.peer_count)
}

fn testnet_root_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Unable to resolve the current user home directory.".to_string())?;
    Ok(home.join(".synergy").join("testnet"))
}

fn ensure_testnet_root() -> Result<PathBuf, String> {
    let root = testnet_root_path()?;
    for path in [
        &root,
        &root.join("nodes"),
        &root.join("network"),
        &root.join("wallets"),
    ] {
        fs::create_dir_all(path)
            .map_err(|error| format!("Failed to create {}: {error}", path.display()))?;
    }
    Ok(root)
}

fn current_testnet_cleanup_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "linux" => "linux",
        "windows" => "windows",
        _ => "unknown",
    }
}

fn normalize_testnet_cleanup_platform(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "macos" | "darwin" | "mac" | "osx" => Ok("macos"),
        "linux" => Ok("linux"),
        "windows" | "win32" | "win" => Ok("windows"),
        other => Err(format!("Unsupported cleanup platform target: {other}")),
    }
}

fn candidate_local_testnet_cleanup_paths(app_context: &AppContext) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(home_dir) = dirs::home_dir().or_else(dirs::data_dir) {
        paths.push(home_dir.join(".synergy").join("node"));
        paths.push(
            home_dir
                .join(".synergy-node-control-panel")
                .join("monitor-workspace")
                .join("testnet"),
        );
        paths.push(
            home_dir
                .join(".synergy-testnet-control-panel")
                .join("monitor-workspace")
                .join("testnet"),
        );
        paths.push(
            home_dir
                .join(".synergy-node-monitor")
                .join("monitor-workspace")
                .join("testnet"),
        );
    }

    if let Some(app_data_dir) = app_context.app_data_dir() {
        paths.push(app_data_dir.join("monitor-workspace").join("testnet"));
    }

    let mut deduped = Vec::new();
    for path in paths {
        if deduped.iter().any(|existing| existing == &path) {
            continue;
        }
        deduped.push(path);
    }
    deduped
}

fn remove_path_if_exists(path: &Path, removed_paths: &mut Vec<String>) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Failed to remove {}: {error}", path.display()))?;
    } else {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to remove {}: {error}", path.display()))?;
    }

    removed_paths.push(path.to_string_lossy().to_string());
    Ok(())
}

fn process_matches_local_testnet_root(process: &sysinfo::Process, root: &Path) -> bool {
    let command_line = process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let process_name = process.name().to_string_lossy().to_ascii_lowercase();
    let executable = process
        .exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let root_text = root.to_string_lossy().to_string().to_ascii_lowercase();

    process_name.contains("synergy-testnet")
        || executable.contains("synergy-testnet")
        || command_line.contains("synergy-testnet")
        || (!root_text.is_empty() && command_line.contains(&root_text))
}

fn force_kill_testnet_processes_under_root(root: &Path) -> Result<usize, String> {
    let mut system = System::new_all();
    system.refresh_all();

    let pids = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            if process_matches_local_testnet_root(process, root) {
                Some(pid.as_u32())
            } else {
                None
            }
        })
        .collect::<HashSet<_>>();

    if pids.is_empty() {
        return Ok(0);
    }

    #[cfg(not(target_os = "windows"))]
    {
        for pid in &pids {
            let _ = ProcessCommand::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
        std::thread::sleep(Duration::from_millis(500));
        for pid in &pids {
            let _ = ProcessCommand::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    #[cfg(target_os = "windows")]
    {
        for pid in &pids {
            let _ = ProcessCommand::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F", "/T"])
                .status();
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    Ok(pids.len())
}

fn canonical_testnet_resource_roots() -> Vec<PathBuf> {
    let mut roots = AppContext::from_env().resource_roots().to_vec();
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));

    let mut deduped = Vec::new();
    for root in roots {
        if deduped.iter().any(|existing| existing == &root) {
            continue;
        }
        deduped.push(root);
    }
    deduped
}

fn resolve_canonical_testnet_resource(relatives: &[&str]) -> Option<PathBuf> {
    for root in canonical_testnet_resource_roots() {
        for relative in relatives {
            let candidate = root.join(relative);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn canonical_testnet_genesis_path() -> Result<PathBuf, String> {
    resolve_canonical_testnet_resource(&[
        "testnet/runtime/installers/GenVal-01/config/genesis.json",
        "testnet/runtime/installers/GenVal-02/config/genesis.json",
        "testnet/runtime/installers/GenVal-03/config/genesis.json",
        "testnet/runtime/installers/GenVal-04/config/genesis.json",
        "testnet/runtime/installers/GenVal-05/config/genesis.json",
        "config/genesis.json",
        "testnet/runtime/configs/genesis/genesis.json",
    ])
    .ok_or_else(|| {
        "Failed to resolve canonical Testnet genesis from bundled resources or source checkout."
            .to_string()
    })
}

fn canonical_testnet_operational_manifest_path() -> Result<PathBuf, String> {
    resolve_canonical_testnet_resource(&[
        "testnet/runtime/configs/operational/operational-manifest.json",
        "testnet/runtime/operational-manifest.json",
        "config/operational-manifest.json",
    ])
    .ok_or_else(|| {
        "Failed to resolve canonical Testnet operational manifest from bundled resources or source checkout."
            .to_string()
    })
}

fn canonical_setup_package_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in canonical_testnet_resource_roots() {
        for slot in 1..=TESTNET_VALIDATOR_CLUSTER_SIZE {
            candidates.push(root.join(format!(
                "testnet/runtime/installers/GenVal-{slot:02}/keys/setup-package.json"
            )));
        }
    }
    candidates
}

fn load_canonical_setup_package() -> Result<TestnetCeremonyPackage, String> {
    canonical_setup_package_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Failed to resolve a canonical validator setup package from bundled resources."
                .to_string()
        })
        .and_then(|path| load_ceremony_package(&path))
}

fn canonical_testnet_genesis_value() -> Result<Value, String> {
    if let Ok(path) = canonical_testnet_genesis_path() {
        return read_json_value(&path);
    }

    let package = load_canonical_setup_package()?;
    if package.artifacts.genesis.is_null() {
        return Err(
            "Canonical validator setup package is missing an embedded genesis artifact."
                .to_string(),
        );
    }
    Ok(package.artifacts.genesis)
}

fn canonical_testnet_operational_manifest_value() -> Result<Value, String> {
    if let Ok(path) = canonical_testnet_operational_manifest_path() {
        return read_json_value(&path);
    }

    let package = load_canonical_setup_package()?;
    if package.artifacts.operational_manifest.is_null() {
        return Err(
            "Canonical validator setup package is missing an embedded operational manifest."
                .to_string(),
        );
    }
    Ok(package.artifacts.operational_manifest)
}

fn read_json_value(path: &Path) -> Result<Value, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))
}

fn normalize_address_list(addresses: Vec<String>) -> Vec<String> {
    let mut normalized = addresses
        .into_iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn extract_validator_addresses_from_manifest_value(value: &Value) -> Vec<String> {
    normalize_address_list(
        value
            .get("validators")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("address").and_then(Value::as_str))
            .map(str::to_string)
            .collect(),
    )
}

fn canonical_testnet_genesis_hash() -> Result<String, String> {
    canonical_testnet_genesis_value()?
        .pointer("/integrity/genesis_hash")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Canonical genesis is missing integrity.genesis_hash.".to_string())
}

fn canonical_testnet_validator_addresses() -> Result<Vec<String>, String> {
    let manifest = canonical_testnet_operational_manifest_value()?;
    let addresses = extract_validator_addresses_from_manifest_value(&manifest);
    if !addresses.is_empty() {
        return Ok(addresses);
    }

    let package = load_canonical_setup_package()?;
    Ok(normalize_address_list(
        extract_ceremony_validator_allowlist(&package.artifacts),
    ))
}

fn is_canonical_genesis_validator_address(node_address: &str) -> bool {
    canonical_testnet_validator_peers()
        .iter()
        .any(|entry| entry.address.eq_ignore_ascii_case(node_address.trim()))
}

fn validator_uses_private_mesh(role_id: &str, node_address: &str) -> bool {
    role_supports_validator_registration(role_id)
        && is_canonical_genesis_validator_address(node_address)
}

fn provisioned_node_uses_private_validator_mesh(node: &TestnetProvisionedNode) -> bool {
    validator_uses_private_mesh(&node.role_id, &node.node_address)
}

fn canonical_validator_dial_targets(current_node_address: &str) -> Vec<String> {
    canonical_testnet_validator_peers()
        .into_iter()
        .filter(|entry| {
            !entry
                .address
                .eq_ignore_ascii_case(current_node_address.trim())
        })
        .map(|entry| canonical_validator_dial_target(&entry))
        .collect()
}

fn validate_validator_assigned_ports(
    assigned_ports: &TestnetCeremonyAssignedPorts,
) -> Result<(), String> {
    let expected = validator_runtime_ports();
    let mut failures = Vec::new();

    if assigned_ports.p2p_port != expected.p2p_port {
        failures.push(format!(
            "p2p_port must be {}, got {}",
            expected.p2p_port, assigned_ports.p2p_port
        ));
    }
    if assigned_ports
        .public_p2p_port
        .unwrap_or(assigned_ports.p2p_port)
        != expected.public_p2p_port
    {
        failures.push(format!(
            "public_p2p_port must be {}, got {}",
            expected.public_p2p_port,
            assigned_ports
                .public_p2p_port
                .unwrap_or(assigned_ports.p2p_port)
        ));
    }
    if assigned_ports.rpc_port != expected.rpc_port {
        failures.push(format!(
            "rpc_port must be {}, got {}",
            expected.rpc_port, assigned_ports.rpc_port
        ));
    }
    if assigned_ports.ws_port != expected.ws_port {
        failures.push(format!(
            "ws_port must be {}, got {}",
            expected.ws_port, assigned_ports.ws_port
        ));
    }
    if assigned_ports.grpc_port != expected.rpc_port {
        failures.push(format!(
            "grpc_port must be {}, got {}",
            expected.rpc_port, assigned_ports.grpc_port
        ));
    }
    if assigned_ports.discovery_port != expected.discovery_port {
        failures.push(format!(
            "discovery_port must be {}, got {}",
            expected.discovery_port, assigned_ports.discovery_port
        ));
    }
    if assigned_ports
        .public_discovery_port
        .unwrap_or(assigned_ports.discovery_port)
        != expected.public_discovery_port
    {
        failures.push(format!(
            "public_discovery_port must be {}, got {}",
            expected.public_discovery_port,
            assigned_ports
                .public_discovery_port
                .unwrap_or(assigned_ports.discovery_port)
        ));
    }
    if assigned_ports.metrics_port != expected.metrics_port {
        failures.push(format!(
            "metrics_port must be {}, got {}",
            expected.metrics_port, assigned_ports.metrics_port
        ));
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Validator package ports do not match the frozen runtime ports:\n- {}",
            failures.join("\n- ")
        ))
    }
}

fn network_profile_path(root: &Path) -> PathBuf {
    root.join("network").join("profile.json")
}

fn registry_path(root: &Path) -> PathBuf {
    root.join("network").join("registry.json")
}

fn write_genesis_json_for_workspace(
    _all_nodes: &[TestnetProvisionedNode],
    workspace_directory: &Path,
) -> Result<(), String> {
    let config_dir = workspace_directory.join("config");
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    write_json_file(
        &config_dir.join("genesis.json"),
        &canonical_testnet_genesis_value()?,
    )
}

fn write_operational_manifest_for_workspace(workspace_directory: &Path) -> Result<(), String> {
    let config_dir = workspace_directory.join("config");
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    write_json_file(
        &config_dir.join("operational-manifest.json"),
        &canonical_testnet_operational_manifest_value()?,
    )
}

fn write_canonical_workspace_manifests(workspace_directory: &Path) -> Result<(), String> {
    write_genesis_json_for_workspace(&[], workspace_directory)?;
    write_operational_manifest_for_workspace(workspace_directory)
}

#[derive(Debug, Clone)]
struct CanonicalValidatorPeer {
    slot: u64,
    address: String,
    private_host: String,
}

#[derive(Debug, Clone)]
struct CanonicalSentryPeer {
    label: String,
    public_host: String,
    _private_host: String,
    port: u16,
}

fn canonical_public_p2p_port_for_validator_slot(slot: u64) -> u16 {
    let _ = slot;
    TESTNET_P2P_PORT
}

fn fallback_validator_private_host_for_slot(slot: u64) -> Option<&'static str> {
    match slot {
        1 => Some("10.69.0.1"),
        2 => Some("10.69.0.2"),
        3 => Some("10.69.0.3"),
        4 => Some("10.69.0.4"),
        5 => Some("10.69.0.5"),
        6 => Some("10.69.0.6"),
        7 => Some("10.69.0.7"),
        _ => None,
    }
}

fn parse_canonical_validator_peer(entry: &Value) -> Option<CanonicalValidatorPeer> {
    let slot = entry.get("slot").and_then(Value::as_u64)?;
    let address = entry
        .get("address")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let private_host = entry
        .get("private_host")
        .and_then(Value::as_str)
        .or_else(|| entry.get("private_ip").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| fallback_validator_private_host_for_slot(slot).map(str::to_string))?;
    Some(CanonicalValidatorPeer {
        slot,
        address,
        private_host,
    })
}

fn canonical_validator_peers_from_manifest_path(path: &Path) -> Vec<CanonicalValidatorPeer> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(_) => return Vec::new(),
    };
    let value: Value = match serde_json::from_str(&contents) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    value
        .get("validators")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_canonical_validator_peer)
        .collect()
}

fn canonical_validator_peers_from_manifest_value(value: &Value) -> Vec<CanonicalValidatorPeer> {
    value
        .get("validators")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_canonical_validator_peer)
        .collect()
}

fn canonical_testnet_validator_peers() -> Vec<CanonicalValidatorPeer> {
    if let Ok(path) = canonical_testnet_operational_manifest_path() {
        let peers = canonical_validator_peers_from_manifest_path(&path);
        if !peers.is_empty() {
            return peers;
        }
    }

    canonical_testnet_operational_manifest_value()
        .ok()
        .map(|value| canonical_validator_peers_from_manifest_value(&value))
        .unwrap_or_default()
}

fn canonical_validator_peers_for_workspace(
    workspace_directory: &Path,
) -> Vec<CanonicalValidatorPeer> {
    canonical_validator_peers_from_manifest_path(
        &workspace_directory
            .join("config")
            .join("operational-manifest.json"),
    )
}

fn canonical_validator_dial_target(entry: &CanonicalValidatorPeer) -> String {
    format!(
        "{}:{}",
        entry.private_host,
        canonical_public_p2p_port_for_validator_slot(entry.slot)
    )
}

fn canonical_validator_dial_targets_toml(
    peers: &[CanonicalValidatorPeer],
    current_node_address: &str,
) -> String {
    peers
        .iter()
        .filter(|entry| {
            !entry
                .address
                .eq_ignore_ascii_case(current_node_address.trim())
        })
        .map(|entry| {
            format!(
                "\"snr://{}@{}\"",
                entry.address,
                canonical_validator_dial_target(entry)
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn canonical_validator_allowlist(peers: &[CanonicalValidatorPeer]) -> String {
    format!(
        "[{}]",
        peers
            .iter()
            .map(|entry| format!("\"{}\"", entry.address))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn canonical_validator_dial_targets_for_workspace(
    workspace_directory: &Path,
    current_node_address: &str,
) -> Vec<String> {
    canonical_validator_peers_for_workspace(workspace_directory)
        .into_iter()
        .filter(|entry| {
            !entry
                .address
                .eq_ignore_ascii_case(current_node_address.trim())
        })
        .map(|entry| canonical_validator_dial_target(&entry))
        .collect()
}

fn canonical_validator_dial_target_for_address(
    workspace_directory: &Path,
    validator_address: &str,
) -> Option<String> {
    canonical_validator_peers_for_workspace(workspace_directory)
        .into_iter()
        .find(|entry| entry.address.eq_ignore_ascii_case(validator_address.trim()))
        .map(|entry| canonical_validator_dial_target(&entry))
}

fn canonical_bootstrap_dns_record() -> String {
    canonical_testnet_operational_manifest_value()
        .ok()
        .and_then(|value| {
            value
                .pointer("/bootstrap/dns/bootstrap_txt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| TESTNET_BOOTSTRAP_DNS_RECORD.to_string())
}

fn bootstrap_endpoints_from_manifest(kind: &str) -> Option<Vec<TestnetBootstrapEndpoint>> {
    let pointer = if kind.eq_ignore_ascii_case("seed") {
        "/bootstrap/seed_servers"
    } else {
        "/bootstrap/bootnodes"
    };
    let endpoint_kind = if kind.eq_ignore_ascii_case("seed") {
        "seed"
    } else {
        "bootnode"
    };
    let default_port = if kind.eq_ignore_ascii_case("seed") {
        TESTNET_SEED_PORT
    } else {
        TESTNET_BOOTNODE_PORT
    };
    let dns_mode = if kind.eq_ignore_ascii_case("seed") {
        "A / SRV / HTTP"
    } else {
        "A / dnsaddr"
    };

    let endpoints = canonical_testnet_operational_manifest_value()
        .ok()
        .and_then(|value| value.pointer(pointer).cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let host = entry
                .get("host")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?
                .to_string();
            let ip_address = entry
                .get("ip_address")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?
                .to_string();
            let port = entry
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(default_port);
            Some(TestnetBootstrapEndpoint {
                kind: endpoint_kind.to_string(),
                host,
                ip_address,
                port,
                dns_mode: dns_mode.to_string(),
            })
        })
        .collect::<Vec<_>>();

    if endpoints.is_empty() {
        None
    } else {
        Some(endpoints)
    }
}

fn canonical_sentry_peers() -> Vec<CanonicalSentryPeer> {
    canonical_testnet_operational_manifest_value()
        .ok()
        .and_then(|value| value.pointer("/bootstrap/sentries").cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let label = entry
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?
                .to_string();
            let public_host = entry
                .get("public_host")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?
                .to_string();
            let private_host = entry
                .get("private_host")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?
                .to_string();
            let port = entry
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(TESTNET_P2P_PORT);

            Some(CanonicalSentryPeer {
                label,
                public_host,
                _private_host: private_host,
                port,
            })
        })
        .collect()
}

fn role_uses_sentry_upstreams(role_id: &str) -> bool {
    matches!(role_id, "rpc_gateway" | "indexer" | "observer")
}

fn canonical_sentry_labels_for_role(role_id: &str) -> Vec<String> {
    let pointer = format!("/bootstrap/routing/{role_id}");
    let labels = canonical_testnet_operational_manifest_value()
        .ok()
        .and_then(|value| value.pointer(&pointer).cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| entry.as_str().map(str::trim).map(str::to_string))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();

    if !labels.is_empty() {
        return labels;
    }

    match role_id {
        "validator" | "rpc_gateway" | "indexer" | "observer" => {
            vec!["sentry1".to_string(), "sentry2".to_string()]
        }
        _ => Vec::new(),
    }
}

fn canonical_sentry_public_dial_targets_for_role(role_id: &str) -> Vec<String> {
    let sentries = canonical_sentry_peers();
    let routed_labels = canonical_sentry_labels_for_role(role_id);
    let mut targets = sentries
        .into_iter()
        .filter(|entry| routed_labels.iter().any(|label| label == &entry.label))
        .map(|entry| format!("{}:{}", entry.public_host, entry.port))
        .collect::<Vec<_>>();
    targets.sort();
    targets.dedup();
    targets
}

fn canonical_public_validator_dial_targets() -> Vec<String> {
    let mut targets = canonical_sentry_public_dial_targets_for_role("validator");
    targets.sort();
    targets.dedup();
    targets
}

fn render_toml_string_array(values: &[String]) -> String {
    values
        .iter()
        .map(|value| format!("\"{}\"", value.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(", ")
}

fn load_or_create_network_profile(root: &Path) -> Result<TestnetNetworkProfile, String> {
    let path = network_profile_path(root);
    if path.is_file() {
        let contents = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        return serde_json::from_str(&contents)
            .map_err(|error| format!("Failed to parse {}: {error}", path.display()));
    }

    let wallets_root = root.join("wallets");
    let treasury_wallet = generate_wallet_files(
        &wallets_root.join("treasury"),
        "Testnet Treasury",
        AddressType::MultisigTreasury,
    )?;
    let faucet_wallet = generate_wallet_files(
        &wallets_root.join("faucet"),
        "Testnet Faucet",
        AddressType::WalletUtility,
    )?;
    let stake_vault_wallet = generate_wallet_files(
        &wallets_root.join("stake-vault"),
        "Testnet Stake Vault",
        AddressType::MultisigValidator,
    )?;
    let now = Utc::now().to_rfc3339();
    let profile = TestnetNetworkProfile {
        version: STATE_VERSION,
        environment_id: TESTNET_ENVIRONMENT_ID.to_string(),
        display_name: TESTNET_DISPLAY_NAME.to_string(),
        chain_name: TESTNET_CHAIN_NAME.to_string(),
        chain_id: TESTNET_CHAIN_ID,
        token_symbol: TOKEN_SYMBOL.to_string(),
        token_decimals: TOKEN_DECIMALS,
        treasury_wallet,
        faucet_wallet,
        stake_vault_wallet,
        genesis_mints: vec![
            TestnetGenesisMint {
                label: "Treasury".to_string(),
                wallet_address: String::new(),
                amount_snrg: format_amount(TREASURY_SUPPLY_SNRG),
                amount_nwei: amount_to_nwei_string(TREASURY_SUPPLY_SNRG),
            },
            TestnetGenesisMint {
                label: "Faucet".to_string(),
                wallet_address: String::new(),
                amount_snrg: format_amount(FAUCET_SUPPLY_SNRG),
                amount_nwei: amount_to_nwei_string(FAUCET_SUPPLY_SNRG),
            },
            TestnetGenesisMint {
                label: "Stake Vault".to_string(),
                wallet_address: String::new(),
                amount_snrg: format_amount(0),
                amount_nwei: amount_to_nwei_string(0),
            },
        ],
        bootnodes: bootstrap_endpoints("bootnode"),
        seed_servers: bootstrap_endpoints("seed"),
        bootstrap_policy: TestnetConnectivityPolicy {
            blocks_dashboard_access: false,
            bootstrap_requirement: "warn-and-continue".to_string(),
            fallback_sequence: vec![
                "hardcoded-bootnodes".to_string(),
                "dnsaddr-bootstrap-records".to_string(),
                "signed-seedlist".to_string(),
                "cached-peerstore".to_string(),
            ],
            note: "Provisioning does not block on bootstrap reachability, but generated nodes are configured to use bootnodes, dnsaddr records, and seed services immediately.".to_string(),
        },
        funding_manifests: Vec::new(),
        created_at_utc: now.clone(),
        updated_at_utc: now,
    };

    let mut finalized = profile;
    finalized.genesis_mints[0].wallet_address = finalized.treasury_wallet.address.clone();
    finalized.genesis_mints[1].wallet_address = finalized.faucet_wallet.address.clone();
    finalized.genesis_mints[2].wallet_address = finalized.stake_vault_wallet.address.clone();
    save_network_profile(root, &finalized)?;
    Ok(finalized)
}

fn save_network_profile(root: &Path, profile: &TestnetNetworkProfile) -> Result<(), String> {
    let path = network_profile_path(root);
    let contents = serde_json::to_string_pretty(profile)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    write_file(&path, &contents)
}

fn load_registry(root: &Path) -> Result<TestnetRegistryFile, String> {
    let path = registry_path(root);
    if !path.is_file() {
        return Ok(TestnetRegistryFile {
            version: STATE_VERSION,
            nodes: Vec::new(),
        });
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let mut registry: TestnetRegistryFile = serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
    normalize_registry_port_slots(&mut registry.nodes);
    Ok(registry)
}

fn save_registry(root: &Path, registry: &TestnetRegistryFile) -> Result<(), String> {
    let path = registry_path(root);
    let contents = serde_json::to_string_pretty(registry)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    write_file(&path, &contents)
}

fn normalize_registry_port_slots(nodes: &mut [TestnetProvisionedNode]) {
    let mut used_slots = std::collections::BTreeSet::new();

    for node in nodes {
        let slot = match node.port_slot {
            Some(slot) if used_slots.insert(slot) => slot,
            _ => {
                let next_slot = next_available_port_slot_from_used(&used_slots);
                used_slots.insert(next_slot);
                next_slot
            }
        };
        node.port_slot = Some(slot);
    }
}

fn next_available_port_slot(nodes: &[TestnetProvisionedNode]) -> u16 {
    let mut used_slots = std::collections::BTreeSet::new();
    for node in nodes {
        if let Some(slot) = node.port_slot {
            used_slots.insert(slot);
        }
    }
    next_available_port_slot_from_used(&used_slots)
}

fn next_available_port_slot_from_used(used_slots: &std::collections::BTreeSet<u16>) -> u16 {
    let mut slot = 0_u16;
    while used_slots.contains(&slot) {
        slot = slot.saturating_add(1);
    }
    slot
}

fn detect_device_profile() -> TestnetDeviceProfile {
    let mut system = System::new_all();
    system.refresh_all();

    let disks = Disks::new_with_refreshed_list();
    let available_disk_gb =
        disks.iter().map(|disk| disk.available_space()).sum::<u64>() / 1024 / 1024 / 1024;

    TestnetDeviceProfile {
        hostname: System::host_name().unwrap_or_else(|| "unknown-host".to_string()),
        username: std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_else(|_| "unknown-user".to_string()),
        operating_system: System::long_os_version()
            .or_else(System::name)
            .unwrap_or_else(|| std::env::consts::OS.to_string()),
        architecture: std::env::consts::ARCH.to_string(),
        cpu_cores: system.cpus().len(),
        total_memory_gb: system.total_memory() / 1024 / 1024 / 1024,
        available_disk_gb,
        home_directory: dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .to_string_lossy()
            .to_string(),
    }
}

async fn detect_public_host() -> Option<String> {
    if let Ok(override_value) = std::env::var("SYNERGY_TESTNET_PUBLIC_HOST") {
        if let Some(host) = normalize_public_host_candidate(&override_value) {
            return Some(host);
        }
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()?;

    for endpoint in [
        "https://api.ipify.org",
        "https://api4.ipify.org",
        "https://ifconfig.me/ip",
    ] {
        let response = match client
            .get(endpoint)
            .header("User-Agent", "Synergy-Node-Control-Panel/5.0.0")
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => response,
            _ => continue,
        };

        let body = match response.text().await {
            Ok(body) => body,
            Err(_) => continue,
        };

        if let Some(host) = normalize_public_host_candidate(&body) {
            return Some(host);
        }
    }

    None
}

fn normalize_public_host_candidate(value: &str) -> Option<String> {
    let mut trimmed = value.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return None;
    }

    if let Some((_, rest)) = trimmed.split_once("://") {
        trimmed = rest
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default()
            .to_string();
    }

    if trimmed.starts_with('[') {
        let closing = trimmed.find(']')?;
        trimmed = trimmed[1..closing].to_string();
    } else if trimmed.matches(':').count() == 1 {
        if let Some((host, port)) = trimmed.rsplit_once(':') {
            if port.chars().all(|ch| ch.is_ascii_digit()) {
                trimmed = host.to_string();
            }
        }
    }

    let trimmed = trimmed.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('@') {
        return None;
    }

    if trimmed.parse::<IpAddr>().is_ok() {
        return Some(trimmed);
    }

    let valid = trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '.');

    if !valid || !trimmed.contains('.') || trimmed.starts_with('.') || trimmed.ends_with('.') {
        return None;
    }

    Some(trimmed)
}

fn is_publicly_routable_host(value: &str) -> bool {
    let Some(host) = normalize_public_host_candidate(value) else {
        return false;
    };

    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(addr) => {
                let [first, second, third, _] = addr.octets();
                first != 0
                    && first != 10
                    && first != 127
                    && first < 224
                    && !(first == 100 && (64..=127).contains(&second))
                    && !(first == 169 && second == 254)
                    && !(first == 172 && (16..=31).contains(&second))
                    && !(first == 192 && second == 0 && third == 0)
                    && !(first == 192 && second == 0 && third == 2)
                    && !(first == 192 && second == 168)
                    && !(first == 198 && (second == 18 || second == 19))
                    && !(first == 198 && second == 51 && third == 100)
                    && !(first == 203 && second == 0 && third == 113)
            }
            IpAddr::V6(addr) => {
                let segments = addr.segments();
                let first = segments[0];
                !addr.is_loopback()
                    && !addr.is_unspecified()
                    && (first & 0xffc0) != 0xfe80
                    && (first & 0xfe00) != 0xfc00
                    && (first & 0xff00) != 0xff00
                    && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
            }
        };
    }

    host != "localhost" && !host.ends_with(".local")
}

fn normalize_endpoint_host(value: &str) -> Option<String> {
    let trimmed = value
        .trim()
        .trim_matches('[')
        .trim_matches(']')
        .trim_end_matches('.')
        .trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn endpoint_host_candidates(
    endpoint: &TestnetBootstrapEndpoint,
    prefer_ip_address: bool,
) -> Vec<String> {
    let ordered = if prefer_ip_address {
        [&endpoint.ip_address, &endpoint.host]
    } else {
        [&endpoint.host, &endpoint.ip_address]
    };
    let mut candidates = Vec::new();
    for value in ordered {
        let Some(normalized) = normalize_endpoint_host(value) else {
            continue;
        };
        if !candidates.iter().any(|existing| existing == &normalized) {
            candidates.push(normalized);
        }
    }
    candidates
}

fn preferred_seed_service_host(endpoint: &TestnetBootstrapEndpoint) -> Option<String> {
    endpoint_host_candidates(endpoint, false).into_iter().next()
}

fn seed_service_urls(endpoint: &TestnetBootstrapEndpoint, path: &str) -> Vec<String> {
    let normalized_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    endpoint_host_candidates(endpoint, false)
        .into_iter()
        .map(|host| format!("http://{host}:{}{}", endpoint.port, normalized_path))
        .collect()
}

async fn fetch_seed_peers(client: &Client, seed: &TestnetBootstrapEndpoint) -> Option<Vec<Value>> {
    for url in seed_service_urls(seed, "/peers") {
        let response = match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => response,
            Ok(_) => continue,
            Err(_) => continue,
        };

        let payload: Value = match response.json().await {
            Ok(payload) => payload,
            Err(_) => continue,
        };

        if let Some(peers) = payload.get("peers").and_then(Value::as_array).cloned() {
            return Some(peers);
        }
    }

    None
}

async fn post_seed_json(
    client: &Client,
    seed: &TestnetBootstrapEndpoint,
    path: &str,
    payload: &(impl Serialize + ?Sized),
) -> Result<(), String> {
    let mut errors = Vec::new();
    for url in seed_service_urls(seed, path) {
        match client.post(&url).json(payload).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                errors.push(format!("{url}: HTTP {}", response.status()));
            }
            Err(error) => {
                errors.push(format!("{url}: {error}"));
            }
        }
    }

    Err(if errors.is_empty() {
        format!("No usable seed endpoints were available for {path}.")
    } else {
        errors.join("; ")
    })
}

#[derive(Debug, Serialize)]
struct SeedPeerRegistration {
    node_id: String,
    role_id: String,
    role_display_name: String,
    wallet_address: String,
    public_host: String,
    p2p_port: u16,
    dial: String,
    chain_id: u64,
    registered_at_utc: String,
}

fn build_seed_registration(
    node: &TestnetProvisionedNode,
    public_host: &str,
) -> SeedPeerRegistration {
    let p2p_port = read_runtime_ports_for_node(node)
        .map(|ports| ports.public_p2p_port)
        .unwrap_or_else(|| default_runtime_ports_for_node(node).public_p2p_port);
    let dial = format!("snr://{}@{}:{}", node.node_address, public_host, p2p_port);
    SeedPeerRegistration {
        node_id: if node.role_id == "validator" {
            node.node_address.clone()
        } else {
            node.id.clone()
        },
        role_id: node.role_id.clone(),
        role_display_name: node.role_display_name.clone(),
        wallet_address: node.node_address.clone(),
        public_host: public_host.to_string(),
        p2p_port,
        dial,
        chain_id: TESTNET_CHAIN_ID,
        registered_at_utc: Utc::now().to_rfc3339(),
    }
}

/// Returns `"127.0.0.1:<p2p_port>"` for every provisioned node on this
/// machine that is NOT `current_node_id`.  These targets let validators on the
/// same host peer with each other directly, bypassing the NAT / public-IP
/// loop-back problem that would otherwise prevent seed-server–sourced addresses
/// from working.
fn local_sibling_dial_targets(
    all_nodes: &[TestnetProvisionedNode],
    current_node_id: &str,
) -> Vec<String> {
    all_nodes
        .iter()
        .filter(|n| n.id != current_node_id)
        .filter_map(|n| {
            let port = read_runtime_ports_for_node(n)
                .map(|ports| ports.p2p_port)
                .or_else(|| {
                    n.port_slot
                        .map(|slot| TESTNET_P2P_PORT.saturating_add(slot))
                })?;
            Some(format!("127.0.0.1:{port}"))
        })
        .collect()
}

/// Reads the `global.additional_dial_targets` array from an existing
/// peers.toml file.  Returns an empty vec if the file is missing or malformed.
fn read_peers_toml_additional_targets(peers_toml_path: &Path) -> Vec<String> {
    let contents = match fs::read_to_string(peers_toml_path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let value: toml::Value = match toml::from_str(&contents) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    value
        .get("global")
        .and_then(|g| g.get("additional_dial_targets"))
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

async fn register_node_with_seeds_async(
    network_profile: &TestnetNetworkProfile,
    node: &TestnetProvisionedNode,
) -> Result<usize, String> {
    let public_host = match node
        .public_host
        .as_deref()
        .and_then(normalize_public_host_candidate)
    {
        Some(host) => host,
        None => detect_public_host()
            .await
            .and_then(|host| normalize_public_host_candidate(&host))
            .ok_or_else(|| "Public host was not detected for seed registration.".to_string())?,
    };
    let payload = build_seed_registration(node, &public_host);

    let client = Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))?;

    let mut errors = Vec::new();
    let mut registered_count = 0usize;
    for seed in &network_profile.seed_servers {
        if let Err(error) = post_seed_json(&client, seed, "/peers/register", &payload).await {
            errors.push(error);
        } else {
            registered_count += 1;
        }
    }

    if registered_count > 0 {
        Ok(registered_count)
    } else {
        Err(format!(
            "Seed registration failed for {} endpoint(s): {}",
            errors.len(),
            errors.join("; ")
        ))
    }
}

async fn register_node_with_seeds_best_effort(
    network_profile: &TestnetNetworkProfile,
    node: &TestnetProvisionedNode,
) {
    let _ = register_node_with_seeds_async(network_profile, node).await;
}

fn bootstrap_endpoints(kind: &str) -> Vec<TestnetBootstrapEndpoint> {
    if let Some(endpoints) = bootstrap_endpoints_from_manifest(kind) {
        return endpoints;
    }

    let host_prefix = if kind.eq_ignore_ascii_case("seed") {
        "seed"
    } else {
        "bootnode"
    };
    let is_seed = kind.eq_ignore_ascii_case("seed");
    let port = if is_seed {
        TESTNET_SEED_PORT
    } else {
        TESTNET_BOOTNODE_PORT
    };
    let dns_mode = if is_seed {
        "A / SRV / HTTP".to_string()
    } else {
        "A / dnsaddr".to_string()
    };

    vec![
        TestnetBootstrapEndpoint {
            kind: host_prefix.to_string(),
            host: if is_seed {
                "seed1.synergynode.xyz".to_string()
            } else {
                "bootnode1.synergynode.xyz".to_string()
            },
            ip_address: "170.64.187.206".to_string(),
            port,
            dns_mode: dns_mode.clone(),
        },
        TestnetBootstrapEndpoint {
            kind: host_prefix.to_string(),
            host: if is_seed {
                "seed2.synergynode.xyz".to_string()
            } else {
                "bootnode2.synergynode.xyz".to_string()
            },
            ip_address: "146.190.210.121".to_string(),
            port,
            dns_mode: dns_mode.clone(),
        },
        TestnetBootstrapEndpoint {
            kind: host_prefix.to_string(),
            host: if is_seed {
                "seed3.synergynode.xyz".to_string()
            } else {
                "bootnode3.synergynode.xyz".to_string()
            },
            ip_address: "157.245.226.240".to_string(),
            port,
            dns_mode,
        },
    ]
}

fn generate_wallet_files(
    wallet_directory: &Path,
    label: &str,
    address_type: AddressType,
) -> Result<TestnetWalletRecord, String> {
    fs::create_dir_all(wallet_directory)
        .map_err(|error| format!("Failed to create {}: {error}", wallet_directory.display()))?;
    let identity = generate_identity(address_type)?;
    persist_identity(wallet_directory, label, identity, None)
}

fn generate_node_wallet(
    role: &TestnetRoleProfile,
    keys_directory: &Path,
    identity_passphrase: Option<&str>,
) -> Result<GeneratedWalletFiles, String> {
    let address_type = node_address_type_for_role(role);

    let label = format!("{} Reward Wallet", role.display_name);
    let identity = generate_identity(address_type)?;
    Ok(GeneratedWalletFiles {
        wallet: persist_identity(keys_directory, &label, identity, identity_passphrase)?,
    })
}

fn node_address_type_for_role(role: &TestnetRoleProfile) -> AddressType {
    match role.class_id {
        1 => AddressType::NodeClass1,
        2 => AddressType::NodeClass2,
        3 => AddressType::NodeClass3,
        4 => AddressType::NodeClass4,
        5 => AddressType::NodeClass5,
        _ => AddressType::WalletPrimary,
    }
}

fn validate_node_address_for_role(role: &TestnetRoleProfile, address: &str) -> Result<(), String> {
    let expected_prefix = node_address_type_for_role(role).prefix();
    if !address.starts_with(expected_prefix) {
        return Err(format!(
            "{} requires an address with the '{}' prefix. The generated or imported address '{}' has the wrong address type.",
            role.display_name, expected_prefix, address
        ));
    }
    if address.len() != TARGET_ADDRESS_LEN || !is_valid_address(address) {
        return Err(format!(
            "{} generated or imported address '{}' is not a canonical {TARGET_ADDRESS_LEN}-character Synergy Bech32m address.",
            role.display_name, address
        ));
    }

    Ok(())
}

fn persist_identity(
    directory: &Path,
    label: &str,
    identity: SynergyIdentity,
    identity_passphrase: Option<&str>,
) -> Result<TestnetWalletRecord, String> {
    let public_key_path = directory.join("public.key");
    let private_key_path = directory.join("private.key");
    let metadata_path = directory.join("identity.json");
    let encrypted_private_key_path = directory.join("private.key.enc");
    let address_path = directory.join("address.txt");

    write_file(&public_key_path, identity.public_key.as_str())?;
    write_private_key_file(&private_key_path, identity.private_key.as_str())?;
    write_file(&address_path, identity.address.as_str())?;
    let encrypted_private_key_written = if let Some(passphrase) = identity_passphrase {
        write_encrypted_private_key_export(
            &encrypted_private_key_path,
            &identity.address,
            identity.private_key.as_str(),
            passphrase,
        )?;
        true
    } else {
        false
    };
    let metadata_contents = serde_json::to_string_pretty(&serde_json::json!({
        "label": label,
        "address": identity.address,
        "address_type": identity.address_type,
        "algorithm": identity.algorithm,
        "created_at": identity.created_at,
        "public_key": identity.public_key,
        "private_key_path": "private.key",
        "encrypted_private_key_path": if encrypted_private_key_written { Some("private.key.enc") } else { None::<&str> },
        "passphrase_required": encrypted_private_key_written,
    }))
    .map_err(|error| format!("Failed to serialize identity metadata: {error}"))?;
    write_file(&metadata_path, &metadata_contents)?;

    Ok(TestnetWalletRecord {
        label: label.to_string(),
        address: identity.address,
        address_type: identity.address_type,
        public_key_path: public_key_path.to_string_lossy().to_string(),
        private_key_path: private_key_path.to_string_lossy().to_string(),
    })
}

fn write_private_key_file(path: &Path, contents: &str) -> Result<(), String> {
    write_file(path, contents)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            format!(
                "Failed to restrict private key permissions for {}: {error}",
                path.display()
            )
        })?;
    }

    Ok(())
}

fn write_encrypted_private_key_export(
    path: &Path,
    address: &str,
    private_key: &str,
    passphrase: &str,
) -> Result<(), String> {
    let salt: [u8; 16] = rand::random();
    let nonce: [u8; 12] = rand::random();
    let mut key = [0u8; 32];
    let iterations = 210_000u32;
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), &salt, iterations, &mut key);

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("Failed to initialize validator key encryption: {error}"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), private_key.as_bytes())
        .map_err(|error| format!("Failed to encrypt validator private key: {error:?}"))?;

    let encrypted = json!({
        "version": 1,
        "address": address,
        "cipher": "AES-256-GCM",
        "kdf": "PBKDF2-HMAC-SHA256",
        "iterations": iterations,
        "salt": general_purpose::STANDARD.encode(salt),
        "nonce": general_purpose::STANDARD.encode(nonce),
        "ciphertext": general_purpose::STANDARD.encode(ciphertext),
        "created_at": Utc::now().to_rfc3339(),
    });
    let contents = serde_json::to_string_pretty(&encrypted)
        .map_err(|error| format!("Failed to serialize encrypted private key: {error}"))?;
    write_private_key_file(path, &contents)
}

fn copy_file(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_file() {
        return Err(format!("Required file is missing: {}", source.display()));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    fs::copy(source, destination).map_err(|error| {
        format!(
            "Failed to copy {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })?;
    Ok(())
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    write_file(path, &contents)
}

fn build_bootstrap_manifest_contents(
    node_id: &str,
    display_name: &str,
    role: &TestnetRoleProfile,
    node_address: &str,
    public_host: Option<&str>,
    funding_manifest: &TestnetFundingManifest,
    device_profile: &TestnetDeviceProfile,
    bootstrap_policy: &TestnetConnectivityPolicy,
) -> Result<String, String> {
    serde_json::to_string_pretty(&json!({
        "node_id": node_id,
        "environment_id": TESTNET_ENVIRONMENT_ID,
        "display_name": display_name,
        "role": role.display_name,
        "node_address": node_address,
        "public_host": public_host,
        "funding_manifest": funding_manifest,
        "device_profile": device_profile,
        "bootstrap_policy": bootstrap_policy,
    }))
    .map_err(|error| format!("Failed to serialize bootstrap manifest: {error}"))
}

fn load_ceremony_package(package_path: &Path) -> Result<TestnetCeremonyPackage, String> {
    let contents = fs::read_to_string(package_path)
        .map_err(|error| format!("Failed to read {}: {error}", package_path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse {}: {error}", package_path.display()))
}

fn validate_ceremony_package(
    package: &TestnetCeremonyPackage,
    requested_role: Option<&str>,
) -> Result<String, String> {
    validate_ceremony_package_identity(package)?;
    validate_ceremony_package_role(package, requested_role)
}

fn validate_ceremony_package_identity(package: &TestnetCeremonyPackage) -> Result<(), String> {
    if package.format != "synergy-testnet-ceremony-package/v1" {
        return Err(format!(
            "Unsupported ceremony package format: {}",
            package.format
        ));
    }
    if package.chain_id != TESTNET_CHAIN_ID {
        return Err(format!(
            "Ceremony package chain ID mismatch. Expected {}, got {}.",
            TESTNET_CHAIN_ID, package.chain_id
        ));
    }
    if package.network_id != TESTNET_NETWORK_ID_V2 {
        return Err(format!(
            "Ceremony package network ID mismatch. Expected {}, got {}.",
            TESTNET_NETWORK_ID_V2, package.network_id
        ));
    }
    if package.token_symbol != TOKEN_SYMBOL {
        return Err(format!(
            "Ceremony package token mismatch. Expected {}, got {}.",
            TOKEN_SYMBOL, package.token_symbol
        ));
    }
    let expected_genesis_hash = canonical_testnet_genesis_hash()?;
    let package_genesis_hash = package
        .artifacts
        .genesis
        .pointer("/integrity/genesis_hash")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Ceremony package genesis is missing integrity.genesis_hash.".to_string())?;
    if !package_genesis_hash.eq_ignore_ascii_case(&expected_genesis_hash) {
        return Err(format!(
            "Ceremony package genesis hash mismatch. Expected {}, got {}.",
            expected_genesis_hash, package_genesis_hash
        ));
    }

    let manifest_chain_id = package
        .artifacts
        .operational_manifest
        .get("chain_id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Ceremony package operational manifest is missing chain_id.".to_string())?;
    if manifest_chain_id != TESTNET_CHAIN_ID {
        return Err(format!(
            "Ceremony package operational manifest chain_id mismatch. Expected {}, got {}.",
            TESTNET_CHAIN_ID, manifest_chain_id
        ));
    }

    let manifest_network_id = package
        .artifacts
        .operational_manifest
        .get("network_id")
        .ok_or_else(|| {
            "Ceremony package operational manifest is missing network_id.".to_string()
        })?;
    let manifest_network_matches = manifest_network_id
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value == TESTNET_NETWORK_ID_V2)
        .unwrap_or(false);
    if !manifest_network_matches {
        return Err(format!(
            "Ceremony package operational manifest network_id mismatch. Expected {}, got {}.",
            TESTNET_NETWORK_ID_V2, manifest_network_id
        ));
    }

    let expected_validator_addresses = canonical_testnet_validator_addresses()?;
    let manifest_validator_addresses =
        extract_validator_addresses_from_manifest_value(&package.artifacts.operational_manifest);
    if !manifest_validator_addresses.is_empty()
        && manifest_validator_addresses != expected_validator_addresses
    {
        return Err(
            "Ceremony package validator registry does not match the canonical release bundle."
                .to_string(),
        );
    }

    let genesis_validator_addresses =
        normalize_address_list(extract_ceremony_validator_allowlist(&package.artifacts));
    if !genesis_validator_addresses.is_empty()
        && genesis_validator_addresses != expected_validator_addresses
    {
        return Err(
            "Ceremony package genesis validator set does not match the canonical release bundle."
                .to_string(),
        );
    }

    if package.role_id.eq_ignore_ascii_case("validator") {
        if let Some(assigned_ports) = package.assigned_ports.as_ref() {
            validate_validator_assigned_ports(assigned_ports)?;
        }
    }
    Ok(())
}

fn validate_ceremony_package_role(
    package: &TestnetCeremonyPackage,
    requested_role: Option<&str>,
) -> Result<String, String> {
    let package_role = package.role_id.trim();
    if package_role.is_empty() {
        return Err("Ceremony package is missing role_id.".to_string());
    }

    find_role_profile(package_role)?;

    if let Some(requested_role) = requested_role
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if package_role != requested_role {
            return Err(format!(
                "Ceremony package role mismatch. Expected {}, got {}.",
                requested_role, package_role
            ));
        }
    }

    Ok(package_role.to_string())
}

fn write_package_artifacts_to_workspace(
    workspace_directory: &Path,
    artifacts: &TestnetCeremonyPackageArtifacts,
) -> Result<(), String> {
    let config_dir = workspace_directory.join("config");
    write_json_file(&config_dir.join("genesis.json"), &artifacts.genesis)?;
    write_json_file(
        &config_dir.join("operational-manifest.json"),
        &artifacts.operational_manifest,
    )?;
    Ok(())
}

fn write_imported_runtime_identity_files(
    workspace_directory: &Path,
    identity: &TestnetCeremonyRuntimeIdentity,
) -> Result<Vec<String>, String> {
    let keys_directory = workspace_directory.join("keys");
    let identity_path = keys_directory.join("identity.json");
    let public_key_path = keys_directory.join("public.key");
    let private_key_path = keys_directory.join("private.key");
    let address_path = keys_directory.join("address.txt");

    write_json_file(
        &identity_path,
        &json!({
            "label": identity.label,
            "address": identity.address,
            "address_type": identity.address_type,
            "algorithm": identity.algorithm,
            "created_at": identity.created_at,
            "public_key": identity.public_key,
        }),
    )?;
    write_file(&public_key_path, &identity.public_key)?;
    if !identity.private_key.trim().is_empty() {
        write_private_key_file(&private_key_path, &identity.private_key)?;
    }
    write_file(&address_path, &identity.address)?;

    let mut written = vec![
        identity_path.to_string_lossy().to_string(),
        public_key_path.to_string_lossy().to_string(),
        address_path.to_string_lossy().to_string(),
    ];
    if private_key_path.exists() {
        written.push(private_key_path.to_string_lossy().to_string());
    }
    Ok(written)
}

fn find_existing_ceremony_node_match(
    registry: &TestnetRegistryFile,
    package: &TestnetCeremonyPackage,
    intended_directory: Option<&str>,
) -> Option<TestnetProvisionedNode> {
    let requested_directory = intended_directory
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(expand_home_path)
        .map(|path| path.canonicalize().unwrap_or(path));

    if let Some(requested_directory) = requested_directory.as_ref() {
        if let Some(existing) = registry.nodes.iter().find(|node| {
            node.role_id == package.role_id
                && PathBuf::from(&node.workspace_directory)
                    .canonicalize()
                    .unwrap_or_else(|_| PathBuf::from(&node.workspace_directory))
                    == *requested_directory
        }) {
            return Some(existing.clone());
        }
    }

    if let Some(identity) = package.runtime_identity.as_ref() {
        if let Some(existing) = registry
            .nodes
            .iter()
            .find(|node| node.role_id == package.role_id && node.node_address == identity.address)
        {
            return Some(existing.clone());
        }
    }

    if let Some(existing) = registry
        .nodes
        .iter()
        .find(|node| node.role_id == package.role_id && node.display_label == package.display_name)
    {
        return Some(existing.clone());
    }

    // Last resort: if there is exactly one node with the target role in the registry, reuse it.
    // This handles the common case where a machine was provisioned with a generic validator
    // workspace before the ceremony package was available. Without this check, a second
    // workspace would be created alongside the existing one.
    let role_nodes: Vec<_> = registry
        .nodes
        .iter()
        .filter(|node| node.role_id == package.role_id)
        .collect();
    if role_nodes.len() == 1 {
        return Some(role_nodes[0].clone());
    }

    None
}

fn extract_ceremony_validator_allowlist(
    artifacts: &TestnetCeremonyPackageArtifacts,
) -> Vec<String> {
    let candidates = [
        artifacts
            .genesis
            .pointer("/contracts/validator_registry/init_params/validators")
            .and_then(Value::as_array),
        artifacts
            .genesis
            .pointer("/validator_registry/init_params/validators")
            .and_then(Value::as_array),
        artifacts
            .genesis
            .get("validators")
            .and_then(Value::as_array),
    ];
    let mut addresses = Vec::new();

    for validators in candidates.into_iter().flatten() {
        for validator in validators {
            let address = validator
                .get("validator_address")
                .and_then(Value::as_str)
                .or_else(|| {
                    validator
                        .get("reward_payout_address")
                        .and_then(Value::as_str)
                })
                .or_else(|| validator.get("operator_address").and_then(Value::as_str))
                .or_else(|| validator.get("reward_address").and_then(Value::as_str))
                .or_else(|| validator.get("address").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if let Some(address) = address {
                let address = address.to_string();
                if !addresses.contains(&address) {
                    addresses.push(address);
                }
            }
        }
        if !addresses.is_empty() {
            break;
        }
    }

    addresses
}

fn apply_ceremony_validator_config_overrides(
    node_toml: String,
    package: &TestnetCeremonyPackage,
) -> String {
    let mut updated = node_toml.replace(
        "auto_register_validator = true",
        "auto_register_validator = false",
    );
    updated = updated.replace(
        "strict_validator_allowlist = false",
        "strict_validator_allowlist = true",
    );

    let allowlist = extract_ceremony_validator_allowlist(&package.artifacts);
    if allowlist.is_empty() {
        return updated;
    }

    let rendered_allowlist = format!(
        "allowed_validator_addresses = [{}]",
        allowlist
            .iter()
            .map(|address| format!("\"{address}\""))
            .collect::<Vec<_>>()
            .join(", ")
    );
    updated.replace("allowed_validator_addresses = []", &rendered_allowlist)
}

fn derive_ceremony_port_slot(package: &TestnetCeremonyPackage) -> Option<u16> {
    if let Some(assigned_ports) = package.assigned_ports.as_ref() {
        if let Some(port_slot) = assigned_ports.port_slot {
            return Some(port_slot);
        }
    }

    package
        .validator_slot
        .and_then(|slot| slot.checked_sub(1).map(u16::from))
}

fn apply_imported_runtime_identity(
    root: &Path,
    setup_result: &mut TestnetSetupResult,
    identity: &TestnetCeremonyRuntimeIdentity,
    package: &TestnetCeremonyPackage,
    public_host_override: Option<&str>,
) -> Result<Vec<String>, String> {
    let workspace_directory = PathBuf::from(&setup_result.node.workspace_directory);
    let identity_paths = write_imported_runtime_identity_files(&workspace_directory, identity)?;
    write_package_artifacts_to_workspace(&workspace_directory, &package.artifacts)?;

    let mut registry = load_registry(root)?;
    let mut network_profile = load_or_create_network_profile(root)?;
    let node_index = registry
        .nodes
        .iter()
        .position(|entry| entry.id == setup_result.node.id)
        .ok_or_else(|| {
            format!(
                "Provisioned node not found in registry: {}",
                setup_result.node.id
            )
        })?;
    let role_id = registry.nodes[node_index].role_id.clone();
    let funding_manifest_id = registry.nodes[node_index].funding_manifest_id.clone();
    let node_id = registry.nodes[node_index].id.clone();
    let role = find_role_profile(&role_id)?;
    let public_host = public_host_override
        .and_then(normalize_public_host_candidate)
        .or_else(|| registry.nodes[node_index].public_host.clone());
    let role_overlay = role_overlay_for(&role.id);
    let port_slot = if role.id == "validator" {
        0
    } else {
        derive_ceremony_port_slot(package)
            .unwrap_or_else(|| registry.nodes[node_index].port_slot.unwrap_or(0))
    };

    {
        let node_record = &mut registry.nodes[node_index];
        node_record.display_label = package.display_name.clone();
        node_record.node_address = identity.address.clone();
        node_record.reward_payout_address = Some(identity.address.clone());
        node_record.public_key_path = workspace_directory
            .join("keys")
            .join("public.key")
            .to_string_lossy()
            .to_string();
        node_record.private_key_path = workspace_directory
            .join("keys")
            .join("private.key")
            .to_string_lossy()
            .to_string();
        node_record.port_slot = Some(port_slot);
        if public_host.is_some() {
            node_record.public_host = public_host.clone();
        }
        node_record.role_certificate_status =
            "Approved genesis validator identity imported from the ceremony package.".to_string();
    }

    if let Some(funding_manifest) = network_profile
        .funding_manifests
        .iter_mut()
        .find(|entry| entry.id == funding_manifest_id)
    {
        funding_manifest.destination_wallet = identity.address.clone();
        funding_manifest.destination_role = role.display_name.clone();
    }
    network_profile.updated_at_utc = Utc::now().to_rfc3339();

    let manifest_for_node = network_profile
        .funding_manifests
        .iter()
        .find(|entry| entry.id == funding_manifest_id)
        .cloned()
        .ok_or_else(|| format!("Funding manifest not found for imported node {node_id}"))?;

    let mut node_contents = build_node_toml(
        &node_id,
        &package.display_name,
        &role,
        &identity.address,
        &workspace_directory,
        public_host.as_deref(),
        &network_profile,
        role_overlay.as_str(),
        port_slot,
        package.assigned_ports.as_ref(),
    );
    if role.id == "validator" {
        node_contents = apply_ceremony_validator_config_overrides(node_contents, package);
    }
    let manifest_contents = build_bootstrap_manifest_contents(
        &node_id,
        &package.display_name,
        &role,
        &identity.address,
        public_host.as_deref(),
        &manifest_for_node,
        &setup_result.device_profile,
        &network_profile.bootstrap_policy,
    )?;
    let readme_contents = build_node_readme(
        &package.display_name,
        &role,
        &identity.address,
        &workspace_directory,
        &network_profile,
        public_host.as_deref(),
    );

    write_file(
        &workspace_directory.join("config").join("node.toml"),
        &node_contents,
    )?;
    write_file(
        &workspace_directory.join("manifests").join("bootstrap.json"),
        &manifest_contents,
    )?;
    write_file(&workspace_directory.join("README.md"), &readme_contents)?;

    let updated_node = registry.nodes[node_index].clone();
    save_registry(root, &registry)?;
    save_network_profile(root, &network_profile)?;
    setup_result.node = updated_node;
    setup_result.network_profile = network_profile;

    Ok(identity_paths)
}

async fn import_bootstrap_bundle(
    requested_role: String,
    package_path: PathBuf,
    intended_directory: Option<String>,
) -> Result<TestnetImportCeremonyPackageResult, String> {
    let root = ensure_testnet_root()?;
    let default_directory = root
        .join("ceremony")
        .join("imports")
        .join(format!("{}-bundle", sanitize_slug(&requested_role)));
    let workspace_directory =
        resolve_node_directory(intended_directory.as_deref(), &default_directory)?;
    let bundle_directory = workspace_directory.join("bundle");
    fs::create_dir_all(&bundle_directory)
        .map_err(|error| format!("Failed to create {}: {error}", bundle_directory.display()))?;
    let staged_paths = extract_import_source(&package_path, &bundle_directory)?;
    let import_manifest_path = workspace_directory.join("import.json");
    write_json_file(
        &import_manifest_path,
        &json!({
            "import_mode": "bootstrap-bundle",
            "role_id": requested_role,
            "package_path": package_path,
            "staged_at_utc": Utc::now().to_rfc3339(),
            "bundle_directory": bundle_directory,
            "staged_paths": staged_paths,
        }),
    )?;

    let display_name = if requested_role == "bootnode" {
        "Bootnode Bundle"
    } else {
        "Seed Server Bundle"
    };

    let mut next_steps = vec![
        format!(
            "Open {} and review the imported deployment guide.",
            bundle_directory.display()
        ),
        "Move the staged bundle onto the target machine if this control panel is not running there."
            .to_string(),
    ];
    if requested_role == "bootnode" {
        next_steps.push(
            "Run install_and_start.sh or install_and_start.ps1 from the imported bundle on the assigned Testnet bootstrap host."
                .to_string(),
        );
    } else {
        next_steps.push(
            "Run install_and_start.sh or install_and_start.ps1 from the imported bundle on the assigned Testnet seed-service host."
                .to_string(),
        );
    }

    Ok(TestnetImportCeremonyPackageResult {
        import_mode: "bootstrap-bundle".to_string(),
        role_id: requested_role,
        display_name: display_name.to_string(),
        workspace_directory: workspace_directory.to_string_lossy().to_string(),
        package_path: package_path.to_string_lossy().to_string(),
        staged_paths: {
            let mut paths = vec![import_manifest_path.to_string_lossy().to_string()];
            paths.extend(staged_paths);
            paths
        },
        message: format!(
            "{} imported into {}. The staged bundle is ready for deployment on the assigned Testnet host.",
            display_name,
            bundle_directory.display()
        ),
        next_steps,
        node: None,
        network_profile: None,
    })
}

fn extract_import_source(source: &Path, destination: &Path) -> Result<Vec<String>, String> {
    if source.is_dir() {
        copy_directory_recursive(source, destination)?;
        return collect_staged_paths(destination);
    }

    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Invalid package path: {}", source.display()))?;

    if file_name.ends_with(".tar.gz") || file_name.ends_with(".tgz") {
        extract_tar_gz(source, destination)?;
        return collect_staged_paths(destination);
    }
    if source.extension().and_then(|value| value.to_str()) == Some("zip") {
        extract_zip(source, destination)?;
        return collect_staged_paths(destination);
    }

    let target_path = destination.join(file_name);
    copy_file(source, &target_path)?;
    Ok(vec![target_path.to_string_lossy().to_string()])
}

fn collect_staged_paths(destination: &Path) -> Result<Vec<String>, String> {
    let mut staged = Vec::new();
    for entry in fs::read_dir(destination)
        .map_err(|error| format!("Failed to inspect {}: {error}", destination.display()))?
    {
        let entry = entry.map_err(|error| {
            format!(
                "Failed to read entry inside {}: {error}",
                destination.display()
            )
        })?;
        staged.push(entry.path().to_string_lossy().to_string());
    }
    staged.sort();
    Ok(staged)
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Failed to create {}: {error}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Failed to inspect {}: {error}", source.display()))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to read {}: {error}", source.display()))?;
        let entry_path = entry.path();
        let target_path = destination.join(entry.file_name());
        if entry_path.is_dir() {
            copy_directory_recursive(&entry_path, &target_path)?;
        } else {
            copy_file(&entry_path, &target_path)?;
        }
    }
    Ok(())
}

fn sanitize_archive_relative_path(path: &Path) -> Result<PathBuf, String> {
    let mut sanitized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => sanitized.push(segment),
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) | Component::ParentDir => {
                return Err(format!("Unsafe archive entry detected: {}", path.display()));
            }
        }
    }
    if sanitized.as_os_str().is_empty() {
        return Err("Archive entry resolved to an empty path.".to_string());
    }
    Ok(sanitized)
}

fn extract_tar_gz(source: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(source)
        .map_err(|error| format!("Failed to open {}: {error}", source.display()))?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("Failed to read {}: {error}", source.display()))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("Failed to unpack {}: {error}", source.display()))?;
        let raw_path = entry
            .path()
            .map_err(|error| format!("Failed to inspect archive entry: {error}"))?;
        let relative = sanitize_archive_relative_path(&raw_path)?;
        let output_path = destination.join(relative);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        entry
            .unpack(&output_path)
            .map_err(|error| format!("Failed to unpack {}: {error}", output_path.display()))?;
    }
    Ok(())
}

fn extract_zip(source: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(source)
        .map_err(|error| format!("Failed to open {}: {error}", source.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("Failed to read {}: {error}", source.display()))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect {}: {error}", source.display()))?;
        let relative = entry
            .enclosed_name()
            .map(PathBuf::from)
            .ok_or_else(|| format!("Unsafe zip entry detected inside {}", source.display()))?;
        let output_path = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("Failed to create {}: {error}", output_path.display()))?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let mut output = File::create(&output_path)
            .map_err(|error| format!("Failed to write {}: {error}", output_path.display()))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Failed to extract {}: {error}", output_path.display()))?;
    }
    Ok(())
}

fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    fs::write(path, contents)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn resolve_node_directory(candidate: Option<&str>, fallback: &Path) -> Result<PathBuf, String> {
    let selected = candidate
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(expand_home_path)
        .unwrap_or_else(|| fallback.to_path_buf());
    ensure_isolated_directory(&selected)
}

fn ensure_isolated_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Ok(path.to_path_buf());
    }

    if !path.is_dir() {
        return Err(format!(
            "Requested workspace path {} exists and is not a directory.",
            path.display()
        ));
    }

    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    if entries.next().is_none() {
        return Ok(path.to_path_buf());
    }

    for _ in 0..32 {
        let suffix = Uuid::new_v4().simple().to_string();
        let candidate = append_path_suffix(path, &suffix[..8]);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "Unable to reserve an isolated workspace path near {} after multiple attempts.",
        path.display()
    ))
}

fn append_path_suffix(path: &Path, suffix: &str) -> PathBuf {
    let fallback_name = format!("node-workspace-{suffix}");
    let next_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| format!("{name}-{suffix}"))
        .unwrap_or(fallback_name);

    path.with_file_name(next_name)
}

fn expand_home_path(value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(value)
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("skip"))
        .map(str::to_string)
}

fn format_amount(amount_snrg: u64) -> String {
    format!("{amount_snrg}.{:09}", 0)
}

fn amount_to_nwei_string(amount_snrg: u64) -> String {
    (amount_snrg * TOKEN_SCALE).to_string()
}

fn sanitize_slug(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    sanitized
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn find_role_profile(role_id: &str) -> Result<TestnetRoleProfile, String> {
    node_catalog()
        .into_iter()
        .find(|entry| entry.id == role_id)
        .ok_or_else(|| format!("Unknown Testnet role: {role_id}"))
}

fn build_node_toml(
    node_id: &str,
    display_label: &str,
    role: &TestnetRoleProfile,
    node_address: &str,
    workspace_directory: &Path,
    public_host: Option<&str>,
    network_profile: &TestnetNetworkProfile,
    role_overlay: &str,
    port_slot: u16,
    assigned_ports: Option<&TestnetCeremonyAssignedPorts>,
) -> String {
    let runtime_ports = if role.id == "validator" {
        validator_runtime_ports()
    } else {
        assigned_ports
            .map(runtime_ports_for_assigned_ports)
            .unwrap_or_else(|| runtime_ports_for_slot(port_slot))
    };
    let p2p_port = runtime_ports.p2p_port;
    let rpc_port = runtime_ports.rpc_port;
    let ws_port = runtime_ports.ws_port;
    let discovery_port = runtime_ports.discovery_port;
    let metrics_port = runtime_ports.metrics_port;
    let config_node_id = if role.id == "validator" {
        node_address.to_string()
    } else {
        node_id.to_string()
    };
    let canonical_validator_peers = canonical_testnet_validator_peers();
    let use_static_validator_mesh = validator_uses_private_mesh(&role.id, node_address)
        && !canonical_validator_peers.is_empty();
    let public_validator_upstreams = if role.id == "validator" && !use_static_validator_mesh {
        canonical_public_validator_dial_targets()
    } else {
        Vec::new()
    };
    let sentry_upstreams = if role_uses_sentry_upstreams(&role.id) {
        canonical_sentry_public_dial_targets_for_role(&role.id)
    } else {
        Vec::new()
    };
    let use_sentry_upstreams = !use_static_validator_mesh && !sentry_upstreams.is_empty();
    let runtime_public_host = if use_static_validator_mesh {
        canonical_validator_peers
            .iter()
            .find(|entry| entry.address.eq_ignore_ascii_case(node_address.trim()))
            .map(|entry| entry.private_host.clone())
            .or_else(|| normalize_optional(public_host))
    } else {
        normalize_optional(public_host)
    };
    let public_host_line = runtime_public_host
        .as_deref()
        .map(|value| format!("public_host = \"{value}\"\n"))
        .unwrap_or_default();
    let runtime_public_address = runtime_public_host
        .as_deref()
        .map(|value| format!("{value}:{}", runtime_ports.public_p2p_port))
        .unwrap_or_else(|| format!("127.0.0.1:{p2p_port}"));
    let bootnodes = if use_static_validator_mesh || use_sentry_upstreams {
        String::new()
    } else {
        network_profile
            .bootnodes
            .iter()
            .filter_map(|entry| {
                endpoint_host_candidates(entry, false)
                    .into_iter()
                    .next()
                    .map(|host| format!("\"{host}:{}\"", entry.port))
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let seeds = if use_static_validator_mesh || use_sentry_upstreams {
        String::new()
    } else {
        network_profile
            .seed_servers
            .iter()
            .filter_map(|entry| {
                preferred_seed_service_host(entry)
                    .map(|host| format!("\"http://{host}:{}\"", entry.port))
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let bootstrap_dns_records = if use_static_validator_mesh || use_sentry_upstreams {
        String::new()
    } else {
        format!("\"{}\"", canonical_bootstrap_dns_record())
    };
    let additional_dial_targets = if use_static_validator_mesh {
        canonical_validator_dial_targets_toml(&canonical_validator_peers, node_address)
    } else if !public_validator_upstreams.is_empty() {
        render_toml_string_array(&public_validator_upstreams)
    } else if use_sentry_upstreams {
        render_toml_string_array(&sentry_upstreams)
    } else {
        String::new()
    };
    let persistent_peers = if use_static_validator_mesh {
        additional_dial_targets.clone()
    } else if !public_validator_upstreams.is_empty() {
        additional_dial_targets.clone()
    } else {
        String::new()
    };
    let auto_register_validator = "false";
    let enable_discovery = if use_static_validator_mesh || use_sentry_upstreams {
        "false"
    } else {
        "true"
    };
    let strict_validator_allowlist = if role.id == "validator" {
        "true"
    } else {
        "false"
    };
    let allowed_validator_addresses = if role.id == "validator" {
        canonical_validator_allowlist(&canonical_validator_peers)
    } else {
        "[]".to_string()
    };
    let bootstrap_note = if use_static_validator_mesh {
        "Validator nodes dial the private WireGuard validator mesh immediately through additional_dial_targets and persistent_peers."
    } else if !public_validator_upstreams.is_empty() {
        "Public non-genesis validators use bootnodes, dnsaddr records, seed services, and the public sentry relayer pair so they can sync while signing stays disabled until explicit activation."
    } else if use_sentry_upstreams {
        "Public edge nodes pin their upstreams to the public sentry pair and do not dial validators directly."
    } else {
        "Node will resolve peers from bootnodes, dnsaddr records, and seed services at startup."
    };

    // RPC Gateway, Indexer, and Observer roles expose a public-facing RPC surface.
    // They bind to all interfaces and enable CORS so nginx can proxy them externally.
    let is_public_rpc_role = matches!(role.id.as_str(), "rpc_gateway" | "indexer" | "observer");
    let rpc_bind_address = if is_public_rpc_role {
        format!("0.0.0.0:{rpc_port}")
    } else {
        format!("127.0.0.1:{rpc_port}")
    };
    let cors_enabled = is_public_rpc_role;
    let cors_origins = if is_public_rpc_role { r#"["*"]"# } else { "[]" };

    format!(
        "[identity]\nnode_id = \"{config_node_id}\"\nrole = \"{role_id}\"\nrole_display = \"{role_display}\"\nenvironment = \"{environment_id}\"\ndisplay_environment = \"{display_name}\"\naddress = \"{node_address}\"\nlabel = \"{display_label}\"\n\n[network]\nid = {chain_id}\nname = \"{chain_name}\"\nchain_name = \"{chain_name}\"\nchain_id = {chain_id}\np2p_port = {p2p_port}\nrpc_port = {rpc_port}\nws_port = {ws_port}\np2p_listen = \"0.0.0.0:{p2p_port}\"\nbootnodes = [{bootnodes}]\nseed_servers = [{seeds}]\nbootstrap_dns_records = [{bootstrap_dns_records}]\nadditional_dial_targets = [{additional_dial_targets}]\npersistent_peers = [{persistent_peers}]\nquic = true\nmax_peers = 128\nbootstrap_connectivity_required = false\nbootstrap_mode = \"multi-source-signed\"\n{public_host_line}\n[blockchain]\nblock_time = {block_time_secs}\nmax_gas_limit = \"0x2fefd8\"\nchain_id = {chain_id}\n\n[consensus]\nalgorithm = \"Proof of Synergy\"\nblock_time_secs = {block_time_secs}\nepoch_length = {epoch_length}\nmin_validators = {min_validators}\nvalidator_cluster_size = {validator_cluster_size}\nvalidator_vote_threshold = {validator_vote_threshold}\nmax_validators = {max_validators}\nstatus_ready_gate_enabled = {status_ready_gate_enabled}\nstatus_ready_min_validators = {status_ready_min_validators}\nstatus_ready_genesis_grace_secs = {status_ready_genesis_grace_secs}\nallow_genesis_status_bypass = {allow_genesis_status_bypass}\nmesh_settle_secs = {mesh_settle_secs}\nleader_timeout_secs = {leader_timeout_secs}\nvote_timeout_secs = {vote_timeout_secs}\nblock_timeout_secs = {block_timeout_secs}\npenalization_enabled = {penalization_enabled}\nsynergy_score_decay_rate = 0.05\nvrf_enabled = true\nvrf_seed_epoch_interval = 1000\nmax_synergy_points_per_epoch = 100\nmax_tasks_per_validator = 10\n\n[consensus.reward_weighting]\ntask_accuracy = 0.5\nuptime = 0.3\ncollaboration = 0.2\n\n[logging]\nlog_level = \"debug\"\nlog_file = \"{log_path}\"\nenable_console = true\nmax_file_size = 10485760\nmax_files = 5\n\n[rpc]\nbind_address = \"{rpc_bind_address}\"\nenable_http = true\nhttp_port = {rpc_port}\nenable_ws = true\nws_port = {ws_port}\nenable_grpc = true\ngrpc_port = {rpc_port}\ncors_enabled = {cors_enabled}\ncors_origins = {cors_origins}\n\n[p2p]\nlisten_address = \"0.0.0.0:{p2p_port}\"\npublic_address = \"{runtime_public_address}\"\nnode_name = \"{config_node_id}\"\nenable_discovery = {enable_discovery}\ndiscovery_port = {discovery_port}\nheartbeat_interval = {heartbeat_interval_secs}\nbootstrap_refresh_secs = {bootstrap_refresh_secs}\n\n[storage]\ndatabase = \"rocksdb\"\nengine = \"rocksdb\"\npath = \"{data_path}\"\nmode = \"role-bounded\"\nenable_pruning = false\npruning_interval = 86400\n\n[node]\nbootstrap_only = false\nauto_register_validator = {auto_register_validator}\nvalidator_address = \"{node_address}\"\nstrict_validator_allowlist = {strict_validator_allowlist}\nallowed_validator_addresses = {allowed_validator_addresses}\n\n[telemetry]\nmetrics_bind = \"0.0.0.0:{metrics_port}\"\nstructured_logs = true\nlog_level = \"debug\"\n\n[policy]\nallow_remote_admin = false\nrequire_signed_updates = true\nquarantine_on_policy_failure = true\nquarantine_on_key_role_mismatch = true\nconnectivity_fail_mode = \"warn-and-continue\"\n\n[wallet]\nreward_address = \"{node_address}\"\nsponsored_stake_snrg = \"{sponsored_stake_snrg}\"\nsponsored_stake_nwei = \"{sponsored_stake_nwei}\"\ntreasury_wallet = \"{treasury_wallet}\"\nstake_vault_wallet = \"{stake_wallet}\"\n[bootstrap]\nstatus = \"configured\"\nnote = \"{bootstrap_note}\"\n\n{role_overlay}",
        role_id = role.id,
        role_display = role.display_name,
        environment_id = TESTNET_ENVIRONMENT_ID,
        display_name = TESTNET_DISPLAY_NAME,
        config_node_id = config_node_id,
        chain_name = network_profile.chain_name,
        chain_id = network_profile.chain_id,
        p2p_port = p2p_port,
        rpc_port = rpc_port,
        ws_port = ws_port,
        discovery_port = discovery_port,
        metrics_port = metrics_port,
        bootnodes = bootnodes,
        seeds = seeds,
        bootstrap_dns_records = bootstrap_dns_records,
        additional_dial_targets = additional_dial_targets,
        persistent_peers = persistent_peers,
        data_path = workspace_directory.join("data").to_string_lossy().replace('\\', "/"),
        log_path = workspace_directory
            .join("logs")
            .join("synergy-testnet.log")
            .to_string_lossy()
            .replace('\\', "/"),
        runtime_public_address = runtime_public_address,
        auto_register_validator = auto_register_validator,
        enable_discovery = enable_discovery,
        strict_validator_allowlist = strict_validator_allowlist,
        allowed_validator_addresses = allowed_validator_addresses,
        rpc_bind_address = rpc_bind_address,
        cors_enabled = cors_enabled,
        cors_origins = cors_origins,
        block_time_secs = TESTNET_BLOCK_TIME_SECS,
        epoch_length = TESTNET_EPOCH_LENGTH,
        min_validators = TESTNET_MIN_GENESIS_VALIDATORS,
        validator_cluster_size = TESTNET_VALIDATOR_CLUSTER_SIZE,
        validator_vote_threshold = TESTNET_VALIDATOR_VOTE_THRESHOLD,
        max_validators = TESTNET_MAX_VALIDATORS,
        status_ready_gate_enabled = TESTNET_STATUS_READY_GATE_ENABLED,
        status_ready_min_validators = TESTNET_STATUS_READY_MIN_VALIDATORS,
        status_ready_genesis_grace_secs = TESTNET_STATUS_READY_GENESIS_GRACE_SECS,
        allow_genesis_status_bypass = TESTNET_ALLOW_GENESIS_STATUS_BYPASS,
        mesh_settle_secs = TESTNET_MESH_SETTLE_SECS,
        leader_timeout_secs = TESTNET_LEADER_TIMEOUT_SECS,
        vote_timeout_secs = TESTNET_VOTE_TIMEOUT_SECS,
        block_timeout_secs = TESTNET_BLOCK_TIMEOUT_SECS,
        penalization_enabled = TESTNET_CONSENSUS_PENALIZATION_ENABLED,
        bootstrap_refresh_secs = TESTNET_P2P_BOOTSTRAP_REFRESH_SECS,
        heartbeat_interval_secs = TESTNET_P2P_HEARTBEAT_INTERVAL_SECS,
        sponsored_stake_snrg = format_amount(MINIMUM_STAKE_SNRG),
        sponsored_stake_nwei = amount_to_nwei_string(MINIMUM_STAKE_SNRG),
        treasury_wallet = network_profile.treasury_wallet.address,
        stake_wallet = network_profile.stake_vault_wallet.address,
        bootstrap_note = bootstrap_note,
    )
}

fn role_supports_validator_registration(role_id: &str) -> bool {
    matches!(role_id, "validator")
}

fn build_peers_toml(network_profile: &TestnetNetworkProfile) -> String {
    build_peers_toml_with_options(network_profile, &[], false)
}

fn build_peers_toml_with_additional(
    network_profile: &TestnetNetworkProfile,
    additional_dial_targets: &[String],
) -> String {
    build_peers_toml_with_options(network_profile, additional_dial_targets, true)
}

fn build_peers_toml_with_public_validator_upstreams(
    network_profile: &TestnetNetworkProfile,
    additional_dial_targets: &[String],
) -> String {
    build_peers_toml_with_options(network_profile, additional_dial_targets, false)
}

fn build_peers_toml_with_options(
    network_profile: &TestnetNetworkProfile,
    additional_dial_targets: &[String],
    explicit_upstreams: bool,
) -> String {
    let use_explicit_upstreams = explicit_upstreams && !additional_dial_targets.is_empty();
    let bootnodes = if use_explicit_upstreams {
        String::new()
    } else {
        network_profile
            .bootnodes
            .iter()
            .filter_map(|entry| {
                endpoint_host_candidates(entry, false)
                    .into_iter()
                    .next()
                    .map(|host| format!("\"{host}:{}\"", entry.port))
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let seeds = if use_explicit_upstreams {
        String::new()
    } else {
        network_profile
            .seed_servers
            .iter()
            .filter_map(|entry| {
                preferred_seed_service_host(entry)
                    .map(|host| format!("\"http://{host}:{}\"", entry.port))
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let bootstrap_dns_records = if use_explicit_upstreams {
        String::new()
    } else {
        format!("\"{}\"", canonical_bootstrap_dns_record())
    };
    let additional = additional_dial_targets
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "# Testnet peer inputs.\n# Explicit additional_dial_targets take precedence over public bootstrap discovery.\n[global]\nbootnodes = [{bootnodes}]\nseed_servers = [{seeds}]\nbootstrap_dns_records = [{bootstrap_dns_records}]\nadditional_dial_targets = [{additional}]\npersistent_peers = [{additional}]\n\n[testnet]\ncore_rpc = \"{core_rpc}\"\ncore_ws = \"{core_ws}\"\nwallet_api = \"https://testnet-wallet-api.synergy-network.io\"\nsxcp_api = \"https://testnet-sxcp-api.synergy-network.io\"\n\n[security]\nstrict_tls = true\nallow_unpinned_dev_endpoints = false\nbootstrap_connectivity_required = false\n",
        core_rpc = TESTNET_PUBLIC_RPC_ENDPOINT,
        core_ws = TESTNET_PUBLIC_WS_ENDPOINT,
        bootstrap_dns_records = bootstrap_dns_records,
    )
}

fn build_aegis_toml() -> String {
    "[verify]\nenabled = true\nendpoint = \"https://127.0.0.1:3050\"\n\n[kms]\nenabled = true\nendpoint = \"https://127.0.0.1:3051\"\nmtls = true\n\n[lifecycle]\nquarantine_on_key_role_mismatch = true\nrequire_rotation_receipts = true\n".to_string()
}

fn build_node_readme(
    display_label: &str,
    role: &TestnetRoleProfile,
    node_address: &str,
    workspace_directory: &Path,
    network_profile: &TestnetNetworkProfile,
    public_host: Option<&str>,
) -> String {
    let public_host_note = normalize_optional(public_host)
        .map(|value| format!("- Public host: `{value}`\n"))
        .unwrap_or_else(|| "- Public host: pending assignment\n".to_string());
    let responsibilities = role
        .responsibilities
        .iter()
        .map(|entry| format!("- {entry}\n"))
        .collect::<String>();
    let policies = role
        .policy_highlights
        .iter()
        .map(|entry| format!("- {entry}\n"))
        .collect::<String>();

    let validator_mesh = canonical_testnet_validator_peers()
        .into_iter()
        .map(|entry| {
            format!(
                "{}:{}",
                entry.private_host,
                canonical_public_p2p_port_for_validator_slot(entry.slot)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sentry_upstreams = canonical_sentry_public_dial_targets_for_role(&role.id).join(", ");
    let bootstrap_section = if validator_uses_private_mesh(&role.id, node_address) {
        format!(
            "## Validator mesh\n- Private validator peers: {validator_mesh}\n- Public bootstrap endpoints: disabled for validator workspaces\n\nThe generated validator configuration is wired for the private WireGuard mesh immediately.\n"
        )
    } else if role.id == "validator" {
        let public_validator_upstreams = canonical_public_validator_dial_targets().join(", ");
        format!(
            "## Validator bootstrap\n- Public sentry relayers: {public_validator_upstreams}\n- Bootnodes: {}\n- Seeds: {}\n- DNS bootstrap records: `{}`\n\nThe generated validator configuration uses public sentry relayers plus public bootstrap so a non-genesis validator can sync the chain while validator auto-registration and signing remain disabled until explicit activation.\n",
            network_profile
                .bootnodes
                .iter()
                .map(|entry| entry.host.clone())
                .collect::<Vec<_>>()
                .join(", "),
            network_profile
                .seed_servers
                .iter()
                .map(|entry| entry.host.clone())
                .collect::<Vec<_>>()
                .join(", "),
            canonical_bootstrap_dns_record(),
        )
    } else if role_uses_sentry_upstreams(&role.id) && !sentry_upstreams.is_empty() {
        format!(
            "## Sentry upstreams\n- Public sentry peers: {sentry_upstreams}\n- Direct validator dialing: disabled\n\nThe generated public-edge configuration is pinned to the sentry pair so public services do not join the validator quorum plane directly.\n"
        )
    } else {
        format!(
            "## Bootstrap endpoints\n- Bootnodes: {}\n- Seeds: {}\n- DNS bootstrap records: `{}`\n\nThe generated node configuration is wired for multi-source bootstrap on startup.\n",
            network_profile
                .bootnodes
                .iter()
                .map(|entry| entry.host.clone())
                .collect::<Vec<_>>()
                .join(", "),
            network_profile
                .seed_servers
                .iter()
                .map(|entry| entry.host.clone())
                .collect::<Vec<_>>()
                .join(", "),
            canonical_bootstrap_dns_record(),
        )
    };

    format!(
        "# {display_label}\n\nThis isolated workspace was generated for the `{role_display}` role on `{environment}`.\n\n## Workspace\n- Path: `{workspace}`\n- Node wallet: `{reward_wallet}`\n- Reserved minimum stake: `{stake}`\n{public_host_note}\n## Role responsibilities\n{responsibilities}\n## Policy guardrails\n{policies}\n{bootstrap_section}",
        role_display = role.display_name,
        environment = TESTNET_DISPLAY_NAME,
        workspace = workspace_directory.to_string_lossy(),
        reward_wallet = node_address,
        stake = format_amount(MINIMUM_STAKE_SNRG),
        responsibilities = responsibilities,
        policies = policies,
        bootstrap_section = bootstrap_section,
    )
}

fn role_overlay_for(role_id: &str) -> String {
    match role_id {
        "validator" => format!(
            "[role]\ncompiled_profile = \"validator_node\"\nservices = [\"p2p\", \"consensus\", \"mempool\", \"state\", \"aegis-verifier\", \"telemetry\"]\n\n[validator]\nparticipation = \"active\"\nverify_quorum_certificates = true\nstate_sync_before_join = {state_sync_before_join}\n",
            state_sync_before_join = TESTNET_VALIDATOR_STATE_SYNC_BEFORE_JOIN
        ),
        "committee" => "[role]\ncompiled_profile = \"committee_node\"\nservices = [\"p2p\", \"committee-sync\", \"epoch-rotation-listener\", \"telemetry\"]\n\n[committee]\nrotation_enforced = true\ncluster_coordination = true\n".to_string(),
        "archive_validator" => "[role]\ncompiled_profile = \"archive_validator_node\"\nservices = [\"state\", \"archive\", \"proof-builder\", \"snapshot\", \"telemetry\"]\n\n[archive]\nretention = \"full-history\"\nsnapshots_enabled = true\n".to_string(),
        "audit_validator" => "[role]\ncompiled_profile = \"audit_validator_node\"\nservices = [\"consensus-observer\", \"audit\", \"receipt-emitter\", \"telemetry\"]\n\n[audit]\nindependent_alerting = true\nemit_signed_audit_receipts = true\n".to_string(),
        "relayer" => "[role]\ncompiled_profile = \"relayer_node\"\nservices = [\"p2p\", \"sxcp-relay\", \"proof-policy\", \"external-chain-adapters\", \"telemetry\"]\n\n[sxcp]\navailability_mode = \"under-constraint\"\nquarantine_on_policy_drift = true\n".to_string(),
        "witness" => "[role]\ncompiled_profile = \"witness_node\"\nservices = [\"event-ingest\", \"attestation\", \"telemetry\"]\n\n[witness]\nemit_signed_receipts = true\n".to_string(),
        "oracle" => "[role]\ncompiled_profile = \"oracle_node\"\nservices = [\"oracle-adapters\", \"data-normalization\", \"telemetry\"]\n\n[oracle]\nfail_closed_on_feed_drift = true\n".to_string(),
        "uma_coordinator" => "[role]\ncompiled_profile = \"uma_coordinator_node\"\nservices = [\"identity-sync\", \"mapping\", \"telemetry\"]\n\n[uma]\nrequire_identity_receipts = true\n".to_string(),
        "cross_chain_verifier" => "[role]\ncompiled_profile = \"cross_chain_verifier_node\"\nservices = [\"receipt-verify\", \"attestation-ingest\", \"telemetry\"]\n\n[verification]\nstrict_proof_policy = true\n".to_string(),
        "compute" => "[role]\ncompiled_profile = \"synq_execution_node\"\nservices = [\"synq-executor\", \"sandbox\", \"scheduler\", \"telemetry\"]\n\n[synq]\nsandbox_mode = \"strict\"\n".to_string(),
        "ai_inference" => "[role]\ncompiled_profile = \"analytics_and_simulation_node\"\nservices = [\"analytics\", \"simulation\", \"telemetry\"]\n\n[analytics]\nreplayable_jobs = true\n".to_string(),
        "pqc_crypto" => "[role]\ncompiled_profile = \"aegis_cryptography_node\"\nservices = [\"aegis-verify\", \"kms-bridge\", \"attestation-sign\", \"audit-log\"]\n\n[aegis]\nrequire_mtls = true\n".to_string(),
        "data_availability" => "[role]\ncompiled_profile = \"data_availability_node\"\nservices = [\"blob-store\", \"proof-availability\", \"telemetry\"]\n\n[data]\nretention_policy = \"proof-complete\"\n".to_string(),
        "governance_auditor" => "[role]\ncompiled_profile = \"governance_auditor_node\"\nservices = [\"governance-audit\", \"receipt-store\", \"telemetry\"]\n\n[governance]\nread_only = true\nemit_signed_reviews = true\n".to_string(),
        "treasury_controller" => "[role]\ncompiled_profile = \"treasury_controller_node\"\nservices = [\"treasury-execution\", \"policy-check\", \"receipt-store\"]\n\n[treasury]\nrequire_kms = true\ndual_control = true\n".to_string(),
        "security_council" => "[role]\ncompiled_profile = \"security_council_node\"\nservices = [\"emergency-policy\", \"containment\", \"audit-log\"]\n\n[security]\nrequire_dual_authorization = true\n".to_string(),
        "rpc_gateway" => "[role]\ncompiled_profile = \"rpc_gateway_node\"\nservices = [\"gateway\", \"rate-limiter\", \"upstream-router\", \"telemetry\"]\n\n[gateway]\npublic_entrypoint = true\nsigning_keys_allowed = false\n".to_string(),
        "indexer" => "[role]\ncompiled_profile = \"indexer_and_explorer_node\"\nservices = [\"ingest\", \"query-api\", \"telemetry\"]\n\n[indexer]\nreorg_aware = true\n".to_string(),
        "observer" => "[role]\ncompiled_profile = \"observer_light_node\"\nservices = [\"header-verify\", \"proof-check\", \"telemetry\"]\n\n[observer]\nminimal_state = true\n".to_string(),
        _ => "[role]\ncompiled_profile = \"generic_testnet_node\"\nservices = [\"telemetry\"]\n".to_string(),
    }
}

fn node_catalog() -> Vec<TestnetRoleProfile> {
    vec![
        role("validator", "Validator Node", 1, "Consensus", "Consensus", "Participates directly in PoSy propose-vote-commit finality.", vec!["Maintain deterministic consensus state and vote correctness.", "Join active committees only after state sync and policy validation.", "Quarantine instead of signing when integrity drift is detected."], vec!["p2p", "consensus", "mempool", "state", "aegis-verifier", "telemetry"], vec!["Compiled profile must match the role certificate.", "Connectivity failures degrade to warning state during provisioning, not hard stop.", "Signed updates and quarantine-first semantics stay enabled."], vec!["Finalization participation", "Vote latency", "Uptime", "State-root agreement"], "Stateful; durable disk and low-latency network required."),
        role("committee", "Committee Node", 1, "Consensus", "Consensus", "Handles committee-assigned PoSy rotation and coordination duties.", vec!["Track epoch rotation and committee membership updates.", "Refuse unauthorized actions outside committee scope.", "Preserve attribution across rotation windows."], vec!["p2p", "committee-sync", "epoch-rotation-listener", "telemetry"], vec!["Role mismatch enters quarantine.", "Rotation receipts remain attributable to stable identity."], vec!["Rotation correctness", "Committee availability", "Epoch sync health"], "Stateful with moderate storage."),
        role("archive_validator", "Archive Validator Node", 1, "Consensus", "Consensus", "Maintains complete history, proofs, and snapshots for the chain.", vec!["Store full history and snapshot artifacts.", "Serve proof-generation and recovery workloads.", "Favor integrity and replayability over pruning."], vec!["state", "archive", "proof-builder", "snapshot", "telemetry"], vec!["History retention is mandatory.", "Snapshot integrity takes precedence over throughput."], vec!["Snapshot freshness", "Proof generation success", "Disk health"], "High-IO full-history storage."),
        role("audit_validator", "Audit Validator Node", 1, "Consensus", "Consensus", "Acts as the consensus canary with independent auditing and signed alerts.", vec!["Observe validator behavior under separate operator control.", "Emit high-fidelity audit receipts and alerts.", "Detect correlated failure or policy drift early."], vec!["consensus-observer", "audit", "receipt-emitter", "telemetry"], vec!["Deployed under separate infrastructure from primary validators.", "Signed audit receipts are mandatory."], vec!["Alert latency", "Receipt fidelity", "Consensus anomaly detection"], "Moderate storage with heavy audit logging."),
        role("relayer", "Relayer Node", 2, "Interoperability", "Interoperability", "Feeds SXCP without ever becoming a bridge or custody domain.", vec!["Monitor external chains and generate proofs.", "Relay verified facts, not discretionary execution.", "Quarantine aggressively on proof or policy drift."], vec!["p2p", "sxcp-relay", "proof-policy", "external-chain-adapters", "telemetry"], vec!["Non-custodial availability under constraint.", "External-chain adapters fail closed."], vec!["Proof validity", "Relay latency", "External endpoint health"], "Moderate storage with outbound network emphasis."),
        role("witness", "Witness Node", 2, "Interoperability", "Interoperability", "Observes events and emits attestations into the interoperability plane.", vec!["Ingest observed events from the assigned domains.", "Emit signed witness receipts.", "Remain narrow in authority and data scope."], vec!["event-ingest", "attestation", "telemetry"], vec!["Attestation scope is fixed by role.", "Fail closed on ambiguous observations."], vec!["Receipt emission", "Observation latency", "Attestation success"], "Light to moderate storage."),
        role("oracle", "Oracle Node", 2, "Interoperability", "Interoperability", "Normalizes external data feeds into bounded oracle outputs.", vec!["Ingest approved external feeds.", "Normalize and sign bounded outputs.", "Stop rather than publish ambiguous data."], vec!["oracle-adapters", "data-normalization", "telemetry"], vec!["Feed drift triggers refusal, not best-effort publishing.", "Pinned upstreams only."], vec!["Feed freshness", "Normalization success", "Signed update rate"], "Moderate storage and outbound connectivity."),
        role("uma_coordinator", "UMA Coordinator Node", 2, "Interoperability", "Interoperability", "Coordinates identity and mapping lifecycle work in the UMA plane.", vec!["Synchronize bounded identity mappings.", "Keep identity receipts attributable and auditable.", "Avoid crossing into execution authority."], vec!["identity-sync", "mapping", "telemetry"], vec!["Receipts are signed and replayable.", "Identity continuity is required."], vec!["Mapping freshness", "Receipt validation", "Coordinator availability"], "Light storage with strong receipt logging."),
        role("cross_chain_verifier", "Cross-Chain Verifier Node", 2, "Interoperability", "Interoperability", "Verifies proofs and attestations before they enter execution-critical paths.", vec!["Verify cross-chain receipts and proofs.", "Reject unverifiable peer hints or role claims.", "Preserve deterministic verification posture."], vec!["receipt-verify", "attestation-ingest", "telemetry"], vec!["Strict proof policy is mandatory.", "Refusal beats ambiguity."], vec!["Proof validation rate", "Receipt latency", "Verification backlog"], "Moderate storage for receipts and proofs."),
        role("compute", "SynQ Execution Node", 3, "Execution / Data / Cryptography", "Execution", "Runs bounded SynQ execution workloads inside the execution plane.", vec!["Execute sandboxed workload profiles.", "Separate scheduling from authority.", "Preserve deterministic execution receipts."], vec!["synq-executor", "sandbox", "scheduler", "telemetry"], vec!["Sandboxing is mandatory.", "Execution does not imply identity authority."], vec!["Job completion", "Scheduler latency", "Sandbox integrity"], "Workload-driven storage and CPU."),
        role("ai_inference", "Analytics & Simulation Node", 3, "Execution / Data / Cryptography", "Execution", "Handles replayable analytics and simulation workloads without leaking authority.", vec!["Run replayable analytics jobs.", "Preserve deterministic simulation inputs and outputs.", "Stay isolated from signing roles."], vec!["analytics", "simulation", "telemetry"], vec!["Workloads must be replayable.", "No signing or governance authority."], vec!["Replay success", "Job throughput", "Resource saturation"], "High CPU/RAM for analytic workloads."),
        role("pqc_crypto", "Aegis Cryptography Node", 3, "Execution / Data / Cryptography", "Cryptography", "Concentrates Aegis verification and KMS lifecycle functions.", vec!["Provide Aegis verify and KMS bridge services.", "Keep mTLS enforced on all KMS traffic.", "Isolate high-risk key lifecycle operations."], vec!["aegis-verify", "kms-bridge", "attestation-sign", "audit-log"], vec!["Hardware-backed key isolation is strongly preferred.", "Role-bound key handles only; no raw key export."], vec!["KMS latency", "Rotation success", "mTLS health"], "Security-focused storage and network isolation."),
        role("data_availability", "Data-Availability Node", 3, "Execution / Data / Cryptography", "Data", "Ensures proofs and data shards remain available to the rest of the network.", vec!["Store and serve proof-complete blobs.", "Favor retention and proof availability.", "Expose auditable availability state."], vec!["blob-store", "proof-availability", "telemetry"], vec!["Proof completeness is a hard requirement.", "Do not prune required availability artifacts."], vec!["Availability success", "Blob retention", "Proof serving latency"], "High-capacity storage."),
        role("governance_auditor", "Governance Auditor Node", 4, "Governance / Security", "Governance", "Audits governance actions without becoming an execution override channel.", vec!["Inspect governance artifacts and proposals.", "Emit signed review receipts.", "Remain read-only relative to treasury execution."], vec!["governance-audit", "receipt-store", "telemetry"], vec!["Read-only by default.", "Audit artifacts stay signed and attributable."], vec!["Receipt generation", "Proposal audit latency", "Artifact retention"], "Moderate storage with durable receipts."),
        role("treasury_controller", "Treasury Controller Node", 4, "Governance / Security", "Treasury", "Executes treasury actions inside a narrow KMS-governed authority envelope.", vec!["Manage treasury execution pathways.", "Require dual-control and replayable receipts.", "Keep KMS-bound authority explicit."], vec!["treasury-execution", "policy-check", "receipt-store"], vec!["KMS is mandatory.", "High-risk actions require dual authorization."], vec!["Execution receipt success", "KMS availability", "Policy check health"], "Security-isolated with hardware signing preference."),
        role("security_council", "Security Council Node", 4, "Governance / Security", "Security", "Contains emergency policy actions without becoming a general-purpose shell.", vec!["Coordinate emergency containment decisions.", "Emit signed emergency receipts.", "Keep bounded authority and dual-approval requirements."], vec!["emergency-policy", "containment", "audit-log"], vec!["Dual authorization required.", "Emergency actions remain auditable and replayable."], vec!["Containment response time", "Receipt validity", "Policy drift"], "Security-isolated with strict audit controls."),
        role("rpc_gateway", "RPC Gateway Node", 5, "Service / Access", "Service", "Publishes the chain read path without holding signing authority.", vec!["Serve high-volume RPC traffic.", "Stay stateless and aggressively rate-limited.", "Pin upstream trust and reject unsafe fallbacks."], vec!["gateway", "rate-limiter", "upstream-router", "telemetry"], vec!["No signing keys allowed.", "Metrics and admin surfaces stay private."], vec!["Request latency", "Rate-limit efficacy", "Upstream health"], "Low local state; high network throughput."),
        role("indexer", "Indexer & Explorer Node", 5, "Service / Access", "Service", "Indexes chain data for explorer and query use without claiming authority.", vec!["Run replayable ingest workers.", "Separate ingest from query API exposure.", "Remain reorg-aware and non-authoritative."], vec!["ingest", "query-api", "telemetry"], vec!["Query APIs stay separate from ingest workers.", "Indexer failure does not imply chain failure."], vec!["Ingest lag", "Reorg recovery success", "Query latency"], "Moderate to high storage depending on history depth."),
        role("observer", "Observer / Light Node", 5, "Service / Access", "Service", "Verifies headers and proofs with a minimal state footprint.", vec!["Verify more while storing less.", "Prefer correctness over latency.", "Stay read-only and low blast radius."], vec!["header-verify", "proof-check", "telemetry"], vec!["Minimal state by design.", "Read-only authority boundary."], vec!["Header verification", "Proof check success", "Latency-to-correctness"], "Minimal storage footprint."),
    ]
}

fn role(
    id: &str,
    display_name: &str,
    class_id: u8,
    class_name: &str,
    authority_plane: &str,
    summary: &str,
    responsibilities: Vec<&str>,
    service_surface: Vec<&str>,
    policy_highlights: Vec<&str>,
    operator_kpis: Vec<&str>,
    storage_profile: &str,
) -> TestnetRoleProfile {
    TestnetRoleProfile {
        id: id.to_string(),
        display_name: display_name.to_string(),
        class_id,
        class_name: class_name.to_string(),
        authority_plane: authority_plane.to_string(),
        summary: summary.to_string(),
        responsibilities: responsibilities.into_iter().map(str::to_string).collect(),
        service_surface: service_surface.into_iter().map(str::to_string).collect(),
        policy_highlights: policy_highlights.into_iter().map(str::to_string).collect(),
        operator_kpis: operator_kpis.into_iter().map(str::to_string).collect(),
        storage_profile: storage_profile.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use once_cell::sync::Lazy;
    use std::ffi::OsString;
    use std::sync::Mutex;
    use tempfile::TempDir;

    static ENV_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    struct CurrentDirGuard {
        previous: PathBuf,
    }

    impl EnvVarGuard {
        fn set_path(key: &'static str, value: &Path) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl CurrentDirGuard {
        fn set(path: &Path) -> Self {
            let previous = std::env::current_dir().expect("current dir should resolve");
            std::env::set_current_dir(path).expect("current dir should update");
            Self { previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    impl Drop for CurrentDirGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.previous);
        }
    }

    fn with_temp_home(test: impl FnOnce(&Path)) {
        let _lock = ENV_LOCK.lock().expect("env lock poisoned");
        let temp = TempDir::new().expect("temp home");
        let _home = EnvVarGuard::set_path("HOME", temp.path());
        let _user_profile = EnvVarGuard::set_path("USERPROFILE", temp.path());
        test(temp.path());
    }

    fn config_path_for(node: &TestnetProvisionedNode, file_name: &str) -> PathBuf {
        node.config_paths
            .iter()
            .map(PathBuf::from)
            .find(|path| path.file_name().and_then(|value| value.to_str()) == Some(file_name))
            .unwrap_or_else(|| panic!("missing {file_name} in generated config paths"))
    }

    #[test]
    fn repair_workspace_chain_state_removes_wrong_genesis_data() {
        let temp = TempDir::new().expect("temp workspace");
        let workspace = temp.path();
        let config_dir = workspace.join("config");
        let data_dir = workspace.join("data");
        fs::create_dir_all(&config_dir).expect("config dir");
        fs::create_dir_all(data_dir.join("chain")).expect("chain dir");
        fs::create_dir_all(data_dir.join("testnet15")).expect("legacy chain dir");

        write_json_file(
            &config_dir.join("genesis.json"),
            &json!({
                "integrity": {
                    "genesis_hash": "active-genesis"
                }
            }),
        )
        .expect("genesis should write");
        write_json_file(
            &data_dir.join("chain.json"),
            &json!([
                {
                    "block_index": 0,
                    "hash": "stale-genesis"
                }
            ]),
        )
        .expect("chain should write");
        write_json_file(
            &data_dir.join("token_state.json"),
            &json!({ "stale": true }),
        )
        .expect("token state should write");
        write_json_file(
            &data_dir.join("validator_registry.json"),
            &json!({ "stale": true }),
        )
        .expect("validator registry should write");

        let message = repair_workspace_chain_state_if_needed(workspace)
            .expect("repair should succeed")
            .expect("repair should run");

        assert!(message.contains("stale-genesis"));
        assert!(!data_dir.join("chain.json").exists());
        assert!(!data_dir.join("token_state.json").exists());
        assert!(!data_dir.join("validator_registry.json").exists());
        assert!(!data_dir.join("chain").exists());
        assert!(!data_dir.join("testnet15").exists());
        assert!(workspace.join("logs").join("control-service.log").exists());
    }

    #[test]
    fn parse_rpc_peer_count_supports_peer_info_objects() {
        assert_eq!(
            parse_rpc_peer_count(json!({
                "peer_count": 3,
                "peers": [
                    {"node_id": "a"},
                    {"node_id": "b"},
                    {"node_id": "c"}
                ]
            }))
            .expect("peer info object should parse"),
            3
        );
    }

    #[test]
    fn parse_rpc_peer_count_supports_legacy_arrays() {
        assert_eq!(
            parse_rpc_peer_count(json!([
                {"node_id": "a"},
                {"node_id": "b"}
            ]))
            .expect("legacy peer array should parse"),
            2
        );
    }

    #[test]
    fn parse_rpc_peer_summary_counts_connected_and_status_ready_validators() {
        let summary = parse_rpc_peer_summary(
            &json!({
                "peer_count": 4,
                "peers": [
                    {
                        "node_id": "validator-2",
                        "validator_address": "synv1b",
                        "genesis_hash": "genesis-a"
                    },
                    {
                        "node_id": "validator-3",
                        "validator_address": "synv1c",
                        "genesis_hash": ""
                    },
                    {
                        "node_id": "bootnode-1",
                        "validator_address": "",
                        "genesis_hash": "genesis-a"
                    }
                ]
            }),
            Some("synv1a"),
        )
        .expect("peer summary should parse");

        assert_eq!(summary.peer_count, 4);
        assert_eq!(summary.connected_validator_count, 3);
        assert_eq!(summary.status_ready_validator_count, 2);
    }

    #[test]
    fn parse_rpc_peer_summary_supports_legacy_arrays() {
        let summary = parse_rpc_peer_summary(
            &json!([
                {
                    "node_id": "validator-2",
                    "validator_address": "synv1b",
                    "genesis_hash": "genesis-a"
                },
                {
                    "node_id": "validator-3",
                    "validator_address": "synv1c",
                    "genesis_hash": ""
                }
            ]),
            Some("synv1a"),
        )
        .expect("legacy peer summary should parse");

        assert_eq!(summary.peer_count, 2);
        assert_eq!(summary.connected_validator_count, 3);
        assert_eq!(summary.status_ready_validator_count, 2);
    }

    #[test]
    fn seed_registry_peer_key_prefers_dial_target_for_deduplication() {
        assert_eq!(
            seed_registry_peer_key(&json!({
                "node_id": "node-a",
                "wallet_address": "wallet-a",
                "public_host": "93.184.216.37",
                "p2p_port": 5622,
                "dial": "93.184.216.37:5622"
            }))
            .expect("dial target should resolve"),
            "93.184.216.37:5622"
        );
    }

    #[test]
    fn seed_registry_peer_key_falls_back_to_host_and_port() {
        assert_eq!(
            seed_registry_peer_key(&json!({
                "node_id": "node-b",
                "public_host": "62.146.182.208",
                "p2p_port": 5622
            }))
            .expect("public host should resolve"),
            "62.146.182.208:5622"
        );
    }

    #[test]
    fn setup_node_writes_non_genesis_validator_bootstrap_inputs() {
        with_temp_home(|_| {
            let _public_host =
                EnvVarGuard::set_path("SYNERGY_TESTNET_PUBLIC_HOST", Path::new("93.184.216.37"));
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let result = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Test Validator Node".to_string()),
                    intended_directory: None,
                    public_host: None,
                    node_address_override: None,
                    identity_passphrase: Some("test-passphrase".to_string()),
                    skip_canonical_manifests: false,
                }))
                .expect("setup should succeed");

            assert_eq!(result.node.role_id, "validator");
            assert_eq!(result.node.role_display_name, "Validator Node");
            assert_eq!(
                result.node.node_address.len(),
                TARGET_ADDRESS_LEN,
                "generated validator address must use the canonical Synergy length"
            );
            assert!(
                result.node.node_address.starts_with("synv11"),
                "validator class-1 address should include the synv1 HRP and Bech32 separator"
            );
            assert!(
                is_valid_address(&result.node.node_address),
                "generated validator address should pass Bech32m validation"
            );
            assert!(
                result
                    .node
                    .connectivity_status
                    .contains("Bootstrap configured"),
                "non-genesis validator connectivity note should mention public bootstrap"
            );

            let node_toml = fs::read_to_string(config_path_for(&result.node, "node.toml"))
                .expect("node.toml should exist");
            let node_value: toml::Value =
                toml::from_str(&node_toml).expect("node.toml should parse");

            assert_eq!(
                node_value
                    .get("identity")
                    .and_then(|section| section.get("role"))
                    .and_then(toml::Value::as_str),
                Some("validator")
            );
            assert_eq!(
                node_value
                    .get("role")
                    .and_then(|section| section.get("compiled_profile"))
                    .and_then(toml::Value::as_str),
                Some("validator_node")
            );
            assert_eq!(
                node_value
                    .get("p2p")
                    .and_then(|section| section.get("public_address"))
                    .and_then(toml::Value::as_str),
                Some("93.184.216.37:5622")
            );
            assert_eq!(
                node_value
                    .get("node")
                    .and_then(|section| section.get("auto_register_validator"))
                    .and_then(toml::Value::as_bool),
                Some(false)
            );
            assert_eq!(
                node_value
                    .get("node")
                    .and_then(|section| section.get("strict_validator_allowlist"))
                    .and_then(toml::Value::as_bool),
                Some(true)
            );
            let validator_allowlist = node_value
                .get("node")
                .and_then(|section| section.get("allowed_validator_addresses"))
                .and_then(toml::Value::as_array)
                .expect("validator allowlist should exist");
            assert!(
                !validator_allowlist.is_empty(),
                "validator node.toml should carry the canonical genesis validator allowlist"
            );
            assert!(
                !validator_allowlist
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .any(|address| address == result.node.node_address),
                "new non-genesis validators must not auto-activate themselves into the live validator set"
            );
            let workspace = PathBuf::from(&result.node.workspace_directory);
            let identity_json = fs::read_to_string(workspace.join("keys").join("identity.json"))
                .expect("identity.json should exist");
            let identity_value: Value =
                serde_json::from_str(&identity_json).expect("identity.json should parse");
            assert_eq!(
                identity_value.get("address").and_then(Value::as_str),
                Some(result.node.node_address.as_str())
            );
            assert!(
                identity_value
                    .get("public_key")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty()),
                "identity metadata should include the validator public key"
            );
            assert!(
                fs::read_to_string(workspace.join("keys").join("private.key"))
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false),
                "validator workspace should carry the local signing private key"
            );
            assert!(
                fs::read_to_string(workspace.join("keys").join("private.key.enc"))
                    .map(|value| value.contains("AES-256-GCM"))
                    .unwrap_or(false),
                "validator workspace should carry an encrypted private key export"
            );

            let bootnodes = node_value
                .get("network")
                .and_then(|section| section.get("bootnodes"))
                .and_then(toml::Value::as_array)
                .expect("bootnodes array should exist");
            assert!(
                !bootnodes.is_empty(),
                "validator node.toml should use bootnodes"
            );

            let seeds = node_value
                .get("network")
                .and_then(|section| section.get("seed_servers"))
                .and_then(toml::Value::as_array)
                .expect("seed_servers array should exist");
            assert!(
                !seeds.is_empty(),
                "validator node.toml should use seed servers"
            );
            let seed_urls = seeds
                .iter()
                .filter_map(toml::Value::as_str)
                .collect::<Vec<_>>();
            assert!(
                seed_urls.contains(&"http://seed1.synergynode.xyz:5621"),
                "validator node.toml should prefer the public seed hostname over stale manifest IPs"
            );
            assert!(
                seed_urls.iter().all(|url| !url.contains("170.64.187.206")),
                "validator node.toml should not pin seed1 to the stale manifest IP"
            );

            let dns_records = node_value
                .get("network")
                .and_then(|section| section.get("bootstrap_dns_records"))
                .and_then(toml::Value::as_array)
                .expect("bootstrap_dns_records array should exist");
            assert!(
                !dns_records.is_empty(),
                "validator node.toml should use DNS bootstrap records"
            );

            let additional_dial_targets = node_value
                .get("network")
                .and_then(|section| section.get("additional_dial_targets"))
                .and_then(toml::Value::as_array)
                .expect("additional_dial_targets array should exist");
            let additional_dial_target_values = additional_dial_targets
                .iter()
                .filter_map(toml::Value::as_str)
                .collect::<Vec<_>>();
            assert!(
                additional_dial_target_values.contains(&"relay1.synergynode.xyz:5622")
                    && additional_dial_target_values.contains(&"relay2.synergynode.xyz:5622"),
                "non-genesis validator node.toml should pin the public sentry relayers for sync"
            );
            assert!(
                additional_dial_target_values
                    .iter()
                    .all(|value| !value.contains("62.146.182.207")
                        && !value.contains("62.146.182.208")
                        && !value.contains("62.146.182.209")
                        && !value.contains("73.79.66.255")
                        && !value.contains("194.163.183.166")
                        && !value.contains("10.69.0.")),
                "non-genesis validator node.toml must not dial genesis validators directly"
            );
            let persistent_peers = node_value
                .get("network")
                .and_then(|section| section.get("persistent_peers"))
                .and_then(toml::Value::as_array)
                .expect("persistent_peers array should exist");
            let persistent_peer_values = persistent_peers
                .iter()
                .filter_map(toml::Value::as_str)
                .collect::<Vec<_>>();
            assert_eq!(persistent_peer_values, additional_dial_target_values);
            assert_eq!(
                node_value
                    .get("consensus")
                    .and_then(|section| section.get("min_validators"))
                    .and_then(toml::Value::as_integer),
                Some(TESTNET_MIN_GENESIS_VALIDATORS as i64)
            );
            assert_eq!(
                node_value
                    .get("consensus")
                    .and_then(|section| section.get("validator_cluster_size"))
                    .and_then(toml::Value::as_integer),
                Some(TESTNET_VALIDATOR_CLUSTER_SIZE as i64)
            );
            assert_eq!(
                node_value
                    .get("consensus")
                    .and_then(|section| section.get("status_ready_gate_enabled"))
                    .and_then(toml::Value::as_bool),
                Some(TESTNET_STATUS_READY_GATE_ENABLED)
            );
            assert_eq!(
                node_value
                    .get("consensus")
                    .and_then(|section| section.get("status_ready_min_validators"))
                    .and_then(toml::Value::as_integer),
                Some(TESTNET_STATUS_READY_MIN_VALIDATORS as i64)
            );
            assert_eq!(
                node_value
                    .get("consensus")
                    .and_then(|section| section.get("leader_timeout_secs"))
                    .and_then(toml::Value::as_integer),
                Some(TESTNET_LEADER_TIMEOUT_SECS as i64)
            );
            assert_eq!(
                node_value
                    .get("consensus")
                    .and_then(|section| section.get("penalization_enabled"))
                    .and_then(toml::Value::as_bool),
                Some(TESTNET_CONSENSUS_PENALIZATION_ENABLED)
            );
            assert_eq!(
                node_value
                    .get("validator")
                    .and_then(|section| section.get("state_sync_before_join"))
                    .and_then(toml::Value::as_bool),
                Some(TESTNET_VALIDATOR_STATE_SYNC_BEFORE_JOIN)
            );

            assert_eq!(
                node_value
                    .get("p2p")
                    .and_then(|section| section.get("bootstrap_refresh_secs"))
                    .and_then(toml::Value::as_integer),
                Some(TESTNET_P2P_BOOTSTRAP_REFRESH_SECS as i64)
            );

            assert_eq!(
                node_value
                    .get("bootstrap")
                    .and_then(|section| section.get("status"))
                    .and_then(toml::Value::as_str),
                Some("configured")
            );

            let peers_toml = fs::read_to_string(config_path_for(&result.node, "peers.toml"))
                .expect("peers.toml should exist");
            let peers_value: toml::Value =
                toml::from_str(&peers_toml).expect("peers.toml should parse");

            let peer_bootnodes = peers_value
                .get("global")
                .and_then(|section| section.get("bootnodes"))
                .and_then(toml::Value::as_array)
                .expect("global.bootnodes should exist");
            assert!(!peer_bootnodes.is_empty());

            let peer_dns_records = peers_value
                .get("global")
                .and_then(|section| section.get("bootstrap_dns_records"))
                .and_then(toml::Value::as_array)
                .expect("global.bootstrap_dns_records should exist");
            assert!(!peer_dns_records.is_empty());

            let peer_seeds = peers_value
                .get("global")
                .and_then(|section| section.get("seed_servers"))
                .and_then(toml::Value::as_array)
                .expect("global.seed_servers should exist");
            assert!(!peer_seeds.is_empty());
            let peer_seed_urls = peer_seeds
                .iter()
                .filter_map(toml::Value::as_str)
                .collect::<Vec<_>>();
            assert!(
                peer_seed_urls.contains(&"http://seed1.synergynode.xyz:5621"),
                "peers.toml should prefer the public seed hostname over stale manifest IPs"
            );

            let peer_persistent_peers = peers_value
                .get("global")
                .and_then(|section| section.get("persistent_peers"))
                .and_then(toml::Value::as_array)
                .expect("global.persistent_peers should exist");
            let peer_persistent_values = peer_persistent_peers
                .iter()
                .filter_map(toml::Value::as_str)
                .collect::<Vec<_>>();
            assert!(
                peer_persistent_values.contains(&"relay1.synergynode.xyz:5622")
                    && peer_persistent_values.contains(&"relay2.synergynode.xyz:5622"),
                "peers.toml should pin the public sentry relayers for non-genesis validators"
            );

            assert_eq!(
                peers_value
                    .get("testnet")
                    .and_then(|section| section.get("core_rpc"))
                    .and_then(toml::Value::as_str),
                Some("https://testnet-core-rpc.synergy-network.io")
            );
            assert_eq!(
                peers_value
                    .get("testnet")
                    .and_then(|section| section.get("wallet_api"))
                    .and_then(toml::Value::as_str),
                Some("https://testnet-wallet-api.synergy-network.io")
            );

            let state = testnet_get_state().expect("state should load from test temp home");
            assert_eq!(state.summary.total_nodes, 1);
            assert_eq!(state.nodes[0].role_id, "validator");
        });
    }

    #[test]
    fn setup_node_requires_validator_identity_passphrase() {
        with_temp_home(|_| {
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let error = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Validator Without Passphrase".to_string()),
                    intended_directory: None,
                    public_host: Some("93.184.216.38".to_string()),
                    node_address_override: None,
                    identity_passphrase: None,
                    skip_canonical_manifests: false,
                }))
                .expect_err("validator setup should require passphrase");

            assert!(
                error.contains("identity encryption passphrase"),
                "unexpected error: {error}"
            );
        });
    }

    #[test]
    fn setup_node_rejects_invalid_public_host_override_for_non_genesis_validator() {
        with_temp_home(|_| {
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let error = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Invalid Validator".to_string()),
                    intended_directory: None,
                    public_host: Some("not a host".to_string()),
                    node_address_override: None,
                    identity_passphrase: Some("test-passphrase".to_string()),
                    skip_canonical_manifests: false,
                }))
                .expect_err("invalid public host should fail before provisioning");

            assert!(
                error.contains("Invalid public host"),
                "unexpected error: {error}"
            );
        });
    }

    #[test]
    fn setup_node_rejects_private_public_host_for_non_genesis_validator() {
        with_temp_home(|_| {
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let error = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Private Validator".to_string()),
                    intended_directory: None,
                    public_host: Some("10.69.0.20".to_string()),
                    node_address_override: None,
                    identity_passphrase: Some("test-passphrase".to_string()),
                    skip_canonical_manifests: false,
                }))
                .expect_err("private validator host should fail before provisioning");

            assert!(
                error.contains("publicly routable"),
                "unexpected error: {error}"
            );
        });
    }

    #[test]
    fn setup_node_rejects_reserved_public_host_for_non_genesis_validator() {
        with_temp_home(|_| {
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let error = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Reserved Validator".to_string()),
                    intended_directory: None,
                    public_host: Some("203.0.113.20".to_string()),
                    node_address_override: None,
                    identity_passphrase: Some("test-passphrase".to_string()),
                    skip_canonical_manifests: false,
                }))
                .expect_err("reserved validator host should fail before provisioning");

            assert!(
                error.contains("publicly routable"),
                "unexpected error: {error}"
            );
        });
    }

    #[test]
    fn setup_node_rejects_validator_address_override_with_wallet_prefix() {
        with_temp_home(|_| {
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let error = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Wrong Address Type".to_string()),
                    intended_directory: None,
                    public_host: Some("93.184.216.39".to_string()),
                    node_address_override: Some("syns1walletaddresswrongtype".to_string()),
                    identity_passphrase: Some("test-passphrase".to_string()),
                    skip_canonical_manifests: false,
                }))
                .expect_err("validator address override should require synv1 prefix");

            assert!(
                error.contains("wrong address type"),
                "unexpected error: {error}"
            );
        });
    }

    #[test]
    fn setup_node_honors_node_address_override() {
        with_temp_home(|_| {
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let override_address = "synv11mka64uz049aekwhdvfrq6dvh75d0k7kmdp5".to_string();
            let result = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Genesis Validator Override".to_string()),
                    intended_directory: None,
                    public_host: None,
                    node_address_override: Some(override_address.clone()),
                    identity_passphrase: Some("test-passphrase".to_string()),
                    skip_canonical_manifests: false,
                }))
                .expect("setup should succeed");

            assert_eq!(result.node.node_address, override_address);

            let node_toml = fs::read_to_string(config_path_for(&result.node, "node.toml"))
                .expect("node.toml should exist");
            assert!(
                node_toml
                    .contains("validator_address = \"synv11mka64uz049aekwhdvfrq6dvh75d0k7kmdp5\""),
                "node.toml should be rendered with the override address"
            );
            assert!(
                result
                    .node
                    .connectivity_status
                    .contains("Private validator mesh configured"),
                "canonical genesis validators should keep the private mesh"
            );

            let node_value: toml::Value =
                toml::from_str(&node_toml).expect("node.toml should parse");
            assert_eq!(
                node_value
                    .get("node")
                    .and_then(|section| section.get("auto_register_validator"))
                    .and_then(toml::Value::as_bool),
                Some(false)
            );
            assert!(node_value
                .get("network")
                .and_then(|section| section.get("bootnodes"))
                .and_then(toml::Value::as_array)
                .expect("bootnodes array should exist")
                .is_empty());
            assert_eq!(
                node_value
                    .get("network")
                    .and_then(|section| section.get("additional_dial_targets"))
                    .and_then(toml::Value::as_array)
                    .expect("additional_dial_targets array should exist")
                    .len(),
                4
            );
        });
    }

    #[test]
    fn seed_peer_target_dedup_prefers_latest_registration_for_same_validator() {
        let mut unique = HashMap::new();

        record_seed_peer_dial_target(
            &mut unique,
            &json!({
                "role_id": "validator",
                "wallet_address": "synv1validator",
                "dial": "snr://synv1validator@10.69.0.2:5622",
                "registered_at_utc": "2026-04-06T17:00:00Z"
            }),
        );
        record_seed_peer_dial_target(
            &mut unique,
            &json!({
                "role_id": "validator",
                "wallet_address": "synv1validator",
                "dial": "snr://synv1validator@10.69.0.2:5622",
                "registered_at_utc": "2026-04-06T17:05:00Z"
            }),
        );

        let mut dials = unique
            .into_values()
            .map(|(_, dial)| dial)
            .collect::<Vec<_>>();
        dials.sort();
        assert_eq!(dials, vec!["10.69.0.2:5622".to_string()]);
    }

    #[test]
    fn seed_peer_target_dedup_preserves_distinct_validators_on_shared_public_host() {
        let mut unique = HashMap::new();

        for (wallet, port) in [
            ("synv1validator2", 5622_u16),
            ("synv1validator3", 5622_u16),
            ("synv1validator4", 5622_u16),
        ] {
            record_seed_peer_dial_target(
                &mut unique,
                &json!({
                    "role_id": "validator",
                    "wallet_address": wallet,
                    "public_host": "10.69.0.2",
                    "p2p_port": port,
                    "registered_at_utc": "2026-04-06T17:05:00Z"
                }),
            );
        }

        let mut dials = unique
            .into_values()
            .map(|(_, dial)| dial)
            .collect::<Vec<_>>();
        dials.sort();
        assert_eq!(
            dials,
            vec![
                "10.69.0.2:5622".to_string(),
                "10.69.0.2:5622".to_string(),
                "10.69.0.2:5622".to_string(),
            ]
        );
    }

    #[test]
    fn seed_peer_target_dedup_ignores_non_validator_roles() {
        let mut unique = HashMap::new();

        record_seed_peer_dial_target(
            &mut unique,
            &json!({
                "node_id": "rpc-gateway-01",
                "role_id": "rpc_gateway",
                "public_host": "testnet-core-rpc.synergy-network.io",
                "p2p_port": 5635,
                "registered_at_utc": "2026-04-07T03:05:00Z"
            }),
        );

        assert!(unique.is_empty());
    }

    #[test]
    fn non_genesis_validator_public_targets_are_relayers_only() {
        let targets = canonical_public_validator_dial_targets();

        assert!(
            targets.contains(&"relay1.synergynode.xyz:5622".to_string())
                && targets.contains(&"relay2.synergynode.xyz:5622".to_string()),
            "public validator bootstrap must include the relayer pair"
        );
        assert!(
            targets.iter().all(|target| !target.contains("62.146.182.")
                && !target.contains("73.79.66.255")
                && !target.contains("194.163.183.166")
                && !target.contains("10.69.0.")),
            "public validator bootstrap must not expose direct genesis validator peers: {targets:?}"
        );
    }

    #[test]
    fn seed_peer_matches_current_validator_identity() {
        let node = TestnetProvisionedNode {
            id: "testnet-validator1".to_string(),
            role_id: "validator".to_string(),
            role_display_name: "Validator Node".to_string(),
            class_name: "Consensus".to_string(),
            display_label: "Genesis Validator 1 Node".to_string(),
            node_address: "synv1validator1".to_string(),
            public_key_path: String::new(),
            private_key_path: String::new(),
            workspace_directory: String::new(),
            config_paths: Vec::new(),
            public_host: Some("62.146.182.207".to_string()),
            reward_payout_address: None,
            connectivity_status: String::new(),
            role_certificate_status: String::new(),
            funding_manifest_id: String::new(),
            created_at_utc: Utc::now().to_rfc3339(),
            port_slot: Some(0),
        };

        assert!(seed_peer_matches_node(
            &json!({
                "role_id": "validator",
                "wallet_address": "synv1validator1",
                "public_host": "10.69.0.1",
                "p2p_port": 5622
            }),
            &node
        ));
    }

    #[test]
    fn self_dial_filter_only_removes_current_validator_target() {
        with_temp_home(|home| {
            let workspace = home.join("validator-workspace");
            let config_dir = workspace.join("config");
            fs::create_dir_all(&config_dir).expect("config dir should exist");

            write_file(
                &config_dir.join("node.toml"),
                r#"[network]
public_host = "62.146.182.207"
p2p_port = 5622

[p2p]
public_address = "62.146.182.207:5622"
"#,
            )
            .expect("node.toml should write");

            write_file(
                &config_dir.join("operational-manifest.json"),
                &serde_json::to_string_pretty(&json!({
                    "validators": [
                        {"address": "synv1validator1", "slot": 1},
                        {"address": "synv1validator5", "slot": 5}
                    ]
                }))
                .expect("manifest should serialize"),
            )
            .expect("manifest should write");

            let node = TestnetProvisionedNode {
                id: "testnet-validator1".to_string(),
                role_id: "validator".to_string(),
                role_display_name: "Validator Node".to_string(),
                class_name: "Consensus".to_string(),
                display_label: "Genesis Validator 1 Node".to_string(),
                node_address: "synv1validator1".to_string(),
                public_key_path: String::new(),
                private_key_path: String::new(),
                workspace_directory: workspace.to_string_lossy().to_string(),
                config_paths: vec![config_dir.join("node.toml").to_string_lossy().to_string()],
                public_host: Some("62.146.182.207".to_string()),
                reward_payout_address: None,
                connectivity_status: String::new(),
                role_certificate_status: String::new(),
                funding_manifest_id: String::new(),
                created_at_utc: Utc::now().to_rfc3339(),
                port_slot: Some(0),
            };

            let mut targets = vec!["10.69.0.1:5622".to_string(), "10.69.0.5:5622".to_string()];
            filter_self_dial_targets_for_node(&mut targets, &node, &workspace);

            assert_eq!(targets, vec!["10.69.0.5:5622".to_string()]);
        });
    }

    #[test]
    fn setup_node_can_skip_canonical_workspace_manifests() {
        with_temp_home(|_| {
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let result = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Validator Import Staging".to_string()),
                    intended_directory: None,
                    public_host: Some("93.184.216.34".to_string()),
                    node_address_override: None,
                    identity_passphrase: Some("test-passphrase".to_string()),
                    skip_canonical_manifests: true,
                }))
                .expect("setup should succeed");

            let workspace = PathBuf::from(&result.node.workspace_directory);
            assert!(
                !workspace.join("config").join("genesis.json").exists(),
                "skip flag should leave genesis.json for the import bundle to write"
            );
            assert!(
                !workspace
                    .join("config")
                    .join("operational-manifest.json")
                    .exists(),
                "skip flag should leave operational-manifest.json for the import bundle to write"
            );
            assert!(
                workspace.join("config").join("node.toml").is_file(),
                "core node config should still be generated"
            );
        });
    }

    #[test]
    fn ceremony_validator_import_overrides_keep_genesis_validator_settings() {
        let package = TestnetCeremonyPackage {
            format: "synergy-testnet-ceremony-package/v1".to_string(),
            package_type: "validator-runtime".to_string(),
            role_id: "validator".to_string(),
            display_name: "Genesis Validator 1 Node".to_string(),
            chain_id: TESTNET_CHAIN_ID,
            network_id: TESTNET_CHAIN_NAME.to_string(),
            token_symbol: TOKEN_SYMBOL.to_string(),
            validator_slot: Some(1),
            assigned_ports: None,
            artifacts: TestnetCeremonyPackageArtifacts {
                genesis: json!({
                    "contracts": {
                        "validator_registry": {
                            "init_params": {
                                "validators": [
                                    {"validator_address": "synv1alpha"},
                                    {"validator_address": "synv1beta"}
                                ]
                            }
                        }
                    }
                }),
                operational_manifest: json!({}),
            },
            runtime_identity: None,
            validator_public: None,
            public_host: None,
            public_host_required: false,
            notes: Vec::new(),
        };
        let base = "[node]\nbootstrap_only = false\nauto_register_validator = true\nvalidator_address = \"synv1alpha\"\nstrict_validator_allowlist = false\nallowed_validator_addresses = []\n".to_string();

        let updated = apply_ceremony_validator_config_overrides(base, &package);

        assert!(updated.contains("auto_register_validator = false"));
        assert!(updated.contains("strict_validator_allowlist = true"));
        assert!(updated.contains("allowed_validator_addresses = [\"synv1alpha\", \"synv1beta\"]"));
    }

    #[test]
    fn repair_workspace_config_skips_ceremony_imported_validator_workspace() {
        let temp = TempDir::new().expect("temp workspace");
        let workspace = temp.path();
        let config_path = workspace.join("config").join("node.toml");
        let manifest_path = workspace.join("manifests").join("ceremony-package.json");

        write_file(
            &config_path,
            "[node]\nauto_register_validator = false\nstrict_validator_allowlist = true\n",
        )
        .expect("config should write");
        write_file(&manifest_path, "{}").expect("manifest should write");

        repair_workspace_config_if_needed("validator", &config_path)
            .expect("repair should not fail");

        let contents = fs::read_to_string(&config_path).expect("config should still exist");
        assert!(
            contents.contains("auto_register_validator = false"),
            "ceremony-imported validators should keep their imported auto-register setting"
        );
    }

    #[test]
    fn repair_workspace_config_migrates_stale_consensus_timing() {
        let temp = TempDir::new().expect("temp workspace");
        let config_path = temp.path().join("config").join("node.toml");
        write_file(
            &config_path,
            r#"[blockchain]
block_time = 2

[consensus]
block_time_secs = 2
min_validators = 4
validator_cluster_size = 7
validator_vote_threshold = 4
max_validators = 100
mesh_settle_secs = 15
leader_timeout_secs = 15
vote_timeout_secs = 8
block_timeout_secs = 30
"#,
        )
        .expect("config should write");

        repair_workspace_config_if_needed("validator", &config_path).expect("repair should pass");

        let repaired = read_toml_value(&config_path).expect("config should parse");
        let consensus = repaired
            .get("consensus")
            .and_then(toml::Value::as_table)
            .expect("consensus table should exist");
        assert_eq!(consensus["mesh_settle_secs"].as_integer(), Some(1));
        assert_eq!(consensus["leader_timeout_secs"].as_integer(), Some(4));
        assert_eq!(consensus["vote_timeout_secs"].as_integer(), Some(2));
        assert_eq!(consensus["block_timeout_secs"].as_integer(), Some(6));
    }

    #[test]
    fn repair_workspace_config_restores_ceremony_validator_ports_from_base_slot() {
        with_temp_home(|_| {
            let root = ensure_testnet_root().expect("testnet root should exist");
            let workspace = root.join("nodes").join("validator4-workspace");
            let config_path = workspace.join("config").join("node.toml");
            let manifest_path = workspace.join("manifests").join("ceremony-package.json");
            fs::create_dir_all(config_path.parent().expect("config parent"))
                .expect("config dir should exist");
            fs::create_dir_all(manifest_path.parent().expect("manifest parent"))
                .expect("manifest dir should exist");

            let network_profile =
                load_or_create_network_profile(&root).expect("network profile should exist");
            let role = find_role_profile("validator").expect("validator role should exist");
            let package = TestnetCeremonyPackage {
                format: "synergy-testnet-ceremony-package/v1".to_string(),
                package_type: "validator-runtime".to_string(),
                role_id: "validator".to_string(),
                display_name: "Genesis Validator 4 Node".to_string(),
                chain_id: TESTNET_CHAIN_ID,
                network_id: TESTNET_CHAIN_NAME.to_string(),
                token_symbol: TOKEN_SYMBOL.to_string(),
                validator_slot: Some(4),
                assigned_ports: Some(TestnetCeremonyAssignedPorts {
                    port_slot: Some(3),
                    p2p_port: 5622,
                    public_p2p_port: None,
                    rpc_port: 5640,
                    ws_port: 5660,
                    grpc_port: 5640,
                    discovery_port: 5680,
                    public_discovery_port: None,
                    metrics_port: 6030,
                }),
                artifacts: TestnetCeremonyPackageArtifacts {
                    genesis: json!({
                        "integrity": {
                            "genesis_hash": "test-genesis-hash"
                        }
                    }),
                    operational_manifest: json!({}),
                },
                runtime_identity: None,
                validator_public: None,
                public_host: None,
                public_host_required: false,
                notes: Vec::new(),
            };

            let base_node_toml = build_node_toml(
                "testnet-validator4",
                "Genesis Validator 4 Node",
                &role,
                "synv1validator4",
                &workspace,
                Some("validator4.example.net"),
                &network_profile,
                role_overlay_for("validator").as_str(),
                0,
                None,
            );
            let base_node_toml =
                apply_ceremony_validator_config_overrides(base_node_toml, &package);
            write_file(&config_path, &base_node_toml).expect("node config should write");
            write_file(
                &manifest_path,
                &serde_json::to_string_pretty(&package).expect("package should serialize"),
            )
            .expect("manifest should write");

            let registry = TestnetRegistryFile {
                version: STATE_VERSION,
                nodes: vec![TestnetProvisionedNode {
                    id: "testnet-validator4".to_string(),
                    role_id: "validator".to_string(),
                    role_display_name: "Validator Node".to_string(),
                    class_name: "Consensus".to_string(),
                    display_label: "Genesis Validator 4 Node".to_string(),
                    node_address: "synv1validator4".to_string(),
                    public_key_path: workspace
                        .join("keys")
                        .join("public.key")
                        .to_string_lossy()
                        .to_string(),
                    private_key_path: workspace
                        .join("keys")
                        .join("private.key")
                        .to_string_lossy()
                        .to_string(),
                    workspace_directory: workspace.to_string_lossy().to_string(),
                    config_paths: vec![config_path.to_string_lossy().to_string()],
                    public_host: Some("validator4.example.net".to_string()),
                    reward_payout_address: Some("synv1validator4".to_string()),
                    connectivity_status: String::new(),
                    role_certificate_status: String::new(),
                    funding_manifest_id: "fund-test".to_string(),
                    created_at_utc: Utc::now().to_rfc3339(),
                    port_slot: Some(0),
                }],
            };
            save_registry(&root, &registry).expect("registry should save");

            repair_workspace_config_if_needed("validator", &config_path)
                .expect("repair should succeed");

            let node_toml = fs::read_to_string(&config_path).expect("node.toml should exist");
            let node_value: toml::Value =
                toml::from_str(&node_toml).expect("node.toml should parse");
            assert_eq!(
                node_value
                    .get("network")
                    .and_then(|section| section.get("p2p_port"))
                    .and_then(toml::Value::as_integer),
                Some(5622)
            );
            assert_eq!(
                node_value
                    .get("rpc")
                    .and_then(|section| section.get("http_port"))
                    .and_then(toml::Value::as_integer),
                Some(5640)
            );
            assert_eq!(
                node_value
                    .get("rpc")
                    .and_then(|section| section.get("ws_port"))
                    .and_then(toml::Value::as_integer),
                Some(5660)
            );
            assert_eq!(
                node_value
                    .get("p2p")
                    .and_then(|section| section.get("discovery_port"))
                    .and_then(toml::Value::as_integer),
                Some(5680)
            );
            assert_eq!(
                node_value
                    .get("telemetry")
                    .and_then(|section| section.get("metrics_bind"))
                    .and_then(toml::Value::as_str),
                Some("0.0.0.0:6030")
            );
            assert_eq!(
                node_value
                    .get("p2p")
                    .and_then(|section| section.get("public_address"))
                    .and_then(toml::Value::as_str),
                Some("validator4.example.net:5622")
            );

            let registry = load_registry(&root).expect("registry should load");
            assert_eq!(registry.nodes[0].port_slot, Some(0));
        });
    }

    #[test]
    fn ceremony_import_reuses_existing_workspace_for_same_validator_identity() {
        let registry = TestnetRegistryFile {
            version: STATE_VERSION,
            nodes: vec![TestnetProvisionedNode {
                id: "testnet-existing".to_string(),
                role_id: "validator".to_string(),
                role_display_name: "Validator Node".to_string(),
                class_name: "Consensus".to_string(),
                display_label: "Genesis Validator 1 Node".to_string(),
                node_address: "synv1existing".to_string(),
                public_key_path: "/tmp/public.key".to_string(),
                private_key_path: "/tmp/private.key".to_string(),
                workspace_directory: "/tmp/validator-workspace".to_string(),
                config_paths: Vec::new(),
                public_host: None,
                reward_payout_address: None,
                connectivity_status: "configured".to_string(),
                role_certificate_status: "imported".to_string(),
                funding_manifest_id: "fund-1".to_string(),
                created_at_utc: Utc::now().to_rfc3339(),
                port_slot: Some(0),
            }],
        };
        let package = TestnetCeremonyPackage {
            format: "synergy-testnet-ceremony-package/v1".to_string(),
            package_type: "validator-runtime".to_string(),
            role_id: "validator".to_string(),
            display_name: "Genesis Validator 1 Node".to_string(),
            chain_id: TESTNET_CHAIN_ID,
            network_id: TESTNET_CHAIN_NAME.to_string(),
            token_symbol: TOKEN_SYMBOL.to_string(),
            validator_slot: Some(1),
            assigned_ports: None,
            artifacts: TestnetCeremonyPackageArtifacts {
                genesis: json!({
                    "integrity": {
                        "genesis_hash": "test-genesis-hash"
                    }
                }),
                operational_manifest: json!({}),
            },
            runtime_identity: Some(TestnetCeremonyRuntimeIdentity {
                label: "Genesis Validator 1".to_string(),
                address: "synv1existing".to_string(),
                address_type: "synv1".to_string(),
                algorithm: "ed25519".to_string(),
                created_at: Utc::now().to_rfc3339(),
                public_key: "pub".to_string(),
                private_key: "priv".to_string(),
            }),
            validator_public: None,
            public_host: None,
            public_host_required: false,
            notes: Vec::new(),
        };

        let matched = find_existing_ceremony_node_match(&registry, &package, None)
            .expect("existing validator workspace should match by identity address");

        assert_eq!(matched.id, "testnet-existing");
        assert_eq!(matched.workspace_directory, "/tmp/validator-workspace");
    }

    #[test]
    fn inspect_ceremony_package_accepts_validator_setup_package_json() {
        with_temp_home(|home| {
            let package_path = home.join("validator-setup-package.json");
            let canonical_genesis =
                canonical_testnet_genesis_value().expect("canonical genesis should load");
            let canonical_manifest = canonical_testnet_operational_manifest_value()
                .expect("canonical manifest should load");
            let package = json!({
                "format": "synergy-testnet-ceremony-package/v1",
                "package_type": "validator-runtime",
                "role_id": "validator",
                "display_name": "Genesis Validator 1 Node",
                "chain_id": TESTNET_CHAIN_ID,
                "network_id": TESTNET_CHAIN_NAME,
                "token_symbol": TOKEN_SYMBOL,
                "validator_slot": 1,
                "artifacts": {
                    "genesis": canonical_genesis,
                    "operational_manifest": canonical_manifest
                },
                "public_host_required": false
            });
            write_json_file(&package_path, &package).expect("package should write");

            let preview = testnet_inspect_ceremony_package(TestnetInspectCeremonyPackageInput {
                package_path: package_path.to_string_lossy().to_string(),
            })
            .expect("validator setup package should inspect");

            assert_eq!(preview.role_id, "validator");
            assert_eq!(preview.package_type, "validator-runtime");
            assert_eq!(preview.validator_slot, Some(1));
        });
    }

    #[test]
    fn ceremony_import_infers_role_from_package_when_setup_role_is_missing() {
        with_temp_home(|home| {
            let package_path = home.join("validator-setup-package.json");
            let canonical_genesis =
                canonical_testnet_genesis_value().expect("canonical genesis should load");
            let canonical_manifest = canonical_testnet_operational_manifest_value()
                .expect("canonical manifest should load");
            let package = json!({
                "format": "synergy-testnet-ceremony-package/v1",
                "package_type": "validator-runtime",
                "role_id": "validator",
                "display_name": "Genesis Validator 1 Node",
                "chain_id": TESTNET_CHAIN_ID,
                "network_id": TESTNET_CHAIN_NAME,
                "token_symbol": TOKEN_SYMBOL,
                "validator_slot": 1,
                "artifacts": {
                    "genesis": canonical_genesis,
                    "operational_manifest": canonical_manifest
                },
                "public_host_required": false
            });
            write_json_file(&package_path, &package).expect("package should write");

            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let result = runtime
                .block_on(testnet_import_ceremony_package(
                    TestnetImportCeremonyPackageInput {
                        setup_role_id: None,
                        package_path: package_path.to_string_lossy().to_string(),
                        intended_directory: None,
                        public_host: None,
                        identity_passphrase: Some("test-passphrase".to_string()),
                    },
                ))
                .expect("package import should infer the validator role");

            assert_eq!(result.role_id, "validator");
            assert_eq!(
                result.node.as_ref().map(|node| node.role_id.as_str()),
                Some("validator")
            );
            assert!(
                PathBuf::from(&result.workspace_directory)
                    .join("manifests")
                    .join("ceremony-package.json")
                    .is_file(),
                "ceremony import should stage the original package into the workspace"
            );
        });
    }

    #[test]
    fn ceremony_import_applies_assigned_validator_ports() {
        with_temp_home(|home| {
            let package_path = home.join("validator-4-setup-package.json");
            let canonical_genesis =
                canonical_testnet_genesis_value().expect("canonical genesis should load");
            let canonical_manifest = canonical_testnet_operational_manifest_value()
                .expect("canonical manifest should load");
            let package = json!({
                "format": "synergy-testnet-ceremony-package/v1",
                "package_type": "validator-runtime",
                "role_id": "validator",
                "display_name": "Genesis Validator 4 Node",
                "chain_id": TESTNET_CHAIN_ID,
                "network_id": TESTNET_CHAIN_NAME,
                "token_symbol": TOKEN_SYMBOL,
                "validator_slot": 4,
                "assigned_ports": {
                    "port_slot": 3,
                    "p2p_port": 5622,
                    "rpc_port": 5640,
                    "ws_port": 5660,
                    "grpc_port": 5640,
                    "discovery_port": 5680,
                    "metrics_port": 6030
                },
                "artifacts": {
                    "genesis": canonical_genesis,
                    "operational_manifest": canonical_manifest
                },
                "runtime_identity": {
                    "label": "Genesis Validator 4",
                    "address": "synv11mka64uz049aekwhdvfrq6dvh75d0k7kmdp5",
                    "address_type": "synv1",
                    "algorithm": "ed25519",
                    "created_at": Utc::now().to_rfc3339(),
                    "public_key": "pub",
                    "private_key": "priv"
                },
                "public_host_required": false
            });
            write_json_file(&package_path, &package).expect("package should write");

            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let result = runtime
                .block_on(testnet_import_ceremony_package(
                    TestnetImportCeremonyPackageInput {
                        setup_role_id: None,
                        package_path: package_path.to_string_lossy().to_string(),
                        intended_directory: None,
                        public_host: Some("validator4.example.net".to_string()),
                        identity_passphrase: Some("test-passphrase".to_string()),
                    },
                ))
                .expect("package import should succeed");

            let node = result.node.expect("validator node should be returned");
            assert_eq!(node.port_slot, Some(0));

            let node_toml = fs::read_to_string(config_path_for(&node, "node.toml"))
                .expect("node.toml should exist");
            let node_value: toml::Value =
                toml::from_str(&node_toml).expect("node.toml should parse");

            assert_eq!(
                node_value
                    .get("network")
                    .and_then(|section| section.get("p2p_port"))
                    .and_then(toml::Value::as_integer),
                Some(5622)
            );
            assert_eq!(
                node_value
                    .get("rpc")
                    .and_then(|section| section.get("http_port"))
                    .and_then(toml::Value::as_integer),
                Some(5640)
            );
            assert_eq!(
                node_value
                    .get("rpc")
                    .and_then(|section| section.get("ws_port"))
                    .and_then(toml::Value::as_integer),
                Some(5660)
            );
            assert_eq!(
                node_value
                    .get("p2p")
                    .and_then(|section| section.get("discovery_port"))
                    .and_then(toml::Value::as_integer),
                Some(5680)
            );
            assert_eq!(
                node_value
                    .get("telemetry")
                    .and_then(|section| section.get("metrics_bind"))
                    .and_then(toml::Value::as_str),
                Some("0.0.0.0:6030")
            );
            assert_eq!(
                node_value
                    .get("p2p")
                    .and_then(|section| section.get("public_address"))
                    .and_then(toml::Value::as_str),
                Some("10.69.0.4:5622")
            );
        });
    }

    #[test]
    fn resolve_runner_falls_back_to_generic_platform_binary() {
        with_temp_home(|home| {
            let _cwd = CurrentDirGuard::set(home);
            let resources = home.join("resources");
            let binaries = resources.join("binaries");
            fs::create_dir_all(&binaries).expect("binaries dir should exist");

            let platform_binary = binaries.join(current_platform_testnet_binary_names()[0]);
            fs::write(&platform_binary, b"#!/bin/sh\n").expect("test binary should write");

            let _resource_root = EnvVarGuard::set_path("SYNERGY_RESOURCE_ROOT", &resources);
            let app_context = AppContext::from_env();
            let runner =
                resolve_testnet_runner(&app_context, "validator").expect("runner should resolve");

            match runner {
                TestnetRunner::Binary(path) => assert_eq!(path, platform_binary),
                other => panic!(
                    "expected binary runner fallback, got {:?}",
                    std::mem::discriminant(&other)
                ),
            }
        });
    }

    #[test]
    #[cfg(unix)]
    fn node_control_start_uses_generic_runner_and_marks_workspace_running() {
        use std::os::unix::fs::PermissionsExt;

        with_temp_home(|home| {
            let resources = home.join("resources");
            let binaries = resources.join("binaries");
            fs::create_dir_all(&binaries).expect("binaries dir should exist");
            let _cwd = CurrentDirGuard::set(home);

            let runner_path = binaries.join(current_platform_testnet_binary_names()[0]);
            fs::write(
                &runner_path,
                r#"#!/bin/sh
set -eu
cmd="$1"
shift || true
case "$cmd" in
  start)
    mkdir -p data logs
    echo $$ > data/synergy-testnet.pid
    echo '{"ok":true}' > data/role-runtime.json
    eval "$(python3 - "$SYNERGY_CONFIG_PATH" <<'PY'
import pathlib
import re
import sys

config_path = pathlib.Path(sys.argv[1])
contents = config_path.read_text()
rpc_match = re.search(r"(?m)^\s*http_port\s*=\s*(\d+)\s*$", contents)
validator_match = re.search(r'(?m)^\s*validator_address\s*=\s*"([^"]+)"\s*$', contents)
print(f'rpc_port="{rpc_match.group(1) if rpc_match else "5640"}"')
print(f'validator_address="{validator_match.group(1) if validator_match else ""}"')
PY
)"
    if [ -n "$validator_address" ]; then
      if [ "${SYNERGY_VALIDATOR_ADDRESS:-}" != "$validator_address" ]; then
        echo "missing validator env" >&2
        exit 1
      fi
      if [ "${NODE_ADDRESS:-}" != "$validator_address" ]; then
        echo "missing node address env" >&2
        exit 1
      fi
    fi
    python3 - "$rpc_port" > logs/rpc-test.out 2> logs/rpc-test.err <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return

HTTPServer(("127.0.0.1", port), Handler).serve_forever()
PY
    echo $! > data/rpc-test.pid
    sleep 30
    ;;
  stop)
    if [ -f data/rpc-test.pid ]; then
      rpc_pid="$(cat data/rpc-test.pid)"
      kill "$rpc_pid" >/dev/null 2>&1 || true
      rm -f data/rpc-test.pid
    fi
    if [ -f data/synergy-testnet.pid ]; then
      pid="$(cat data/synergy-testnet.pid)"
      kill "$pid" >/dev/null 2>&1 || true
      rm -f data/synergy-testnet.pid
    fi
    ;;
  sync)
    exit 0
    ;;
esac
"#,
            )
            .expect("runner test script should write");
            let mut permissions = fs::metadata(&runner_path)
                .expect("runner metadata should exist")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&runner_path, permissions).expect("runner should be executable");

            let _resource_root = EnvVarGuard::set_path("SYNERGY_RESOURCE_ROOT", &resources);
            let _skip_clock_skew =
                EnvVarGuard::set_path("SYNERGY_TEST_SKIP_CLOCK_SKEW_PREFLIGHT", Path::new("1"));
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let setup = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Validator Test".to_string()),
                    intended_directory: None,
                    public_host: Some("93.184.216.35".to_string()),
                    node_address_override: None,
                    identity_passphrase: Some("test-passphrase".to_string()),
                    skip_canonical_manifests: false,
                }))
                .expect("setup should succeed");
            let config_path = PathBuf::from(&setup.node.workspace_directory)
                .join("config")
                .join("node.toml");
            let config_contents =
                fs::read_to_string(&config_path).expect("workspace config should exist");
            let config_contents = config_contents
                .replace(
                    "bind_address = \"127.0.0.1:5640\"",
                    "bind_address = \"127.0.0.1:6140\"",
                )
                .replace("http_port = 5640", "http_port = 6140");
            fs::write(&config_path, config_contents).expect("workspace config should update");
            let app_context = AppContext::from_env();
            let start_result = runtime
                .block_on(testnet_node_control(
                    &app_context,
                    TestnetNodeControlInput {
                        node_id: setup.node.id.clone(),
                        action: "start".to_string(),
                    },
                ))
                .expect("start should succeed");

            assert_eq!(start_result.status, "ok");
            assert!(
                running_pid_for_workspace(Path::new(&setup.node.workspace_directory)).is_some(),
                "workspace PID should point to a live process"
            );

            runtime
                .block_on(testnet_node_control(
                    &app_context,
                    TestnetNodeControlInput {
                        node_id: setup.node.id,
                        action: "stop".to_string(),
                    },
                ))
                .expect("stop should succeed");
        });
    }

    #[test]
    #[cfg(unix)]
    fn runner_commands_export_workspace_runtime_env() {
        use std::os::unix::fs::PermissionsExt;

        with_temp_home(|home| {
            let workspace = home.join("validator-workspace");
            let config_dir = workspace.join("config");
            fs::create_dir_all(&config_dir).expect("config dir should exist");

            let config_path = config_dir.join("node.toml");
            fs::write(
                &config_path,
                "[rpc]\nhttp_port = 5640\n\n[node]\nvalidator_address = \"synv11mka64uz049aekwhdvfrq6dvh75d0k7kmdp5\"\n",
            )
            .expect("config should write");

            let env_dump_path = workspace.join("env-sync.json");
            let runner_path = home.join("runner-env-check.sh");
            fs::write(
                &runner_path,
                format!(
                    r#"#!/bin/sh
set -eu
cmd="$1"
shift || true
if [ "$cmd" != "sync" ]; then
  exit 1
fi
if [ "${{SYNERGY_PROJECT_ROOT:-}}" != "{workspace}" ]; then
  echo "missing project root env" >&2
  exit 1
fi
if [ "${{SYNERGY_CONFIG_PATH:-}}" != "{config}" ]; then
  echo "missing config env" >&2
  exit 1
fi
if [ "${{SYNERGY_VALIDATOR_ADDRESS:-}}" != "synv11mka64uz049aekwhdvfrq6dvh75d0k7kmdp5" ]; then
  echo "missing validator env" >&2
  exit 1
fi
if [ "${{NODE_ADDRESS:-}}" != "synv11mka64uz049aekwhdvfrq6dvh75d0k7kmdp5" ]; then
  echo "missing node address env" >&2
  exit 1
fi
cat > "{dump}" <<EOF
{{"project_root":"${{SYNERGY_PROJECT_ROOT}}","config_path":"${{SYNERGY_CONFIG_PATH}}","validator_address":"${{SYNERGY_VALIDATOR_ADDRESS}}","node_address":"${{NODE_ADDRESS}}"}}
EOF
"#,
                    workspace = workspace.display(),
                    config = config_path.display(),
                    dump = env_dump_path.display(),
                ),
            )
            .expect("runner script should write");
            let mut permissions = fs::metadata(&runner_path)
                .expect("runner metadata should exist")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&runner_path, permissions).expect("runner should be executable");

            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            runtime
                .block_on(run_runner_and_wait(
                    &TestnetRunner::Binary(runner_path),
                    "sync",
                    &config_path,
                    &workspace,
                ))
                .expect("sync should receive workspace env");

            let env_dump =
                fs::read_to_string(&env_dump_path).expect("env dump should be written by runner");
            assert!(
                env_dump.contains(&workspace.to_string_lossy().to_string()),
                "workspace env should be passed through to runner"
            );
            assert!(
                env_dump.contains(&config_path.to_string_lossy().to_string()),
                "config env should be passed through to runner"
            );
            assert!(
                env_dump.contains("synv11mka64uz049aekwhdvfrq6dvh75d0k7kmdp5"),
                "validator identity env should be passed through to runner"
            );
        });
    }

    #[test]
    fn setup_assigns_unique_port_slots_and_config_ports() {
        with_temp_home(|home| {
            let _cwd = CurrentDirGuard::set(home);
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");

            let first = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Validator A".to_string()),
                    intended_directory: None,
                    public_host: Some("93.184.216.36".to_string()),
                    node_address_override: None,
                    identity_passphrase: Some("test-passphrase".to_string()),
                    skip_canonical_manifests: false,
                }))
                .expect("first setup should succeed");
            let second = runtime
                .block_on(testnet_setup_node(TestnetSetupInput {
                    role_id: "rpc_gateway".to_string(),
                    display_label: Some("RPC B".to_string()),
                    intended_directory: None,
                    public_host: None,
                    node_address_override: None,
                    identity_passphrase: None,
                    skip_canonical_manifests: false,
                }))
                .expect("second setup should succeed");

            assert_eq!(first.node.port_slot, Some(0));
            assert_eq!(second.node.port_slot, Some(1));

            let second_toml = fs::read_to_string(config_path_for(&second.node, "node.toml"))
                .expect("second node.toml should exist");
            let second_value: toml::Value =
                toml::from_str(&second_toml).expect("second node.toml should parse");

            assert_eq!(
                second_value
                    .get("rpc")
                    .and_then(|section| section.get("http_port"))
                    .and_then(toml::Value::as_integer),
                Some(i64::from(TESTNET_RPC_PORT + 1))
            );
            assert_eq!(
                second_value
                    .get("p2p")
                    .and_then(|section| section.get("discovery_port"))
                    .and_then(toml::Value::as_integer),
                Some(i64::from(TESTNET_DISCOVERY_PORT + 1))
            );
        });
    }

    #[test]
    fn role_functions_document_current_runtime_state_for_all_roles() {
        let catalog = node_catalog();
        assert_eq!(catalog.len(), 19);

        let docs_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/node-role-functions.md");
        let docs = fs::read_to_string(&docs_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", docs_path.display()));

        assert!(
            docs.contains("Current runtime note"),
            "role doc should record current runtime notes"
        );

        for role in &catalog {
            let heading = format!("### {}", role.display_name);
            let alternate_heading = format!("### {}", role.display_name.replace('&', "and"));
            assert!(
                docs.contains(&heading) || docs.contains(&alternate_heading),
                "role doc should contain a section for {}",
                role.display_name
            );
        }
    }
}
