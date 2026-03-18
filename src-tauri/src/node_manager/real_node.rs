use crate::node_manager::types::NodeType;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::process::{Child, Command};

#[derive(Debug)]
pub struct RealNodeProcess {
    #[allow(dead_code)]
    pub child: Option<Child>,
    pub config: NodeConfig,
    pub node_type: NodeType,
    pub is_running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeConfig {
    pub node_id: String,
    pub node_type: String,
    pub network_id: u64,
    pub p2p_port: u16,
    pub rpc_port: u16,
    pub data_dir: PathBuf,
    pub log_file: PathBuf,
    pub bootstrap_nodes: Vec<String>,
}

impl RealNodeProcess {
    pub fn new(node_type: NodeType, node_id: String) -> Self {
        let config = NodeConfig {
            node_id: node_id.clone(),
            node_type: node_type.as_str().to_string(),
            network_id: 338639, // Synergy Testnet-Beta chain ID
            p2p_port: get_default_p2p_port(&node_type),
            rpc_port: get_default_rpc_port(&node_type),
            data_dir: PathBuf::from(format!("./data/{}", node_id)),
            log_file: PathBuf::from(format!("./logs/{}.log", node_id)),
            bootstrap_nodes: vec![
                "snr://synv11lylxla8qjcrk3ef8gjlyyhew3z4mjswwwsn6zv@bootnode1.synergynode.xyz:38638".to_string(),
                "snr://synv11csyhf60yd6gp8n4wflz99km29g7fh8guxrmu04@bootnode2.synergynode.xyz:38638".to_string(),
                "snr://synv110y3fuyvqmjdp02j6m6y2rceqjp2dexwu3p6np4@bootnode3.synergynode.xyz:38638".to_string(),
            ],
        };

        Self {
            child: None,
            config,
            node_type,
            is_running: false,
            pid: None,
            started_at: None,
        }
    }

    pub async fn start(&mut self, binary_path: &PathBuf) -> Result<(), String> {
        if self.is_running {
            return Err("Node is already running".to_string());
        }

        // Ensure directories exist
        fs::create_dir_all(&self.config.data_dir)
            .map_err(|e| format!("Failed to create data directory: {}", e))?;

        if let Some(parent) = self.config.log_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create log directory: {}", e))?;
        }

        // Ensure log file exists
        let _ = std::fs::File::create(&self.config.log_file)
            .map_err(|e| format!("Failed to create log file: {}", e))?;

        // Build the command to start the actual node
        let mut cmd = Command::new(binary_path);
        cmd.arg("start")
            .arg("--node-type")
            .arg(self.config.node_type.clone())
            .arg("--node-id")
            .arg(self.config.node_id.clone())
            .arg("--network-id")
            .arg(self.config.network_id.to_string())
            .arg("--p2p-port")
            .arg(self.config.p2p_port.to_string())
            .arg("--rpc-port")
            .arg(self.config.rpc_port.to_string())
            .arg("--data-dir")
            .arg(&self.config.data_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Start the process
        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start node process: {}", e))?;

        let pid = child.id().expect("Process should have an ID");
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        self.child = Some(child);
        self.is_running = true;
        self.pid = Some(pid);
        self.started_at = Some(started_at);

        Ok(())
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        if !self.is_running {
            return Err("Node is not running".to_string());
        }

        if let Some(mut child) = self.child.take() {
            child
                .kill()
                .await
                .map_err(|e| format!("Failed to kill process: {}", e))?;
        }

        self.is_running = false;
        self.pid = None;
        self.started_at = None;

        Ok(())
    }

    pub fn get_status(&self) -> NodeStatus {
        NodeStatus {
            is_running: self.is_running,
            pid: self.pid,
            node_type: self.config.node_type.clone(),
            node_id: self.config.node_id.clone(),
            uptime: self.started_at.map(|start| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
                    .saturating_sub(start)
            }),
            p2p_port: self.config.p2p_port,
            rpc_port: self.config.rpc_port,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeStatus {
    pub is_running: bool,
    pub pid: Option<u32>,
    pub node_type: String,
    pub node_id: String,
    pub uptime: Option<u64>,
    pub p2p_port: u16,
    pub rpc_port: u16,
}

fn get_default_p2p_port(node_type: &NodeType) -> u16 {
    match node_type {
        NodeType::Validator => 38638,
        NodeType::Committee => 38639,
        NodeType::ArchiveValidator => 38640,
        NodeType::AuditValidator => 38641,
        NodeType::Relayer => 31400,
        NodeType::Witness => 31401,
        NodeType::Oracle => 31402,
        NodeType::UmaCoordinator => 31403,
        NodeType::CrossChainVerifier => 31404,
        NodeType::Compute => 31405,
        NodeType::AiInference => 31406,
        NodeType::PqcCrypto => 31407,
        NodeType::DataAvailability => 31408,
        NodeType::GovernanceAuditor => 31409,
        NodeType::TreasuryController => 31410,
        NodeType::SecurityCouncil => 31411,
        NodeType::RpcGateway => 31412,
        NodeType::Indexer => 31413,
        NodeType::Observer => 31414,
    }
}

fn get_default_rpc_port(node_type: &NodeType) -> u16 {
    match node_type {
        NodeType::Validator => 48638,
        NodeType::Committee => 48639,
        NodeType::ArchiveValidator => 48640,
        NodeType::AuditValidator => 48641,
        NodeType::Relayer => 8600,
        NodeType::Witness => 8601,
        NodeType::Oracle => 8602,
        NodeType::UmaCoordinator => 8603,
        NodeType::CrossChainVerifier => 8604,
        NodeType::Compute => 8605,
        NodeType::AiInference => 8606,
        NodeType::PqcCrypto => 8607,
        NodeType::DataAvailability => 8608,
        NodeType::GovernanceAuditor => 8609,
        NodeType::TreasuryController => 8610,
        NodeType::SecurityCouncil => 8611,
        NodeType::RpcGateway => 8612,
        NodeType::Indexer => 8613,
        NodeType::Observer => 8614,
    }
}
