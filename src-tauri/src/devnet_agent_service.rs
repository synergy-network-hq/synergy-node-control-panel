use axum::{
    extract::{ConnectInfo, Path as AxumPath, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use uuid::Uuid;

pub const DEVNET_AGENT_PORT: u16 = 47_990;
const DEFAULT_REMOTE_ROOT_UNIX: &str = "/opt/synergy";
const DEFAULT_REMOTE_ROOT_WINDOWS: &str = "C:\\Synergy\\Devnet";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevnetAgentHealth {
    pub status: String,
    pub version: String,
    pub workspace_path: String,
    pub local_vpn_ip: Option<String>,
    pub physical_machine_id: Option<String>,
    pub node_slot_ids: Vec<String>,
    pub supported_actions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevnetAgentControlRequest {
    pub node_slot_id: String,
    pub action: String,
    #[serde(default)]
    pub target_reason: Option<String>,
    #[serde(default)]
    pub target_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevnetAgentControlResponse {
    pub node_slot_id: String,
    pub action: String,
    pub success: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub transport: String,
    pub executed_at_utc: String,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub process_alive: Option<bool>,
}

#[derive(Debug, Clone)]
struct AgentState {
    workspace_root: PathBuf,
    jobs: Arc<Mutex<HashMap<String, DevnetAgentControlResponse>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InventoryNode {
    node_slot_id: String,
    host: String,
    vpn_ip: String,
    physical_machine_id: String,
}

#[derive(Debug, Clone)]
struct NodeInstall {
    node_slot_id: String,
    install_dir: PathBuf,
}

pub async fn serve(workspace_root: PathBuf, port: u16) -> Result<(), String> {
    serve_with_host(workspace_root, port, None).await
}

pub async fn serve_with_host(
    workspace_root: PathBuf,
    port: u16,
    host: Option<String>,
) -> Result<(), String> {
    eprintln!(
        "[{}] devnet-agent starting workspace={} port={} host={}",
        Utc::now().to_rfc3339(),
        workspace_root.display(),
        port,
        host.as_deref().unwrap_or("0.0.0.0")
    );
    let state = AgentState {
        workspace_root,
        jobs: Arc::new(Mutex::new(HashMap::new())),
    };
    let router = Router::new()
        .route("/health", get(health_handler))
        .route("/v1/control", post(control_handler))
        .route("/v1/control/jobs/{job_id}", get(control_job_handler))
        .with_state(state);

    let mut listeners = Vec::new();
    for bind_addr in bind_addresses_for_host(host.as_deref(), port) {
        match tokio::net::TcpListener::bind(bind_addr).await {
            Ok(listener) => listeners.push((bind_addr, listener)),
            Err(error) if bind_addr.ip().is_loopback() || bind_addr.ip().is_unspecified() => {
                return Err(format!(
                    "Failed to bind devnet agent on {bind_addr}: {error}"
                ));
            }
            Err(error) => {
                eprintln!("devnet agent optional bind skipped on {bind_addr}: {error}");
            }
        }
    }

    if listeners.is_empty() {
        return Err("Failed to bind devnet agent on loopback or VPN interface".to_string());
    }

    let mut servers = JoinSet::new();
    for (bind_addr, listener) in listeners {
        let service = router
            .clone()
            .into_make_service_with_connect_info::<SocketAddr>();
        servers.spawn(async move {
            axum::serve(listener, service)
                .await
                .map_err(|error| format!("Devnet agent server error on {bind_addr}: {error}"))
        });
    }

    while let Some(result) = servers.join_next().await {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(error),
            Err(error) => return Err(format!("Devnet agent server task panicked: {error}")),
        }
    }

    Ok(())
}

fn bind_addresses(port: u16) -> Vec<SocketAddr> {
    bind_addresses_for_host(None, port)
}

fn bind_addresses_for_host(host: Option<&str>, port: u16) -> Vec<SocketAddr> {
    if let Some(host) = host {
        // Explicit host override via --host flag
        if let Ok(ip) = host.parse::<Ipv4Addr>() {
            return vec![SocketAddr::from((ip, port))];
        }
        eprintln!("devnet agent: invalid --host value '{host}', falling back to 0.0.0.0");
    }
    // Default: bind on all interfaces so the agent is reachable via VPN, localhost, and
    // any other network interface. Previously used loopback + runtime VPN detection, but
    // that was unreliable under macOS launchd where ip/ifconfig may not surface the
    // WireGuard interface at agent startup time.
    vec![SocketAddr::from(([0, 0, 0, 0], port))]
}

fn supported_agent_actions() -> Vec<String> {
    [
        "start",
        "stop",
        "restart",
        "status",
        "setup",
        "setup_node",
        "install_node",
        "bootstrap_node",
        "reset_chain",
        "explorer_reset",
        "node_logs",
        "logs",
        "sync_node",
    ]
    .iter()
    .map(|entry| entry.to_string())
    .collect()
}

fn should_run_as_job(action: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        matches!(
            action,
            "start" | "restart" | "setup" | "setup_node" | "install_node" | "bootstrap_node"
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = action;
        false
    }
}

async fn health_handler(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<AgentState>,
) -> impl IntoResponse {
    if !is_allowed_remote(remote_addr.ip()) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "agent access restricted to WireGuard peers" })),
        )
            .into_response();
    }

    match build_health(&state.workspace_root) {
        Ok(payload) => (
            StatusCode::OK,
            Json(serde_json::to_value(payload).unwrap_or_default()),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

async fn control_handler(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<AgentState>,
    Json(input): Json<DevnetAgentControlRequest>,
) -> impl IntoResponse {
    if !is_allowed_remote(remote_addr.ip()) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "agent access restricted to WireGuard peers" })),
        )
            .into_response();
    }

    let normalized_action = normalize_action(&input.action);
    eprintln!(
        "[{}] devnet-agent control node={} action={} remote={}",
        Utc::now().to_rfc3339(),
        input.node_slot_id.trim(),
        normalized_action,
        remote_addr
    );
    if should_run_as_job(&normalized_action) {
        let job_id = Uuid::new_v4().to_string();
        let queued = DevnetAgentControlResponse {
            node_slot_id: input.node_slot_id.trim().to_string(),
            action: normalized_action.clone(),
            success: false,
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            transport: "wireguard-agent".to_string(),
            executed_at_utc: Utc::now().to_rfc3339(),
            phase: Some("queued".to_string()),
            job_id: Some(job_id.clone()),
            process_alive: None,
        };

        {
            let mut jobs = state.jobs.lock().await;
            jobs.insert(job_id.clone(), queued.clone());
        }

        let workspace_root = state.workspace_root.clone();
        let jobs = state.jobs.clone();
        let queued_for_job = queued.clone();
        let job_id_for_task = job_id.clone();
        tokio::spawn(async move {
            {
                let mut map = jobs.lock().await;
                if let Some(entry) = map.get_mut(&job_id_for_task) {
                    entry.phase = Some("running".to_string());
                }
            }

            let job_result =
                tokio::task::spawn_blocking(move || execute_control(&workspace_root, input)).await;
            let final_response = match job_result {
                Ok(Ok(mut outcome)) => {
                    outcome.job_id = Some(job_id_for_task.clone());
                    outcome
                }
                Ok(Err(error)) => DevnetAgentControlResponse {
                    node_slot_id: queued_for_job.node_slot_id.clone(),
                    action: queued_for_job.action.clone(),
                    success: false,
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: error,
                    transport: "wireguard-agent".to_string(),
                    executed_at_utc: Utc::now().to_rfc3339(),
                    phase: Some("failed".to_string()),
                    job_id: Some(job_id_for_task.clone()),
                    process_alive: None,
                },
                Err(join_error) => DevnetAgentControlResponse {
                    node_slot_id: queued_for_job.node_slot_id.clone(),
                    action: queued_for_job.action.clone(),
                    success: false,
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: format!("agent task panicked: {join_error}"),
                    transport: "wireguard-agent".to_string(),
                    executed_at_utc: Utc::now().to_rfc3339(),
                    phase: Some("failed".to_string()),
                    job_id: Some(job_id_for_task.clone()),
                    process_alive: None,
                },
            };

            let mut map = jobs.lock().await;
            map.insert(job_id_for_task, final_response);
        });

        return (
            StatusCode::ACCEPTED,
            Json(serde_json::to_value(queued).unwrap_or_default()),
        )
            .into_response();
    }

    // `execute_control` can block for several minutes. Offload to a blocking
    // thread pool so the async executor stays responsive.
    let workspace_root = state.workspace_root.clone();
    let result = tokio::task::spawn_blocking(move || execute_control(&workspace_root, input)).await;

    match result {
        Ok(Ok(outcome)) => (
            if outcome.success {
                StatusCode::OK
            } else {
                StatusCode::BAD_REQUEST
            },
            Json(serde_json::to_value(outcome).unwrap_or_default()),
        )
            .into_response(),
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
        Err(join_error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("agent task panicked: {join_error}") })),
        )
            .into_response(),
    }
}

