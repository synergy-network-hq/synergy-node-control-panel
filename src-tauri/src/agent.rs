use crate::devnet_agent_service::DEVNET_AGENT_PORT;
use crate::app_context::AppContext;
use crate::node_manager::commands::{setup_node, NodeSetupOptions, SetupProgress};
use crate::node_manager::multi_node::MultiNodeManager;
use crate::node_manager::multi_node_process::ProcessManager;
use crate::recipe::load_and_validate;
use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::fs::OpenOptions;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

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
    pub physical_machine_id: String,
    pub node_slot_id: String,
    pub node_alias: String,
    pub role_group: String,
    pub role: String,
    pub node_type: String,
    pub host: String,
    pub vpn_ip: String,
    pub operator: String,
    pub device: String,
    pub operating_system: String,
    pub public_ip: String,
    pub local_ip: String,
    pub p2p_port: u16,
    pub rpc_port: u16,
    pub ws_port: u16,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JarvisPrepareHostsEnvInput {
    pub global_ssh_user: Option<String>,
    pub global_ssh_port: Option<u16>,
    pub global_ssh_key_path: Option<String>,
    pub atlas_base_url: Option<String>,
    pub machines: Vec<JarvisMachineConnectionInput>,
}

#[tauri::command]
pub fn agent_monitor_initialize_workspace(app_handle: AppHandle) -> Result<String, String> {
    let workspace = crate::monitor::ensure_monitor_workspace(&app_handle)?;
    Ok(workspace.to_string_lossy().to_string())
}

pub fn agent_monitor_initialize_workspace_from_context(
    app_context: &AppContext,
) -> Result<String, String> {
    let workspace = crate::monitor::ensure_monitor_workspace_with_context(app_context)?;
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
    let app_context = AppContext::from_tauri(&app_handle);
    let workspace = crate::monitor::ensure_monitor_workspace_with_context(&app_context)?;
    prepare_hosts_env_in_workspace(&workspace, input)
}

pub fn agent_prepare_hosts_env_from_context(
    input: JarvisPrepareHostsEnvInput,
    app_context: &AppContext,
) -> Result<String, String> {
    let workspace = crate::monitor::ensure_monitor_workspace_with_context(app_context)?;
    prepare_hosts_env_in_workspace(&workspace, input)
}

fn prepare_hosts_env_in_workspace(
    workspace: &Path,
    input: JarvisPrepareHostsEnvInput,
) -> Result<String, String> {
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
    }

    let ordered_updates = updates
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    upsert_env_values(&hosts_env_path, &ordered_updates)?;
    Ok(hosts_env_path.to_string_lossy().to_string())
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
    let physical_machine_idx = column(
        &["physical_machine_id", "physical_machine"],
        "physical_machine_id",
    )?;
    let operator_idx = column(&["operator"], "operator")?;
    let device_idx = column(&["device"], "device")?;
    let operating_system_idx = column(&["operating_system"], "operating_system")?;
    let public_ip_idx = column(&["public_ip"], "public_ip")?;
    let local_ip_idx = column(&["local_ip"], "local_ip")?;
    let p2p_port_idx = column(&["p2p_port"], "p2p_port")?;
    let rpc_port_idx = column(&["rpc_port"], "rpc_port")?;
    let ws_port_idx = column(&["ws_port"], "ws_port")?;

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
        let p2p_port = get(p2p_port_idx).parse::<u16>().map_err(|error| {
            format!(
                "Invalid p2p_port for {} in {}: {error}",
                node_slot_id,
                path.display()
            )
        })?;
        let rpc_port = get(rpc_port_idx).parse::<u16>().map_err(|error| {
            format!(
                "Invalid rpc_port for {} in {}: {error}",
                node_slot_id,
                path.display()
            )
        })?;
        let ws_port = get(ws_port_idx).parse::<u16>().map_err(|error| {
            format!(
                "Invalid ws_port for {} in {}: {error}",
                node_slot_id,
                path.display()
            )
        })?;
        output.push(JarvisInventoryMachine {
            physical_machine_id: get(physical_machine_idx),
            node_slot_id,
            node_alias: get(node_alias_idx),
            role_group: get(role_group_idx),
            role: get(role_idx),
            node_type: get(node_type_idx),
            host: get(host_idx),
            vpn_ip: get(vpn_ip_idx),
            operator: get(operator_idx),
            device: get(device_idx),
            operating_system: get(operating_system_idx),
            public_ip: get(public_ip_idx),
            local_ip: get(local_ip_idx),
            p2p_port,
            rpc_port,
            ws_port,
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

pub async fn ensure_local_devnet_agent(app_handle: AppHandle) -> Result<(), String> {
    let workspace_root = crate::monitor::ensure_monitor_workspace(&app_handle)?;
    ensure_local_devnet_agent_in_workspace(&workspace_root).await
}

pub async fn ensure_local_devnet_agent_from_context(app_context: &AppContext) -> Result<(), String> {
    let workspace_root = crate::monitor::ensure_monitor_workspace_with_context(app_context)?;
    ensure_local_devnet_agent_in_workspace(&workspace_root).await
}

pub async fn ensure_local_devnet_agent_in_workspace(workspace_root: &Path) -> Result<(), String> {
    if local_agent_running().await {
        return Ok(());
    }

    let binary_source = resolve_agent_resource_binary(&workspace_root)?;
    let installed_binary = install_agent_binary(&workspace_root, &binary_source)?;

    if !local_agent_port_available() {
        kill_local_agent_processes(&workspace_root);
        std::thread::sleep(std::time::Duration::from_millis(300));
        if !local_agent_port_available() && !local_agent_running().await {
            return Err(format!(
                "Port {DEVNET_AGENT_PORT} is already occupied by a non-agent process. Free the port before starting the local devnet agent."
            ));
        }
    }

    let autostart_ok = match install_agent_autostart(&workspace_root, &installed_binary) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("devnet agent autostart warning: {error}");
            false
        }
    };

    #[cfg(target_os = "windows")]
    {
        spawn_local_agent(&workspace_root, &installed_binary)?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        if !autostart_ok {
            spawn_local_agent(&workspace_root, &installed_binary)?;
        }
    }

    if wait_for_local_agent(20, 250).await {
        return Ok(());
    }

    Err("Local devnet agent did not become healthy after startup".to_string())
}

