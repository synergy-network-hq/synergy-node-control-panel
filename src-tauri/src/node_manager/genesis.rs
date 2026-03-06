//! Genesis Manager
//!
//! Handles genesis block configuration for the Synergy Devnet:
//! - Generates deterministic node addresses based on machine ID, node type, and class
//! - Allocates 500,000 SNRG to each devnet node in the genesis block
//! - Automatically stakes the required amount for each node's class on setup
//! - Tracks balances (genesis allocation, staked, liquid) for each node

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::node_classes::NodeClass;
use super::types::NodeType;

/// SNRG allocated to each devnet node in the genesis block
pub const GENESIS_ALLOCATION_PER_NODE: u64 = 500_000;

/// Token symbol
pub const TOKEN_SYMBOL: &str = "SNRG";

/// A single node's genesis account
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenesisNodeAccount {
    pub node_type: String,
    pub node_class: u8,
    pub address: String,
    pub genesis_balance: u64,
    pub staked_amount: u64,
    pub liquid_balance: u64,
    pub p2p_port: Option<u16>,
    pub machine_id: String,
}

/// Auto-stake result for a node
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoStakeResult {
    pub success: bool,
    pub action: String,
    pub node_type: String,
    pub node_class: u8,
    pub address: String,
    pub genesis_balance: u64,
    pub staked_amount: u64,
    pub liquid_balance: u64,
    pub message: String,
    pub staking_tx_hash: Option<String>,
}

/// Summary of all genesis allocations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenesisSummary {
    pub total_nodes: usize,
    pub total_allocated: u64,
    pub total_staked: u64,
    pub total_liquid: u64,
    pub breakdown_by_class: HashMap<String, ClassBreakdown>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassBreakdown {
    pub nodes: usize,
    pub allocated: u64,
    pub staked: u64,
    pub liquid: u64,
}

/// Full genesis configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenesisConfig {
    pub chain_id: u64,
    pub token: String,
    pub per_node_allocation: u64,
    pub auto_stake: bool,
    pub accounts: Vec<GenesisNodeAccount>,
    pub summary: GenesisSummary,
}

/// Generate a deterministic devnet address for a node.
/// Format: {class_prefix}devnet{machine_num}{type_slug}{hash} (42 chars, all lowercase)
pub fn generate_node_address(machine_id: &str, node_type: &str, node_class: u8, p2p_port: Option<u16>) -> String {
    let class_prefix = match node_class {
        1 => "synv1",
        2 => "synv2",
        3 => "synv3",
        4 => "synv4",
        5 => "synv5",
        _ => "synv0",
    };

    // Extract machine number
    let machine_num = machine_id
        .replace("machine-", "")
        .replace("Machine-", "");
    let machine_num = format!("{:0>2}", machine_num);

    // Create type slug (lowercase, no spaces/hyphens, max 12 chars)
    let type_slug: String = node_type
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    let type_slug = &type_slug[..type_slug.len().min(12)];

    // Deterministic hash for uniqueness
    let seed = format!("{}-{}-{:?}", machine_id, node_type, p2p_port);
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let hash_short = &hash[..8];

    // Build address, pad to 42 chars
    let base = format!("{}devnet{}{}{}", class_prefix, machine_num, type_slug, hash_short);
    let mut address = base;
    while address.len() < 42 {
        address.push('0');
    }
    address.truncate(42);
    address
}

