pub mod actual_node_binary;
pub mod binary_downloader;
pub mod binary_verification;
pub mod commands;
pub mod config;
pub mod config_editor;
pub mod crypto;
pub mod genesis;
pub mod init;
pub mod installer;
pub mod logs;
pub mod monitoring;
pub mod multi_node;
pub mod multi_node_process;
pub mod network_discovery;
pub mod node_classes;
pub mod process;
pub mod real_node;
pub mod status;
pub mod system_metrics;
pub mod types;

use types::*;

pub struct NodeManager {
    pub process_handle: Option<tokio::process::Child>,
    pub node_info: NodeInfo,
}

impl NodeManager {
    pub fn new() -> Self {
        Self {
            process_handle: None,
            node_info: NodeInfo::default(),
        }
    }
}

// Re-export command handlers with pub use
pub use init::{check_initialization, init_node_environment};
pub use installer::install_node_binaries;
pub use logs::{read_log_file, stream_logs};
pub use process::{restart_node, start_node, stop_node};
pub use status::{
    get_block_validation_status, get_node_status, get_peer_info, get_validator_activity,
};

// Re-export multi-node commands
pub use commands::{
    check_multi_node_initialization,
    get_all_nodes,
    get_available_node_types,
    get_network_peers,
    get_node_balance,
    get_node_by_id,
    init_multi_node_environment,
    // Network discovery commands
    init_network_discovery,
    refresh_network_peers,
    remove_node,
    setup_node,
};

// Re-export multi-node process commands
pub use multi_node_process::{
    get_node_logs, restart_node_by_id, start_node_by_id, stop_node_by_id, ProcessManager,
};

// Re-export config editor commands
pub use config_editor::{get_node_config, reload_node_config, save_node_config};

// Re-export genesis commands
pub use genesis::{
    auto_stake_node, generate_devnet_address, get_genesis_config, get_genesis_summary,
};

// Re-export system metrics commands
pub use system_metrics::{
    capture_connection_diagnostics, get_node_alerts, get_node_health, get_performance_history,
    get_rewards_data, get_rpc_node_info, get_security_status, get_synergy_score_breakdown,
    get_system_metrics, read_diagnostics_log,
};
