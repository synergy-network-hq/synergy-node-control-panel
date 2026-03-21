use crate::app_context::AppContext;
use chrono::Utc;
use futures_util::future::join_all;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use synergy_address_engine::{generate_identity, AddressType, SynergyIdentity};
use sysinfo::{Disks, Pid, System};
use tokio::net::TcpStream;
use tokio::time::timeout;
use uuid::Uuid;

const STATE_VERSION: u32 = 1;
const TESTNET_BETA_ENVIRONMENT_ID: &str = "testbeta";
const TESTNET_BETA_DISPLAY_NAME: &str = "Testnet-Beta";
const TESTNET_BETA_CHAIN_NAME: &str = "synergy-testnet-beta";
const TESTNET_BETA_CHAIN_ID: u64 = 338639;
const TESTNET_BETA_P2P_PORT: u16 = 38638;
const TESTNET_BETA_RPC_PORT: u16 = 48638;
const TESTNET_BETA_WS_PORT: u16 = 58638;
const TESTNET_BETA_DISCOVERY_PORT: u16 = 30301;
const TESTNET_BETA_METRICS_PORT: u16 = 9090;
const TESTNET_BETA_PUBLIC_RPC_ENDPOINT: &str = "https://testbeta-core-rpc.synergy-network.io";
const TOKEN_SYMBOL: &str = "SNRG";
const TOKEN_DECIMALS: u32 = 9;
const TOKEN_SCALE: u64 = 1_000_000_000;
const MINIMUM_STAKE_SNRG: u64 = 5_000;
const TREASURY_SUPPLY_SNRG: u64 = 100_000_000;
const FAUCET_SUPPLY_SNRG: u64 = 4_000_000_000;

