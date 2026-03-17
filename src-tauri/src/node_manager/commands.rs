use crate::env_config::EnvConfig;
use crate::node_manager::binary_downloader;
use crate::node_manager::binary_verification;
use crate::node_manager::crypto::{self, NodeIdentity};
use crate::node_manager::multi_node::MultiNodeManager;
use crate::node_manager::multi_node_process::ProcessManager;
use crate::node_manager::node_classes::NodeClass;
use crate::node_manager::types::{NodeInstance, NodeOperationMode, NodeType};
use crate::recipe::{load_and_validate, SetupRecipe};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tokio::process::Command;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeTypeInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub compatible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitResponse {
    pub success: bool,
    pub message: String,
    pub control_panel_path: String,
}

#[tauri::command]
pub async fn check_multi_node_initialization(
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<bool, String> {
    let mgr = manager.lock().await;
    Ok(mgr.info.is_initialized)
}

#[tauri::command]
pub async fn init_multi_node_environment(
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<InitResponse, String> {
    let mut mgr = manager.lock().await;

    // Create control panel directory structure
    let cp_path = mgr.info.control_panel_path.clone();
    fs::create_dir_all(&cp_path)
        .map_err(|e| format!("Failed to create control panel directory: {}", e))?;

    fs::create_dir_all(cp_path.join("bin"))
        .map_err(|e| format!("Failed to create bin directory: {}", e))?;

    fs::create_dir_all(cp_path.join("templates"))
        .map_err(|e| format!("Failed to create templates directory: {}", e))?;

    fs::create_dir_all(cp_path.join("nodes"))
        .map_err(|e| format!("Failed to create nodes directory: {}", e))?;

    mgr.info.is_initialized = true;
    mgr.save()?;

    Ok(InitResponse {
        success: true,
        message: "Control panel environment initialized successfully".to_string(),
        control_panel_path: cp_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn get_available_node_types(
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<Vec<NodeTypeInfo>, String> {
    let mgr = manager.lock().await;
    let compatible_types = mgr.get_compatible_node_types();

    let all_types = vec![
        (
            NodeType::Validator,
            "Core network validator node that validates transactions and produces blocks",
        ),
        (
            NodeType::Committee,
            "Committee member that participates in consensus",
        ),
        (
            NodeType::ArchiveValidator,
            "Validator with full historical archive",
        ),
        (
            NodeType::AuditValidator,
            "Validator focused on audit and compliance",
        ),
        (
            NodeType::Relayer,
            "Relays messages and data between network segments",
        ),
        (NodeType::Witness, "Witnesses and attests to network events"),
        (NodeType::Oracle, "Provides external data to the network"),
        (
            NodeType::UmaCoordinator,
            "Coordinates UMA protocol operations",
        ),
        (
            NodeType::CrossChainVerifier,
            "Verifies cross-chain transactions",
        ),
        (NodeType::Compute, "General purpose compute node"),
        (
            NodeType::AiInference,
            "Specialized AI inference compute node",
        ),
        (
            NodeType::PqcCrypto,
            "Post-quantum cryptography compute node",
        ),
        (
            NodeType::DataAvailability,
            "Ensures data availability across the network",
        ),
        (
            NodeType::GovernanceAuditor,
            "Audits governance proposals and decisions",
        ),
        (NodeType::TreasuryController, "Manages treasury operations"),
        (NodeType::SecurityCouncil, "Security council member node"),
        (NodeType::RpcGateway, "RPC gateway for network access"),
        (NodeType::Indexer, "Indexes blockchain data"),
        (NodeType::Observer, "Observes and monitors network state"),
    ];

    let result = all_types
        .into_iter()
        .map(|(node_type, description)| {
            let compatible = compatible_types.contains(&node_type);
            NodeTypeInfo {
                id: node_type.as_str().to_string(),
                display_name: node_type.display_name().to_string(),
                description: description.to_string(),
                compatible,
            }
        })
        .collect();

    Ok(result)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SetupProgress {
    pub step: String,
    pub message: String,
    pub progress: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NodeSetupOptions {
    pub user_operated: bool,
    pub auto_start: bool,
}

impl Default for NodeSetupOptions {
    fn default() -> Self {
        Self {
            user_operated: true,
            auto_start: true,
        }
    }
}

#[derive(Debug, Clone)]
struct AllocatedPorts {
    p2p: u16,
    rpc: u16,
    ws: u16,
    metrics: u16,
    discovery: u16,
}

fn progress_for_step(map: &HashMap<String, u8>, step: &str) -> u8 {
    if let Some(value) = map.get(step) {
        return *value;
    }

    match step {
        "recipe" => 0,
        "init" => 10,
        "directories" => 25,
        "keygen" => 40,
        "binary" => 60,
        "config" => 75,
        "register" => 90,
        "sync" => 95,
        "complete" => 100,
        _ => 0,
    }
}

fn emit_progress(
    app_handle: &tauri::AppHandle,
    map: &HashMap<String, u8>,
    step: &str,
    message: String,
) -> Result<(), String> {
    let progress = progress_for_step(map, step);
    app_handle
        .emit(
            "setup-progress",
            SetupProgress {
                step: step.to_string(),
                message,
                progress,
            },
        )
        .map_err(|e| format!("Failed to emit progress: {}", e))?;
    Ok(())
}

fn emit_failure(app_handle: &tauri::AppHandle, map: &HashMap<String, u8>, step: &str, error: &str) {
    let _ = app_handle.emit(
        "setup-progress",
        SetupProgress {
            step: format!("{}-failed", step),
            message: format!("{} failed: {}", step, error),
            progress: progress_for_step(map, step),
        },
    );
}

/// Verify network connectivity before starting node setup
/// This ensures the Synergy network is accessible before we begin
async fn verify_network_connectivity(
    env_config: &EnvConfig,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    app_handle.emit("terminal-output",
        serde_json::json!({ "line": "[Network] Checking connectivity to Synergy network...", "type": "info" })
    ).unwrap_or(());

    // Build the RPC request to check node info
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let rpc_request = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "synergy_nodeInfo",
        "params": [],
        "id": 1
    });

    let endpoints = env_config.rpc_endpoints();
    if endpoints.is_empty() {
        return Err("No RPC endpoints configured for connectivity check".to_string());
    }

    let mut last_error = None;
    for rpc_endpoint in endpoints {
        let response = client.post(&rpc_endpoint).json(&rpc_request).send().await;

        match response {
            Ok(resp) if resp.status().is_success() => {
                let body: serde_json::Value = match resp.json().await {
                    Ok(body) => body,
                    Err(e) => {
                        last_error = Some(format!(
                            "Failed to parse response from {}: {}",
                            rpc_endpoint, e
                        ));
                        continue;
                    }
                };

                if let Some(error) = body.get("error") {
                    last_error = Some(format!("RPC error from {}: {}", rpc_endpoint, error));
                    continue;
                }

                let result = match body.get("result") {
                    Some(result) => result,
                    None => {
                        last_error = Some(format!(
                            "RPC response from {} missing result field",
                            rpc_endpoint
                        ));
                        continue;
                    }
                };

                if !result.is_object() {
                    last_error = Some(format!(
                        "Unexpected RPC response from {}: {}",
                        rpc_endpoint, result
                    ));
                    continue;
                }

                app_handle
                    .emit(
                        "terminal-output",
                        serde_json::json!({
                            "line": format!("[Network] ✓ Connected to {}", rpc_endpoint),
                            "type": "success"
                        }),
                    )
                    .unwrap_or(());
                return Ok(());
            }
            Ok(resp) => {
                last_error = Some(format!(
                    "Synergy network RPC endpoint {} returned HTTP {}",
                    rpc_endpoint,
                    resp.status()
                ));
            }
            Err(e) => {
                if e.is_timeout() {
                    last_error = Some(format!("Connection to {} timed out", rpc_endpoint));
                } else if e.is_connect() {
                    last_error = Some(format!("Cannot connect to {}", rpc_endpoint));
                } else {
                    last_error = Some(format!(
                        "Network connectivity check failed for {}: {}",
                        rpc_endpoint, e
                    ));
                }
            }
        }
    }

    Err(format!(
        "All RPC endpoints failed connectivity checks. Last error: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[tauri::command]
pub async fn setup_node(
    node_type: String,
    display_name: Option<String>,
    setup_options: Option<NodeSetupOptions>,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
    process_manager: State<'_, Arc<Mutex<ProcessManager>>>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let env_config = EnvConfig::load(Some(&app_handle))?;
    let setup_options = setup_options.unwrap_or_default();

    let recipe_path = format!("recipes/{}.yml", node_type);
    let recipe = load_and_validate(&recipe_path, &app_handle)
        .map(|(r, _)| r)
        .unwrap_or_else(|_| SetupRecipe {
            node_type: node_type.clone(),
            role: display_name.clone().unwrap_or_else(|| "node".to_string()),
            steps: vec![],
        });
    let progress_map = recipe
        .steps
        .iter()
        .map(|s| (s.name.clone(), s.progress))
        .collect::<HashMap<_, _>>();

    let node_type = NodeType::from_str(&node_type)
        .ok_or_else(|| format!("Invalid node type: {}", node_type))?;
    let node_class = NodeClass::from_node_type(&node_type);
    let target_display = display_name
        .clone()
        .unwrap_or_else(|| node_type.display_name().to_string());

    emit_progress(
        &app_handle,
        &progress_map,
        "init",
        format!("Initializing {} node setup...", node_type.display_name()),
    )?;

    if !setup_options.user_operated {
        if let Err(e) = verify_network_connectivity(&env_config, &app_handle).await {
            emit_failure(&app_handle, &progress_map, "init", &e);
            app_handle
                .emit(
                    "terminal-output",
                    serde_json::json!({
                        "line": format!("[ERROR] {}", e),
                        "type": "error"
                    }),
                )
                .unwrap_or(());
            return Err(format!(
                "Network connectivity check failed: {}. Setup cannot proceed without network access.",
                e
            ));
        }
    } else {
        app_handle
            .emit(
                "terminal-output",
                serde_json::json!({
                    "line": "[Setup] User-operated local mode enabled: external network registration and sync are skipped.",
                    "type": "info"
                }),
            )
            .unwrap_or(());
    }

    let (node_id, mut node, _existing_node) = ensure_node_record(
        &node_type,
        &target_display,
        &manager,
        &app_handle,
        &progress_map,
    )
    .await?;

    let directories_message = ensure_node_directories(&node).map_err(|e| {
        emit_failure(&app_handle, &progress_map, "directories", &e);
        e
    })?;
    emit_progress(
        &app_handle,
        &progress_map,
        "directories",
        directories_message,
    )?;

    let (node_identity, generated_new_identity) =
        ensure_node_identity(&node_id, node_class, &manager, &app_handle, &progress_map).await?;
    node = reload_node(&node_id, &manager).await?;
    let allocated_ports =
        allocate_ports_for_node(&node_id, &manager, &env_config, &node.config_path).await?;

    {
        let mut mgr = manager.lock().await;
        mgr.set_node_operation_mode(
            &node_id,
            if setup_options.user_operated {
                NodeOperationMode::UserOperatedLocal
            } else {
                NodeOperationMode::NetworkParticipating
            },
        )?;
    }
    node = reload_node(&node_id, &manager).await?;

    emit_progress(
        &app_handle,
        &progress_map,
        "keygen",
        if generated_new_identity {
            format!("Generated address: {}", node_identity.address)
        } else {
            format!("Reusing existing address: {}", node_identity.address)
        },
    )?;

    let (binary_path, binary_message) = ensure_binary_ready(
        &env_config,
        &node.node_type,
        &manager,
        &app_handle,
        &progress_map,
    )
    .await?;
    emit_progress(&app_handle, &progress_map, "binary", binary_message)?;

    let config_message = ensure_config(
        &node,
        &env_config,
        &node_identity,
        &allocated_ports,
        setup_options.user_operated,
        &app_handle,
        &progress_map,
    )?;
    emit_progress(&app_handle, &progress_map, "config", config_message)?;

    if setup_options.user_operated {
        emit_progress(
            &app_handle,
            &progress_map,
            "register",
            "Skipped external network registration for user-operated local node".to_string(),
        )?;
        emit_progress(
            &app_handle,
            &progress_map,
            "sync",
            "Skipped blockchain sync for user-operated local node".to_string(),
        )?;
    } else {
        let registration_message = perform_registration(
            &binary_path,
            &node_identity,
            &node.config_path,
            &app_handle,
            &progress_map,
        )
        .await?;
        emit_progress(&app_handle, &progress_map, "register", registration_message)?;

        let sync_message =
            perform_sync(&binary_path, &node.config_path, &app_handle, &progress_map).await?;
        emit_progress(&app_handle, &progress_map, "sync", sync_message)?;
    }

    if setup_options.auto_start {
        let start_message = ensure_node_running(
            &node_id,
            &manager,
            &process_manager,
            &binary_path,
            &env_config,
            &progress_map,
            &app_handle,
        )
        .await?;
        emit_progress(&app_handle, &progress_map, "complete", start_message)?;
    } else {
        emit_progress(
            &app_handle,
            &progress_map,
            "complete",
            "Setup complete. Node is configured and ready to start.".to_string(),
        )?;
    }

    // Mark the manager as initialized after successful setup
    {
        let mut mgr = manager.lock().await;
        mgr.info.is_initialized = true;
        mgr.save()?;
    }

    Ok(node_id)
}

async fn ensure_node_record(
    node_type: &NodeType,
    display_name: &str,
    manager: &State<'_, Arc<Mutex<MultiNodeManager>>>,
    app_handle: &tauri::AppHandle,
    progress_map: &HashMap<String, u8>,
) -> Result<(String, NodeInstance, bool), String> {
    let mut mgr = manager.lock().await;
    if let Some((id, node)) = mgr
        .info
        .nodes
        .iter()
        .find(|(_, n)| n.node_type == *node_type && n.display_name == display_name)
    {
        return Ok((id.clone(), node.clone(), true));
    }

    let node_id = mgr
        .add_node(node_type.clone(), Some(display_name.to_string()))
        .map_err(|e| {
            emit_failure(app_handle, progress_map, "init", &e);
            e
        })?;
    let node = mgr
        .get_node(&node_id)
        .cloned()
        .ok_or_else(|| "Failed to get newly created node".to_string())?;
    Ok((node_id, node, false))
}

async fn reload_node(
    node_id: &str,
    manager: &State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<NodeInstance, String> {
    let mgr = manager.lock().await;
    mgr.get_node(node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {}", node_id))
}

fn parse_ports_from_config(
    config_path: &Path,
    env_config: &EnvConfig,
) -> Result<Option<AllocatedPorts>, String> {
    if !config_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(config_path)
        .map_err(|e| format!("Failed to read config {}: {}", config_path.display(), e))?;
    let value: toml::Value = content.parse().map_err(|e: toml::de::Error| {
        format!("Failed to parse config {}: {}", config_path.display(), e)
    })?;

    let network = value.get("network").and_then(|v| v.as_table());
    let p2p = network
        .and_then(|n| n.get("p2p_port"))
        .and_then(|v| v.as_integer())
        .and_then(|v| u16::try_from(v).ok());
    let rpc = network
        .and_then(|n| n.get("rpc_port"))
        .and_then(|v| v.as_integer())
        .and_then(|v| u16::try_from(v).ok());
    let ws = network
        .and_then(|n| n.get("ws_port"))
        .and_then(|v| v.as_integer())
        .and_then(|v| u16::try_from(v).ok());

    let Some(p2p) = p2p else { return Ok(None) };
    let Some(rpc) = rpc else { return Ok(None) };
    let Some(ws) = ws else { return Ok(None) };

    let metrics = value
        .get("metrics")
        .and_then(|m| m.get("port"))
        .and_then(|v| v.as_integer())
        .and_then(|v| u16::try_from(v).ok())
        .unwrap_or(env_config.default_metrics_port);

    let discovery = value
        .get("p2p")
        .and_then(|p| p.get("discovery_port"))
        .and_then(|v| v.as_integer())
        .and_then(|v| u16::try_from(v).ok())
        .unwrap_or(30_301);

    Ok(Some(AllocatedPorts {
        p2p,
        rpc,
        ws,
        metrics,
        discovery,
    }))
}

fn candidate_ports_for_slot(env_config: &EnvConfig, slot: u16) -> Option<AllocatedPorts> {
    let stride = 10_u32;
    let offset = u32::from(slot) * stride;
    let p2p = u32::from(env_config.default_p2p_port) + offset;
    let rpc = u32::from(env_config.default_rpc_port) + offset;
    let ws = u32::from(env_config.default_ws_port) + offset;
    let metrics = u32::from(env_config.default_metrics_port) + offset;
    let discovery = 30_301_u32 + offset;

    if p2p > u32::from(u16::MAX)
        || rpc > u32::from(u16::MAX)
        || ws > u32::from(u16::MAX)
        || metrics > u32::from(u16::MAX)
        || discovery > u32::from(u16::MAX)
    {
        return None;
    }

    Some(AllocatedPorts {
        p2p: p2p as u16,
        rpc: rpc as u16,
        ws: ws as u16,
        metrics: metrics as u16,
        discovery: discovery as u16,
    })
}

fn insert_allocated_ports(used_ports: &mut HashSet<u16>, ports: &AllocatedPorts) {
    used_ports.insert(ports.p2p);
    used_ports.insert(ports.rpc);
    used_ports.insert(ports.ws);
    used_ports.insert(ports.metrics);
    used_ports.insert(ports.discovery);
}

async fn allocate_ports_for_node(
    node_id: &str,
    manager: &State<'_, Arc<Mutex<MultiNodeManager>>>,
    env_config: &EnvConfig,
    node_config_path: &Path,
) -> Result<AllocatedPorts, String> {
    if let Some(existing) = parse_ports_from_config(node_config_path, env_config)? {
        return Ok(existing);
    }

    let mut used_ports = HashSet::new();
    {
        let mgr = manager.lock().await;
        for (existing_node_id, existing_node) in &mgr.info.nodes {
            if existing_node_id == node_id {
                continue;
            }
            if let Some(ports) = parse_ports_from_config(&existing_node.config_path, env_config)? {
                insert_allocated_ports(&mut used_ports, &ports);
            }
        }
    }

    for slot in 0..2048 {
        let Some(candidate) = candidate_ports_for_slot(env_config, slot) else {
            break;
        };
        if !used_ports.contains(&candidate.p2p)
            && !used_ports.contains(&candidate.rpc)
            && !used_ports.contains(&candidate.ws)
            && !used_ports.contains(&candidate.metrics)
            && !used_ports.contains(&candidate.discovery)
        {
            return Ok(candidate);
        }
    }

    Err("Unable to allocate non-conflicting ports for node".to_string())
}

fn ensure_node_directories(node: &NodeInstance) -> Result<String, String> {
    fs::create_dir_all(&node.sandbox_path)
        .map_err(|e| format!("Failed to create sandbox: {}", e))?;
    fs::create_dir_all(&node.logs_path)
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;
    fs::create_dir_all(&node.data_path)
        .map_err(|e| format!("Failed to create data directory: {}", e))?;
    if let Some(parent) = node.config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    fs::create_dir_all(node.sandbox_path.join("keys"))
        .map_err(|e| format!("Failed to create keys directory: {}", e))?;

    Ok(format!(
        "Directory structure ready at {}",
        node.sandbox_path.display()
    ))
}

async fn ensure_node_identity(
    node_id: &str,
    node_class: NodeClass,
    manager: &State<'_, Arc<Mutex<MultiNodeManager>>>,
    app_handle: &tauri::AppHandle,
    progress_map: &HashMap<String, u8>,
) -> Result<(NodeIdentity, bool), String> {
    let (existing_identity, keys_dir) = {
        let mgr = manager.lock().await;
        let node = mgr.get_node(node_id).ok_or("Node not found")?;
        let keys_dir = node.sandbox_path.join("keys");
        let private_key_path = keys_dir.join("private.key");
        let public_key_path = keys_dir.join("public.key");

        if private_key_path.exists()
            && public_key_path.exists()
            && node.address.is_some()
            && node.public_key.is_some()
            && node.node_class.is_some()
        {
            let identity = NodeIdentity {
                address: node.address.clone().unwrap(),
                public_key: node.public_key.clone().unwrap(),
                private_key_path,
                node_class: node.node_class.unwrap(),
            };
            (Some(identity), keys_dir)
        } else {
            (None, keys_dir)
        }
    };

    if let Some(identity) = existing_identity {
        return Ok((identity, false));
    }

    fs::create_dir_all(&keys_dir).map_err(|e| {
        emit_failure(app_handle, progress_map, "keygen", &e.to_string());
        format!("Failed to prepare keys directory: {}", e)
    })?;

    let generated_identity = crypto::generate_pqc_keypair(node_class, &keys_dir)
        .await
        .map_err(|e| {
            emit_failure(app_handle, progress_map, "keygen", &e);
            e
        })?;

    let mut mgr = manager.lock().await;
    mgr.update_node_identity(node_id, &generated_identity)?;
    Ok((generated_identity, true))
}

fn installed_binary_path(control_panel_path: &Path, node_type: &NodeType) -> PathBuf {
    control_panel_path
        .join("bin")
        .join(node_type.installed_binary_name())
}

async fn fetch_manifest_entry(
    env_config: &EnvConfig,
    node_type: &NodeType,
) -> Result<(String, Option<String>, Option<String>), String> {
    let platform_key = env_config.platform_key();
    if platform_key == "unsupported" {
        return Err("Unsupported platform for binary download".to_string());
    }

    let response = reqwest::get(&env_config.unified_binary_url)
        .await
        .map_err(|e| format!("Failed to download binary manifest: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Binary manifest returned {}", response.status()));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read manifest body: {}", e))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse manifest JSON: {}", e))?;

    let profile_key = node_type.compiled_profile();

    let entry_value = manifest
        .get("binaries")
        .and_then(|b| b.get(&platform_key))
        .and_then(|platform| {
            platform
                .get("roles")
                .and_then(|roles| roles.get(profile_key))
                .or_else(|| platform.get(profile_key))
        })
        .or_else(|| {
            manifest
                .get("platforms")
                .and_then(|p| p.get(&platform_key))
                .and_then(|platform| {
                    platform
                        .get("roles")
                        .and_then(|roles| roles.get(profile_key))
                        .or_else(|| platform.get(profile_key))
                })
        })
        .ok_or_else(|| {
            format!(
                "No manifest entry for platform {} and role {}",
                platform_key, profile_key
            )
        })?;

    let url = if entry_value.is_object() {
        entry_value
            .get("url")
            .and_then(|u| u.as_str())
            .map(|s| s.to_string())
    } else if entry_value.is_string() {
        entry_value.as_str().map(|s| s.to_string())
    } else {
        None
    }
    .ok_or_else(|| format!("Manifest entry for {} missing url", platform_key))?;

    let checksum = entry_value
        .get("checksum")
        .or_else(|| entry_value.get("sha256"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok((url, checksum, version))
}

async fn ensure_binary_ready(
    env_config: &EnvConfig,
    node_type: &NodeType,
    manager: &State<'_, Arc<Mutex<MultiNodeManager>>>,
    app_handle: &tauri::AppHandle,
    progress_map: &HashMap<String, u8>,
) -> Result<(PathBuf, String), String> {
    let binary_path = {
        let mgr = manager.lock().await;
        installed_binary_path(&mgr.info.control_panel_path, node_type)
    };

    if binary_path.exists() {
        if let Ok((url, checksum, _version)) = fetch_manifest_entry(env_config, node_type).await {
            if let Some(expected) = checksum {
                let actual = binary_verification::calculate_checksum(&binary_path)
                    .map_err(|e| format!("Failed to checksum binary: {}", e))?;
                if actual == expected {
                    return Ok((
                        binary_path,
                        format!("Binary verified from manifest {}", url),
                    ));
                }
                fs::remove_file(&binary_path)
                    .map_err(|e| format!("Corrupt binary remove failed: {}", e))?;
            } else {
                return Ok((
                    binary_path,
                    "Binary present (no manifest checksum provided)".to_string(),
                ));
            }
        } else {
            return Ok((binary_path, "Binary present locally".to_string()));
        }
    }

    // Try manifest download first
    match fetch_manifest_entry(env_config, node_type).await {
        Ok((url, checksum, _version)) => {
            let download_result = binary_downloader::download_binary_direct_with_progress(
                &binary_path,
                &url,
                checksum.as_deref(),
                |_downloaded, _total| {},
            )
            .await;

            match download_result {
                Ok(_) => {
                    if let Some(expected) = checksum {
                        let actual = binary_verification::calculate_checksum(&binary_path)
                            .map_err(|e| format!("Failed to checksum binary: {}", e))?;
                        if actual != expected {
                            emit_failure(
                                app_handle,
                                progress_map,
                                "binary",
                                "Checksum mismatch after download",
                            );
                            return Err("Checksum mismatch after download".to_string());
                        }
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let mut perms = fs::metadata(&binary_path)
                            .map_err(|e| format!("Failed to get binary metadata: {}", e))?
                            .permissions();
                        perms.set_mode(0o755);
                        fs::set_permissions(&binary_path, perms)
                            .map_err(|e| format!("Failed to set binary permissions: {}", e))?;
                    }
                    return Ok((binary_path, "Binary ready".to_string()));
                }
                Err(e) => {
                    // fall through to local fallback after logging failure
                    emit_failure(
                        app_handle,
                        progress_map,
                        "binary",
                        &format!("Download failed: {}", e),
                    );
                }
            }
        }
        Err(e) => {
            emit_failure(
                app_handle,
                progress_map,
                "binary",
                &format!("Manifest fetch failed: {}", e),
            );
        }
    }

    // Fallback: look for bundled or local binary and copy it
    if let Some(source) = find_local_binary(env_config, node_type, app_handle) {
        fs::create_dir_all(binary_path.parent().unwrap_or(Path::new(".")))
            .map_err(|e| format!("Failed to create bin directory: {}", e))?;
        fs::copy(&source, &binary_path)
            .map_err(|e| format!("Failed to copy bundled binary: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&binary_path)
                .map_err(|e| format!("Failed to get binary metadata: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&binary_path, perms)
                .map_err(|e| format!("Failed to set binary permissions: {}", e))?;
        }
        return Ok((
            binary_path,
            format!("Binary installed from bundled copy ({})", source.display()),
        ));
    }

    Err("Binary download failed and no bundled binary found".to_string())
}

fn find_local_binary(
    env_config: &EnvConfig,
    node_type: &NodeType,
    app_handle: &tauri::AppHandle,
) -> Option<PathBuf> {
    let mut paths = Vec::new();
    let platform_key = env_config.platform_key();
    let installed_name = node_type.installed_binary_name();
    let artifact_name = node_type.artifact_binary_name(&platform_key);

    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        paths.push(resource_dir.join("binaries").join(&installed_name));
        paths.push(resource_dir.join("binaries").join(&artifact_name));
        paths.push(
            resource_dir
                .join("_up_")
                .join("binaries")
                .join(&installed_name),
        );
        paths.push(
            resource_dir
                .join("_up_")
                .join("binaries")
                .join(&artifact_name),
        );
    }

    if let Ok(current_dir) = std::env::current_dir() {
        paths.push(current_dir.join("binaries").join(&installed_name));
        paths.push(current_dir.join("binaries").join(&artifact_name));
        paths.push(
            current_dir
                .join("..")
                .join("binaries")
                .join(&installed_name),
        );
        paths.push(current_dir.join("..").join("binaries").join(&artifact_name));
        paths.push(
            current_dir
                .join("..")
                .join("..")
                .join("..")
                .join("synergy-testnet-beta")
                .join("binaries")
                .join(&installed_name),
        );
        paths.push(
            current_dir
                .join("..")
                .join("..")
                .join("..")
                .join("synergy-testnet-beta")
                .join("binaries")
                .join(&artifact_name),
        );
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            paths.push(exe_dir.join("binaries").join(&installed_name));
            paths.push(exe_dir.join("binaries").join(&artifact_name));
            paths.push(exe_dir.join("..").join("binaries").join(&installed_name));
            paths.push(exe_dir.join("..").join("binaries").join(&artifact_name));
        }
    }

    paths.into_iter().find(|p| p.exists())
}

fn load_template_content(
    node: &NodeInstance,
    app_handle: &tauri::AppHandle,
) -> Result<String, String> {
    use tauri::Manager;

    let template_name = node.node_type.template_file();
    let mut template_paths = vec![];

    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        template_paths.push(
            resource_dir
                .join("_up_")
                .join("templates")
                .join(&template_name),
        );
        template_paths.push(resource_dir.join("templates").join(&template_name));
    }

    if let Ok(current_dir) = std::env::current_dir() {
        template_paths.push(current_dir.join("templates").join(&template_name));
        template_paths.push(
            current_dir
                .join("..")
                .join("templates")
                .join(&template_name),
        );
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            template_paths.push(exe_dir.join("templates").join(&template_name));
            template_paths.push(exe_dir.join("..").join("templates").join(&template_name));
            template_paths.push(exe_dir.join("../..").join("templates").join(&template_name));
        }
    }

    let source_path = template_paths.iter().find(|p| p.exists()).ok_or_else(|| {
        format!(
            "Template file not found: {}. Searched paths: {:?}",
            template_name, template_paths
        )
    })?;

    fs::read_to_string(source_path)
        .map_err(|e| format!("Failed to read template {}: {}", source_path.display(), e))
}

fn ensure_config(
    node: &NodeInstance,
    env_config: &EnvConfig,
    identity: &NodeIdentity,
    allocated_ports: &AllocatedPorts,
    user_operated_local: bool,
    app_handle: &tauri::AppHandle,
    progress_map: &HashMap<String, u8>,
) -> Result<String, String> {
    let content = if node.config_path.exists() {
        fs::read_to_string(&node.config_path).map_err(|e| {
            emit_failure(app_handle, progress_map, "config", &e.to_string());
            format!("Failed to read existing config: {}", e)
        })?
    } else {
        load_template_content(node, app_handle)?
    };

    let mut config_value: toml::Value = content.parse().map_err(|e: toml::de::Error| {
        emit_failure(app_handle, progress_map, "config", &e.to_string());
        format!("Failed to parse config template: {}", e)
    })?;

    // Apply environment overrides
    set_toml_value(
        &mut config_value,
        &["network", "id"],
        toml::Value::Integer(env_config.chain_id as i64),
    );
    set_toml_value(
        &mut config_value,
        &["network", "name"],
        toml::Value::String(env_config.network.clone()),
    );

    set_toml_value(
        &mut config_value,
        &["network", "p2p_port"],
        toml::Value::Integer(allocated_ports.p2p as i64),
    );
    set_toml_value(
        &mut config_value,
        &["network", "rpc_port"],
        toml::Value::Integer(allocated_ports.rpc as i64),
    );
    set_toml_value(
        &mut config_value,
        &["network", "ws_port"],
        toml::Value::Integer(allocated_ports.ws as i64),
    );
    set_toml_value(
        &mut config_value,
        &["rpc", "http_port"],
        toml::Value::Integer(allocated_ports.rpc as i64),
    );
    set_toml_value(
        &mut config_value,
        &["rpc", "ws_port"],
        toml::Value::Integer(allocated_ports.ws as i64),
    );
    set_toml_value(
        &mut config_value,
        &["metrics", "port"],
        toml::Value::Integer(allocated_ports.metrics as i64),
    );
    set_toml_value(
        &mut config_value,
        &["p2p", "discovery_port"],
        toml::Value::Integer(allocated_ports.discovery as i64),
    );

    let listen_host = if user_operated_local {
        "127.0.0.1"
    } else {
        "0.0.0.0"
    };
    set_toml_value(
        &mut config_value,
        &["p2p", "listen_address"],
        toml::Value::String(format!("{}:{}", listen_host, allocated_ports.p2p)),
    );
    set_toml_value(
        &mut config_value,
        &["p2p", "public_address"],
        toml::Value::String(format!("{}:{}", listen_host, allocated_ports.p2p)),
    );
    set_toml_array(
        &mut config_value,
        &["network", "bootnodes"],
        if user_operated_local {
            Vec::new()
        } else {
            env_config.bootstrap_nodes.clone()
        },
    );
    set_toml_array(
        &mut config_value,
        &["network", "seed_servers"],
        if user_operated_local {
            Vec::new()
        } else {
            env_config.seed_servers.clone()
        },
    );
    set_toml_array(
        &mut config_value,
        &["network", "bootstrap_dns_records"],
        if user_operated_local {
            Vec::new()
        } else {
            env_config.bootstrap_dns_records.clone()
        },
    );
    set_toml_value(
        &mut config_value,
        &["p2p", "enable_discovery"],
        toml::Value::Boolean(!user_operated_local),
    );

    set_toml_value(
        &mut config_value,
        &["blockchain", "chain_id"],
        toml::Value::Integer(env_config.chain_id as i64),
    );
    set_toml_value(
        &mut config_value,
        &["p2p", "node_name"],
        toml::Value::String(identity.address.clone()),
    );

    set_toml_value(
        &mut config_value,
        &["logging", "log_file"],
        toml::Value::String(
            node.logs_path
                .join("node.log")
                .to_string_lossy()
                .to_string(),
        ),
    );
    set_toml_value(
        &mut config_value,
        &["storage", "path"],
        toml::Value::String(node.data_path.to_string_lossy().to_string()),
    );
    if user_operated_local {
        set_toml_value(
            &mut config_value,
            &["endpoints", "rpc"],
            toml::Value::String(format!("http://127.0.0.1:{}/rpc", allocated_ports.rpc)),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "ws"],
            toml::Value::String(format!("ws://127.0.0.1:{}", allocated_ports.ws)),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "api"],
            toml::Value::String(format!("http://127.0.0.1:{}/rpc", allocated_ports.rpc)),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "sxcp_api"],
            toml::Value::String(String::new()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "sxcp_ws"],
            toml::Value::String(String::new()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "aegis_verify"],
            toml::Value::String(String::new()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "explorer"],
            toml::Value::String(String::new()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "indexer"],
            toml::Value::String(String::new()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "faucet"],
            toml::Value::String(String::new()),
        );
    } else {
        set_toml_value(
            &mut config_value,
            &["endpoints", "rpc"],
            toml::Value::String(env_config.rpc_endpoint.clone()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "ws"],
            toml::Value::String(env_config.ws_endpoint.clone()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "api"],
            toml::Value::String(env_config.api_endpoint.clone()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "sxcp_api"],
            toml::Value::String(env_config.sxcp_api_endpoint.clone()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "sxcp_ws"],
            toml::Value::String(env_config.sxcp_ws_endpoint.clone()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "aegis_verify"],
            toml::Value::String(env_config.aegis_verify_endpoint.clone()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "explorer"],
            toml::Value::String(env_config.explorer_endpoint.clone()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "indexer"],
            toml::Value::String(env_config.indexer_endpoint.clone()),
        );
        set_toml_value(
            &mut config_value,
            &["endpoints", "faucet"],
            toml::Value::String(env_config.faucet_endpoint.clone()),
        );
    }

    if let Some(parent) = node.config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let serialized = toml::to_string_pretty(&config_value)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&node.config_path, serialized)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(format!(
        "Configuration applied (P2P {}, RPC {}, WS {}, mode: {})",
        allocated_ports.p2p,
        allocated_ports.rpc,
        allocated_ports.ws,
        if user_operated_local {
            "user-operated-local"
        } else {
            "network-participating"
        }
    ))
}

fn set_toml_value(root: &mut toml::Value, path: &[&str], value: toml::Value) {
    if path.is_empty() {
        return;
    }

    // Ensure root is a table
    if !root.is_table() {
        *root = toml::Value::Table(toml::map::Map::new());
    }

    let mut current = root;
    for key in path.iter().take(path.len() - 1) {
        // Ensure current is a table before accessing
        if !current.is_table() {
            *current = toml::Value::Table(toml::map::Map::new());
        }

        // Get or create the nested table
        let table = current.as_table_mut().unwrap();
        if !table.contains_key(*key) {
            table.insert(key.to_string(), toml::Value::Table(toml::map::Map::new()));
        }
        current = table.get_mut(*key).unwrap();
    }

    // Set the final value
    if let Some(table) = current.as_table_mut() {
        table.insert(path[path.len() - 1].to_string(), value);
    }
}

fn set_toml_array(root: &mut toml::Value, path: &[&str], values: Vec<String>) {
    let array = toml::Value::Array(values.into_iter().map(toml::Value::String).collect());
    set_toml_value(root, path, array);
}

async fn perform_registration(
    binary_path: &Path,
    identity: &NodeIdentity,
    config_path: &Path,
    app_handle: &tauri::AppHandle,
    progress_map: &HashMap<String, u8>,
) -> Result<String, String> {
    crypto::register_node_with_network(
        app_handle.clone(),
        &binary_path.to_path_buf(),
        identity,
        &config_path.to_path_buf(),
    )
    .await
    .map(|_| "Node registered with network".to_string())
    .map_err(|e| {
        emit_failure(app_handle, progress_map, "register", &e);
        e
    })
}

async fn perform_sync(
    binary_path: &Path,
    config_path: &Path,
    app_handle: &tauri::AppHandle,
    progress_map: &HashMap<String, u8>,
) -> Result<String, String> {
    crypto::connect_and_sync(
        app_handle.clone(),
        &binary_path.to_path_buf(),
        &config_path.to_path_buf(),
    )
    .await
    .map(|_| "Node synced with devnet".to_string())
    .map_err(|e| {
        emit_failure(app_handle, progress_map, "sync", &e);
        e
    })
}

async fn ensure_node_running(
    node_id: &str,
    manager: &State<'_, Arc<Mutex<MultiNodeManager>>>,
    process_manager: &State<'_, Arc<Mutex<ProcessManager>>>,
    binary_path: &Path,
    env_config: &EnvConfig,
    progress_map: &HashMap<String, u8>,
    app_handle: &tauri::AppHandle,
) -> Result<String, String> {
    let node = {
        let mgr = manager.lock().await;
        mgr.get_node(node_id)
            .cloned()
            .ok_or_else(|| format!("Node not found: {}", node_id))?
    };

    if node.is_running {
        return Ok("Node already running".to_string());
    }

    let mut cmd = Command::new(binary_path);
    // Subcommand must come BEFORE options
    cmd.arg("start")
        .arg("--config")
        .arg(&node.config_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(&node.sandbox_path);

    let child = cmd.spawn().map_err(|e| {
        emit_failure(app_handle, progress_map, "complete", &e.to_string());
        format!("Failed to start node: {}", e)
    })?;

    let pid = child
        .id()
        .ok_or_else(|| "Failed to get process ID".to_string())?;

    {
        let mut pm = process_manager.lock().await;
        pm.processes.insert(node_id.to_string(), child);
    }

    {
        let mut mgr = manager.lock().await;
        if let Some(node_mut) = mgr.get_node_mut(node_id) {
            node_mut.is_running = true;
            node_mut.pid = Some(pid);
            node_mut.started_at = Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            );
        }
        mgr.save()?;
    }

    let addr = {
        let port_from_config = fs::read_to_string(&node.config_path)
            .ok()
            .and_then(|content| content.parse::<toml::Value>().ok())
            .and_then(|value| {
                value
                    .get("rpc")
                    .and_then(|rpc| rpc.get("http_port"))
                    .and_then(|v| v.as_integer())
            })
            .and_then(|v| u16::try_from(v).ok());
        format!(
            "127.0.0.1:{}",
            port_from_config.unwrap_or(env_config.default_rpc_port)
        )
    };
    let timeout = std::time::Duration::from_secs(15);
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if let Ok(_) = tokio::net::TcpStream::connect(addr.clone()).await {
            return Ok(format!("Node started (pid {}) and RPC is reachable", pid));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    emit_failure(
        app_handle,
        progress_map,
        "complete",
        "RPC port did not open in time",
    );
    Err("Node started but RPC port did not open in time".to_string())
}

#[tauri::command]
pub async fn get_all_nodes(
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<Vec<NodeInstance>, String> {
    let mgr = manager.lock().await;
    Ok(mgr.list_nodes().into_iter().cloned().collect())
}

#[tauri::command]
pub async fn get_node_by_id(
    node_id: String,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<NodeInstance, String> {
    let mgr = manager.lock().await;
    mgr.get_node(&node_id)
        .cloned()
        .ok_or_else(|| format!("Node not found: {}", node_id))
}

#[tauri::command]
pub async fn remove_node(
    node_id: String,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<(), String> {
    let mut mgr = manager.lock().await;
    mgr.remove_node(&node_id)
}

fn copy_template_for_node(
    node: &NodeInstance,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;

    // Get the template file name
    let template_name = node.node_type.template_file();

    // Try multiple locations for templates
    let mut template_paths = vec![];

    // 1. Try resource directory (for bundled app)
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        // Packaged desktop builds bundle ../templates as _up_/templates
        template_paths.push(
            resource_dir
                .join("_up_")
                .join("templates")
                .join(&template_name),
        );
        // Also try without _up_ (for AppImage and other formats)
        template_paths.push(resource_dir.join("templates").join(&template_name));
    }

    // 2. Try project root (for development)
    if let Ok(current_dir) = std::env::current_dir() {
        template_paths.push(current_dir.join("templates").join(&template_name));
        template_paths.push(
            current_dir
                .join("..")
                .join("templates")
                .join(&template_name),
        );
    }

    // 3. Try relative to executable
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            template_paths.push(exe_dir.join("templates").join(&template_name));
            template_paths.push(exe_dir.join("..").join("templates").join(&template_name));
            template_paths.push(exe_dir.join("../..").join("templates").join(&template_name));
        }
    }

    // Find first existing template
    let source_path = template_paths.iter().find(|p| p.exists()).ok_or_else(|| {
        format!(
            "Template file not found: {}. Searched paths: {:?}",
            template_name, template_paths
        )
    })?;

    // Copy the template
    fs::copy(source_path, &node.config_path)
        .map_err(|e| format!("Failed to copy template: {}", e))?;

    // Customize the template
    customize_node_config(node)?;

    Ok(())
}

fn customize_node_config(node: &NodeInstance) -> Result<(), String> {
    let config_content = fs::read_to_string(&node.config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    // Replace placeholders in the config
    let customized = config_content
        .replace("<auto>", &node.id)
        .replace("./sandbox", &node.sandbox_path.to_string_lossy())
        .replace("./logs", &node.logs_path.to_string_lossy())
        .replace("./data", &node.data_path.to_string_lossy());

    let mut config_value: toml::Value = customized
        .parse()
        .map_err(|e: toml::de::Error| format!("Failed to parse customized config: {}", e))?;

    let document = config_value
        .as_table_mut()
        .ok_or_else(|| "Customized config did not parse as a TOML table".to_string())?;

    let identity = document
        .entry("identity")
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
        .as_table_mut()
        .ok_or_else(|| "identity section is not a TOML table".to_string())?;
    identity.insert(
        "node_id".to_string(),
        toml::Value::String(node.id.clone()),
    );
    identity.insert(
        "role".to_string(),
        toml::Value::String(node.node_type.as_str().to_string()),
    );
    identity.insert(
        "label".to_string(),
        toml::Value::String(node.display_name.clone()),
    );

    let role = document
        .entry("role")
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
        .as_table_mut()
        .ok_or_else(|| "role section is not a TOML table".to_string())?;
    role.insert(
        "compiled_profile".to_string(),
        toml::Value::String(node.node_type.compiled_profile().to_string()),
    );

    let serialized = toml::to_string_pretty(&config_value)
        .map_err(|e| format!("Failed to serialize customized config: {}", e))?;

    fs::write(&node.config_path, serialized)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

// ============================================================================
// Network Discovery Commands
// ============================================================================

use crate::node_manager::network_discovery::{NetworkDiscovery, NetworkStatus};
use once_cell::sync::Lazy;

/// Global network discovery instance
static NETWORK_DISCOVERY: Lazy<Arc<Mutex<Option<NetworkDiscovery>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

/// Initialize network discovery with configuration from environment
#[tauri::command]
pub async fn init_network_discovery(app_handle: tauri::AppHandle) -> Result<(), String> {
    let env_config = EnvConfig::load(Some(&app_handle))?;

    let discovery = NetworkDiscovery::new(
        env_config.bootstrap_nodes.clone(),
        env_config.rpc_endpoint.clone(),
    );

    let mut global = NETWORK_DISCOVERY.lock().await;
    *global = Some(discovery);

    Ok(())
}

/// Get current network status and discovered peers
#[tauri::command]
pub async fn get_network_peers(app_handle: tauri::AppHandle) -> Result<NetworkStatus, String> {
    // Initialize if not already done
    {
        let global = NETWORK_DISCOVERY.lock().await;
        if global.is_none() {
            drop(global);
            init_network_discovery(app_handle.clone()).await?;
        }
    }

    let global = NETWORK_DISCOVERY.lock().await;
    match global.as_ref() {
        Some(discovery) => discovery.get_network_status().await,
        None => Err("Network discovery not initialized".to_string()),
    }
}

/// Force refresh network peer discovery
#[tauri::command]
pub async fn refresh_network_peers(app_handle: tauri::AppHandle) -> Result<NetworkStatus, String> {
    // Initialize if not already done
    {
        let global = NETWORK_DISCOVERY.lock().await;
        if global.is_none() {
            drop(global);
            init_network_discovery(app_handle.clone()).await?;
        }
    }

    let global = NETWORK_DISCOVERY.lock().await;
    match global.as_ref() {
        Some(discovery) => discovery.discover_peers().await,
        None => Err("Network discovery not initialized".to_string()),
    }
}

/// Get balance for a node by its ID
#[tauri::command]
pub async fn get_node_balance(
    node_id: String,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // Get node address and config path
    let (address, config_path) = {
        let mgr = manager.lock().await;
        let node = mgr.get_node(&node_id).ok_or("Node not found")?;
        (
            node.address.clone().unwrap_or_default(),
            node.config_path.clone(),
        )
    };

    if address.is_empty() {
        return Ok("N/A".to_string());
    }

    // Load config to get RPC endpoint
    let env_config = EnvConfig::load(Some(&app_handle))?;

    // Read RPC port from node's config file
    let rpc_port = {
        let config_content = std::fs::read_to_string(&config_path).unwrap_or_default();
        // Parse the toml to get rpc_port from [network] section
        config_content
            .lines()
            .find(|line| line.trim().starts_with("rpc_port"))
            .and_then(|line| {
                line.split('=').nth(1).map(|v| {
                    v.trim()
                        .parse::<u16>()
                        .unwrap_or(env_config.default_rpc_port)
                })
            })
            .unwrap_or(env_config.default_rpc_port)
    };

    // Build the RPC request to get balance using Synergy-specific method
    // synergy_getTokenBalance takes [address, token_symbol]
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let rpc_request = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "synergy_getTokenBalance",
        "params": [address, "SNRG"],
        "id": 1
    });

    // Try local node first (more reliable), then fall back to remote RPC
    let local_rpc = format!("http://localhost:{}/rpc", rpc_port);
    let remote_rpc = env_config.rpc_endpoint.clone();
    let endpoints = vec![local_rpc, remote_rpc];

    for endpoint in endpoints {
        let response = client.post(&endpoint).json(&rpc_request).send().await;

        match response {
            Ok(resp) if resp.status().is_success() => {
                let body: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("Failed to parse balance response: {}", e))?;

                // Check for "Unknown method" response - method not implemented yet
                if let Some(result) = body.get("result") {
                    if result.as_str() == Some("Unknown method") {
                        // Method not implemented - return N/A
                        return Ok("N/A".to_string());
                    }
                }

                // Check for RPC error in response
                if let Some(_error) = body.get("error") {
                    continue; // Try next endpoint
                }

                // Get balance from result - could be string or number
                // Balance is returned in nWei (1 SNRG = 1,000,000,000 nWei)
                let balance = body
                    .get("result")
                    .and_then(|r| {
                        if let Some(s) = r.as_str() {
                            // Parse hex string like "0x1234"
                            if s.starts_with("0x") {
                                u64::from_str_radix(&s[2..], 16).ok()
                            } else {
                                s.parse::<u64>().ok()
                            }
                        } else {
                            r.as_u64()
                        }
                    })
                    .unwrap_or(0);

                // Convert from nWei to SNRG (1 SNRG = 1,000,000,000 nWei = 10^9)
                let snrg_balance = balance as f64 / 1_000_000_000.0;
                return Ok(format!("{:.4}", snrg_balance));
            }
            _ => continue, // Try next endpoint
        }
    }

    // If all endpoints failed, return N/A (balance query not available)
    Ok("N/A".to_string())
}