async fn control_job_handler(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<AgentState>,
    AxumPath(job_id): AxumPath<String>,
) -> impl IntoResponse {
    if !is_allowed_remote(remote_addr.ip()) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "agent access restricted to WireGuard peers" })),
        )
            .into_response();
    }

    let jobs = state.jobs.lock().await;
    if let Some(result) = jobs.get(job_id.trim()) {
        return (
            StatusCode::OK,
            Json(serde_json::to_value(result).unwrap_or_default()),
        )
            .into_response();
    }

    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": format!("control job not found: {}", job_id.trim()) })),
    )
        .into_response()
}

fn build_health(workspace_root: &Path) -> Result<DevnetAgentHealth, String> {
    let local_vpn_ip = detect_local_vpn_ip();
    let nodes = load_inventory_nodes(workspace_root)?;
    let installable = installed_node_slots(workspace_root, &nodes);
    let physical_machine_id = local_vpn_ip
        .as_deref()
        .and_then(|vpn_ip| nodes.iter().find(|node| node.vpn_ip == vpn_ip))
        .map(|node| node.physical_machine_id.clone());

    Ok(DevnetAgentHealth {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        workspace_path: workspace_root.to_string_lossy().to_string(),
        local_vpn_ip,
        physical_machine_id,
        node_slot_ids: installable,
        supported_actions: supported_agent_actions(),
    })
}