pub async fn force_update_local_devnet_agent(app_handle: AppHandle) -> Result<PathBuf, String> {
    let workspace_root = crate::monitor::ensure_monitor_workspace(&app_handle)?;
    force_update_local_devnet_agent_in_workspace(&workspace_root).await
}

pub async fn force_update_local_devnet_agent_from_context(
    app_context: &AppContext,
) -> Result<PathBuf, String> {
    let workspace_root = crate::monitor::ensure_monitor_workspace_with_context(app_context)?;
    force_update_local_devnet_agent_in_workspace(&workspace_root).await
}

pub async fn force_update_local_devnet_agent_in_workspace(
    workspace_root: &Path,
) -> Result<PathBuf, String> {
    let binary_source = resolve_agent_resource_binary(&workspace_root)?;
    let installed_binary = install_agent_binary(&workspace_root, &binary_source)?;

    let autostart_ok = match install_agent_autostart(&workspace_root, &installed_binary) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("devnet agent autostart warning during update: {error}");
            false
        }
    };

    restart_local_agent_runtime(&workspace_root, &installed_binary, autostart_ok)?;
    for _ in 0..20 {
        sleep(Duration::from_millis(250)).await;
        if local_agent_running().await {
            return Ok(installed_binary);
        }
    }

    Err("Local devnet agent did not become healthy after update".to_string())
}

async fn local_agent_running() -> bool {
    let client = Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .unwrap_or_else(|_| Client::new());
    client
        .get(format!("http://127.0.0.1:{DEVNET_AGENT_PORT}/health"))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

async fn wait_for_local_agent(attempts: usize, delay_ms: u64) -> bool {
    for _ in 0..attempts {
        if local_agent_running().await {
            return true;
        }
        sleep(Duration::from_millis(delay_ms)).await;
    }
    false
}

fn local_agent_port_available() -> bool {
    TcpListener::bind(("127.0.0.1", DEVNET_AGENT_PORT)).is_ok()
}

fn resolve_agent_resource_binary(workspace_root: &Path) -> Result<PathBuf, String> {
    let candidates = [
        workspace_root
            .join("binaries")
            .join(agent_resource_binary_name()?),
        workspace_root
            .join("agent")
            .join("bin")
            .join(agent_installed_binary_name()),
    ];

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            format!(
                "Bundled devnet agent binary not found. Expected {} in workspace resources.",
                agent_resource_binary_name().unwrap_or("synergy-devnet-agent".to_string())
            )
        })
}

fn install_agent_binary(workspace_root: &Path, source: &Path) -> Result<PathBuf, String> {
    let destination = workspace_root
        .join("agent")
        .join("bin")
        .join(agent_installed_binary_name());

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create devnet agent binary directory {}: {error}",
                parent.display()
            )
        })?;
    }

    copy_file_atomic(source, &destination).map_err(|error| {
        format!(
            "Failed to install devnet agent binary {} -> {}: {error}",
            source.display(),
            destination.display()
        )
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o755)).map_err(|error| {
            format!(
                "Failed to mark devnet agent binary executable {}: {error}",
                destination.display()
            )
        })?;
    }

    Ok(destination)
}

