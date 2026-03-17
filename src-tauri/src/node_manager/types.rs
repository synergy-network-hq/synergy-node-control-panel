use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInfo {
    pub sandbox_path: PathBuf,
    pub binary_path: PathBuf,
    pub config_path: PathBuf,
    pub logs_path: PathBuf,
    pub is_initialized: bool,
    pub is_running: bool,
    pub pid: Option<u32>,
    pub started_at: u64,
}

impl Default for NodeInfo {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let sandbox = home.join(".synergy").join("node");

        Self {
            sandbox_path: sandbox.clone(),
            // The remaining legacy single-node path is validator-only, so its default
            // binary should resolve to the validator-specific artifact rather than a
            // generic shared executable name.
            binary_path: sandbox
                .join("bin")
                .join(NodeType::Validator.installed_binary_name()),
            config_path: sandbox.join("config").join("node.toml"),
            logs_path: sandbox.join("logs").join("node.log"),
            is_initialized: false,
            is_running: false,
            pid: None,
            started_at: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum NodeType {
    Validator,
    Committee,
    ArchiveValidator,
    AuditValidator,
    Relayer,
    Witness,
    Oracle,
    UmaCoordinator,
    CrossChainVerifier,
    Compute,
    AiInference,
    PqcCrypto,
    DataAvailability,
    GovernanceAuditor,
    TreasuryController,
    SecurityCouncil,
    RpcGateway,
    Indexer,
    Observer,
}

impl NodeType {
    pub fn as_str(&self) -> &str {
        match self {
            NodeType::Validator => "validator",
            NodeType::Committee => "committee",
            NodeType::ArchiveValidator => "archive_validator",
            NodeType::AuditValidator => "audit_validator",
            NodeType::Relayer => "relayer",
            NodeType::Witness => "witness",
            NodeType::Oracle => "oracle",
            NodeType::UmaCoordinator => "uma_coordinator",
            NodeType::CrossChainVerifier => "cross_chain_verifier",
            NodeType::Compute => "compute",
            NodeType::AiInference => "ai_inference",
            NodeType::PqcCrypto => "pqc_crypto",
            NodeType::DataAvailability => "data_availability",
            NodeType::GovernanceAuditor => "governance_auditor",
            NodeType::TreasuryController => "treasury_controller",
            NodeType::SecurityCouncil => "security_council",
            NodeType::RpcGateway => "rpc_gateway",
            NodeType::Indexer => "indexer",
            NodeType::Observer => "observer",
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            NodeType::Validator => "Validator",
            NodeType::Committee => "Committee",
            NodeType::ArchiveValidator => "Archive Validator",
            NodeType::AuditValidator => "Audit Validator",
            NodeType::Relayer => "Relayer",
            NodeType::Witness => "Witness",
            NodeType::Oracle => "Oracle",
            NodeType::UmaCoordinator => "UMA Coordinator",
            NodeType::CrossChainVerifier => "Cross Chain Verifier",
            NodeType::Compute => "Compute",
            NodeType::AiInference => "AI Inference",
            NodeType::PqcCrypto => "PQC Crypto",
            NodeType::DataAvailability => "Data Availability",
            NodeType::GovernanceAuditor => "Governance Auditor",
            NodeType::TreasuryController => "Treasury Controller",
            NodeType::SecurityCouncil => "Security Council",
            NodeType::RpcGateway => "RPC Gateway",
            NodeType::Indexer => "Indexer",
            NodeType::Observer => "Observer",
        }
    }

    pub fn template_file(&self) -> String {
        format!("{}.toml", self.as_str().replace("_", "-"))
    }

    pub fn compiled_profile(&self) -> &str {
        match self {
            NodeType::Validator => "validator_node",
            NodeType::Committee => "committee_node",
            NodeType::ArchiveValidator => "archive_validator_node",
            NodeType::AuditValidator => "audit_validator_node",
            NodeType::Relayer => "relayer_node",
            NodeType::Witness => "witness_node",
            NodeType::Oracle => "oracle_node",
            NodeType::UmaCoordinator => "uma_coordinator_node",
            NodeType::CrossChainVerifier => "cross_chain_verifier_node",
            NodeType::Compute => "synq_execution_node",
            NodeType::AiInference => "analytics_and_simulation_node",
            NodeType::PqcCrypto => "aegis_cryptography_node",
            NodeType::DataAvailability => "data_availability_node",
            NodeType::GovernanceAuditor => "governance_auditor_node",
            NodeType::TreasuryController => "treasury_controller_node",
            NodeType::SecurityCouncil => "security_council_node",
            NodeType::RpcGateway => "rpc_gateway_node",
            NodeType::Indexer => "indexer_and_explorer_node",
            NodeType::Observer => "observer_light_node",
        }
    }

    pub fn binary_slug(&self) -> &str {
        match self {
            NodeType::Validator => "validator-node",
            NodeType::Committee => "committee-node",
            NodeType::ArchiveValidator => "archive-validator-node",
            NodeType::AuditValidator => "audit-validator-node",
            NodeType::Relayer => "relayer-node",
            NodeType::Witness => "witness-node",
            NodeType::Oracle => "oracle-node",
            NodeType::UmaCoordinator => "uma-coordinator-node",
            NodeType::CrossChainVerifier => "cross-chain-verifier-node",
            NodeType::Compute => "synq-execution-node",
            NodeType::AiInference => "analytics-and-simulation-node",
            NodeType::PqcCrypto => "aegis-cryptography-node",
            NodeType::DataAvailability => "data-availability-node",
            NodeType::GovernanceAuditor => "governance-auditor-node",
            NodeType::TreasuryController => "treasury-controller-node",
            NodeType::SecurityCouncil => "security-council-node",
            NodeType::RpcGateway => "rpc-gateway-node",
            NodeType::Indexer => "indexer-and-explorer-node",
            NodeType::Observer => "observer-light-node",
        }
    }

    pub fn installed_binary_name(&self) -> String {
        #[cfg(target_os = "windows")]
        {
            return format!("synergy-{}.exe", self.binary_slug());
        }

        #[cfg(not(target_os = "windows"))]
        {
            format!("synergy-{}", self.binary_slug())
        }
    }

    pub fn artifact_binary_name(&self, platform_key: &str) -> String {
        let windows = platform_key.contains("windows");
        let suffix = if windows { ".exe" } else { "" };
        format!("synergy-{}-{}{}", self.binary_slug(), platform_key, suffix)
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "validator" => Some(NodeType::Validator),
            "committee" => Some(NodeType::Committee),
            "archive_validator" => Some(NodeType::ArchiveValidator),
            "audit_validator" => Some(NodeType::AuditValidator),
            "relayer" => Some(NodeType::Relayer),
            "witness" => Some(NodeType::Witness),
            "oracle" => Some(NodeType::Oracle),
            "uma_coordinator" => Some(NodeType::UmaCoordinator),
            "cross_chain_verifier" => Some(NodeType::CrossChainVerifier),
            "compute" => Some(NodeType::Compute),
            "ai_inference" => Some(NodeType::AiInference),
            "pqc_crypto" => Some(NodeType::PqcCrypto),
            "data_availability" => Some(NodeType::DataAvailability),
            "governance_auditor" => Some(NodeType::GovernanceAuditor),
            "treasury_controller" => Some(NodeType::TreasuryController),
            "security_council" => Some(NodeType::SecurityCouncil),
            "rpc_gateway" => Some(NodeType::RpcGateway),
            "indexer" => Some(NodeType::Indexer),
            "observer" => Some(NodeType::Observer),
            _ => None,
        }
    }

    pub fn compatible_nodes(&self) -> Vec<NodeType> {
        match self {
            NodeType::Validator => vec![
                NodeType::Committee,
                NodeType::ArchiveValidator,
                NodeType::AuditValidator,
            ],
            NodeType::Committee => vec![NodeType::Validator],
            NodeType::ArchiveValidator => vec![NodeType::Validator],
            NodeType::AuditValidator => vec![NodeType::Validator],
            NodeType::Relayer => vec![NodeType::Witness, NodeType::Oracle],
            NodeType::Witness => vec![NodeType::Relayer],
            NodeType::Oracle => vec![NodeType::Relayer],
            NodeType::UmaCoordinator => vec![NodeType::CrossChainVerifier],
            NodeType::CrossChainVerifier => vec![NodeType::UmaCoordinator],
            NodeType::Compute => vec![NodeType::AiInference, NodeType::PqcCrypto],
            NodeType::AiInference => vec![NodeType::Compute],
            NodeType::PqcCrypto => vec![NodeType::Compute],
            NodeType::DataAvailability => vec![NodeType::ArchiveValidator],
            NodeType::GovernanceAuditor => vec![NodeType::SecurityCouncil],
            NodeType::TreasuryController => vec![NodeType::SecurityCouncil],
            NodeType::SecurityCouncil => {
                vec![NodeType::GovernanceAuditor, NodeType::TreasuryController]
            }
            NodeType::RpcGateway => vec![NodeType::Indexer, NodeType::Observer],
            NodeType::Indexer => vec![NodeType::RpcGateway],
            NodeType::Observer => vec![NodeType::RpcGateway],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeOperationMode {
    NetworkParticipating,
    UserOperatedLocal,
}

impl Default for NodeOperationMode {
    fn default() -> Self {
        Self::NetworkParticipating
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInstance {
    pub id: String,
    pub node_type: NodeType,
    pub sandbox_path: PathBuf,
    pub config_path: PathBuf,
    pub logs_path: PathBuf,
    pub data_path: PathBuf,
    pub is_running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub display_name: String,
    pub address: Option<String>,
    pub public_key: Option<String>,
    pub node_class: Option<u8>,
    #[serde(default)]
    pub operation_mode: NodeOperationMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiNodeInfo {
    pub control_panel_path: PathBuf,
    pub binary_path: PathBuf,
    pub nodes: HashMap<String, NodeInstance>,
    pub is_initialized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeStatus {
    pub is_running: bool,
    pub pid: Option<u32>,
    pub uptime: Option<u64>,
    pub version: Option<String>,
    pub block_height: Option<u64>,
    pub peer_count: Option<u64>,
    pub sync_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallProgress {
    pub step: String,
    pub progress: u8,
    pub message: String,
}

#[cfg(target_os = "windows")]
pub fn get_binary_name() -> String {
    "synergy-node.exe".to_string()
}

#[cfg(not(target_os = "windows"))]
pub fn get_binary_name() -> String {
    "synergy-node".to_string()
}
