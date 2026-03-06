use crate::node_manager::commands::{setup_node, NodeSetupOptions, SetupProgress};
use crate::node_manager::multi_node::MultiNodeManager;
use crate::node_manager::multi_node_process::ProcessManager;
use crate::recipe::load_and_validate;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// Tauri command implementing deterministic, recipe-driven node setup.
/// Parses and validates the provided YAML recipe and delegates to the
/// existing node setup logic while emitting real progress events.
#[tauri::command]
pub async fn agent_setup_node(
    recipe_path: String,
    display_name: Option<String>,
    setup_options: Option<NodeSetupOptions>,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
    process_manager: State<'_, Arc<Mutex<ProcessManager>>>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let (recipe, node_type) = load_and_validate(&recipe_path, &app_handle)?;

    // Emit a real progress event acknowledging recipe validation
    let _ = app_handle.emit(
        "setup-progress",
        SetupProgress {
            step: "recipe".to_string(),
            message: format!(
                "Validated {} recipe for {} role",
                node_type.display_name(),
                recipe.role.trim()
            ),
            progress: 0,
        },
    );

    let node_type_arg = node_type.as_str().to_string();
    let display_name = display_name.or_else(|| Some(recipe.role.trim().to_string()));

    setup_node(
        node_type_arg,
        display_name,
        setup_options,
        manager,
        process_manager,
        app_handle,
    )
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JarvisInventoryMachine {
    pub node_slot_id: String,
    pub node_alias: String,
    pub role_group: String,
    pub role: String,
    pub node_type: String,
    pub host: String,
    pub vpn_ip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JarvisMachineConnectionInput {
    #[serde(alias = "machine_id")]
    pub node_slot_id: String,
    pub host: String,
    pub ssh_user: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_key_path: Option<String>,
    pub remote_dir: Option<String>,
    pub wg_interface: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JarvisPrepareHostsEnvInput {
    pub global_ssh_user: Option<String>,
    pub global_ssh_port: Option<u16>,
    pub global_ssh_key_path: Option<String>,
    pub atlas_base_url: Option<String>,
    pub machines: Vec<JarvisMachineConnectionInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JarvisCommandResult {
    pub success: bool,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub fn agent_monitor_initialize_workspace(app_handle: AppHandle) -> Result<String, String> {
    let workspace = crate::monitor::ensure_monitor_workspace(&app_handle)?;
    Ok(workspace.to_string_lossy().to_string())
}

#[tauri::command]
pub fn agent_get_inventory_machines() -> Result<Vec<JarvisInventoryMachine>, String> {
    let inventory_path = PathBuf::from(crate::monitor::get_monitor_inventory_path()?);
    parse_inventory_machines(&inventory_path)
}

#[tauri::command]
pub fn agent_prepare_hosts_env(
    input: JarvisPrepareHostsEnvInput,
    app_handle: AppHandle,
) -> Result<String, String> {
    let workspace = crate::monitor::ensure_monitor_workspace(&app_handle)?;
    let hosts_env_path = workspace.join("devnet/lean15/hosts.env");
    ensure_hosts_env_exists(&workspace, &hosts_env_path)?;

    let mut updates = BTreeMap::<String, String>::new();

    if let Some(user) = normalize_opt(&input.global_ssh_user) {
        updates.insert("SYNERGY_DEVNET_SSH_USER".to_string(), user);
    }
    if let Some(port) = input.global_ssh_port {
        updates.insert("SYNERGY_DEVNET_SSH_PORT".to_string(), port.to_string());
    }
    if let Some(key_path) = normalize_opt(&input.global_ssh_key_path) {
        updates.insert("SYNERGY_DEVNET_SSH_KEY".to_string(), key_path);
    }
    if let Some(atlas) = normalize_opt(&input.atlas_base_url) {
        updates.insert("ATLAS_BASE_URL".to_string(), atlas);
    }

    for machine in input.machines {
        let node_slot_id = machine.node_slot_id.trim().to_string();
        if node_slot_id.is_empty() {
            return Err("node_slot_id is required for each machine entry".to_string());
        }
        let host = machine.host.trim().to_string();
        if host.is_empty() {
            return Err(format!("host is required for machine '{node_slot_id}'"));
        }

        let machine_key = node_slot_id.to_ascii_uppercase().replace('-', "_");
        updates.insert(format!("{machine_key}_HOST"), host);

        if let Some(value) = normalize_opt(&machine.ssh_user) {
            updates.insert(format!("{machine_key}_SSH_USER"), value);
        }
        if let Some(value) = machine.ssh_port {
            updates.insert(format!("{machine_key}_SSH_PORT"), value.to_string());
        }
        if let Some(value) = normalize_opt(&machine.ssh_key_path) {
            updates.insert(format!("{machine_key}_SSH_KEY"), value);
        }
        if let Some(value) = normalize_opt(&machine.remote_dir) {
            updates.insert(format!("{machine_key}_REMOTE_DIR"), value);
        }
        if let Some(value) = normalize_opt(&machine.wg_interface) {
            updates.insert(format!("{machine_key}_WG_INTERFACE"), value);
        }
    }

    let ordered_updates = updates
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    upsert_env_values(&hosts_env_path, &ordered_updates)?;
    Ok(hosts_env_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn agent_generate_wireguard_mesh(app_handle: AppHandle) -> Result<JarvisCommandResult, String> {
    let workspace = crate::monitor::ensure_monitor_workspace(&app_handle)?;
    let script_path = workspace.join("scripts/devnet15/generate-wireguard-mesh.sh");
    let output_dir = workspace.join("devnet/lean15/wireguard");
    let hosts_env = workspace.join("devnet/lean15/hosts.env");

    if !script_path.is_file() {
        return Err(format!(
            "WireGuard mesh generator script missing at {}",
            script_path.display()
        ));
    }

    fs::create_dir_all(&output_dir).map_err(|error| {
        format!(
            "Failed to create WireGuard output directory {}: {error}",
            output_dir.display()
        )
    })?;

    let command = format!(
        "SYNERGY_MONITOR_HOSTS_ENV={} bash {} {}",
        shell_quote(hosts_env.to_string_lossy().as_ref()),
        shell_quote(script_path.to_string_lossy().as_ref()),
        shell_quote(output_dir.to_string_lossy().as_ref())
    );

    let output = ProcessCommand::new("bash")
        .arg(script_path.to_string_lossy().to_string())
        .arg(output_dir.to_string_lossy().to_string())
        .env(
            "SYNERGY_MONITOR_HOSTS_ENV",
            hosts_env.to_string_lossy().to_string(),
        )
        .output()
        .map_err(|error| format!("Failed to run WireGuard mesh generator: {error}"))?;

    Ok(JarvisCommandResult {
        success: output.status.success(),
        command,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn normalize_opt(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn ensure_hosts_env_exists(workspace: &Path, hosts_env_path: &Path) -> Result<(), String> {
    if hosts_env_path.is_file() {
        return Ok(());
    }

    let example = workspace.join("devnet/lean15/hosts.env.example");
    if !example.is_file() {
        return Err(format!(
            "hosts.env not found and no example available at {}",
            example.display()
        ));
    }

    if let Some(parent) = hosts_env_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create hosts.env parent directory {}: {error}",
                parent.display()
            )
        })?;
    }

    fs::copy(&example, hosts_env_path).map_err(|error| {
        format!(
            "Failed to copy {} to {}: {error}",
            example.display(),
            hosts_env_path.display()
        )
    })?;

    Ok(())
}

fn upsert_env_values(path: &Path, updates: &[(&str, &str)]) -> Result<(), String> {
    let existing = if path.is_file() {
        fs::read_to_string(path)
            .map_err(|error| format!("Failed to read hosts env {}: {error}", path.display()))?
    } else {
        String::new()
    };

    let mut lines = existing
        .lines()
        .map(|line| line.to_string())
        .collect::<Vec<String>>();
    let mut index = HashMap::<String, usize>::new();

    for (idx, raw_line) in lines.iter().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let normalized = line.strip_prefix("export ").unwrap_or(line).trim();
        if let Some((key, _)) = normalized.split_once('=') {
            let key = key.trim();
            if !key.is_empty() {
                index.insert(key.to_string(), idx);
            }
        }
    }

    for (key, value) in updates {
        let rendered = format!("{key}={}", format_env_value(value));
        if let Some(existing_idx) = index.get(*key) {
            lines[*existing_idx] = rendered;
        } else {
            lines.push(rendered);
        }
    }

    let mut serialized = lines.join("\n");
    if !serialized.ends_with('\n') {
        serialized.push('\n');
    }

    fs::write(path, serialized)
        .map_err(|error| format!("Failed to write hosts env {}: {error}", path.display()))?;
    Ok(())
}

fn format_env_value(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':' | '@'))
    {
        value.to_string()
    } else {
        shell_quote(value)
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn parse_inventory_machines(path: &Path) -> Result<Vec<JarvisInventoryMachine>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read inventory {}: {error}", path.display()))?;
    let mut lines = content.lines();
    let header = lines
        .next()
        .ok_or_else(|| format!("Inventory file is empty: {}", path.display()))?;
    let headers = header
        .split(',')
        .map(|value| value.trim().to_string())
        .collect::<Vec<_>>();

    let column = |aliases: &[&str], label: &str| -> Result<usize, String> {
        aliases
            .iter()
            .find_map(|name| {
                headers
                    .iter()
                    .position(|header| header.eq_ignore_ascii_case(name))
            })
            .ok_or_else(|| format!("Inventory column '{label}' is missing"))
    };

    let node_slot_idx = column(&["node_slot_id", "machine_id"], "node_slot_id")?;
    let node_alias_idx = column(&["node_alias", "node_id"], "node_alias")?;
    let role_group_idx = column(&["role_group"], "role_group")?;
    let role_idx = column(&["role"], "role")?;
    let node_type_idx = column(&["node_type"], "node_type")?;
    let host_idx = column(&["host"], "host")?;
    let vpn_ip_idx = column(&["vpn_ip"], "vpn_ip")?;

    let mut output = Vec::new();
    for raw_line in lines {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let values = raw_line
            .split(',')
            .map(|value| value.trim().trim_end_matches('\r').to_string())
            .collect::<Vec<_>>();
        let get = |index: usize| -> String { values.get(index).cloned().unwrap_or_default() };
        let node_slot_id = get(node_slot_idx);
        if node_slot_id.is_empty() {
            continue;
        }
        output.push(JarvisInventoryMachine {
            node_slot_id,
            node_alias: get(node_alias_idx),
            role_group: get(role_group_idx),
            role: get(role_idx),
            node_type: get(node_type_idx),
            host: get(host_idx),
            vpn_ip: get(vpn_ip_idx),
        });
    }

    if output.is_empty() {
        return Err(format!(
            "No inventory rows loaded from {}",
            path.to_string_lossy()
        ));
    }

    Ok(output)
}