fn copy_file_atomic(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("devnet-agent");
    let temp_name = format!(
        ".{}.tmp-{}-{}",
        destination_name,
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let temp_path = destination.with_file_name(temp_name);

    let copy_result = (|| -> Result<(), std::io::Error> {
        fs::copy(source, &temp_path)?;
        match fs::rename(&temp_path, destination) {
            Ok(()) => Ok(()),
            Err(rename_error) => {
                #[cfg(target_os = "windows")]
                {
                    if destination.exists() {
                        let _ = fs::remove_file(destination);
                        if let Ok(()) = fs::rename(&temp_path, destination) {
                            return Ok(());
                        }
                    }
                }
                Err(rename_error)
            }
        }
    })();

    if copy_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    copy_result?;
    sync_unix_permissions_from_source(source, destination)?;
    Ok(())
}

fn spawn_local_agent(workspace_root: &Path, binary_path: &Path) -> Result<(), String> {
    let log_dir = workspace_root.join("agent").join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| {
        format!(
            "Failed to create devnet agent log directory {}: {error}",
            log_dir.display()
        )
    })?;

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("agent.out.log"))
        .map_err(|error| format!("Failed to open devnet agent stdout log: {error}"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("agent.err.log"))
        .map_err(|error| format!("Failed to open devnet agent stderr log: {error}"))?;

    let started_at = Utc::now().to_rfc3339();
    let startup_line = format!(
        "[{started_at}] local-agent-start workspace={} binary={} port={}\n",
        workspace_root.display(),
        binary_path.display(),
        DEVNET_AGENT_PORT
    );
    let _ = fs::write(log_dir.join("last-startup.txt"), startup_line.as_bytes());

    let mut command = ProcessCommand::new(binary_path);
    command
        .arg("serve")
        .arg("--workspace")
        .arg(workspace_root)
        .arg("--port")
        .arg(DEVNET_AGENT_PORT.to_string())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .stdin(Stdio::null())
        .current_dir(workspace_root);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    command
        .spawn()
        .map_err(|error| format!("Failed to spawn local devnet agent: {error}"))?;

    Ok(())
}

fn sync_unix_permissions_from_source(
    source: &Path,
    destination: &Path,
) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = fs::metadata(source)?.permissions().mode();
        fs::set_permissions(destination, fs::Permissions::from_mode(mode))?;
    }

    Ok(())
}

fn restart_local_agent_runtime(
    workspace_root: &Path,
    binary_path: &Path,
    autostart_ok: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        kill_local_agent_processes(workspace_root);
        return spawn_local_agent(workspace_root, binary_path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        if autostart_ok {
            return Ok(());
        }
        kill_local_agent_processes(workspace_root);
        spawn_local_agent(workspace_root, binary_path)
    }
}

fn kill_local_agent_processes(workspace_root: &Path) {
    let binary_path = workspace_root
        .join("agent")
        .join("bin")
        .join(agent_installed_binary_name());

    #[cfg(target_os = "windows")]
    {
        let _ = ProcessCommand::new("taskkill")
            .args(["/F", "/IM", "synergy-devnet-agent.exe"])
            .output();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = ProcessCommand::new("pkill")
            .args(["-f", binary_path.to_string_lossy().as_ref()])
            .output();
    }
}