/// Generate genesis config from the node inventory CSV
pub fn generate_genesis_from_inventory(inventory_path: &Path) -> Result<GenesisConfig, String> {
    let content = fs::read_to_string(inventory_path)
        .map_err(|e| format!("Failed to read inventory: {}", e))?;

    let mut accounts = Vec::new();
    let mut class_totals: HashMap<String, ClassBreakdown> = HashMap::new();

    for (i, line) in content.lines().enumerate() {
        if i == 0 { continue; } // skip header
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() < 7 { continue; }

        let machine_id = fields[0].trim();
        let node_type_str = fields[4].trim();
        let address_class: u8 = fields[5].trim().parse().unwrap_or(0);
        let p2p_port: Option<u16> = fields[6].trim().parse().ok();

        let staking_req = match address_class {
            1 => 100_000u64,
            2 => 250_000,
            3 => 50_000,
            4 => 10_000,
            _ => 0,
        };

        let address = generate_node_address(machine_id, node_type_str, address_class, p2p_port);
        let liquid = GENESIS_ALLOCATION_PER_NODE - staking_req;

        accounts.push(GenesisNodeAccount {
            node_type: node_type_str.to_string(),
            node_class: address_class,
            address,
            genesis_balance: GENESIS_ALLOCATION_PER_NODE,
            staked_amount: staking_req,
            liquid_balance: liquid,
            p2p_port,
            machine_id: machine_id.to_string(),
        });

        let class_key = format!("Class {}", match address_class {
            1 => "I", 2 => "II", 3 => "III", 4 => "IV", 5 => "V", _ => "N/A",
        });
        let entry = class_totals.entry(class_key).or_insert(ClassBreakdown {
            nodes: 0, allocated: 0, staked: 0, liquid: 0,
        });
        entry.nodes += 1;
        entry.allocated += GENESIS_ALLOCATION_PER_NODE;
        entry.staked += staking_req;
        entry.liquid += liquid;
    }

    let total_nodes = accounts.len();
    let total_allocated: u64 = accounts.iter().map(|a| a.genesis_balance).sum();
    let total_staked: u64 = accounts.iter().map(|a| a.staked_amount).sum();

    Ok(GenesisConfig {
        chain_id: 9999,
        token: TOKEN_SYMBOL.to_string(),
        per_node_allocation: GENESIS_ALLOCATION_PER_NODE,
        auto_stake: true,
        accounts,
        summary: GenesisSummary {
            total_nodes,
            total_allocated,
            total_staked,
            total_liquid: total_allocated - total_staked,
            breakdown_by_class: class_totals,
        },
    })
}

/// Perform auto-staking for a specific node
pub fn auto_stake_for_node(node_type: &NodeType, machine_id: &str, p2p_port: Option<u16>) -> AutoStakeResult {
    let class = NodeClass::from_node_type(node_type);
    let class_num = class.class_number();
    let stake_amount = class.staking_requirement();
    let address = generate_node_address(
        machine_id,
        node_type.display_name(),
        class_num,
        p2p_port,
    );

    if stake_amount == 0 {
        return AutoStakeResult {
            success: true,
            action: "no_stake_required".to_string(),
            node_type: node_type.display_name().to_string(),
            node_class: class_num,
            address,
            genesis_balance: GENESIS_ALLOCATION_PER_NODE,
            staked_amount: 0,
            liquid_balance: GENESIS_ALLOCATION_PER_NODE,
            message: format!(
                "{} ({}) does not require staking",
                node_type.display_name(),
                class.description()
            ),
            staking_tx_hash: None,
        };
    }

    // Generate deterministic tx hash
    let seed = format!("stake-{}-{}-{}", address, stake_amount, machine_id);
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let tx_hash = format!("0x{:x}", hasher.finalize());

    AutoStakeResult {
        success: true,
        action: "auto_staked".to_string(),
        node_type: node_type.display_name().to_string(),
        node_class: class_num,
        address: address.clone(),
        genesis_balance: GENESIS_ALLOCATION_PER_NODE,
        staked_amount: stake_amount,
        liquid_balance: GENESIS_ALLOCATION_PER_NODE - stake_amount,
        message: format!(
            "Auto-staked {} {} for {} (Class {}). Liquid: {} {}",
            stake_amount,
            TOKEN_SYMBOL,
            node_type.display_name(),
            class_num,
            GENESIS_ALLOCATION_PER_NODE - stake_amount,
            TOKEN_SYMBOL,
        ),
        staking_tx_hash: Some(tx_hash),
    }
}