fn execute_control(
    workspace_root: &Path,
    input: DevnetAgentControlRequest,
) -> Result<DevnetAgentControlResponse, String> {
    let node_slot_id = input.node_slot_id.trim().to_string();
    if node_slot_id.is_empty() {
        return Err("node_slot_id is required".to_string());
    }

    let normalized_action = normalize_action(&input.action);
    if normalized_action.is_empty() {
        return Err("action is required".to_string());
    }

    let result = match normalized_action.as_str() {
        "explorer_reset" => {
            trigger_explorer_reset(input.target_url.as_deref(), input.target_reason.as_deref())
        }
        "stop" => {
            let install = resolve_node_install(workspace_root, &node_slot_id)?;
            // Ask nodectl to stop first (clean shutdown via PID file if available).
            let nodectl_result = run_nodectl(&install, "stop");
            // Always follow with force-kill to handle the case where the node was
            // started outside nodectl (no PID file), leaving nodectl returning "not
            // running" while the process is still alive. This is the root cause of
            // validator nodes (node-02, node-04, node-06) ignoring stop commands.
            force_kill_node_processes(&install);
            nodectl_result
        }
        "restart" => {
            let install = resolve_node_install(workspace_root, &node_slot_id)?;
            // Same safe-stop sequence, then start fresh.
            let _ = run_nodectl(&install, "stop");
            force_kill_node_processes(&install);
            run_nodectl(&install, "start")
        }
        "start" => {
            let install = resolve_node_install(workspace_root, &node_slot_id)?;
            run_nodectl(&install, &normalized_action)
        }
        "sync_node" => {
            // Run the pre-start sync without starting the node.  Intended for
            // late-joining nodes or nodes that have been offline long enough to
            // fall significantly behind the chain tip.
            //
            // The HTTP timeout for this action is set to 7200 s in monitor.rs so
            // that the caller waits as long as the sync needs.  The sync itself
            // honours PRESTART_SYNC_TIMEOUT_SECS (defaulting to 7200 s inside
            // nodectl.sh sync) which gives a 2-hour window to download blocks.
            let install = resolve_node_install(workspace_root, &node_slot_id)?;
            run_nodectl(&install, "sync")
        }
        "status" => {
            let install = resolve_node_install(workspace_root, &node_slot_id)?;
            // Run nodectl status first (PID-file based), then cross-check with
            // OS-level process detection to catch nodes running without PID files.
            let nodectl_result = run_nodectl(&install, "status");
            let process_alive = is_node_process_running(&install);
            match nodectl_result {
                Ok(mut outcome) => {
                    // Append process-alive status to stdout so the caller gets both signals.
                    let process_status = if process_alive { "true" } else { "false" };
                    outcome.stdout = format!(
                        "{}\nPROCESS_ALIVE: {}",
                        outcome.stdout.trim(),
                        process_status
                    );
                    // If nodectl says "not running" but process is actually alive,
                    // override success to true so the dashboard shows the node as running.
                    if !outcome.success && process_alive {
                        outcome.success = true;
                        outcome.stdout = format!(
                            "{}\nNOTE: nodectl reports not running (no PID file) but process is alive. Node is running without PID tracking.",
                            outcome.stdout
                        );
                    }
                    Ok(outcome)
                }
                Err(error) => {
                    if process_alive {
                        Ok(CommandOutcome {
                            success: true,
                            exit_code: 0,
                            stdout: format!("PROCESS_ALIVE: true\nNOTE: nodectl failed but process is alive. Node is running without PID tracking."),
                            stderr: error,
                        })
                    } else {
                        Err(error)
                    }
                }
            }
        }
        "logs" | "node_logs" => {
            let install = resolve_node_install(workspace_root, &node_slot_id)?;
            run_nodectl(&install, "logs")
        }
        "setup" | "setup_node" | "install_node" | "bootstrap_node" => {
            let install = resolve_node_install(workspace_root, &node_slot_id)?;
            let _ = run_nodectl(&install, "stop");
            force_kill_node_processes(&install);
            sync_workspace_installer(workspace_root, &install)?;
            run_install_script(&install)
        }
        "reset_chain" => {
            let install = resolve_node_install(workspace_root, &node_slot_id)?;
            reset_chain(workspace_root, &install)
        }
        other => Err(format!("Unsupported devnet agent action: {other}")),
    }?;

    let process_alive = match normalized_action.as_str() {
        "start" | "restart" | "status" | "setup" | "setup_node" | "install_node"
        | "bootstrap_node" => resolve_node_install(workspace_root, &node_slot_id)
            .ok()
            .map(|install| is_node_process_running(&install)),
        _ => None,
    };
    let phase = match normalized_action.as_str() {
        "start" | "restart" | "setup" | "setup_node" | "install_node" | "bootstrap_node" => {
            if result.success && process_alive == Some(true) {
                Some("process_alive".to_string())
            } else if result.success {
                Some("pid_written".to_string())
            } else {
                Some("spawn_failed".to_string())
            }
        }
        "status" => Some("status_complete".to_string()),
        "sync_node" => Some(if result.success {
            "sync_complete".to_string()
        } else {
            "sync_failed".to_string()
        }),
        "reset_chain" => Some(if result.success {
            "reset_complete".to_string()
        } else {
            "reset_failed".to_string()
        }),
        _ => Some("completed".to_string()),
    };

    Ok(DevnetAgentControlResponse {
        node_slot_id,
        action: normalized_action,
        success: result.success,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        transport: "wireguard-agent".to_string(),
        executed_at_utc: Utc::now().to_rfc3339(),
        phase,
        job_id: None,
        process_alive,
    })
}

