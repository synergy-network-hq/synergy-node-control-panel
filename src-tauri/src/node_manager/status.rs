use super::multi_node::MultiNodeManager;
use super::types::*;
use super::NodeManager;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::sync::Mutex;

/// Get the LOCAL node's RPC endpoint for monitoring
/// For monitoring the local running node, we query localhost with the configured RPC port
fn get_local_rpc_endpoint() -> String {
    // Get the default RPC port from environment config
    if let Ok(env_config) = crate::env_config::EnvConfig::load(None) {
        return format!("http://localhost:{}/rpc", env_config.default_rpc_port);
    }
    // Fallback to default RPC port
    "http://localhost:48638/rpc".to_string()
}

/// Get the public network RPC endpoint for network-wide queries
fn get_public_rpc_endpoint() -> String {
    // Try to load from environment config
    if let Ok(env_config) = crate::env_config::EnvConfig::load(None) {
        return env_config.rpc_endpoint;
    }
    // Fallback to public testbeta RPC
    "https://testbeta-core-rpc.synergy-network.io/".to_string()
}

fn parse_rpc_endpoint_from_config(config_path: &Path) -> Option<String> {
    let content = fs::read_to_string(config_path).ok()?;
    let value: toml::Value = content.parse().ok()?;
    let rpc_port = value
        .get("rpc")
        .and_then(|rpc| rpc.get("http_port"))
        .and_then(|v| v.as_integer())
        .and_then(|v| u16::try_from(v).ok())
        .or_else(|| {
            value
                .get("network")
                .and_then(|network| network.get("rpc_port"))
                .and_then(|v| v.as_integer())
                .and_then(|v| u16::try_from(v).ok())
        })?;
    Some(format!("http://127.0.0.1:{}/rpc", rpc_port))
}