fn install_agent_autostart(workspace_root: &Path, binary_path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        install_agent_launchd(workspace_root, binary_path)?;
    }
    #[cfg(target_os = "linux")]
    {
        install_agent_systemd_user(workspace_root, binary_path)?;
    }
    #[cfg(target_os = "windows")]
    {
        install_agent_windows_startup(workspace_root, binary_path)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_agent_launchd(workspace_root: &Path, binary_path: &Path) -> Result<(), String> {
    let launch_agents = dirs::home_dir()
        .ok_or_else(|| "Home directory not available for launchd agent".to_string())?
        .join("Library/LaunchAgents");
    fs::create_dir_all(&launch_agents).map_err(|error| {
        format!(
            "Failed to create launch agents directory {}: {error}",
            launch_agents.display()
        )
    })?;

    let plist_path = launch_agents.join("io.synergy.devnet.agent.plist");
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>io.synergy.devnet.agent</string>
    <key>ProgramArguments</key>
    <array>
      <string>{}</string>
      <string>serve</string>
      <string>--workspace</string>
      <string>{}</string>
      <string>--port</string>
      <string>{}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{}</string>
    <key>StandardErrorPath</key>
    <string>{}</string>
  </dict>
</plist>
"#,
        binary_path.display(),
        workspace_root.display(),
        DEVNET_AGENT_PORT,
        workspace_root.join("agent/logs/launchd.out.log").display(),
        workspace_root.join("agent/logs/launchd.err.log").display(),
    );
    fs::write(&plist_path, plist).map_err(|error| {
        format!(
            "Failed to write launchd plist {}: {error}",
            plist_path.display()
        )
    })?;

    let _ = ProcessCommand::new("launchctl")
        .args(["unload", plist_path.to_string_lossy().as_ref()])
        .output();
    let output = ProcessCommand::new("launchctl")
        .args(["load", "-w", plist_path.to_string_lossy().as_ref()])
        .output()
        .map_err(|error| format!("Failed to load launchd agent: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "launchctl load failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_agent_systemd_user(workspace_root: &Path, binary_path: &Path) -> Result<(), String> {
    let systemd_dir = dirs::home_dir()
        .ok_or_else(|| "Home directory not available for systemd user agent".to_string())?
        .join(".config/systemd/user");
    fs::create_dir_all(&systemd_dir).map_err(|error| {
        format!(
            "Failed to create systemd user directory {}: {error}",
            systemd_dir.display()
        )
    })?;

    let service_path = systemd_dir.join("synergy-devnet-agent.service");
    let service = format!(
        "[Unit]\nDescription=Synergy Devnet Agent\nAfter=network-online.target\n\n[Service]\nExecStart={} serve --workspace {} --port {}\nRestart=always\nRestartSec=2\nWorkingDirectory={}\n\n[Install]\nWantedBy=default.target\n",
        shell_argument(binary_path),
        shell_argument(workspace_root),
        DEVNET_AGENT_PORT,
        shell_argument(workspace_root),
    );
    fs::write(&service_path, service).map_err(|error| {
        format!(
            "Failed to write systemd user service {}: {error}",
            service_path.display()
        )
    })?;

    let reload = ProcessCommand::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()
        .map_err(|error| format!("Failed to reload systemd user daemon: {error}"))?;
    if !reload.status.success() {
        return Err(format!(
            "systemctl --user daemon-reload failed: {}",
            String::from_utf8_lossy(&reload.stderr).trim()
        ));
    }

    let enable = ProcessCommand::new("systemctl")
        .args(["--user", "enable", "synergy-devnet-agent.service"])
        .output()
        .map_err(|error| format!("Failed to enable systemd user agent: {error}"))?;
    if !enable.status.success() {
        return Err(format!(
            "systemctl --user enable failed: {}",
            String::from_utf8_lossy(&enable.stderr).trim()
        ));
    }

    let restart = ProcessCommand::new("systemctl")
        .args(["--user", "restart", "synergy-devnet-agent.service"])
        .output()
        .map_err(|error| format!("Failed to restart systemd user agent: {error}"))?;
    if !restart.status.success() {
        return Err(format!(
            "systemctl --user restart failed: {}",
            String::from_utf8_lossy(&restart.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_agent_windows_startup(workspace_root: &Path, binary_path: &Path) -> Result<(), String> {
    let startup_dir = dirs::config_dir()
        .ok_or_else(|| "Config directory not available for Windows startup agent".to_string())?
        .join("Microsoft/Windows/Start Menu/Programs/Startup");
    fs::create_dir_all(&startup_dir).map_err(|error| {
        format!(
            "Failed to create Windows startup directory {}: {error}",
            startup_dir.display()
        )
    })?;

    let startup_cmd = startup_dir.join("Synergy Devnet Agent.cmd");
    let log_dir = workspace_root.join("agent").join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| {
        format!(
            "Failed to create Windows agent log directory {}: {error}",
            log_dir.display()
        )
    })?;
    let command = format!(
        "@echo off\r\nstart \"\" /B \"{}\" serve --workspace \"{}\" --port {} 1>>\"{}\" 2>>\"{}\"\r\n",
        binary_path.display(),
        workspace_root.display(),
        DEVNET_AGENT_PORT,
        log_dir.join("startup.out.log").display(),
        log_dir.join("startup.err.log").display()
    );
    fs::write(&startup_cmd, command).map_err(|error| {
        format!(
            "Failed to write Windows startup command {}: {error}",
            startup_cmd.display()
        )
    })?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn shell_argument(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}

fn agent_installed_binary_name() -> String {
    if cfg!(target_os = "windows") {
        "synergy-devnet-agent.exe".to_string()
    } else {
        "synergy-devnet-agent".to_string()
    }
}

fn agent_resource_binary_name() -> Result<String, String> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok("synergy-devnet-agent-darwin-arm64".to_string())
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Ok("synergy-devnet-agent-linux-amd64".to_string())
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok("synergy-devnet-agent-windows-amd64.exe".to_string())
    } else {
        Err("Unsupported platform for bundled devnet agent binary".to_string())
    }
}
