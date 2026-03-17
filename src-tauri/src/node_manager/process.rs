use super::NodeManager;
use std::fs::OpenOptions;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::process::Command;
use tokio::sync::Mutex;

#[tauri::command]
pub async fn start_node(state: State<'_, Arc<Mutex<NodeManager>>>) -> Result<String, String> {
    let mut manager = state.lock().await;

    if manager.node_info.is_running {
        return Err("Node is already running".to_string());
    }

    // Open log file
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&manager.node_info.logs_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    // Spawn node process with "start" subcommand
    let child = Command::new(&manager.node_info.binary_path)
        .arg("start")
        .arg("--config")
        .arg(&manager.node_info.config_path)
        .current_dir(&manager.node_info.sandbox_path)
        .stdout(log_file.try_clone().map_err(|e| e.to_string())?)
        .stderr(log_file)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start node: {}", e))?;

    let pid = child.id();
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    manager.process_handle = Some(child);
    manager.node_info.is_running = true;
    manager.node_info.pid = pid;
    manager.node_info.started_at = started_at;

    Ok(format!("Node started with PID: {:?}", pid))
}

#[tauri::command]
pub async fn stop_node(state: State<'_, Arc<Mutex<NodeManager>>>) -> Result<String, String> {
    let mut manager = state.lock().await;

    if !manager.node_info.is_running {
        return Err("Node is not running".to_string());
    }

    if let Some(mut child) = manager.process_handle.take() {
        child
            .kill()
            .await
            .map_err(|e| format!("Failed to kill process: {}", e))?;
        manager.node_info.is_running = false;
        manager.node_info.pid = None;
        manager.node_info.started_at = 0;
        Ok("Node stopped successfully".to_string())
    } else {
        Err("No process handle found".to_string())
    }
}

#[tauri::command]
pub async fn restart_node(state: State<'_, Arc<Mutex<NodeManager>>>) -> Result<String, String> {
    // Stop the node
    stop_node(state.clone()).await?;

    // Wait a moment
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    // Start the node
    start_node(state).await?;

    Ok("Node restarted successfully".to_string())
}