async fn get_node_rpc_endpoint(
    node_id: &str,
    manager: &State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<String, String> {
    let (config_path, display_name) = {
        let mgr = manager.lock().await;
        let node = mgr
            .get_node(node_id)
            .ok_or_else(|| format!("Node not found: {}", node_id))?;
        (node.config_path.clone(), node.display_name.clone())
    };

    if let Some(endpoint) = parse_rpc_endpoint_from_config(&config_path) {
        return Ok(endpoint);
    }

    Err(format!(
        "Unable to resolve RPC endpoint for node {} ({})",
        node_id, display_name
    ))
}

async fn query_rpc(
    method: &str,
    params: Vec<serde_json::Value>,
    rpc_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let request_body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": 1
    });

    // Use provided URL or get local node's RPC endpoint for monitoring
    let url = rpc_url.unwrap_or_else(get_local_rpc_endpoint);

    let response = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("RPC request failed: {}", e))?;

    let json_response: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse RPC response: {}", e))?;

    if let Some(error) = json_response.get("error") {
        return Err(format!("RPC error: {}", error));
    }

    json_response
        .get("result")
        .cloned()
        .ok_or_else(|| "RPC response missing result field".to_string())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NodeMonitoringData {
    pub current_block_height: u64,
    pub sync_status: String,
    pub sync_percentage: u8,
    pub connected_peers: u64,
    pub balance: f64,
    pub synergy_score: f64,
    pub network_height: u64,
    pub recent_blocks: Vec<BlockInfo>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlockValidationStatus {
    pub current_block_height: u64,
    pub recent_blocks: Vec<BlockInfo>,
    pub validation_queue: Vec<serde_json::Value>,
    pub active_validators: usize,
    pub total_validators: usize,
    pub cluster_info: ClusterInfo,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlockInfo {
    pub block_number: u64,
    pub timestamp: u64,
    pub transactions: Option<u64>,
    pub validator: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ClusterInfo {
    pub active_clusters: u64,
    pub total_stake: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ValidatorActivity {
    pub address: String,
    pub name: String,
    pub synergy_score: f64,
    pub blocks_produced: u64,
    pub uptime: String,
    pub cluster_id: Option<u64>,
    pub stake_amount: u64,
    pub last_active: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ValidatorActivityResponse {
    pub validators: Vec<ValidatorActivity>,
    pub total_active: usize,
    pub average_synergy_score: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PeerDetail {
    pub node_id: String,
    pub address: String,
    pub version: String,
    pub connected_at: u64,
    pub last_seen: u64,
    pub blocks_sent: u64,
    pub blocks_received: u64,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PeerInfo {
    pub peer_count: u64,
    pub peers: Vec<PeerDetail>,
}

fn get_rpc_url_from_config(manager: &NodeManager) -> Option<String> {
    parse_rpc_endpoint_from_config(&manager.node_info.config_path).or_else(|| Some(get_local_rpc_endpoint()))
}

#[tauri::command]
pub async fn get_node_status(
    state: State<'_, Arc<Mutex<NodeManager>>>,
) -> Result<NodeStatus, String> {
    let manager = state.lock().await;

    let is_running = manager.node_info.is_running;
    let pid = manager.node_info.pid;

    // Calculate uptime from start time if process is running
    let uptime = if is_running && manager.node_info.started_at > 0 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        Some(now - manager.node_info.started_at)
    } else {
        None
    };

    // If node is not running, return basic status
    if !is_running {
        // Try to get version from binary
        let version = get_binary_version(&manager.node_info.binary_path)
            .await
            .ok();

        return Ok(NodeStatus {
            is_running: false,
            pid: None,
            uptime: None,
            version,
            block_height: None,
            peer_count: None,
            sync_status: Some("Stopped".to_string()),
        });
    }

    // Get RPC URL from config
    let rpc_url = get_rpc_url_from_config(&manager);

    // Query real data from the running node via synergy RPC methods
    let block_height =
        match query_rpc("synergy_getBlockValidationStatus", vec![], rpc_url.clone()).await {
            Ok(result) => {
                // Response: {"current_block_height": 123, ...}
                result.get("current_block_height").and_then(|v| v.as_u64())
            }
            Err(_) => None,
        };

    let peer_count = match query_rpc("synergy_getPeerInfo", vec![], rpc_url).await {
        Ok(result) => {
            // Response: {"peer_count": 2, ...}
            result.get("peer_count").and_then(|v| v.as_u64())
        }
        Err(_) => None,
    };

    let sync_status = if is_running {
        if let Some(height) = block_height {
            if height > 0 {
                Some("Synced".to_string())
            } else {
                Some("Syncing".to_string())
            }
        } else {
            Some("Starting".to_string())
        }
    } else {
        Some("Stopped".to_string())
    };

    // Get version from binary
    let version = get_binary_version(&manager.node_info.binary_path)
        .await
        .ok();

    Ok(NodeStatus {
        is_running,
        pid,
        uptime,
        version,
        block_height,
        peer_count,
        sync_status,
    })
}

async fn get_binary_version(binary_path: &std::path::PathBuf) -> Result<String, String> {
    if !binary_path.exists() {
        return Err("Binary not found".to_string());
    }

    // Execute binary with --version flag
    let output = tokio::process::Command::new(binary_path)
        .arg("--version")
        .output()
        .await
        .map_err(|e| format!("Failed to execute binary: {}", e))?;

    if !output.status.success() {
        return Err("Failed to get version".to_string());
    }

    let version_output = String::from_utf8_lossy(&output.stdout);
    // Parse version from output like "Synergy Devnet Node v1.0.0"
    let version = version_output
        .lines()
        .next()
        .unwrap_or("Unknown")
        .trim()
        .to_string();

    Ok(version)
}

#[tauri::command]
pub async fn get_block_validation_status(
    node_id: String,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<BlockValidationStatus, String> {
    let rpc_url = get_node_rpc_endpoint(&node_id, &manager).await?;
    let result = query_rpc("synergy_getBlockValidationStatus", vec![], Some(rpc_url)).await?;
    serde_json::from_value(result)
        .map_err(|e| format!("Failed to parse block validation status: {}", e))
}

#[tauri::command]
pub async fn get_validator_activity(
    node_id: String,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<ValidatorActivityResponse, String> {
    let rpc_url = get_node_rpc_endpoint(&node_id, &manager).await?;
    let result = query_rpc("synergy_getValidatorActivity", vec![], Some(rpc_url)).await?;
    serde_json::from_value(result).map_err(|e| format!("Failed to parse validator activity: {}", e))
}

#[tauri::command]
pub async fn get_peer_info(
    node_id: String,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<PeerInfo, String> {
    let rpc_url = get_node_rpc_endpoint(&node_id, &manager).await?;
    let result = query_rpc("synergy_getPeerInfo", vec![], Some(rpc_url)).await?;
    serde_json::from_value(result).map_err(|e| format!("Failed to parse peer info: {}", e))
}
