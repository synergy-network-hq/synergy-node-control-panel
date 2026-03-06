#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod blockchain;
mod env_config;
mod monitor;
mod node_manager;
mod recipe;

use std::sync::Arc;
use tauri::{Manager, PhysicalPosition, PhysicalSize, Position, Size};
use tokio::sync::Mutex;

// Custom panic hook to log panics to a file for debugging
fn setup_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        // Log to file in user's home directory
        if let Some(home) = dirs::home_dir() {
            let log_path = home.join(".synergy").join("panic.log");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                use std::io::Write;
                let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
                let _ = writeln!(file, "\n=== PANIC at {} ===", timestamp);
                let _ = writeln!(file, "{}", panic_info);

                // Try to get backtrace
                let bt = std::backtrace::Backtrace::capture();
                let _ = writeln!(file, "Backtrace:\n{}", bt);
            }
        }
        // Call default hook to print to stderr
        default_hook(panic_info);
    }));
}

use crate::agent::{
    agent_generate_wireguard_mesh, agent_get_inventory_machines,
    agent_monitor_initialize_workspace, agent_prepare_hosts_env, agent_setup_node,
};
use crate::monitor::{
    get_monitor_inventory_path, get_monitor_node_details, get_monitor_security_state,
    get_monitor_snapshot, get_monitor_user_manual_markdown, get_monitor_workspace_path,
    monitor_apply_devnet_topology, monitor_assign_machine_ssh_profile,
    monitor_bulk_node_control, monitor_delete_operator, monitor_delete_ssh_profile,
    monitor_detect_local_vpn_identity, monitor_export_node_data, monitor_get_setup_status,
    monitor_initialize_workspace, monitor_mark_setup_complete, monitor_node_control,
    monitor_remove_machine_ssh_profile, monitor_run_terminal_command, monitor_set_active_operator,
    monitor_upsert_operator, monitor_upsert_ssh_profile,
};
use crate::node_manager::monitoring::MonitoringService;
use blockchain::BlockchainService;
use node_manager::{
    auto_stake_node, capture_connection_diagnostics, check_initialization,
    check_multi_node_initialization, generate_devnet_address, get_all_nodes,
    get_available_node_types, get_block_validation_status, get_genesis_config, get_genesis_summary,
    get_network_peers, get_node_alerts, get_node_balance, get_node_by_id, get_node_config,
    get_node_health, get_node_logs, get_node_status, get_peer_info, get_performance_history,
    get_rewards_data, get_rpc_node_info, get_security_status, get_synergy_score_breakdown,
    get_system_metrics, get_validator_activity, init_multi_node_environment, init_network_discovery,
    init_node_environment, install_node_binaries, multi_node::MultiNodeManager,
    read_diagnostics_log, read_log_file, refresh_network_peers, reload_node_config, remove_node,
    restart_node, restart_node_by_id, save_node_config, setup_node, start_node, start_node_by_id,
    stop_node, stop_node_by_id, stream_logs, NodeManager, ProcessManager,
};

async fn start_monitoring_services(
    app_handle: tauri::AppHandle,
    multi_node_manager: Arc<Mutex<crate::node_manager::multi_node::MultiNodeManager>>,
    blockchain_service: Arc<Mutex<crate::blockchain::BlockchainService>>,
) {
    let mut monitoring_service = MonitoringService::new(multi_node_manager, blockchain_service);
    monitoring_service.set_app_handle(app_handle);
    monitoring_service.start_monitoring().await;
}

fn configure_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| format!("Failed to read current monitor: {error}"))?
    {
        let work_area = monitor.work_area().to_owned();
        window
            .set_size(Size::Physical(PhysicalSize::new(
                work_area.size.width,
                work_area.size.height,
            )))
            .map_err(|error| format!("Failed to resize main window: {error}"))?;
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                work_area.position.x,
                work_area.position.y,
            )))
            .map_err(|error| format!("Failed to reposition main window: {error}"))?;
    }

    window
        .show()
        .map_err(|error| format!("Failed to show main window: {error}"))?;
    Ok(())
}