/// Load genesis config from a JSON file, or generate from inventory
pub fn load_or_generate_genesis(
    genesis_path: &Path,
    inventory_path: &Path,
) -> Result<GenesisConfig, String> {
    if genesis_path.exists() {
        let content = fs::read_to_string(genesis_path)
            .map_err(|e| format!("Failed to read genesis config: {}", e))?;
        let config: GenesisConfig = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse genesis config: {}", e))?;
        return Ok(config);
    }

    // Generate from inventory
    let config = generate_genesis_from_inventory(inventory_path)?;

    // Save it
    if let Some(parent) = genesis_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create genesis directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize genesis config: {}", e))?;
    fs::write(genesis_path, json)
        .map_err(|e| format!("Failed to write genesis config: {}", e))?;

    Ok(config)
}

// ── Tauri command wrappers ──────────────────────────────────────────────

fn resolve_workspace() -> Result<PathBuf, String> {
    let ws = crate::monitor::get_monitor_workspace_path()?;
    Ok(PathBuf::from(ws))
}

/// Get the full genesis configuration (loads from disk or generates from inventory)
#[tauri::command]
pub fn get_genesis_config() -> Result<GenesisConfig, String> {
    let workspace = resolve_workspace()?;
    let genesis_path = workspace.join("devnet/lean15/configs/genesis/genesis.json");
    let inventory_path = workspace.join("devnet/lean15/node-inventory.csv");
    load_or_generate_genesis(&genesis_path, &inventory_path)
}

/// Get just the genesis summary (totals, class breakdown)
#[tauri::command]
pub fn get_genesis_summary() -> Result<GenesisSummary, String> {
    let config = get_genesis_config()?;
    Ok(config.summary)
}

/// Auto-stake a specific node by type, machine, and port
#[tauri::command]
pub fn auto_stake_node(
    node_type: String,
    machine_id: String,
    p2p_port: Option<u16>,
) -> Result<AutoStakeResult, String> {
    let nt = NodeType::from_str(&node_type)
        .ok_or_else(|| format!("Unknown node type: {}", node_type))?;
    Ok(auto_stake_for_node(&nt, &machine_id, p2p_port))
}

/// Generate a deterministic devnet address (exposed to frontend)
#[tauri::command]
pub fn generate_devnet_address(
    machine_id: String,
    node_type: String,
    node_class: u8,
    p2p_port: Option<u16>,
) -> String {
    generate_node_address(&machine_id, &node_type, node_class, p2p_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_address_lowercase() {
        let addr = generate_node_address("node-01", "validator", 1, Some(38638));
        assert_eq!(addr, addr.to_lowercase(), "Address must be all lowercase");
        assert!(addr.starts_with("synv1"), "Class I should start with synv1");
        assert_eq!(addr.len(), 42, "Address should be 42 chars");
    }

    #[test]
    fn test_generate_address_deterministic() {
        let a1 = generate_node_address("node-01", "validator", 1, Some(38638));
        let a2 = generate_node_address("node-01", "validator", 1, Some(38638));
        assert_eq!(a1, a2, "Same inputs should produce same address");
    }

    #[test]
    fn test_generate_address_unique() {
        let a1 = generate_node_address("node-01", "validator", 1, Some(38638));
        let a2 = generate_node_address("node-02", "validator", 1, Some(38639));
        assert_ne!(a1, a2, "Different machines should produce different addresses");
    }

    #[test]
    fn test_auto_stake_validator() {
        let result = auto_stake_for_node(&NodeType::Validator, "node-01", Some(38638));
        assert!(result.success);
        assert_eq!(result.staked_amount, 100_000);
        assert_eq!(result.liquid_balance, 400_000);
        assert!(result.staking_tx_hash.is_some());
    }

    #[test]
    fn test_auto_stake_observer_no_stake() {
        let result = auto_stake_for_node(&NodeType::Observer, "node-15", Some(38652));
        assert!(result.success);
        assert_eq!(result.staked_amount, 0);
        assert_eq!(result.liquid_balance, 500_000);
        assert!(result.staking_tx_hash.is_none());
    }
}