static NODE_LIVE_CACHE: Lazy<Mutex<HashMap<String, CachedNodeLiveSnapshot>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
struct CachedNodeLiveSnapshot {
    local_chain_height: Option<u64>,
    local_peer_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaBootstrapEndpoint {
    pub kind: String,
    pub host: String,
    pub ip_address: String,
    pub port: u16,
    pub dns_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaWalletRecord {
    pub label: String,
    pub address: String,
    pub address_type: String,
    pub public_key_path: String,
    pub private_key_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaGenesisMint {
    pub label: String,
    pub wallet_address: String,
    pub amount_snrg: String,
    pub amount_nwei: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaFundingManifest {
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
pub struct TestnetBetaConnectivityPolicy {
    pub blocks_dashboard_access: bool,
    pub bootstrap_requirement: String,
    pub fallback_sequence: Vec<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaNetworkProfile {
    pub version: u32,
    pub environment_id: String,
    pub display_name: String,
    pub chain_name: String,
    pub chain_id: u64,
    pub token_symbol: String,
    pub token_decimals: u32,
    pub treasury_wallet: TestnetBetaWalletRecord,
    pub faucet_wallet: TestnetBetaWalletRecord,
    pub stake_vault_wallet: TestnetBetaWalletRecord,
    pub genesis_mints: Vec<TestnetBetaGenesisMint>,
    pub bootnodes: Vec<TestnetBetaBootstrapEndpoint>,
    pub seed_servers: Vec<TestnetBetaBootstrapEndpoint>,
    pub bootstrap_policy: TestnetBetaConnectivityPolicy,
    pub funding_manifests: Vec<TestnetBetaFundingManifest>,
    pub created_at_utc: String,
    pub updated_at_utc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaDeviceProfile {
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
pub struct TestnetBetaRoleProfile {
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
pub struct TestnetBetaProvisionedNode {
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
struct TestnetBetaRegistryFile {
    pub version: u32,
    #[serde(default)]
    pub nodes: Vec<TestnetBetaProvisionedNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaDashboardSummary {
    pub total_nodes: usize,
    pub active_role_profiles: usize,
    pub total_sponsored_stake_snrg: String,
    pub total_sponsored_stake_nwei: String,
    pub connectivity_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaState {
    pub environment_id: String,
    pub display_name: String,
    pub device_profile: TestnetBetaDeviceProfile,
    pub network_profile: TestnetBetaNetworkProfile,
    pub node_catalog: Vec<TestnetBetaRoleProfile>,
    pub nodes: Vec<TestnetBetaProvisionedNode>,
    pub summary: TestnetBetaDashboardSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaEndpointLiveStatus {
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
pub struct TestnetBetaNodeLiveStatus {
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
    pub sync_gap: Option<u64>,
    pub log_local_chain_height: Option<u64>,
    pub best_observed_peer_height: Option<u64>,
    pub best_network_height: Option<u64>,
    pub synergy_score: Option<f64>,
    pub synergy_score_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaLiveStatus {
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
    pub bootnodes: Vec<TestnetBetaEndpointLiveStatus>,
    pub seed_servers: Vec<TestnetBetaEndpointLiveStatus>,
    pub nodes: Vec<TestnetBetaNodeLiveStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetBetaSetupInput {
    pub role_id: String,
    pub display_label: Option<String>,
    pub intended_directory: Option<String>,
    /// If the node will run on a remote server rather than this machine, supply
    /// that server's public IP here.  When set it takes precedence over the
    /// automatic public-host detection and is baked into node.toml and the
    /// generated nginx.conf at provisioning time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaSetupResult {
    pub node: TestnetBetaProvisionedNode,
    pub network_profile: TestnetBetaNetworkProfile,
    pub device_profile: TestnetBetaDeviceProfile,
    pub next_steps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestnetBetaNodeControlInput {
    pub node_id: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaNodeControlResult {
    pub node_id: String,
    pub action: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaRemoveNodeInput {
    pub node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestnetBetaRemoveNodeResult {
    pub node_id: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GeneratedWalletFiles {
    wallet: TestnetBetaWalletRecord,
}

pub fn testbeta_get_state() -> Result<TestnetBetaState, String> {
    build_state()
}

pub fn testbeta_get_device_profile() -> Result<TestnetBetaDeviceProfile, String> {
    Ok(detect_device_profile())
}

pub fn testbeta_get_catalog() -> Result<Vec<TestnetBetaRoleProfile>, String> {
    Ok(node_catalog())
}

pub async fn testbeta_get_live_status() -> Result<TestnetBetaLiveStatus, String> {
    let state = build_state()?;
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("Failed to create live-status HTTP client: {error}"))?;

    let bootnodes = join_all(
        state
            .network_profile
            .bootnodes
            .iter()
            .cloned()
            .map(check_bootstrap_endpoint),
    )
    .await;
    let seed_servers = join_all(
        state
            .network_profile
            .seed_servers
            .iter()
            .cloned()
            .map(|endpoint| check_seed_endpoint(&client, endpoint)),
    )
    .await;

    let public_chain_height = query_public_chain_height(&client).await.ok();
    let public_peer_count = query_public_peer_count(&client).await.ok();
    let network_peer_count =
        query_seed_peer_count(&client, &state.network_profile.seed_servers).await.ok();
    let public_rpc_online = public_chain_height.is_some() || public_peer_count.is_some();

    let nodes = join_all(
        state
            .nodes
            .iter()
            .map(|node| build_node_live_status(&client, node)),
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

    Ok(TestnetBetaLiveStatus {
        generated_at_utc: Utc::now().to_rfc3339(),
        public_rpc_endpoint: TESTNET_BETA_PUBLIC_RPC_ENDPOINT.to_string(),
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

pub async fn testbeta_node_control(
    app_context: &AppContext,
    input: TestnetBetaNodeControlInput,
) -> Result<TestnetBetaNodeControlResult, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|entry| entry.id == input.node_id)
        .cloned()
        .ok_or_else(|| format!("Unknown Testnet-Beta node: {}", input.node_id))?;

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
    let runner = resolve_testbeta_runner(app_context, &node.role_id)?;
    let action = input.action.trim().to_ascii_lowercase();
    let is_running = running_pid_for_workspace(&workspace_directory).is_some();

    match action.as_str() {
        "start" => {
            if is_running {
                return Ok(TestnetBetaNodeControlResult {
                    node_id: node.id,
                    action,
                    status: "ignored".to_string(),
                    message: "Node is already running.".to_string(),
                });
            }

            // Refresh genesis.json before launch so all currently provisioned
            // validator nodes are in the validator manager when the binary boots.
            // Without this each node self-registers only itself (1 validator)
            // which is below min_validators=3 and blocks block production.
            if let Err(e) = write_genesis_json_for_workspace(&state.nodes, &workspace_directory) {
                eprintln!(
                    "Warning: could not write genesis.json for {}: {e}",
                    node.display_label
                );
            }

            // Inject localhost dial targets for every other node provisioned on
            // this machine so same-machine validators can peer directly without
            // relying on NAT loop-back through the public IP.  We merge with
            // whatever the JS bootstrap refresh already wrote (seed-server peers)
            // so nothing is lost.
            {
                let peers_toml_path = workspace_directory.join("config").join("peers.toml");
                let mut targets = read_peers_toml_additional_targets(&peers_toml_path);
                for sibling in local_sibling_dial_targets(&state.nodes, &node.id) {
                    if !targets.contains(&sibling) {
                        targets.push(sibling);
                    }
                }
                let peers_contents =
                    build_peers_toml_with_additional(&state.network_profile, &targets);
                if let Err(e) = write_file(&peers_toml_path, &peers_contents) {
                    eprintln!(
                        "Warning: could not refresh peers.toml for {}: {e}",
                        node.display_label
                    );
                }
            }

            launch_runner_detached(&runner, "start", &config_path, &workspace_directory).await?;
            wait_for_workspace_start(&workspace_directory, Duration::from_secs(30)).await?;
            if let Err(error) = register_node_with_seeds_async(&state.network_profile, &node).await
            {
                eprintln!("Warning: {error}");
            }
            Ok(TestnetBetaNodeControlResult {
                node_id: node.id,
                action: "start".to_string(),
                status: "ok".to_string(),
                message: "Node is online and running in its workspace.".to_string(),
            })
        }
        "stop" => {
            if !is_running {
                return Ok(TestnetBetaNodeControlResult {
                    node_id: node.id,
                    action,
                    status: "ignored".to_string(),
                    message: "Node is already stopped.".to_string(),
                });
            }

            run_runner_and_wait(&runner, "stop", &config_path, &workspace_directory).await?;
            Ok(TestnetBetaNodeControlResult {
                node_id: node.id,
                action: "stop".to_string(),
                status: "ok".to_string(),
                message: "Node stop command completed.".to_string(),
            })
        }
        "sync" => {
            if role_supports_validator_registration(&node.role_id) {
                if is_running {
                    run_runner_and_wait(&runner, "stop", &config_path, &workspace_directory).await?;
                }

                if let Err(e) = write_genesis_json_for_workspace(&state.nodes, &workspace_directory) {
                    eprintln!(
                        "Warning: could not write genesis.json for {}: {e}",
                        node.display_label
                    );
                }

                {
                    let peers_toml_path = workspace_directory.join("config").join("peers.toml");
                    let mut targets = read_peers_toml_additional_targets(&peers_toml_path);
                    for sibling in local_sibling_dial_targets(&state.nodes, &node.id) {
                        if !targets.contains(&sibling) {
                            targets.push(sibling);
                        }
                    }
                    let peers_contents =
                        build_peers_toml_with_additional(&state.network_profile, &targets);
                    if let Err(e) = write_file(&peers_toml_path, &peers_contents) {
                        eprintln!(
                            "Warning: could not refresh peers.toml for {}: {e}",
                            node.display_label
                        );
                    }
                }

                launch_runner_detached(&runner, "start", &config_path, &workspace_directory).await?;
                wait_for_workspace_start(&workspace_directory, Duration::from_secs(30)).await?;
                if let Err(error) = register_node_with_seeds_async(&state.network_profile, &node).await
                {
                    eprintln!("Warning: {error}");
                }

                return Ok(TestnetBetaNodeControlResult {
                    node_id: node.id,
                    action: "sync".to_string(),
                    status: "ok".to_string(),
                    message: "Validator rejoin completed. Validator nodes use restart-based peer rejoin instead of offline fast-sync.".to_string(),
                });
            }

            if is_running {
                run_runner_and_wait(&runner, "stop", &config_path, &workspace_directory).await?;
            }

            // Refresh genesis.json before relaunching after sync.
            if let Err(e) = write_genesis_json_for_workspace(&state.nodes, &workspace_directory) {
                eprintln!(
                    "Warning: could not write genesis.json for {}: {e}",
                    node.display_label
                );
            }

            // Same local-sibling injection as the start path.
            {
                let peers_toml_path = workspace_directory.join("config").join("peers.toml");
                let mut targets = read_peers_toml_additional_targets(&peers_toml_path);
                for sibling in local_sibling_dial_targets(&state.nodes, &node.id) {
                    if !targets.contains(&sibling) {
                        targets.push(sibling);
                    }
                }
                let peers_contents =
                    build_peers_toml_with_additional(&state.network_profile, &targets);
                if let Err(e) = write_file(&peers_toml_path, &peers_contents) {
                    eprintln!(
                        "Warning: could not refresh peers.toml for {}: {e}",
                        node.display_label
                    );
                }
            }

            run_runner_and_wait(&runner, "sync", &config_path, &workspace_directory).await?;
            launch_runner_detached(&runner, "start", &config_path, &workspace_directory).await?;
            wait_for_workspace_start(&workspace_directory, Duration::from_secs(30)).await?;
            if let Err(error) = register_node_with_seeds_async(&state.network_profile, &node).await
            {
                eprintln!("Warning: {error}");
            }

            Ok(TestnetBetaNodeControlResult {
                node_id: node.id,
                action: "sync".to_string(),
                status: "ok".to_string(),
                message: "Node fast-sync completed and the runtime is back online.".to_string(),
            })
        }
        other => Err(format!("Unsupported Testnet-Beta node action: {other}")),
    }
}

pub async fn testbeta_remove_node(
    app_context: &AppContext,
    input: TestnetBetaRemoveNodeInput,
) -> Result<TestnetBetaRemoveNodeResult, String> {
    let root = ensure_testnet_beta_root()?;
    let mut registry = load_registry(&root)?;
    let network_profile = load_or_create_network_profile(&root)?;

    let node = registry
        .nodes
        .iter()
        .find(|entry| entry.id == input.node_id)
        .cloned()
        .ok_or_else(|| format!("Unknown Testnet-Beta node: {}", input.node_id))?;

    let workspace_directory = PathBuf::from(&node.workspace_directory);

    // Ensure node is stopped before removal.
    if let Some(pid) = running_pid_for_workspace(&workspace_directory) {
        let config_path = workspace_directory.join("config").join("node.toml");
        if config_path.is_file() {
            if let Ok(runner) = resolve_testbeta_runner(app_context, &node.role_id) {
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

    Ok(TestnetBetaRemoveNodeResult {
        node_id: input.node_id,
        status: "ok".to_string(),
        message: format!(
            "Node {} has been removed. Workspace deleted and seed registrations cleared.",
            node.display_label
        ),
    })
}

async fn deregister_node_from_seeds(
    network_profile: &TestnetBetaNetworkProfile,
    node: &TestnetBetaProvisionedNode,
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
            let url = format!("http://{}:{}/peers/deregister", seed.host, seed.port);
            client.post(&url).json(&payload).send()
        })
        .collect::<Vec<_>>();

    let _ = join_all(futures).await;
}

pub fn testbeta_reset_deferred_bootstrap_note() -> Result<String, String> {
    Ok("Bootnodes, dnsaddr bootstrap records, and seed services are configured as the active multi-source discovery path.".to_string())
}

/// Returns recent blocks from the node's local chain via its JSON-RPC endpoint.
/// Fetches the last `count` blocks (default 20, max 100) using synergy_getBlockRange.
pub async fn testbeta_get_chain_blocks(
    node_id: String,
    count: Option<u64>,
) -> Result<Vec<serde_json::Value>, String> {
    let root = ensure_testnet_beta_root()?;
    let registry = load_registry(&root)?;
    let node = registry
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .ok_or_else(|| format!("Node not found: {}", node_id))?;

    let workspace = PathBuf::from(&node.workspace_directory);
    let config_path = workspace.join("config").join("node.toml");
    let rpc_endpoint = parse_testbeta_rpc_endpoint(&config_path)
        .unwrap_or_else(|| format!("http://127.0.0.1:{TESTNET_BETA_RPC_PORT}"));

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    // Get current block height
    let height = match query_local_chain_height(&client, &rpc_endpoint).await {
        Ok(height) => height,
        Err(error) if rpc_error_is_transport_unavailable(&error) => {
            return Ok(Vec::new());
        }
        Err(error) => {
            return Err(format!(
                "Local chain RPC is unavailable on {rpc_endpoint}: {error}"
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
        Err(error) if rpc_error_is_transport_unavailable(&error) => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Local chain RPC is unavailable on {rpc_endpoint}: {error}"
            ));
        }
    };

    let blocks = result
        .as_array()
        .cloned()
        .unwrap_or_default();

    // Return newest first
    let mut ordered = blocks;
    ordered.reverse();
    Ok(ordered)
}

/// Returns the last `lines` lines from a node's main log file.
/// Reads `{workspace_directory}/logs/synergy-testbeta.log`.
pub async fn testbeta_run_register_with_seeds(node_id: String) -> Result<String, String> {
    let state = build_state()?;
    let node = state
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {}", node_id))?;

    register_node_with_seeds_async(&state.network_profile, &node).await?;
    Ok(format!(
        "Node '{}' registered with all configured seed servers.",
        node.display_label
    ))
}

pub fn testbeta_get_node_logs(node_id: String, lines: Option<usize>) -> Result<String, String> {
    let root = ensure_testnet_beta_root()?;
    let registry = load_registry(&root)?;
    let node = registry
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .ok_or_else(|| format!("Node not found: {}", node_id))?;

    let workspace = PathBuf::from(&node.workspace_directory);
    let log_path = workspace.join("logs").join("synergy-testbeta.log");

    if !log_path.exists() {
        return Ok(String::new());
    }

    let max_lines = lines.unwrap_or(500);
    Ok(log_tail_excerpt(&log_path, max_lines).unwrap_or_default())
}

pub async fn testbeta_setup_node(
    input: TestnetBetaSetupInput,
) -> Result<TestnetBetaSetupResult, String> {
    let root = ensure_testnet_beta_root()?;
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
    let node_id = format!("tbeta-{}", Uuid::new_v4().simple());
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

    let node_identity = generate_node_wallet(&role, &keys_directory)?;
    // Use the caller-supplied public host (remote server IP) if provided;
    // otherwise fall back to automatic detection via ipify / ifconfig.
    let detected_public_host = match input
        .public_host
        .as_deref()
        .and_then(normalize_public_host_candidate)
    {
        Some(override_host) => Some(override_host),
        None => detect_public_host().await,
    };
    let funding_manifest = TestnetBetaFundingManifest {
        id: format!("fund-{}", Uuid::new_v4().simple()),
        source_wallet: network_profile.treasury_wallet.address.clone(),
        destination_wallet: node_identity.wallet.address.clone(),
        destination_role: role.display_name.clone(),
        amount_snrg: format_amount(MINIMUM_STAKE_SNRG),
        amount_nwei: amount_to_nwei_string(MINIMUM_STAKE_SNRG),
        stake_vault_wallet: network_profile.stake_vault_wallet.address.clone(),
        status: "planned".to_string(),
        note: "Provisioning does not block on bootstrap reachability. Generated workspaces are still configured to use bootnodes, dnsaddr, and seed services immediately.".to_string(),
        created_at_utc: Utc::now().to_rfc3339(),
    };
    network_profile
        .funding_manifests
        .push(funding_manifest.clone());
    network_profile.updated_at_utc = Utc::now().to_rfc3339();

    let role_overlay = role_overlay_for(&role.id);
    let port_slot = next_available_port_slot(&registry.nodes);
    let peers_contents = build_peers_toml(&network_profile);
    let aegis_contents = build_aegis_toml();
    let node_contents = build_node_toml(
        &node_id,
        &label,
        &role,
        &node_identity.wallet.address,
        &workspace_directory,
        detected_public_host.as_deref(),
        &network_profile,
        role_overlay.as_str(),
        port_slot,
    );
    let manifest_contents = serde_json::to_string_pretty(&serde_json::json!({
        "node_id": node_id,
        "environment_id": TESTNET_BETA_ENVIRONMENT_ID,
        "display_name": label,
        "role": role.display_name,
        "node_address": node_identity.wallet.address,
        "public_host": detected_public_host,
        "funding_manifest": funding_manifest,
        "device_profile": device_profile,
        "bootstrap_policy": network_profile.bootstrap_policy,
    }))
    .map_err(|error| format!("Failed to serialize bootstrap manifest: {error}"))?;
    let readme_contents = build_node_readme(
        &label,
        &role,
        &node_identity.wallet.address,
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

    // Generate an nginx reverse-proxy config for roles that expose a public RPC surface.
    if matches!(role.id.as_str(), "rpc_gateway" | "indexer") {
        let p2p_port_val = TESTNET_BETA_P2P_PORT.saturating_add(port_slot);
        let rpc_port_val = TESTNET_BETA_RPC_PORT.saturating_add(port_slot);
        let ws_port_val = TESTNET_BETA_WS_PORT.saturating_add(port_slot);
        let public_host_val = detected_public_host.as_deref().unwrap_or("YOUR_SERVER_IP");
        let rpc_subdomain = if role.id == "rpc_gateway" {
            "testbeta-core-rpc.synergy-network.io"
        } else {
            "testbeta-indexer.synergy-network.io"
        };
        let ws_subdomain = if role.id == "rpc_gateway" {
            "testbeta-core-ws.synergy-network.io"
        } else {
            "testbeta-indexer-ws.synergy-network.io"
        };
        let nginx_contents = format!(
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
             #      sudo certbot --nginx -d {rpc_subdomain} -d {ws_subdomain}\n\
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
             \t# certbot --nginx will fill in the ssl_certificate lines below automatically.\n\
             \tssl_certificate /etc/letsencrypt/live/{rpc_subdomain}/fullchain.pem;\n\
             \tssl_certificate_key /etc/letsencrypt/live/{rpc_subdomain}/privkey.pem;\n\
             \tinclude /etc/letsencrypt/options-ssl-nginx.conf;\n\
             \tssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n\
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
             \tlocation /healthz {{ return 200 \"ok\\n\"; }}\n\
             }}\n\n\
             server {{\n\
             \tlisten 443 ssl http2;\n\
             \tserver_name {ws_subdomain};\n\
             \t# certbot --nginx will fill in the ssl_certificate lines below automatically.\n\
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
        );
        let nginx_path = workspace_directory.join("nginx.conf");
        let _ = write_file(&nginx_path, &nginx_contents);
    }

    let node_record = TestnetBetaProvisionedNode {
        id: node_id.clone(),
        role_id: role.id.clone(),
        role_display_name: role.display_name.clone(),
        class_name: role.class_name.clone(),
        display_label: label.clone(),
        node_address: node_identity.wallet.address.clone(),
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
                paths.push(workspace_directory.join("nginx.conf").to_string_lossy().to_string());
            }
            paths
        },
        public_host: detected_public_host.clone(),
        reward_payout_address: None,
        connectivity_status: "Bootstrap configured. Node will use hardcoded bootnodes, dnsaddr bootstrap records, and seed services on startup.".to_string(),
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

    // Write/refresh genesis.json for every validator workspace so that when
    // any node starts it sees ALL provisioned validators in its validator manager.
    for n in registry
        .nodes
        .iter()
        .filter(|n| role_supports_validator_registration(&n.role_id))
    {
        let ws = PathBuf::from(&n.workspace_directory);
        if ws.is_dir() {
            if let Err(e) = write_genesis_json_for_workspace(&registry.nodes, &ws) {
                eprintln!(
                    "Warning: could not write genesis.json for {}: {e}",
                    n.display_label
                );
            }
        }
    }

    register_node_with_seeds_best_effort(&network_profile, &node_record).await;

    Ok(TestnetBetaSetupResult {
        node: node_record,
        network_profile,
        device_profile,
        next_steps: {
            let mut steps = vec![
                "Review the generated node.toml, peers.toml, and aegis.toml overlays in the isolated workspace.".to_string(),
                "Wire the treasury signing path when ready so the reserved 5,000 SNRG stake can move from manifest to execution.".to_string(),
                format!(
                    "Public host detection: {}.",
                    detected_public_host
                        .as_deref()
                        .unwrap_or("not available from automatic detection")
                ),
                "Start the node with the generated workspace; multi-source peer discovery is configured from bootnodes, dnsaddr, and seed services.".to_string(),
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

fn build_state() -> Result<TestnetBetaState, String> {
    let root = ensure_testnet_beta_root()?;
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

    Ok(TestnetBetaState {
        environment_id: TESTNET_BETA_ENVIRONMENT_ID.to_string(),
        display_name: TESTNET_BETA_DISPLAY_NAME.to_string(),
        device_profile,
        network_profile: network_profile.clone(),
        node_catalog: node_catalog.clone(),
        nodes: registry.nodes,
        summary: TestnetBetaDashboardSummary {
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
    healthy_seed_servers: usize,
    total_seed_servers: usize,
) -> (String, String) {
    if healthy_bootnodes >= 2 && healthy_seed_servers >= 1 {
        return (
            "Online".to_string(),
            format!(
                "{healthy_bootnodes}/{total_bootnodes} bootnodes and {healthy_seed_servers}/{total_seed_servers} seed services are responding."
            ),
        );
    }

    if healthy_bootnodes > 0 || healthy_seed_servers > 0 {
        return (
            "Degraded".to_string(),
            format!(
                "Only {healthy_bootnodes}/{total_bootnodes} bootnodes and {healthy_seed_servers}/{total_seed_servers} seed services are reachable."
            ),
        );
    }

    (
        "Offline".to_string(),
        "No bootnodes or seed services responded to the control panel health check.".to_string(),
    )
}

fn chain_summary(
    public_rpc_online: bool,
    public_chain_height: Option<u64>,
    public_peer_count: Option<usize>,
    healthy_bootnodes: usize,
    healthy_seed_servers: usize,
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

    if healthy_bootnodes > 0 || healthy_seed_servers > 0 {
        return (
            "Bootstrap Only".to_string(),
            "Bootstrap endpoints are reachable, but the public RPC is not answering yet."
                .to_string(),
        );
    }

    (
        "Unavailable".to_string(),
        "Neither the public RPC nor the bootstrap endpoints are responding yet.".to_string(),
    )
}

async fn check_bootstrap_endpoint(
    endpoint: TestnetBetaBootstrapEndpoint,
) -> TestnetBetaEndpointLiveStatus {
    let started = Instant::now();
    let result = timeout(
        Duration::from_secs(3),
        TcpStream::connect((endpoint.host.as_str(), endpoint.port)),
    )
    .await;

    match result {
        Ok(Ok(_stream)) => TestnetBetaEndpointLiveStatus {
            kind: endpoint.kind,
            host: endpoint.host,
            ip_address: endpoint.ip_address,
            port: endpoint.port,
            status: "online".to_string(),
            detail: "TCP handshake completed.".to_string(),
            reachable: true,
            latency_ms: Some(started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
        },
        Ok(Err(error)) => TestnetBetaEndpointLiveStatus {
            kind: endpoint.kind,
            host: endpoint.host,
            ip_address: endpoint.ip_address,
            port: endpoint.port,
            status: "offline".to_string(),
            detail: format!("TCP connection failed: {error}"),
            reachable: false,
            latency_ms: None,
        },
        Err(_) => TestnetBetaEndpointLiveStatus {
            kind: endpoint.kind,
            host: endpoint.host,
            ip_address: endpoint.ip_address,
            port: endpoint.port,
            status: "offline".to_string(),
            detail: "Timed out during TCP connection.".to_string(),
            reachable: false,
            latency_ms: None,
        },
    }
}

async fn check_seed_endpoint(
    client: &Client,
    endpoint: TestnetBetaBootstrapEndpoint,
) -> TestnetBetaEndpointLiveStatus {
    let started = Instant::now();
    let url = format!("http://{}:{}/healthz", endpoint.host, endpoint.port);
    let response = client.get(url).send().await;

    match response {
        Ok(response) if response.status().is_success() => TestnetBetaEndpointLiveStatus {
            kind: endpoint.kind,
            host: endpoint.host,
            ip_address: endpoint.ip_address,
            port: endpoint.port,
            status: "online".to_string(),
            detail: "Seed health endpoint responded.".to_string(),
            reachable: true,
            latency_ms: Some(started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
        },
        Ok(response) => TestnetBetaEndpointLiveStatus {
            kind: endpoint.kind,
            host: endpoint.host,
            ip_address: endpoint.ip_address,
            port: endpoint.port,
            status: "offline".to_string(),
            detail: format!("Seed health endpoint returned HTTP {}.", response.status()),
            reachable: false,
            latency_ms: None,
        },
        Err(error) => TestnetBetaEndpointLiveStatus {
            kind: endpoint.kind,
            host: endpoint.host,
            ip_address: endpoint.ip_address,
            port: endpoint.port,
            status: "offline".to_string(),
            detail: format!("Seed health request failed: {error}"),
            reachable: false,
            latency_ms: None,
        },
    }
}

async fn build_node_live_status(
    client: &Client,
    node: &TestnetBetaProvisionedNode,
) -> TestnetBetaNodeLiveStatus {
    let workspace_directory = PathBuf::from(&node.workspace_directory);
    let config_path = workspace_directory.join("config").join("node.toml");
    let runtime_report_path = workspace_directory.join("data").join("role-runtime.json");
    let rpc_endpoint = parse_testbeta_rpc_endpoint(&config_path)
        .unwrap_or_else(|| format!("http://127.0.0.1:{TESTNET_BETA_RPC_PORT}"));
    let public_chain_height = query_public_chain_height(client).await.ok();
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
    let (fresh_local_peer_count, local_peer_error) = if is_running {
        match query_rpc_value(client, &rpc_endpoint, "synergy_getPeerInfo", json!([])).await {
            Ok(value) => match parse_rpc_peer_count(value) {
                Ok(count) => (Some(count), None),
                Err(error) => (None, Some(error)),
            },
            Err(error) => (None, Some(error)),
        }
    } else {
        (None, None)
    };
    let cached_snapshot = {
        let cache = NODE_LIVE_CACHE.lock().unwrap();
        cache.get(&node.id).cloned()
    };
    let local_chain_height = fresh_local_chain_height
        .or_else(|| cached_snapshot.as_ref().and_then(|entry| entry.local_chain_height))
        .or(log_local_chain_height);
    let local_peer_count = fresh_local_peer_count
        .or_else(|| cached_snapshot.as_ref().and_then(|entry| entry.local_peer_count));
    let using_cached_snapshot = is_running
        && ((fresh_local_chain_height.is_none() && local_chain_height.is_some())
            || (fresh_local_peer_count.is_none() && local_peer_count.is_some()));
    let using_log_height = is_running
        && fresh_local_chain_height.is_none()
        && log_local_chain_height.is_some();
    let local_rpc_ready =
        is_running && (fresh_local_chain_height.is_some() || fresh_local_peer_count.is_some());
    let local_rpc_status = if !is_running {
        let mut cache = NODE_LIVE_CACHE.lock().unwrap();
        cache.remove(&node.id);
        "Local runtime is offline.".to_string()
    } else if local_rpc_ready {
        let mut cache = NODE_LIVE_CACHE.lock().unwrap();
        cache.insert(
            node.id.clone(),
            CachedNodeLiveSnapshot {
                local_chain_height,
                local_peer_count,
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

    TestnetBetaNodeLiveStatus {
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
        sync_gap,
        log_local_chain_height,
        best_observed_peer_height,
        best_network_height,
        synergy_score,
        synergy_score_status,
    }
}

struct RunningProcessInfo {
    pid: u32,
    uptime_secs: u64,
}

fn running_process_for_workspace(workspace_directory: &Path) -> Option<RunningProcessInfo> {
    let pid_path = workspace_directory
        .join("data")
        .join("synergy-testbeta.pid");
    let pid_text = fs::read_to_string(pid_path).ok()?;
    let pid = pid_text.trim().parse::<u32>().ok()?;
    let mut system = System::new_all();
    system.refresh_all();
    let process = system.process(Pid::from_u32(pid))?;
    Some(RunningProcessInfo {
        pid,
        uptime_secs: process.run_time(),
    })
}

fn running_pid_for_workspace(workspace_directory: &Path) -> Option<u32> {
    running_process_for_workspace(workspace_directory).map(|info| info.pid)
}

fn repair_workspace_config_if_needed(role_id: &str, config_path: &Path) -> Result<(), String> {
    if !role_supports_validator_registration(role_id) {
        return Ok(());
    }

    let contents = fs::read_to_string(config_path)
        .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?;
    if contents.contains("auto_register_validator = true") {
        return Ok(());
    }
    if !contents.contains("auto_register_validator = false") {
        return Ok(());
    }

    let updated = contents.replacen(
        "auto_register_validator = false",
        "auto_register_validator = true",
        1,
    );
    fs::write(config_path, updated)
        .map_err(|error| format!("Failed to update {}: {error}", config_path.display()))?;
    Ok(())
}

enum TestnetBetaRunner {
    Binary(PathBuf),
    Cargo {
        manifest_path: PathBuf,
        binary_name: &'static str,
    },
}

fn resolve_testbeta_runner(
    app_context: &AppContext,
    role_id: &str,
) -> Result<TestnetBetaRunner, String> {
    for root in app_context.resource_roots() {
        if let Some(binary_name) = binary_name_for_role(role_id) {
            for candidate in runner_binary_candidates(root, binary_name) {
                if candidate.is_file() {
                    return Ok(TestnetBetaRunner::Binary(candidate));
                }
            }
        }
    }

    for root in app_context.resource_roots() {
        for manifest in [root
            .join("synergy-testnet-beta")
            .join("src")
            .join("Cargo.toml")]
        {
            if manifest.is_file() {
                return Ok(TestnetBetaRunner::Cargo {
                    manifest_path: manifest,
                    binary_name: "synergy-testbeta",
                });
            }
        }
    }

    for root in app_context.resource_roots() {
        for binary_name in current_platform_testbeta_binary_names() {
            for candidate in runner_binary_candidates(root, binary_name) {
                if candidate.is_file() {
                    return Ok(TestnetBetaRunner::Binary(candidate));
                }
            }
        }
    }

    Err(format!(
        "Could not find a runnable Testnet-Beta binary or source manifest for role {}.",
        role_id
    ))
}

fn runner_binary_candidates(root: &Path, binary_name: &str) -> [PathBuf; 4] {
    [
        root.join("binaries").join(binary_name),
        root.join("bin").join(binary_name),
        root.join(binary_name),
        root.join("synergy-testnet-beta")
            .join("target")
            .join("release")
            .join(binary_name),
    ]
}

fn current_platform_testbeta_binary_names() -> &'static [&'static str] {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return &[
        "synergy-testbeta-macos-arm64",
        "synergy-testbeta-darwin-arm64",
        "synergy-testbeta",
    ];

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return &["synergy-testbeta-macos-amd64", "synergy-testbeta"];

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return &["synergy-testbeta-linux-amd64", "synergy-testbeta"];

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return &["synergy-testbeta-linux-arm64", "synergy-testbeta"];

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return &["synergy-testbeta-windows-amd64.exe", "synergy-testbeta.exe"];

    #[allow(unreachable_code)]
    &["synergy-testbeta"]
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
    runner: &TestnetBetaRunner,
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
        command
            .arg(&subcommand)
            .arg("--config")
            .arg(&config_path)
            .current_dir(&workspace_directory)
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));

        command
            .spawn()
            .map_err(|error| format!("Failed to launch {}: {}", subcommand, error))?;
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
    let log_path = workspace_directory.join("logs").join("synergy-testbeta.log");
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
        workspace_directory
            .join("logs")
            .join("synergy-testbeta.log"),
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

async fn wait_for_workspace_start(
    workspace_directory: &Path,
    timeout_window: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < timeout_window {
        if running_pid_for_workspace(workspace_directory).is_some() {
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
    runner: &TestnetBetaRunner,
    subcommand: &str,
    config_path: &Path,
    workspace_directory: &Path,
) -> Result<(), String> {
    let runner = runner_to_owned(runner);
    let config_path = config_path.to_path_buf();
    let workspace_directory = workspace_directory.to_path_buf();
    let subcommand = subcommand.to_string();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut command = command_for_runner(&runner);
        command
            .arg(&subcommand)
            .arg("--config")
            .arg(&config_path)
            .current_dir(&workspace_directory);

        let output = command
            .output()
            .map_err(|error| format!("Failed to execute {}: {}", subcommand, error))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        Err(format!("{} failed: {}", subcommand, detail))
    })
    .await
    .map_err(|error| format!("Failed to run node command: {error}"))?
}

fn runner_to_owned(runner: &TestnetBetaRunner) -> TestnetBetaRunner {
    match runner {
        TestnetBetaRunner::Binary(path) => TestnetBetaRunner::Binary(path.clone()),
        TestnetBetaRunner::Cargo {
            manifest_path,
            binary_name,
        } => TestnetBetaRunner::Cargo {
            manifest_path: manifest_path.clone(),
            binary_name,
        },
    }
}

fn command_for_runner(runner: &TestnetBetaRunner) -> std::process::Command {
    match runner {
        TestnetBetaRunner::Binary(path) => std::process::Command::new(path),
        TestnetBetaRunner::Cargo {
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

fn parse_testbeta_rpc_endpoint(config_path: &Path) -> Option<String> {
    let contents = fs::read_to_string(config_path).ok()?;
    let value = contents.parse::<toml::Value>().ok()?;
    let port = value
        .get("rpc")
        .and_then(|section| section.get("http_port"))
        .and_then(toml::Value::as_integer)
        .unwrap_or(i64::from(TESTNET_BETA_RPC_PORT));
    Some(format!("http://127.0.0.1:{port}"))
}

async fn query_public_chain_height(client: &Client) -> Result<u64, String> {
    query_local_chain_height(client, TESTNET_BETA_PUBLIC_RPC_ENDPOINT).await
}

async fn query_public_peer_count(client: &Client) -> Result<usize, String> {
    let value = query_rpc_value(
        client,
        TESTNET_BETA_PUBLIC_RPC_ENDPOINT,
        "synergy_getPeerInfo",
        json!([]),
    )
    .await?;
    parse_rpc_peer_count(value)
}

async fn query_seed_peer_count(
    client: &Client,
    seed_servers: &[TestnetBetaBootstrapEndpoint],
) -> Result<usize, String> {
    let mut unique_peers = HashMap::new();
    let mut reachable_seed_count = 0usize;

    for seed in seed_servers {
        let url = format!("http://{}:{}/peers", seed.host, seed.port);
        let response = match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => response,
            Ok(_) => continue,
            Err(_) => continue,
        };

        let payload: Value = match response.json().await {
            Ok(payload) => payload,
            Err(_) => continue,
        };

        let peers = match payload.get("peers").and_then(Value::as_array) {
            Some(peers) => peers,
            None => continue,
        };

        reachable_seed_count += 1;
        for peer in peers {
            let key = peer
                .get("node_id")
                .and_then(Value::as_str)
                .or_else(|| peer.get("dial").and_then(Value::as_str))
                .or_else(|| peer.get("wallet_address").and_then(Value::as_str));

            if let Some(key) = key {
                unique_peers.entry(key.to_string()).or_insert(());
            }
        }
    }

    if reachable_seed_count == 0 {
        return Err("No seed services returned a peer registry.".to_string());
    }

    Ok(unique_peers.len())
}

async fn query_synergy_score(client: &Client, address: &str) -> Result<f64, String> {
    query_synergy_score_from_endpoint(client, TESTNET_BETA_PUBLIC_RPC_ENDPOINT, address).await
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

    if let Ok(score) = query_synergy_score_from_validator_activity(
        client,
        TESTNET_BETA_PUBLIC_RPC_ENDPOINT,
        address,
    )
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
                "Synergy score is unavailable because the local RPC is not responding on {rpc_endpoint}."
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
        "Synergy score is not available from the public RPC yet.".to_string(),
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

fn rpc_error_is_transport_unavailable(error: &str) -> bool {
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

fn parse_rpc_peer_count(value: Value) -> Result<usize, String> {
    if let Some(number) = value.get("peer_count").and_then(Value::as_u64) {
        return usize::try_from(number)
            .map_err(|error| format!("Failed to convert peer count to usize: {error}"));
    }

    if let Some(peers) = value.get("peers").and_then(Value::as_array) {
        return Ok(peers.len());
    }

    if let Some(peers) = value.as_array() {
        return Ok(peers.len());
    }

    Err("Peer RPC returned neither peer_count nor peers.".to_string())
}

fn ensure_testnet_beta_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Unable to resolve the current user home directory.".to_string())?;
    let root = home.join(".synergy").join("testnet-beta");
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

fn network_profile_path(root: &Path) -> PathBuf {
    root.join("network").join("profile.json")
}

fn registry_path(root: &Path) -> PathBuf {
    root.join("network").join("registry.json")
}

/// Build a genesis.json that lists every provisioned validator node so that the
/// binary's validator manager is seeded correctly when it boots.  The binary
/// reads "config/genesis.json" relative to its working directory
/// (the workspace_directory).  Without this file each node falls back to an
/// empty validator set, self-registers only itself, and block production stalls
/// because active_validators.len() < min_validators.
///
/// The binary accepts either a file path (`public_key_file`) or a fallback
/// of "genesis_key".  We use absolute paths so the read succeeds even when a
/// validator's key lives in a different workspace directory.
fn build_genesis_json_for_workspace(
    all_nodes: &[TestnetBetaProvisionedNode],
    target_workspace: &Path,
) -> String {
    // Collect validator nodes from the registry.
    let validators: Vec<_> = all_nodes
        .iter()
        .filter(|n| role_supports_validator_registration(&n.role_id))
        .collect();

    let validator_entries: Vec<String> = validators
        .iter()
        .enumerate()
        .map(|(i, node)| {
            // Resolve the public key file as an absolute path so the binary can
            // read it regardless of which workspace it is currently running from.
            let key_abs = PathBuf::from(&node.public_key_path);
            let key_str = if key_abs.is_file() {
                key_abs.to_string_lossy().into_owned()
            } else {
                // Fallback: derive from workspace directory.
                PathBuf::from(&node.workspace_directory)
                    .join("keys")
                    .join("identity.json")
                    .to_string_lossy()
                    .into_owned()
            };
            let name = if node.display_label.is_empty() {
                format!("Validator {}", i + 1)
            } else {
                node.display_label.clone()
            };
            // Escape the strings for JSON.
            let addr = node.node_address.replace('"', "\\\"");
            let key_str_escaped = key_str.replace('\\', "\\\\").replace('"', "\\\"");
            let name_escaped = name.replace('"', "\\\"");
            format!(
                "    {{\n      \"address\": \"{addr}\",\n      \"public_key_file\": \"{key_str_escaped}\",\n      \"details\": {{ \"name\": \"{name_escaped}\" }}\n    }}"
            )
        })
        .collect();

    let validators_json = validator_entries.join(",\n");

    // Compute the workspace path for context (unused at runtime; included as a comment).
    let ws_note = target_workspace.to_string_lossy();

    format!(
        "{{\n  \"_note\": \"Auto-generated by Synergy Node Control Panel for workspace {ws_note}\",\n  \"validators\": [\n{validators_json}\n  ]\n}}\n"
    )
}

/// Write (or refresh) the genesis.json inside a workspace config directory.
fn write_genesis_json_for_workspace(
    all_nodes: &[TestnetBetaProvisionedNode],
    workspace_directory: &Path,
) -> Result<(), String> {
    let config_dir = workspace_directory.join("config");
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    let genesis_path = config_dir.join("genesis.json");
    let contents = build_genesis_json_for_workspace(all_nodes, workspace_directory);
    write_file(&genesis_path, &contents)
}

fn load_or_create_network_profile(root: &Path) -> Result<TestnetBetaNetworkProfile, String> {
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
        "Testnet-Beta Treasury",
        AddressType::MultisigTreasury,
    )?;
    let faucet_wallet = generate_wallet_files(
        &wallets_root.join("faucet"),
        "Testnet-Beta Faucet",
        AddressType::WalletUtility,
    )?;
    let stake_vault_wallet = generate_wallet_files(
        &wallets_root.join("stake-vault"),
        "Testnet-Beta Stake Vault",
        AddressType::MultisigValidator,
    )?;
    let now = Utc::now().to_rfc3339();
    let profile = TestnetBetaNetworkProfile {
        version: STATE_VERSION,
        environment_id: TESTNET_BETA_ENVIRONMENT_ID.to_string(),
        display_name: TESTNET_BETA_DISPLAY_NAME.to_string(),
        chain_name: TESTNET_BETA_CHAIN_NAME.to_string(),
        chain_id: TESTNET_BETA_CHAIN_ID,
        token_symbol: TOKEN_SYMBOL.to_string(),
        token_decimals: TOKEN_DECIMALS,
        treasury_wallet,
        faucet_wallet,
        stake_vault_wallet,
        genesis_mints: vec![
            TestnetBetaGenesisMint {
                label: "Treasury".to_string(),
                wallet_address: String::new(),
                amount_snrg: format_amount(TREASURY_SUPPLY_SNRG),
                amount_nwei: amount_to_nwei_string(TREASURY_SUPPLY_SNRG),
            },
            TestnetBetaGenesisMint {
                label: "Faucet".to_string(),
                wallet_address: String::new(),
                amount_snrg: format_amount(FAUCET_SUPPLY_SNRG),
                amount_nwei: amount_to_nwei_string(FAUCET_SUPPLY_SNRG),
            },
            TestnetBetaGenesisMint {
                label: "Stake Vault".to_string(),
                wallet_address: String::new(),
                amount_snrg: format_amount(0),
                amount_nwei: amount_to_nwei_string(0),
            },
        ],
        bootnodes: bootstrap_endpoints("bootnode"),
        seed_servers: bootstrap_endpoints("seed"),
        bootstrap_policy: TestnetBetaConnectivityPolicy {
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

fn save_network_profile(root: &Path, profile: &TestnetBetaNetworkProfile) -> Result<(), String> {
    let path = network_profile_path(root);
    let contents = serde_json::to_string_pretty(profile)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    write_file(&path, &contents)
}

fn load_registry(root: &Path) -> Result<TestnetBetaRegistryFile, String> {
    let path = registry_path(root);
    if !path.is_file() {
        return Ok(TestnetBetaRegistryFile {
            version: STATE_VERSION,
            nodes: Vec::new(),
        });
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let mut registry: TestnetBetaRegistryFile = serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
    normalize_registry_port_slots(&mut registry.nodes);
    Ok(registry)
}

fn save_registry(root: &Path, registry: &TestnetBetaRegistryFile) -> Result<(), String> {
    let path = registry_path(root);
    let contents = serde_json::to_string_pretty(registry)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    write_file(&path, &contents)
}

fn normalize_registry_port_slots(nodes: &mut [TestnetBetaProvisionedNode]) {
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

fn next_available_port_slot(nodes: &[TestnetBetaProvisionedNode]) -> u16 {
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

fn detect_device_profile() -> TestnetBetaDeviceProfile {
    let mut system = System::new_all();
    system.refresh_all();

    let disks = Disks::new_with_refreshed_list();
    let available_disk_gb =
        disks.iter().map(|disk| disk.available_space()).sum::<u64>() / 1024 / 1024 / 1024;

    TestnetBetaDeviceProfile {
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
    if let Ok(override_value) = std::env::var("SYNERGY_TESTBETA_PUBLIC_HOST") {
        if let Some(host) = normalize_public_host_candidate(&override_value) {
            return Some(host);
        }
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()?;

    for endpoint in [
        "https://api64.ipify.org",
        "https://api.ipify.org",
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
    let trimmed = value.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
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
    node: &TestnetBetaProvisionedNode,
    public_host: &str,
) -> SeedPeerRegistration {
    // Use the slot-adjusted P2P port so the seed server publishes the correct
    // address for this node.  Without this, every node on the same machine
    // (slots 0-3) registers as port 38638 and the seed-server peer list is
    // useless for slots 1-3.
    let p2p_port = TESTNET_BETA_P2P_PORT.saturating_add(node.port_slot.unwrap_or(0));
    let dial = format!("snr://{}@{}:{}", node.node_address, public_host, p2p_port);
    SeedPeerRegistration {
        node_id: node.id.clone(),
        role_id: node.role_id.clone(),
        role_display_name: node.role_display_name.clone(),
        wallet_address: node.node_address.clone(),
        public_host: public_host.to_string(),
        p2p_port,
        dial,
        chain_id: TESTNET_BETA_CHAIN_ID,
        registered_at_utc: Utc::now().to_rfc3339(),
    }
}

/// Returns `"127.0.0.1:<p2p_port>"` for every provisioned node on this
/// machine that is NOT `current_node_id`.  These targets let validators on the
/// same host peer with each other directly, bypassing the NAT / public-IP
/// loop-back problem that would otherwise prevent seed-server–sourced addresses
/// from working.
fn local_sibling_dial_targets(
    all_nodes: &[TestnetBetaProvisionedNode],
    current_node_id: &str,
) -> Vec<String> {
    all_nodes
        .iter()
        .filter(|n| n.id != current_node_id)
        .filter_map(|n| {
            let slot = n.port_slot?;
            let port = TESTNET_BETA_P2P_PORT.saturating_add(slot);
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
    network_profile: &TestnetBetaNetworkProfile,
    node: &TestnetBetaProvisionedNode,
) -> Result<(), String> {
    let public_host = match node
        .public_host
        .as_deref()
        .and_then(normalize_public_host_candidate)
    {
        Some(host) => host,
        None => detect_public_host()
            .await
            .and_then(|host| normalize_public_host_candidate(&host))
            .ok_or_else(|| "Public host not available for seed registration.".to_string())?,
    };
    let payload = build_seed_registration(node, &public_host);

    let client = Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))?;

    let mut errors = Vec::new();
    for seed in &network_profile.seed_servers {
        let url = format!("http://{}:{}/peers/register", seed.host, seed.port);
        let result = client.post(&url).json(&payload).send().await;
        if let Err(error) = result {
            errors.push(format!("{}: {}", url, error));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Seed registration failed for {} endpoint(s): {}",
            errors.len(),
            errors.join("; ")
        ))
    }
}

async fn register_node_with_seeds_best_effort(
    network_profile: &TestnetBetaNetworkProfile,
    node: &TestnetBetaProvisionedNode,
) {
    let _ = register_node_with_seeds_async(network_profile, node).await;
}

fn bootstrap_endpoints(kind: &str) -> Vec<TestnetBetaBootstrapEndpoint> {
    let host_prefix = if kind.eq_ignore_ascii_case("seed") {
        "seed"
    } else {
        "bootnode"
    };
    let is_seed = kind.eq_ignore_ascii_case("seed");
    let port = if is_seed { 18080 } else { 38638 };
    let dns_mode = if is_seed {
        "A / SRV / HTTP".to_string()
    } else {
        "A / dnsaddr".to_string()
    };

    vec![
        TestnetBetaBootstrapEndpoint {
            kind: host_prefix.to_string(),
            host: format!("{host_prefix}1.synergynode.xyz"),
            ip_address: "74.208.227.23".to_string(),
            port,
            dns_mode: dns_mode.clone(),
        },
        TestnetBetaBootstrapEndpoint {
            kind: host_prefix.to_string(),
            host: format!("{host_prefix}2.synergynode.xyz"),
            ip_address: "73.79.66.255".to_string(),
            port,
            dns_mode: dns_mode.clone(),
        },
        TestnetBetaBootstrapEndpoint {
            kind: host_prefix.to_string(),
            host: format!("{host_prefix}3.synergynode.xyz"),
            ip_address: "64.227.107.57".to_string(),
            port,
            dns_mode,
        },
    ]
}

fn generate_wallet_files(
    wallet_directory: &Path,
    label: &str,
    address_type: AddressType,
) -> Result<TestnetBetaWalletRecord, String> {
    fs::create_dir_all(wallet_directory)
        .map_err(|error| format!("Failed to create {}: {error}", wallet_directory.display()))?;
    let identity = generate_identity(address_type)?;
    persist_identity(wallet_directory, label, identity)
}

fn generate_node_wallet(
    role: &TestnetBetaRoleProfile,
    keys_directory: &Path,
) -> Result<GeneratedWalletFiles, String> {
    let address_type = match role.class_id {
        1 => AddressType::NodeClass1,
        2 => AddressType::NodeClass2,
        3 => AddressType::NodeClass3,
        4 => AddressType::NodeClass4,
        5 => AddressType::NodeClass5,
        _ => AddressType::WalletPrimary,
    };

    let label = format!("{} Reward Wallet", role.display_name);
    let identity = generate_identity(address_type)?;
    Ok(GeneratedWalletFiles {
        wallet: persist_identity(keys_directory, &label, identity)?,
    })
}

fn persist_identity(
    directory: &Path,
    label: &str,
    identity: SynergyIdentity,
) -> Result<TestnetBetaWalletRecord, String> {
    let public_key_path = directory.join("public.key");
    let private_key_path = directory.join("private.key");
    let metadata_path = directory.join("identity.json");

    write_file(&public_key_path, identity.public_key.as_str())?;
    write_file(&private_key_path, identity.private_key.as_str())?;
    let metadata_contents = serde_json::to_string_pretty(&serde_json::json!({
        "label": label,
        "address": identity.address,
        "address_type": identity.address_type,
        "algorithm": identity.algorithm,
        "created_at": identity.created_at,
    }))
    .map_err(|error| format!("Failed to serialize identity metadata: {error}"))?;
    write_file(&metadata_path, &metadata_contents)?;

    Ok(TestnetBetaWalletRecord {
        label: label.to_string(),
        address: identity.address,
        address_type: identity.address_type,
        public_key_path: public_key_path.to_string_lossy().to_string(),
        private_key_path: private_key_path.to_string_lossy().to_string(),
    })
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

fn find_role_profile(role_id: &str) -> Result<TestnetBetaRoleProfile, String> {
    node_catalog()
        .into_iter()
        .find(|entry| entry.id == role_id)
        .ok_or_else(|| format!("Unknown Testnet-Beta role: {role_id}"))
}

fn build_node_toml(
    node_id: &str,
    display_label: &str,
    role: &TestnetBetaRoleProfile,
    node_address: &str,
    workspace_directory: &Path,
    public_host: Option<&str>,
    network_profile: &TestnetBetaNetworkProfile,
    role_overlay: &str,
    port_slot: u16,
) -> String {
    let p2p_port = TESTNET_BETA_P2P_PORT.saturating_add(port_slot);
    let rpc_port = TESTNET_BETA_RPC_PORT.saturating_add(port_slot);
    let ws_port = TESTNET_BETA_WS_PORT.saturating_add(port_slot);
    let discovery_port = TESTNET_BETA_DISCOVERY_PORT.saturating_add(port_slot);
    let metrics_port = TESTNET_BETA_METRICS_PORT.saturating_add(port_slot);
    let public_host_line = normalize_optional(public_host)
        .map(|value| format!("public_host = \"{value}\"\n"))
        .unwrap_or_default();
    let runtime_public_address = normalize_optional(public_host)
        .map(|value| format!("{value}:{p2p_port}"))
        .unwrap_or_else(|| format!("127.0.0.1:{p2p_port}"));
    let bootnodes = network_profile
        .bootnodes
        .iter()
        .map(|entry| format!("\"{}:{}\"", entry.host, entry.port))
        .collect::<Vec<_>>()
        .join(", ");
    let seeds = network_profile
        .seed_servers
        .iter()
        .map(|entry| format!("\"http://{}:{}\"", entry.host, entry.port))
        .collect::<Vec<_>>()
        .join(", ");
    let bootstrap_dns_records = "\"_dnsaddr.bootstrap.synergynode.xyz\"";
    let auto_register_validator = if role_supports_validator_registration(&role.id) {
        "true"
    } else {
        "false"
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
        "[identity]\nnode_id = \"{node_id}\"\nrole = \"{role_id}\"\nrole_display = \"{role_display}\"\nenvironment = \"{environment_id}\"\ndisplay_environment = \"{display_name}\"\naddress = \"{node_address}\"\nlabel = \"{display_label}\"\n\n[network]\nid = {chain_id}\nname = \"{chain_name}\"\nchain_name = \"{chain_name}\"\nchain_id = {chain_id}\np2p_port = {p2p_port}\nrpc_port = {rpc_port}\nws_port = {ws_port}\np2p_listen = \"0.0.0.0:{p2p_port}\"\nbootnodes = [{bootnodes}]\nseed_servers = [{seeds}]\nbootstrap_dns_records = [{bootstrap_dns_records}]\nquic = true\nmax_peers = 128\nbootstrap_connectivity_required = false\nbootstrap_mode = \"multi-source-signed\"\n{public_host_line}\n[blockchain]\nblock_time = 5\nmax_gas_limit = \"0x2fefd8\"\nchain_id = {chain_id}\n\n[consensus]\nalgorithm = \"Proof of Synergy\"\nblock_time_secs = 5\nepoch_length = 30000\nmin_validators = 3\nvalidator_cluster_size = 5\nmax_validators = 21\nsynergy_score_decay_rate = 0.05\nvrf_enabled = true\nvrf_seed_epoch_interval = 1000\nmax_synergy_points_per_epoch = 100\nmax_tasks_per_validator = 10\n\n[consensus.reward_weighting]\ntask_accuracy = 0.5\nuptime = 0.3\ncollaboration = 0.2\n\n[logging]\nlog_level = \"info\"\nlog_file = \"{log_path}\"\nenable_console = true\nmax_file_size = 10485760\nmax_files = 5\n\n[rpc]\nbind_address = \"{rpc_bind_address}\"\nenable_http = true\nhttp_port = {rpc_port}\nenable_ws = true\nws_port = {ws_port}\nenable_grpc = true\ngrpc_port = {rpc_port}\ncors_enabled = {cors_enabled}\ncors_origins = {cors_origins}\n\n[p2p]\nlisten_address = \"0.0.0.0:{p2p_port}\"\npublic_address = \"{runtime_public_address}\"\nnode_name = \"{node_id}\"\nenable_discovery = true\ndiscovery_port = {discovery_port}\nheartbeat_interval = 30\n\n[storage]\ndatabase = \"rocksdb\"\nengine = \"rocksdb\"\npath = \"{data_path}\"\nmode = \"role-bounded\"\nenable_pruning = false\npruning_interval = 86400\n\n[node]\nbootstrap_only = false\nauto_register_validator = {auto_register_validator}\nvalidator_address = \"{node_address}\"\nstrict_validator_allowlist = false\nallowed_validator_addresses = []\n\n[telemetry]\nmetrics_bind = \"127.0.0.1:{metrics_port}\"\nstructured_logs = true\nlog_level = \"info\"\n\n[policy]\nallow_remote_admin = false\nrequire_signed_updates = true\nquarantine_on_policy_failure = true\nquarantine_on_key_role_mismatch = true\nconnectivity_fail_mode = \"warn-and-continue\"\n\n[wallet]\nreward_address = \"{node_address}\"\nsponsored_stake_snrg = \"{sponsored_stake_snrg}\"\nsponsored_stake_nwei = \"{sponsored_stake_nwei}\"\ntreasury_wallet = \"{treasury_wallet}\"\nstake_vault_wallet = \"{stake_wallet}\"\n[bootstrap]\nstatus = \"configured\"\nnote = \"Node will resolve peers from bootnodes, dnsaddr records, and seed services at startup.\"\n\n{role_overlay}",
        role_id = role.id,
        role_display = role.display_name,
        environment_id = TESTNET_BETA_ENVIRONMENT_ID,
        display_name = TESTNET_BETA_DISPLAY_NAME,
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
        data_path = workspace_directory.join("data").to_string_lossy(),
        log_path = workspace_directory
            .join("logs")
            .join("synergy-testbeta.log")
            .to_string_lossy(),
        runtime_public_address = runtime_public_address,
        auto_register_validator = auto_register_validator,
        rpc_bind_address = rpc_bind_address,
        cors_enabled = cors_enabled,
        cors_origins = cors_origins,
        sponsored_stake_snrg = format_amount(MINIMUM_STAKE_SNRG),
        sponsored_stake_nwei = amount_to_nwei_string(MINIMUM_STAKE_SNRG),
        treasury_wallet = network_profile.treasury_wallet.address,
        stake_wallet = network_profile.stake_vault_wallet.address,
    )
}

fn role_supports_validator_registration(role_id: &str) -> bool {
    matches!(role_id, "validator")
}

fn build_peers_toml(network_profile: &TestnetBetaNetworkProfile) -> String {
    build_peers_toml_with_additional(network_profile, &[])
}

fn build_peers_toml_with_additional(
    network_profile: &TestnetBetaNetworkProfile,
    additional_dial_targets: &[String],
) -> String {
    let bootnodes = network_profile
        .bootnodes
        .iter()
        .map(|entry| format!("\"{}:{}\"", entry.host, entry.port))
        .collect::<Vec<_>>()
        .join(", ");
    let seeds = network_profile
        .seed_servers
        .iter()
        .map(|entry| format!("\"http://{}:{}\"", entry.host, entry.port))
        .collect::<Vec<_>>()
        .join(", ");
    let additional = additional_dial_targets
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "# Testnet-Beta multi-source bootstrap inputs.\n# Nodes consume these endpoints directly for hardcoded bootnode dialing, dnsaddr resolution, and seed-service fallbacks.\n[global]\nbootnodes = [{bootnodes}]\nseed_servers = [{seeds}]\nbootstrap_dns_records = [\"_dnsaddr.bootstrap.synergynode.xyz\"]\nadditional_dial_targets = [{additional}]\n\n[testbeta]\ncore_rpc = \"https://testbeta-core-rpc.synergy-network.io\"\ncore_ws = \"wss://testbeta-core-ws.synergy-network.io\"\nwallet_api = \"https://testbeta-wallet-api.synergy-network.io\"\nsxcp_api = \"https://testbeta-sxcp-api.synergy-network.io\"\n\n[security]\nstrict_tls = true\nallow_unpinned_dev_endpoints = false\nbootstrap_connectivity_required = false\n",
    )
}

fn build_aegis_toml() -> String {
    "[verify]\nenabled = true\nendpoint = \"https://127.0.0.1:3050\"\n\n[kms]\nenabled = true\nendpoint = \"https://127.0.0.1:3051\"\nmtls = true\n\n[lifecycle]\nquarantine_on_key_role_mismatch = true\nrequire_rotation_receipts = true\n".to_string()
}

fn build_node_readme(
    display_label: &str,
    role: &TestnetBetaRoleProfile,
    node_address: &str,
    workspace_directory: &Path,
    network_profile: &TestnetBetaNetworkProfile,
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

    format!(
        "# {display_label}\n\nThis isolated workspace was generated for the `{role_display}` role on `{environment}`.\n\n## Workspace\n- Path: `{workspace}`\n- Node wallet: `{reward_wallet}`\n- Reserved minimum stake: `{stake}`\n{public_host_note}\n## Role responsibilities\n{responsibilities}\n## Policy guardrails\n{policies}\n## Bootstrap endpoints\n- Bootnodes: {bootnodes}\n- Seeds: {seeds}\n- DNS bootstrap records: `_dnsaddr.bootstrap.synergynode.xyz`\n\nThe generated node configuration is wired for multi-source bootstrap on startup.\n",
        role_display = role.display_name,
        environment = TESTNET_BETA_DISPLAY_NAME,
        workspace = workspace_directory.to_string_lossy(),
        reward_wallet = node_address,
        stake = format_amount(MINIMUM_STAKE_SNRG),
        responsibilities = responsibilities,
        policies = policies,
        bootnodes = network_profile
            .bootnodes
            .iter()
            .map(|entry| entry.host.clone())
            .collect::<Vec<_>>()
            .join(", "),
        seeds = network_profile
            .seed_servers
            .iter()
            .map(|entry| entry.host.clone())
            .collect::<Vec<_>>()
            .join(", "),
    )
}

fn role_overlay_for(role_id: &str) -> String {
    match role_id {
        "validator" => "[role]\ncompiled_profile = \"validator_node\"\nservices = [\"p2p\", \"consensus\", \"mempool\", \"state\", \"aegis-verifier\", \"telemetry\"]\n\n[validator]\nparticipation = \"active\"\nverify_quorum_certificates = true\nstate_sync_before_join = true\n".to_string(),
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
        _ => "[role]\ncompiled_profile = \"generic_testbeta_node\"\nservices = [\"telemetry\"]\n".to_string(),
    }
}

fn node_catalog() -> Vec<TestnetBetaRoleProfile> {
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
) -> TestnetBetaRoleProfile {
    TestnetBetaRoleProfile {
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

    fn config_path_for(node: &TestnetBetaProvisionedNode, file_name: &str) -> PathBuf {
        node.config_paths
            .iter()
            .map(PathBuf::from)
            .find(|path| path.file_name().and_then(|value| value.to_str()) == Some(file_name))
            .unwrap_or_else(|| panic!("missing {file_name} in generated config paths"))
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
    fn setup_node_writes_role_metadata_and_bootstrap_inputs() {
        with_temp_home(|_| {
            let _public_host = EnvVarGuard::set_path(
                "SYNERGY_TESTBETA_PUBLIC_HOST",
                Path::new("validator-alpha.synergynode.xyz"),
            );
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let result = runtime
                .block_on(testbeta_setup_node(TestnetBetaSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Validator Alpha".to_string()),
                    intended_directory: None,
                    public_host: None,
                }))
                .expect("setup should succeed");

            assert_eq!(result.node.role_id, "validator");
            assert_eq!(result.node.role_display_name, "Validator Node");
            assert!(
                result
                    .node
                    .connectivity_status
                    .contains("bootnodes, dnsaddr bootstrap records, and seed services"),
                "node connectivity note should mention all bootstrap sources"
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
                Some("validator-alpha.synergynode.xyz:38638")
            );
            assert_eq!(
                node_value
                    .get("node")
                    .and_then(|section| section.get("auto_register_validator"))
                    .and_then(toml::Value::as_bool),
                Some(true)
            );

            let bootnodes = node_value
                .get("network")
                .and_then(|section| section.get("bootnodes"))
                .and_then(toml::Value::as_array)
                .expect("bootnodes array should exist");
            assert_eq!(bootnodes.len(), 3);
            assert_eq!(
                bootnodes[0].as_str(),
                Some("bootnode1.synergynode.xyz:38638")
            );
            assert_eq!(
                bootnodes[1].as_str(),
                Some("bootnode2.synergynode.xyz:38638")
            );
            assert_eq!(
                bootnodes[2].as_str(),
                Some("bootnode3.synergynode.xyz:38638")
            );

            let seeds = node_value
                .get("network")
                .and_then(|section| section.get("seed_servers"))
                .and_then(toml::Value::as_array)
                .expect("seed_servers array should exist");
            assert_eq!(seeds.len(), 3);
            assert_eq!(
                seeds[0].as_str(),
                Some("http://seed1.synergynode.xyz:18080")
            );
            assert_eq!(
                seeds[1].as_str(),
                Some("http://seed2.synergynode.xyz:18080")
            );
            assert_eq!(
                seeds[2].as_str(),
                Some("http://seed3.synergynode.xyz:18080")
            );

            let dns_records = node_value
                .get("network")
                .and_then(|section| section.get("bootstrap_dns_records"))
                .and_then(toml::Value::as_array)
                .expect("bootstrap_dns_records array should exist");
            assert_eq!(dns_records.len(), 1);
            assert_eq!(
                dns_records[0].as_str(),
                Some("_dnsaddr.bootstrap.synergynode.xyz")
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
            assert_eq!(peer_bootnodes.len(), 3);
            assert_eq!(
                peer_bootnodes[0].as_str(),
                Some("bootnode1.synergynode.xyz:38638")
            );

            let peer_dns_records = peers_value
                .get("global")
                .and_then(|section| section.get("bootstrap_dns_records"))
                .and_then(toml::Value::as_array)
                .expect("global.bootstrap_dns_records should exist");
            assert_eq!(peer_dns_records.len(), 1);
            assert_eq!(
                peer_dns_records[0].as_str(),
                Some("_dnsaddr.bootstrap.synergynode.xyz")
            );

            let peer_seeds = peers_value
                .get("global")
                .and_then(|section| section.get("seed_servers"))
                .and_then(toml::Value::as_array)
                .expect("global.seed_servers should exist");
            assert_eq!(peer_seeds.len(), 3);
            assert_eq!(
                peer_seeds[0].as_str(),
                Some("http://seed1.synergynode.xyz:18080")
            );

            assert_eq!(
                peers_value
                    .get("testbeta")
                    .and_then(|section| section.get("core_rpc"))
                    .and_then(toml::Value::as_str),
                Some("https://testbeta-core-rpc.synergy-network.io")
            );
            assert_eq!(
                peers_value
                    .get("testbeta")
                    .and_then(|section| section.get("wallet_api"))
                    .and_then(toml::Value::as_str),
                Some("https://testbeta-wallet-api.synergy-network.io")
            );

            let state = testbeta_get_state().expect("state should load from test temp home");
            assert_eq!(state.summary.total_nodes, 1);
            assert_eq!(state.nodes[0].role_id, "validator");
        });
    }

    #[test]
    fn resolve_runner_falls_back_to_generic_platform_binary() {
        with_temp_home(|home| {
            let _cwd = CurrentDirGuard::set(home);
            let resources = home.join("resources");
            let binaries = resources.join("binaries");
            fs::create_dir_all(&binaries).expect("binaries dir should exist");

            let platform_binary = binaries.join(current_platform_testbeta_binary_names()[0]);
            fs::write(&platform_binary, b"#!/bin/sh\n").expect("binary stub should write");

            let _resource_root = EnvVarGuard::set_path("SYNERGY_RESOURCE_ROOT", &resources);
            let app_context = AppContext::from_env();
            let runner =
                resolve_testbeta_runner(&app_context, "validator").expect("runner should resolve");

            match runner {
                TestnetBetaRunner::Binary(path) => assert_eq!(path, platform_binary),
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

            let runner_path = binaries.join(current_platform_testbeta_binary_names()[0]);
            fs::write(
                &runner_path,
                r#"#!/bin/sh
set -eu
cmd="$1"
shift || true
case "$cmd" in
  start)
    mkdir -p data logs
    echo $$ > data/synergy-testbeta.pid
    echo '{"ok":true}' > data/role-runtime.json
    sleep 30
    ;;
  stop)
    if [ -f data/synergy-testbeta.pid ]; then
      pid="$(cat data/synergy-testbeta.pid)"
      kill "$pid" >/dev/null 2>&1 || true
      rm -f data/synergy-testbeta.pid
    fi
    ;;
  sync)
    exit 0
    ;;
esac
"#,
            )
            .expect("runner stub should write");
            let mut permissions = fs::metadata(&runner_path)
                .expect("runner metadata should exist")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&runner_path, permissions).expect("runner should be executable");

            let _resource_root = EnvVarGuard::set_path("SYNERGY_RESOURCE_ROOT", &resources);
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
            let setup = runtime
                .block_on(testbeta_setup_node(TestnetBetaSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Validator Test".to_string()),
                    intended_directory: None,
                    public_host: None,
                }))
                .expect("setup should succeed");
            let app_context = AppContext::from_env();
            let start_result = runtime
                .block_on(testbeta_node_control(
                    &app_context,
                    TestnetBetaNodeControlInput {
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
                .block_on(testbeta_node_control(
                    &app_context,
                    TestnetBetaNodeControlInput {
                        node_id: setup.node.id,
                        action: "stop".to_string(),
                    },
                ))
                .expect("stop should succeed");
        });
    }

    #[test]
    fn setup_assigns_unique_port_slots_and_config_ports() {
        with_temp_home(|home| {
            let _cwd = CurrentDirGuard::set(home);
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");

            let first = runtime
                .block_on(testbeta_setup_node(TestnetBetaSetupInput {
                    role_id: "validator".to_string(),
                    display_label: Some("Validator A".to_string()),
                    intended_directory: None,
                    public_host: None,
                }))
                .expect("first setup should succeed");
            let second = runtime
                .block_on(testbeta_setup_node(TestnetBetaSetupInput {
                    role_id: "rpc_gateway".to_string(),
                    display_label: Some("RPC B".to_string()),
                    intended_directory: None,
                    public_host: None,
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
                Some(i64::from(TESTNET_BETA_RPC_PORT + 1))
            );
            assert_eq!(
                second_value
                    .get("p2p")
                    .and_then(|section| section.get("discovery_port"))
                    .and_then(toml::Value::as_integer),
                Some(i64::from(TESTNET_BETA_DISCOVERY_PORT + 1))
            );
        });
    }

    #[test]
    fn role_functions_document_current_runtime_state_for_all_roles() {
        let catalog = node_catalog();
        assert_eq!(catalog.len(), 19);

        let docs_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../synergy-testnet-beta/docs/node-role-functions.md");
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