#[tokio::main]
async fn main() {
    // Set up panic hook for debugging
    setup_panic_hook();

    let node_manager = Arc::new(Mutex::new(NodeManager::new()));
    let multi_node_manager = Arc::new(Mutex::new(
        MultiNodeManager::load().unwrap_or_else(|_| MultiNodeManager::new().unwrap()),
    ));
    let process_manager = Arc::new(Mutex::new(ProcessManager::new()));
    let blockchain_service = Arc::new(Mutex::new(BlockchainService::new(
        "https://devnet-core-rpc.synergy-network.io".to_string(),
    )));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Err(error) = crate::monitor::ensure_monitor_workspace(&app.handle().clone()) {
                eprintln!("monitor workspace initialization warning: {error}");
            }
            if let Err(error) = configure_main_window(&app.handle().clone()) {
                eprintln!("main window initialization warning: {error}");
            }
            let app_handle = app.handle().clone();
            let multi_node_manager_data: Arc<
                Mutex<crate::node_manager::multi_node::MultiNodeManager>,
            > = app
                .state::<Arc<Mutex<crate::node_manager::multi_node::MultiNodeManager>>>()
                .inner()
                .clone();
            let blockchain_service_data: Arc<Mutex<crate::blockchain::BlockchainService>> = app
                .state::<Arc<Mutex<crate::blockchain::BlockchainService>>>()
                .inner()
                .clone();
            tauri::async_runtime::spawn(async move {
                start_monitoring_services(
                    app_handle,
                    multi_node_manager_data,
                    blockchain_service_data,
                )
                .await;
            });
            Ok(())
        })
        .manage(node_manager)
        .manage(multi_node_manager)
        .manage(process_manager)
        .manage(blockchain_service)
        .invoke_handler(tauri::generate_handler![
            init_node_environment,
            check_initialization,
            install_node_binaries,
            start_node,
            stop_node,
            restart_node,
            get_node_status,
            get_block_validation_status,
            get_validator_activity,
            get_peer_info,
            stream_logs,
            read_log_file,
            check_multi_node_initialization,
            init_multi_node_environment,
            get_available_node_types,
            setup_node,
            get_all_nodes,
            get_node_by_id,
            remove_node,
            get_node_balance,
            start_node_by_id,
            stop_node_by_id,
            restart_node_by_id,
            get_node_logs,
            get_node_config,
            save_node_config,
            reload_node_config,
            agent_setup_node,
            agent_monitor_initialize_workspace,
            agent_get_inventory_machines,
            agent_prepare_hosts_env,
            agent_generate_wireguard_mesh,
            // Genesis and staking commands
            get_genesis_config,
            get_genesis_summary,
            auto_stake_node,
            generate_devnet_address,
            // Network discovery commands
            init_network_discovery,
            get_network_peers,
            refresh_network_peers,
            // System metrics commands
            get_system_metrics,
            get_rpc_node_info,
            get_node_health,
            get_node_alerts,
            get_rewards_data,
            get_security_status,
            get_synergy_score_breakdown,
            get_performance_history,
            capture_connection_diagnostics,
            read_diagnostics_log,
            // Monitoring-only commands for remote 15-node devnet view
            get_monitor_inventory_path,
            get_monitor_workspace_path,
            get_monitor_user_manual_markdown,
            monitor_initialize_workspace,
            monitor_apply_devnet_topology,
            get_monitor_snapshot,
            get_monitor_node_details,
            monitor_node_control,
            monitor_bulk_node_control,
            monitor_export_node_data,
            monitor_run_terminal_command,
            get_monitor_security_state,
            monitor_detect_local_vpn_identity,
            monitor_get_setup_status,
            monitor_mark_setup_complete,
            monitor_set_active_operator,
            monitor_upsert_operator,
            monitor_delete_operator,
            monitor_upsert_ssh_profile,
            monitor_delete_ssh_profile,
            monitor_assign_machine_ssh_profile,
            monitor_remove_machine_ssh_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