#[derive(Debug)]
struct CommandOutcome {
    success: bool,
    exit_code: i32,
    stdout: String,
    stderr: String,
}

fn normalize_action(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace(' ', "_")
}

fn trigger_explorer_reset(
    endpoint: Option<&str>,
    reason: Option<&str>,
) -> Result<CommandOutcome, String> {
    let endpoint = endpoint
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "target_url is required for explorer_reset".to_string())?;
    let reason = reason
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("chain_reset");
    let parsed =
        Url::parse(endpoint).map_err(|error| format!("Invalid explorer reset URL: {error}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Explorer reset URL is missing a hostname".to_string())?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "Explorer reset URL is missing a known port".to_string())?;
    let payload = json!({
        "action": "reindex_from_genesis",
        "reason": reason,
        "timestamp_utc": Utc::now().to_rfc3339(),
    });

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Failed to build async runtime for explorer reset: {error}"))?;

    let (transport, body) = runtime.block_on(async move {
        let loopback_client = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .resolve(&host, SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
            .build()
            .map_err(|error| format!("Failed to build loopback HTTP client: {error}"))?;

        match loopback_client.post(endpoint).json(&payload).send().await {
            Ok(response) if response.status().is_success() => {
                let body = response.text().await.unwrap_or_default();
                return Ok((format!("loopback-resolve({host})"), body));
            }
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                eprintln!("Explorer reset loopback attempt returned HTTP {status}: {body}");
            }
            Err(error) => {
                eprintln!("Explorer reset loopback attempt failed: {error}");
            }
        }

        let direct_client = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|error| format!("Failed to build direct HTTP client: {error}"))?;
        let response = direct_client
            .post(endpoint)
            .json(&payload)
            .send()
            .await
            .map_err(|error| format!("Explorer reset direct request failed: {error}"))?;
        if response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            Ok(("direct".to_string(), body))
        } else {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            Err(format!("Explorer reset returned HTTP {status}: {body}"))
        }
    })?;

    Ok(CommandOutcome {
        success: true,
        exit_code: 0,
        stdout: format!("Explorer reset accepted via {transport}\n{body}"),
        stderr: String::new(),
    })
}

