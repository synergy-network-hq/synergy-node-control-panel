use super::NodeManager;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::fs;
use tokio::sync::Mutex;

#[tauri::command]
pub async fn read_log_file(
    state: State<'_, Arc<Mutex<NodeManager>>>,
    lines: Option<usize>,
) -> Result<Vec<String>, String> {
    let manager = state.lock().await;
    let log_path = manager.node_info.logs_path.clone();
    drop(manager);

    let bytes = fs::read(&log_path)
        .await
        .map_err(|e| format!("Failed to open log file: {}", e))?;
    let log_lines = decode_log_bytes(&bytes);

    // Return last N lines if specified
    if let Some(n) = lines {
        let start = log_lines.len().saturating_sub(n);
        Ok(log_lines[start..].to_vec())
    } else {
        Ok(log_lines)
    }
}

#[tauri::command]
pub async fn stream_logs(
    app: AppHandle,
    state: State<'_, Arc<Mutex<NodeManager>>>,
) -> Result<(), String> {
    let manager = state.lock().await;
    let log_path = manager.node_info.logs_path.clone();
    drop(manager);

    tokio::spawn(async move {
        let mut emitted = 0usize;
        loop {
            if let Ok(bytes) = fs::read(&log_path).await {
                let lines = decode_log_bytes(&bytes);
                for line in lines.iter().skip(emitted) {
                    let _ = app.emit("log-line", line);
                }
                emitted = lines.len();
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }
    });

    Ok(())
}

fn decode_log_bytes(bytes: &[u8]) -> Vec<String> {
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        let utf16 = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&utf16)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    };

    text.replace('\r', "")
        .lines()
        .map(|line| line.to_string())
        .collect()
}
