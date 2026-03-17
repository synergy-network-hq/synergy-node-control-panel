use super::types::*;
use super::NodeManager;
use std::fs;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

#[tauri::command]
pub async fn init_node_environment(
    state: State<'_, Arc<Mutex<NodeManager>>>,
) -> Result<NodeInfo, String> {
    let mut manager = state.lock().await;

    // Create sandbox directory structure
    let sandbox = &manager.node_info.sandbox_path;

    fs::create_dir_all(sandbox)
        .map_err(|e| format!("Failed to create sandbox directory: {}", e))?;

    fs::create_dir_all(sandbox.join("bin"))
        .map_err(|e| format!("Failed to create bin directory: {}", e))?;

    fs::create_dir_all(sandbox.join("config"))
        .map_err(|e| format!("Failed to create config directory: {}", e))?;

    fs::create_dir_all(sandbox.join("logs"))
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;

    fs::create_dir_all(sandbox.join("data"))
        .map_err(|e| format!("Failed to create data directory: {}", e))?;

    // Create a runtime-compatible TOML config for the legacy single-node path.
    let data_dir = toml::Value::String(sandbox.join("data").to_string_lossy().to_string()).to_string();
    let log_file = toml::Value::String(sandbox.join("logs").join("node.log").to_string_lossy().to_string()).to_string();
    let config_content = format!(
        r#"[network]
name = "devnet"
rpc_port = 48638
p2p_port = 38638

[rpc]
http_port = 48638
enable_http = true
enable_ws = false
enable_grpc = false

[p2p]
listen_address = "0.0.0.0:38638"
node_name = "validator-local"

[storage]
data_dir = {data_dir}

[logging]
log_level = "info"
enable_console = true
log_file = {log_file}

[identity]
role = "validator"

[role]
compiled_profile = "validator_node"

[node]
auto_register_validator = false
strict_validator_allowlist = false
allowed_validator_addresses = []
"#
    );

    fs::write(&manager.node_info.config_path, config_content)
        .map_err(|e| format!("Failed to write config file: {}", e))?;

    manager.node_info.is_initialized = true;

    Ok(manager.node_info.clone())
}

#[tauri::command]
pub async fn check_initialization(
    state: State<'_, Arc<Mutex<NodeManager>>>,
) -> Result<bool, String> {
    let manager = state.lock().await;
    let sandbox = &manager.node_info.sandbox_path;
    let binary = &manager.node_info.binary_path;
    let config = &manager.node_info.config_path;

    // Check if all required components exist
    let initialized = sandbox.exists() && binary.exists() && config.exists();

    Ok(initialized)
}