fn is_allowed_remote(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback()
                || (ip.octets()[0] == 10 && ip.octets()[1] == 50 && ip.octets()[2] == 0)
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip
                    .to_ipv4_mapped()
                    .map(is_allowed_remote_v4)
                    .unwrap_or(false)
        }
    }
}

fn is_allowed_remote_v4(ip: Ipv4Addr) -> bool {
    ip.is_loopback() || (ip.octets()[0] == 10 && ip.octets()[1] == 50 && ip.octets()[2] == 0)
}

fn load_inventory_nodes(workspace_root: &Path) -> Result<Vec<InventoryNode>, String> {
    let inventory_path = workspace_root.join("devnet/lean15/node-inventory.csv");
    let content = fs::read_to_string(&inventory_path).map_err(|error| {
        format!(
            "Failed to read inventory {}: {error}",
            inventory_path.display()
        )
    })?;
    let mut lines = content.lines();
    let header = lines
        .next()
        .ok_or_else(|| format!("Inventory file is empty: {}", inventory_path.display()))?;
    let headers = header
        .split(',')
        .map(|entry| entry.trim().to_string())
        .collect::<Vec<_>>();

    let column = |aliases: &[&str], label: &str| -> Result<usize, String> {
        aliases
            .iter()
            .find_map(|alias| {
                headers
                    .iter()
                    .position(|header| header.eq_ignore_ascii_case(alias))
            })
            .ok_or_else(|| format!("Inventory column '{label}' is missing"))
    };

    let node_slot_idx = column(&["node_slot_id", "machine_id"], "node_slot_id")?;
    let host_idx = column(&["host"], "host")?;
    let vpn_ip_idx = column(&["vpn_ip"], "vpn_ip")?;
    let physical_idx = column(
        &["physical_machine_id", "physical_machine"],
        "physical_machine_id",
    )?;

    let mut nodes = Vec::new();
    for raw_line in lines {
        if raw_line.trim().is_empty() {
            continue;
        }
        let values = raw_line
            .split(',')
            .map(|entry| entry.trim().trim_end_matches('\r').to_string())
            .collect::<Vec<_>>();
        let get = |index: usize| values.get(index).cloned().unwrap_or_default();
        let node_slot_id = get(node_slot_idx);
        if node_slot_id.is_empty() {
            continue;
        }
        nodes.push(InventoryNode {
            node_slot_id,
            host: get(host_idx),
            vpn_ip: get(vpn_ip_idx),
            physical_machine_id: get(physical_idx),
        });
    }

    Ok(nodes)
}

fn installed_node_slots(workspace_root: &Path, inventory: &[InventoryNode]) -> Vec<String> {
    inventory
        .iter()
        .filter_map(|node| {
            resolve_node_install(workspace_root, node.node_slot_id.as_str())
                .ok()
                .map(|_| node.node_slot_id.clone())
        })
        .collect()
}

