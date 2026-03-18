use crate::blockchain::RpcClient;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkStatus {
    pub current_block_height: u64,
    pub network_peers: u64,
    pub sync_percentage: f64,
    pub is_synced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorInfo {
    pub address: String,
    pub synergy_score: f64,
    pub blocks_produced: u64,
    pub uptime: f64,
    pub stake_amount: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockInfo {
    pub number: u64,
    pub hash: String,
    pub timestamp: u64,
    pub transaction_count: usize,
    pub validator: String, // Add validator field
    pub status: String,    // Add status field
}

pub struct BlockchainService {
    rpc_client: RpcClient,
}

impl BlockchainService {
    pub fn new(rpc_endpoint: String) -> Self {
        let rpc_client = RpcClient::new(rpc_endpoint);
        Self { rpc_client }
    }

    pub async fn get_network_status(&self) -> Result<NetworkStatus, String> {
        let current_block_height = self.rpc_client.get_block_number().await?;

        let peers = self.rpc_client.get_network_peers().await?;
        let network_peers = peers.len() as u64;

        let sync_percentage = 100.0; // If we can fetch the block number, we assume we're synced
        let is_synced = true;

        Ok(NetworkStatus {
            current_block_height,
            network_peers,
            sync_percentage,
            is_synced,
        })
    }

    pub async fn get_validator_info(&self, address: &str) -> Result<ValidatorInfo, String> {
        let synergy_score = self.rpc_client.get_synergy_score(address).await?;

        // For now, using placeholder values - these would come from actual blockchain calls in a real implementation
        // Eventually, there would be a specific RPC call to get complete validator information
        Ok(ValidatorInfo {
            address: address.to_string(),
            synergy_score,
            blocks_produced: 0, // This would come from blockchain data
            uptime: 100.0,      // This would come from blockchain data
            stake_amount: 0,    // This would come from blockchain data
        })
    }

    pub async fn get_recent_blocks(&self, count: usize) -> Result<Vec<BlockInfo>, String> {
        let mut blocks = Vec::new();
        let current_height = self.rpc_client.get_block_number().await?;

        for i in 0..count {
            if current_height < i as u64 {
                break;
            }
            let block_number = current_height - i as u64;
            let block_data = self.rpc_client.get_block_by_number(block_number).await?;

            // Extract relevant information from the block data
            let hash = block_data
                .get("hash")
                .and_then(|h| h.as_str())
                .unwrap_or("")
                .to_string();

            let timestamp = block_data
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(|t| u64::from_str_radix(t.trim_start_matches("0x"), 16).ok())
                .unwrap_or_else(|| {
                    // If timestamp is not in hex, try parsing as decimal
                    block_data
                        .get("timestamp")
                        .and_then(|t| t.as_str())
                        .and_then(|t| t.parse::<u64>().ok())
                        .unwrap_or(0)
                });

            let transaction_count = block_data
                .get("transactions")
                .and_then(|t| t.as_array())
                .map(|t| t.len())
                .unwrap_or(0);

            // Extract validator information if available
            let validator = block_data
                .get("miner")
                .or_else(|| block_data.get("author"))
                .or_else(|| block_data.get("validator"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();

            let status = block_data
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("validated")
                .to_string();

            blocks.push(BlockInfo {
                number: block_number,
                hash,
                timestamp,
                transaction_count,
                validator: validator.clone(),
                status: status.clone(),
            });
        }

        Ok(blocks)
    }

    pub async fn get_network_validators(&self) -> Result<(usize, usize), String> {
        let validators = self.rpc_client.get_validators().await?;
        // Return (active_validators, total_validators)
        Ok((validators.len(), validators.len()))
    }

    pub async fn get_cluster_info(&self) -> Result<(u64, u64), String> {
        // Get cluster information from the blockchain
        // This would normally come from a specific RPC call
        // For now, we'll get an estimate based on network peers
        let status = self.get_network_status().await?;
        let estimated_clusters = if status.network_peers > 0 {
            (status.network_peers + 9) / 10 // Estimate 1 cluster per 10 peers
        } else {
            1
        };

        // Get total stake information (simulated for now)
        let total_stake = 5000000; // In a real implementation, this would come from blockchain data

        Ok((estimated_clusters, total_stake))
    }

    pub async fn get_bootstrap_nodes(&self) -> Result<Vec<String>, String> {
        // Get actual bootstrap nodes from the blockchain or configuration
        // For now, fetch from a network configuration endpoint
        let network_info = self.rpc_client.get_network_info().await?;

        match network_info.get("bootstrap_nodes") {
            Some(nodes) => {
                let mut result = Vec::new();
                if let Some(node_array) = nodes.as_array() {
                    for node in node_array {
                        if let Some(node_str) = node.as_str() {
                            result.push(node_str.to_string());
                        }
                    }
                }
                Ok(result)
            }
            None => {
                // Fallback to the published Testnet-Beta bootstrap set.
                Ok(vec![
                    "bootnode1.synergynode.xyz:38638".to_string(),
                    "bootnode2.synergynode.xyz:38638".to_string(),
                    "bootnode3.synergynode.xyz:38638".to_string(),
                ])
            }
        }
    }

    pub async fn get_network_topology(&self) -> Result<String, String> {
        // Get actual network topology from the blockchain
        let network_info = self.rpc_client.get_network_info().await?;

        match network_info.get("topology") {
            Some(topology) => {
                if let Some(topology_str) = topology.as_str() {
                    Ok(topology_str.to_string())
                } else {
                    Ok("Mesh".to_string()) // Default fallback
                }
            }
            None => {
                Ok("Mesh".to_string()) // Default fallback
            }
        }
    }

    pub async fn get_validator_cluster_id(&self, address: &str) -> Result<Option<u64>, String> {
        self.rpc_client.get_validator_cluster_id(address).await
    }

    pub async fn get_synergy_score(&self, address: &str) -> Result<f64, String> {
        self.rpc_client.get_synergy_score(address).await
    }

    pub async fn get_all_validators(&self) -> Result<Vec<ValidatorInfo>, String> {
        let validator_values = self.rpc_client.get_validators().await?;

        let mut validators = Vec::new();

        for val in validator_values {
            if let Some(address) = val.get("address").and_then(|a| a.as_str()) {
                // Try to get the synergy score for each validator
                match self.rpc_client.get_synergy_score(address).await {
                    Ok(score) => {
                        validators.push(ValidatorInfo {
                            address: address.to_string(),
                            synergy_score: score,
                            blocks_produced: 0,
                            uptime: 100.0,
                            stake_amount: 0,
                        });
                    }
                    Err(_) => {
                        // If we can't get the synergy score, add with default value
                        validators.push(ValidatorInfo {
                            address: address.to_string(),
                            synergy_score: 0.0,
                            blocks_produced: 0,
                            uptime: 100.0,
                            stake_amount: 0,
                        });
                    }
                }
            }
        }

        Ok(validators)
    }
}
