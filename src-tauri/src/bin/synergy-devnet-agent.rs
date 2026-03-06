#[path = "../devnet_agent_service.rs"]
mod devnet_agent_service;

use devnet_agent_service::{serve, DEVNET_AGENT_PORT};
use std::path::PathBuf;

fn default_workspace_root() -> PathBuf {
    dirs::home_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".synergy-devnet-control-panel")
        .join("monitor-workspace")
}

#[tokio::main]
async fn main() {
    let mut workspace_root = default_workspace_root();
    let mut port = DEVNET_AGENT_PORT;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "serve" => {}
            "--workspace" => {
                if let Some(value) = args.next() {
                    workspace_root = PathBuf::from(value);
                }
            }
            "--port" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<u16>() {
                        port = parsed;
                    }
                }
            }
            _ => {}
        }
    }

    if let Err(error) = serve(workspace_root, port).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