fn legacy_workspace_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home_dir) = dirs::home_dir().or_else(dirs::data_dir) {
        roots.push(
            home_dir
                .join(".synergy-node-monitor")
                .join("monitor-workspace"),
        );
    }
    roots
}

fn install_candidates(workspace_root: &Path, node_slot_id: &str) -> Result<Vec<PathBuf>, String> {
    let hosts_env = parse_hosts_env(workspace_root.join("devnet/lean15/hosts.env"))?;
    let key_prefix = node_slot_id.to_ascii_uppercase().replace('-', "_");
    let remote_dir_key = format!("{key_prefix}_REMOTE_DIR");
    let remote_dir = hosts_env
        .get(&remote_dir_key)
        .cloned()
        .or_else(|| {
            hosts_env.get("SYNERGY_REMOTE_ROOT").map(|root| {
                PathBuf::from(root)
                    .join(node_slot_id)
                    .to_string_lossy()
                    .to_string()
            })
        })
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                format!("{DEFAULT_REMOTE_ROOT_WINDOWS}\\{node_slot_id}")
            } else {
                format!("{DEFAULT_REMOTE_ROOT_UNIX}/{node_slot_id}")
            }
        });

    let mut candidates = Vec::new();
    candidates.push(PathBuf::from(remote_dir));
    candidates.push(
        workspace_root
            .join("devnet/lean15/installers")
            .join(node_slot_id),
    );
    for legacy_root in legacy_workspace_roots() {
        candidates.push(
            legacy_root
                .join("devnet/lean15/installers")
                .join(node_slot_id),
        );
    }

    let mut deduped = Vec::new();
    for candidate in candidates {
        if !deduped
            .iter()
            .any(|existing: &PathBuf| existing == &candidate)
        {
            deduped.push(candidate);
        }
    }

    Ok(deduped)
}

fn is_process_running_for_install_dir(install_dir: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        let install_path = install_dir.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$target = '{install_path}'; $match = Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -and $_.CommandLine.Contains($target) }} | Select-Object -First 1; if ($match) {{ exit 0 }} else {{ exit 1 }}"
        );
        return ProcessCommand::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let install_path = install_dir.to_string_lossy().to_string();
        return ProcessCommand::new("pgrep")
            .args(["-f", &install_path])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
}

fn resolve_node_install(workspace_root: &Path, node_slot_id: &str) -> Result<NodeInstall, String> {
    let candidates = install_candidates(workspace_root, node_slot_id)?;
    let existing_candidates = candidates
        .into_iter()
        .filter(|candidate| candidate.join("node.env").is_file())
        .collect::<Vec<_>>();

    let install_dir = existing_candidates
        .iter()
        .find(|candidate| is_process_running_for_install_dir(candidate))
        .cloned()
        .or_else(|| existing_candidates.first().cloned())
        .ok_or_else(|| {
            format!(
                "No local installer directory found for {node_slot_id}. Expected node.env in workspace installer, legacy workspace, or configured remote root."
            )
        })?;

    Ok(NodeInstall {
        node_slot_id: node_slot_id.to_string(),
        install_dir,
    })
}

fn parse_hosts_env(path: PathBuf) -> Result<HashMap<String, String>, String> {
    if !path.is_file() {
        return Ok(HashMap::new());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read hosts env {}: {error}", path.display()))?;
    let mut output = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let normalized = trimmed.strip_prefix("export ").unwrap_or(trimmed).trim();
        let Some((key, value)) = normalized.split_once('=') else {
            continue;
        };
        output.insert(key.trim().to_string(), strip_env_quotes(value.trim()));
    }
    Ok(output)
}

