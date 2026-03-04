use crate::env_config::EnvConfig;
use crate::node_manager::multi_node::MultiNodeManager;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

pub struct ProcessManager {
    pub processes: HashMap<String, tokio::process::Child>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: HashMap::new(),
        }
    }
}

/// Refresh the node's config file with current bootnodes from env config
fn refresh_node_bootnodes(
    config_path: &std::path::Path,
    env_config: &EnvConfig,
) -> Result<(), String> {
    if !config_path.exists() {
        return Ok(()); // Nothing to refresh if config doesn't exist
    }

    let content = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let mut config_value: toml::Value = content
        .parse()
        .map_err(|e: toml::de::Error| format!("Failed to parse config: {}", e))?;

    // Update bootnodes from current env config
    if let Some(network) = config_value.get_mut("network") {
        if let Some(table) = network.as_table_mut() {
            let bootnodes = toml::Value::Array(
                env_config
                    .bootstrap_nodes
                    .iter()
                    .map(|s| toml::Value::String(s.clone()))
                    .collect(),
            );
            table.insert("bootnodes".to_string(), bootnodes);
        }
    }

    let serialized = toml::to_string_pretty(&config_value)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(config_path, serialized)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn start_node_by_id(
    node_id: String,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
    process_manager: State<'_, Arc<Mutex<ProcessManager>>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut mgr = manager.lock().await;
    let mut pm = process_manager.lock().await;

    // Get node info
    let node = mgr.get_node(&node_id).ok_or("Node not found")?.clone();

    if node.is_running {
        return Err("Node is already running".to_string());
    }

    // Refresh bootnodes in config with current env settings before starting
    let env_config = EnvConfig::load(Some(&app_handle))?;
    refresh_node_bootnodes(&node.config_path, &env_config)?;

    // Build command
    let binary_path = &mgr.info.binary_path;
    if !binary_path.exists() {
        return Err("Node binary not found. Please reinstall.".to_string());
    }

    let mut cmd = tokio::process::Command::new(binary_path);
    // Subcommand must come BEFORE options
    cmd.arg("start")
        .arg("--config")
        .arg(&node.config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(&node.sandbox_path);

    // Start process
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start node: {}", e))?;

    let pid = child.id().ok_or("Failed to get process ID")?;

    // Setup log file for output capture
    let log_file_path = node.logs_path.join(format!("node-{}.log", pid));
    let log_file_path_clone = log_file_path.clone();

    // Capture stdout in background task
    if let Some(stdout) = child.stdout.take() {
        let log_path = log_file_path.clone();
        tokio::spawn(async move {
            use tokio::fs::OpenOptions;
            use tokio::io::AsyncWriteExt;
            use tokio::io::{AsyncBufReadExt, BufReader};

            let mut reader = BufReader::new(stdout).lines();
            let mut log_file = match OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .await
            {
                Ok(file) => file,
                Err(e) => {
                    eprintln!("Failed to open log file: {}", e);
                    return;
                }
            };

            while let Ok(Some(line)) = reader.next_line().await {
                let log_line = format!("[STDOUT] {}\n", line);
                if let Err(e) = log_file.write_all(log_line.as_bytes()).await {
                    eprintln!("Failed to write to log file: {}", e);
                }
                let _ = log_file.flush().await;
            }
        });
    }

    // Capture stderr in background task
    if let Some(stderr) = child.stderr.take() {
        let log_path = log_file_path_clone;
        tokio::spawn(async move {
            use tokio::fs::OpenOptions;
            use tokio::io::AsyncWriteExt;
            use tokio::io::{AsyncBufReadExt, BufReader};

            let mut reader = BufReader::new(stderr).lines();
            let mut log_file = match OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .await
            {
                Ok(file) => file,
                Err(e) => {
                    eprintln!("Failed to open log file: {}", e);
                    return;
                }
            };

            while let Ok(Some(line)) = reader.next_line().await {
                let log_line = format!("[STDERR] {}\n", line);
                if let Err(e) = log_file.write_all(log_line.as_bytes()).await {
                    eprintln!("Failed to write to log file: {}", e);
                }
                let _ = log_file.flush().await;
            }
        });
    }

    // Store process
    pm.processes.insert(node_id.clone(), child);

    // Update node info
    if let Some(node_mut) = mgr.get_node_mut(&node_id) {
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

    Ok(())
}

#[tauri::command]
pub async fn stop_node_by_id(
    node_id: String,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
    process_manager: State<'_, Arc<Mutex<ProcessManager>>>,
) -> Result<(), String> {
    let mut mgr = manager.lock().await;
    let mut pm = process_manager.lock().await;

    // Get node info
    let node = mgr.get_node(&node_id).ok_or("Node not found")?;

    if !node.is_running {
        return Err("Node is not running".to_string());
    }

    // Kill process
    if let Some(mut child) = pm.processes.remove(&node_id) {
        child
            .kill()
            .await
            .map_err(|e| format!("Failed to kill process: {}", e))?;
    } else if let Some(pid) = node.pid {
        // Try to kill by PID if process handle is lost
        #[cfg(unix)]
        {
            use nix::sys::signal::{self, Signal};
            use nix::unistd::Pid;
            let _ = signal::kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }

        #[cfg(windows)]
        {
            use std::process::Command;
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .output();
        }
    }

    // Update node info
    if let Some(node_mut) = mgr.get_node_mut(&node_id) {
        node_mut.is_running = false;
        node_mut.pid = None;
        node_mut.started_at = None;
    }

    mgr.save()?;

    Ok(())
}

#[tauri::command]
pub async fn restart_node_by_id(
    node_id: String,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
    process_manager: State<'_, Arc<Mutex<ProcessManager>>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    stop_node_by_id(node_id.clone(), manager.clone(), process_manager.clone()).await?;
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    start_node_by_id(node_id, manager, process_manager, app_handle).await?;
    Ok(())
}

#[tauri::command]
pub async fn get_node_logs(
    node_id: String,
    manager: State<'_, Arc<Mutex<MultiNodeManager>>>,
) -> Result<String, String> {
    let mgr = manager.lock().await;

    let node = mgr.get_node(&node_id).ok_or("Node not found")?;

    // Find the most recent log file
    let log_dir = &node.logs_path;
    if !log_dir.exists() {
        return Ok(String::new());
    }

    let mut log_files: Vec<_> = std::fs::read_dir(log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s == "log")
                .unwrap_or(false)
        })
        .collect();

    log_files.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });

    if let Some(latest_log) = log_files.last() {
        let content = std::fs::read_to_string(latest_log.path())
            .map_err(|e| format!("Failed to read log file: {}", e))?;

        // Return last 500 lines
        let lines: Vec<&str> = content.lines().collect();
        let start = lines.len().saturating_sub(500);
        Ok(lines[start..].join("\n"))
    } else {
        Ok(String::new())
    }
}
