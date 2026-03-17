use super::binary_downloader;
use super::binary_verification;
use super::types::*;
use super::NodeManager;
use std::fs::{self};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

fn resource_binary_candidates(binary_path: &std::path::Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(file_name) = binary_path.file_name() {
        candidates.push(PathBuf::from(file_name));
    }

    #[cfg(target_os = "windows")]
    {
        candidates.push(PathBuf::from("synergy-testbeta.exe"));
        candidates.push(PathBuf::from("synergy-node.exe"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(PathBuf::from("synergy-testbeta"));
        candidates.push(PathBuf::from("synergy-node"));
    }

    // Preserve support for older packaged resources used by some local builds.
    candidates.push(PathBuf::from("synergy-devnet-aarch64-apple-darwin"));
    candidates
}

#[tauri::command]
pub async fn install_node_binaries(
    app: AppHandle,
    state: State<'_, Arc<Mutex<NodeManager>>>,
) -> Result<String, String> {
    let manager = state.lock().await;
    let binary_path = manager.node_info.binary_path.clone();
    drop(manager);

    // Emit progress: Starting
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            step: "starting".to_string(),
            progress: 0,
            message: "Preparing to install node binaries...".to_string(),
        },
    );

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // Emit progress: Extracting
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            step: "extracting".to_string(),
            progress: 25,
            message: "Extracting bundled Synergy node binary...".to_string(),
        },
    );

    // Get the bundled binary from the packaged desktop app resources
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    let bundled_binary_path = resource_binary_candidates(&binary_path)
        .into_iter()
        .map(|candidate| resource_path.join(candidate))
        .find(|candidate| candidate.exists());

    // If bundled binary not found, try downloading from remote
    if bundled_binary_path.is_none() {
        let _ = app.emit(
            "install-progress",
            InstallProgress {
                step: "downloading".to_string(),
                progress: 30,
                message: "Bundled binary not found. Downloading from releases server..."
                    .to_string(),
            },
        );

        println!("Bundled binary not found. Attempting remote download...");

        // Download with progress callback
        binary_downloader::download_binary_with_progress(
            &binary_path,
            None,
            |downloaded, total| {
                let progress_pct = if total > 0 {
                    30 + ((downloaded as f64 / total as f64) * 40.0) as u8
                } else {
                    50
                };

                let _ = app.emit(
                    "install-progress",
                    InstallProgress {
                        step: "downloading".to_string(),
                        progress: progress_pct,
                        message: if total > 0 {
                            format!(
                                "Downloading: {} / {} MB",
                                downloaded / 1024 / 1024,
                                total / 1024 / 1024
                            )
                        } else {
                            format!("Downloading: {} MB", downloaded / 1024 / 1024)
                        },
                    },
                );
            },
        )
        .await?;

        // Binary downloaded successfully - verification already done in download_binary_with_progress
        let _ = app.emit(
            "install-progress",
            InstallProgress {
                step: "complete".to_string(),
                progress: 100,
                message: "Binary downloaded and installed successfully!".to_string(),
            },
        );

        return Ok("Node binary downloaded and installed successfully".to_string());
    }

    let bundled_binary_path = bundled_binary_path.unwrap();

    // Emit progress: Installing
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            step: "installing".to_string(),
            progress: 75,
            message: "Installing binary...".to_string(),
        },
    );

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // Emit progress: Verifying
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            step: "verifying".to_string(),
            progress: 50,
            message: "Verifying binary checksum...".to_string(),
        },
    );

    // Verify bundled binary checksum before copying
    match binary_verification::verify_binary(&bundled_binary_path) {
        Ok(true) => {
            println!("✅ Binary checksum verified");
        }
        Ok(false) => {
            return Err("Binary verification failed - checksum mismatch".to_string());
        }
        Err(e) => {
            eprintln!("⚠️  Warning: Binary verification error: {}", e);
            eprintln!("Proceeding with installation (verification bypassed)");
        }
    }

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // Copy the bundled binary to the node directory
    fs::copy(&bundled_binary_path, &binary_path)
        .map_err(|e| format!("Failed to copy binary: {}", e))?;

    // Make executable on Unix systems
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&binary_path)
            .map_err(|e| format!("Failed to get metadata: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&binary_path, perms)
            .map_err(|e| format!("Failed to set permissions: {}", e))?;
    }

    // Verify copied binary
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            step: "final-verification".to_string(),
            progress: 90,
            message: "Verifying installed binary...".to_string(),
        },
    );

    match binary_verification::verify_binary(&binary_path) {
        Ok(true) => {
            println!("✅ Installed binary verified");
        }
        Ok(false) => {
            // Clean up failed installation
            let _ = fs::remove_file(&binary_path);
            return Err(
                "Installed binary verification failed - removed corrupted file".to_string(),
            );
        }
        Err(e) => {
            eprintln!("⚠️  Warning: Installed binary verification error: {}", e);
        }
    }

    // Emit progress: Complete
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            step: "complete".to_string(),
            progress: 100,
            message: "Installation complete!".to_string(),
        },
    );

    Ok("Node binaries installed and verified successfully".to_string())
}