fn strip_env_quotes(value: &str) -> String {
    if value.len() >= 2 {
        let first = value.as_bytes()[0] as char;
        let last = value.as_bytes()[value.len() - 1] as char;
        if (first == '\'' && last == '\'') || (first == '"' && last == '"') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn sync_workspace_installer(workspace_root: &Path, install: &NodeInstall) -> Result<(), String> {
    let source = workspace_root
        .join("devnet/lean15/installers")
        .join(&install.node_slot_id);
    if !source.is_dir() || source == install.install_dir {
        return Ok(());
    }

    copy_directory_force(&source, &install.install_dir)
}

/// Checks if a node process is actually running, independent of PID files.
/// Uses OS-level process enumeration to detect processes whose command line
/// contains this node's install directory path.
fn is_node_process_running(install: &NodeInstall) -> bool {
    #[cfg(not(target_os = "windows"))]
    {
        let path = install.install_dir.to_string_lossy().to_string();
        // pgrep -f returns 0 if any matching process found, 1 if none.
        match ProcessCommand::new("pgrep").args(["-f", &path]).output() {
            Ok(output) => output.status.success(),
            Err(_) => false,
        }
    }

    #[cfg(target_os = "windows")]
    {
        let install_path = install.install_dir.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$target = '{install_path}'; $p = Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -and $_.CommandLine.Contains($target) }}; if ($p) {{ exit 0 }} else {{ exit 1 }}"
        );
        match ProcessCommand::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .output()
        {
            Ok(output) => output.status.success(),
            Err(_) => false,
        }
    }
}

/// Kill any lingering node processes associated with this install directory.
/// This handles the case where the node is running but has no PID file (e.g.
/// it was started manually, the PID file was deleted, or the file got out of sync).
/// nodectl stop_node silently exits when the PID file is missing, so this is the
/// safety net that ensures the old process is truly gone before we wipe chain data.
fn force_kill_node_processes(install: &NodeInstall) {
    #[cfg(not(target_os = "windows"))]
    {
        let path = install.install_dir.to_string_lossy().to_string();
        // Kill any process whose command line contains the install dir path.
        // This precisely targets THIS node's binary without disturbing other nodes.
        let _ = ProcessCommand::new("pkill").args(["-f", &path]).output();
        // Give the OS a moment to reap the process before we delete chain data.
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }

    #[cfg(target_os = "windows")]
    {
        let install_path = install.install_dir.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$target = '{install_path}'; Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -and $_.CommandLine.Contains($target) }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
        );
        let _ = ProcessCommand::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .output();
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
}

fn reset_chain(workspace_root: &Path, install: &NodeInstall) -> Result<CommandOutcome, String> {
    let _ = run_nodectl(install, "stop");
    // Belt-and-suspenders: kill any orphaned process that nodectl may have missed
    // (e.g. node started outside nodectl so it has no PID file).
    force_kill_node_processes(install);
    sync_workspace_installer(workspace_root, install)?;

    let data_dir = install.install_dir.join("data");
    let node_data_dir = data_dir.join("devnet15").join(&install.node_slot_id);
    let targets = [
        data_dir.join("chain"),
        node_data_dir.join("chain"),
        node_data_dir.join("logs"),
        data_dir.join("chain.json"),
        data_dir.join("token_state.json"),
        data_dir.join("validator_registry.json"),
        data_dir.join("synergy-devnet.pid"),
        data_dir.join(".reset_flag"),
        data_dir.join("node.pid"),
    ];

    for target in targets {
        if target.is_dir() {
            fs::remove_dir_all(&target).map_err(|error| {
                format!(
                    "Failed to remove {} during reset: {error}",
                    target.display()
                )
            })?;
        } else if target.is_file() {
            fs::remove_file(&target).map_err(|error| {
                format!(
                    "Failed to remove {} during reset: {error}",
                    target.display()
                )
            })?;
        }
    }

    fs::create_dir_all(data_dir.join("chain"))
        .map_err(|error| format!("Failed to recreate chain dir: {error}"))?;
    fs::create_dir_all(node_data_dir.join("chain"))
        .map_err(|error| format!("Failed to recreate node chain dir: {error}"))?;
    fs::create_dir_all(node_data_dir.join("logs"))
        .map_err(|error| format!("Failed to recreate node log dir: {error}"))?;
    fs::create_dir_all(data_dir.join("logs"))
        .map_err(|error| format!("Failed to recreate shared log dir: {error}"))?;

    // Verify chain data was actually deleted — fail hard if not.
    let chain_dir = data_dir.join("chain");
    if chain_dir.is_dir() {
        let has_files = fs::read_dir(&chain_dir)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false);
        if has_files {
            return Err(format!(
                "Chain directory still contains files after reset for {}",
                install.node_slot_id
            ));
        }
    }
    for check_file in &["chain.json", "token_state.json", "validator_registry.json"] {
        if data_dir.join(check_file).exists() {
            return Err(format!(
                "{} still exists after reset for {}",
                check_file, install.node_slot_id
            ));
        }
    }

    // Node is intentionally NOT restarted after reset. User should use
    // "Start All" from the control panel dashboard when all nodes are
    // confirmed reset.
    Ok(CommandOutcome {
        success: true,
        exit_code: 0,
        stdout: format!(
            "Cleared chain state for {}. Node is stopped and ready for manual start.",
            install.node_slot_id
        ),
        stderr: String::new(),
    })
}

fn run_install_script(install: &NodeInstall) -> Result<CommandOutcome, String> {
    #[cfg(target_os = "windows")]
    let output = ProcessCommand::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            install
                .install_dir
                .join("install_and_start.ps1")
                .to_string_lossy()
                .as_ref(),
        ])
        .current_dir(&install.install_dir)
        .output()
        .map_err(|error| format!("Failed to run install script: {error}"))?;

    #[cfg(not(target_os = "windows"))]
    let output = ProcessCommand::new("bash")
        .arg(install.install_dir.join("install_and_start.sh"))
        .current_dir(&install.install_dir)
        .output()
        .map_err(|error| format!("Failed to run install script: {error}"))?;

    Ok(CommandOutcome {
        success: output.status.success(),
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn run_nodectl(install: &NodeInstall, action: &str) -> Result<CommandOutcome, String> {
    #[cfg(target_os = "windows")]
    let output = ProcessCommand::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            install
                .install_dir
                .join("nodectl.ps1")
                .to_string_lossy()
                .as_ref(),
            action,
        ])
        .current_dir(&install.install_dir)
        .output()
        .map_err(|error| format!("Failed to run nodectl action '{action}': {error}"))?;

    #[cfg(not(target_os = "windows"))]
    let output = ProcessCommand::new("bash")
        .arg(install.install_dir.join("nodectl.sh"))
        .arg(action)
        .current_dir(&install.install_dir)
        .output()
        .map_err(|error| format!("Failed to run nodectl action '{action}': {error}"))?;

    Ok(CommandOutcome {
        success: output.status.success(),
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn detect_local_vpn_ip() -> Option<String> {
    let candidates = gather_local_ips();
    candidates.into_iter().find(|ip| ip.starts_with("10.50.0."))
}

fn gather_local_ips() -> Vec<String> {
    #[cfg(target_os = "windows")]
    let command_output = ProcessCommand::new("ipconfig").output().ok();

    #[cfg(not(target_os = "windows"))]
    let command_output = ProcessCommand::new("sh")
        .arg("-lc")
        .arg("ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || ifconfig 2>/dev/null | awk '/inet /{print $2}'")
        .output()
        .ok();

    let raw = command_output
        .as_ref()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default();

    raw.lines()
        .flat_map(|line| line.split_whitespace())
        .map(|entry| {
            entry
                .trim()
                .trim_matches(|ch: char| ch == ':' || ch == '(' || ch == ')')
        })
        .filter(|entry| entry.parse::<Ipv4Addr>().is_ok())
        .map(|entry| entry.to_string())
        .collect()
}

fn copy_directory_force(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!("Directory missing: {}", source.display()));
    }

    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Failed to create destination directory {}: {error}",
            destination.display()
        )
    })?;

    for entry in fs::read_dir(source)
        .map_err(|error| format!("Failed to read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory_force(&source_path, &destination_path)?;
        } else {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "Failed to create destination parent {}: {error}",
                        parent.display()
                    )
                })?;
            }
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "Failed to copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if destination_path
                    .extension()
                    .and_then(|entry| entry.to_str())
                    .is_none()
                    || matches!(
                        destination_path
                            .extension()
                            .and_then(|entry| entry.to_str()),
                        Some("sh")
                    )
                {
                    let _ =
                        fs::set_permissions(&destination_path, fs::Permissions::from_mode(0o755));
                }
            }
        }
    }

    Ok(())
}
