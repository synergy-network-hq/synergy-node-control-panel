// network_discovery.rs - P2P Network Discovery for Control Panel
//
// This module allows control panels to discover other nodes on the Synergy network
// by querying RPC endpoints. It uses the existing synergy_getPeerInfo and synergy_nodeInfo
// RPC methods to build a map of the network.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Information about a discovered peer on the network
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredPeer {
    /// Network address of the peer (IP:port)
    pub address: String,
    /// Node identifier if available
    pub node_id: Option<String>,
    /// Protocol version
    pub version: Option<String>,
    /// Capabilities advertised by the node
    pub capabilities: Vec<String>,
    /// Unix timestamp when peer was last seen
    pub last_seen: u64,
    /// Number of blocks sent by this peer
    pub blocks_sent: u64,
    /// Number of blocks received from this peer
    pub blocks_received: u64,
    /// Unix timestamp when connection was established
    pub connected_at: u64,
}

/// Overall network status from discovery
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkStatus {
    /// Total number of discovered peers
    pub peer_count: usize,
    /// List of discovered peers
    pub peers: Vec<DiscoveredPeer>,
    /// Number of bootstrap nodes that are reachable
    pub bootstrap_nodes_reachable: usize,
    /// Total number of configured bootstrap nodes
    pub bootstrap_nodes_total: usize,
    /// Unix timestamp of last network scan
    pub last_updated: u64,
    /// Network chain ID
    pub chain_id: Option<u64>,
    /// Current block height from queried nodes
    pub current_block: Option<u64>,
}

/// Network discovery manager
pub struct NetworkDiscovery {
    /// RPC endpoints to query
    rpc_endpoints: Vec<String>,
    /// Cached network status
    cached_status: Arc<Mutex<Option<NetworkStatus>>>,
}

impl NetworkDiscovery {
    /// Create a new network discovery instance
    pub fn new(bootstrap_nodes: Vec<String>, rpc_endpoint: String) -> Self {
        let mut endpoints = vec![rpc_endpoint];

        // Extract RPC endpoints from bootstrap node addresses
        // Bootstrap nodes are in format: snr://nodeaddress@host:p2p_port
        // RPC is typically on port 48638
        for node in bootstrap_nodes {
            if let Some(host) = extract_host_from_bootnode(&node) {
                endpoints.push(format!("http://{}:48638/rpc", host));
            }
        }

        // Deduplicate endpoints
        endpoints.sort();
        endpoints.dedup();

        Self {
            rpc_endpoints: endpoints,
            cached_status: Arc::new(Mutex::new(None)),
        }
    }

    /// Query network for peer information
    pub async fn discover_peers(&self) -> Result<NetworkStatus, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let mut all_peers: HashMap<String, DiscoveredPeer> = HashMap::new();
        let mut reachable_count = 0;
        let mut chain_id: Option<u64> = None;
        let mut current_block: Option<u64> = None;

        for endpoint in &self.rpc_endpoints {
            // Try to get peer info from this endpoint
            match query_peer_info(&client, endpoint).await {
                Ok(peers) => {
                    reachable_count += 1;
                    for peer in peers {
                        // Use address as unique key to avoid duplicates
                        all_peers.entry(peer.address.clone()).or_insert(peer);
                    }
                }
                Err(e) => {
                    eprintln!("Failed to query peers from {}: {}", endpoint, e);
                }
            }

            // Also try to get node info for chain_id and block height
            if chain_id.is_none() {
                if let Ok(info) = query_node_info(&client, endpoint).await {
                    chain_id = info.0;
                    current_block = info.1;
                }
            }
        }

        let status = NetworkStatus {
            peer_count: all_peers.len(),
            peers: all_peers.into_values().collect(),
            bootstrap_nodes_reachable: reachable_count,
            bootstrap_nodes_total: self.rpc_endpoints.len(),
            last_updated: current_timestamp(),
            chain_id,
            current_block,
        };

        // Cache the status
        *self.cached_status.lock().await = Some(status.clone());

        Ok(status)
    }

    /// Get cached status or fetch fresh if cache is stale (>30 seconds old)
    pub async fn get_network_status(&self) -> Result<NetworkStatus, String> {
        let cached = self.cached_status.lock().await;
        if let Some(status) = cached.as_ref() {
            // Use cached if less than 30 seconds old
            if current_timestamp() - status.last_updated < 30 {
                return Ok(status.clone());
            }
        }
        drop(cached);

        // Fetch fresh data
        self.discover_peers().await
    }

    /// Get the list of RPC endpoints being used
    pub fn get_endpoints(&self) -> &[String] {
        &self.rpc_endpoints
    }
}

/// Query synergy_getPeerInfo RPC method
async fn query_peer_info(
    client: &reqwest::Client,
    endpoint: &str,
) -> Result<Vec<DiscoveredPeer>, String> {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "synergy_getPeerInfo",
        "params": [],
        "id": 1
    });

    let response = client
        .post(endpoint)
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {}", e))?;

    // Check for RPC error
    if let Some(error) = json.get("error") {
        return Err(format!("RPC error: {:?}", error));
    }

    let result = json.get("result").ok_or("No result field in response")?;

    let peers_array = result
        .get("peers")
        .and_then(|p| p.as_array())
        .ok_or("No peers array in result")?;

    let discovered: Vec<DiscoveredPeer> =
        peers_array.iter().filter_map(|p| parse_peer(p)).collect();

    Ok(discovered)
}

/// Query synergy_nodeInfo RPC method
async fn query_node_info(
    client: &reqwest::Client,
    endpoint: &str,
) -> Result<(Option<u64>, Option<u64>), String> {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "synergy_nodeInfo",
        "params": [],
        "id": 1
    });

    let response = client
        .post(endpoint)
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {}", e))?;

    let result = json.get("result").ok_or("No result field in response")?;

    let chain_id = result
        .get("chainId")
        .or_else(|| result.get("chain_id"))
        .or_else(|| result.get("networkId"))
        .and_then(|v| v.as_u64());

    let current_block = result
        .get("currentBlock")
        .or_else(|| result.get("current_block"))
        .or_else(|| result.get("blockNumber"))
        .and_then(|v| v.as_u64());

    Ok((chain_id, current_block))
}

/// Parse a peer JSON object into a DiscoveredPeer
fn parse_peer(peer: &serde_json::Value) -> Option<DiscoveredPeer> {
    let address = peer
        .get("address")
        .or_else(|| peer.get("addr"))
        .or_else(|| peer.get("peer_address"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())?;

    let node_id = peer
        .get("node_id")
        .or_else(|| peer.get("nodeId"))
        .or_else(|| peer.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let version = peer
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let capabilities = peer
        .get("capabilities")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let last_seen = peer
        .get("last_seen")
        .or_else(|| peer.get("lastSeen"))
        .and_then(|v| v.as_u64())
        .unwrap_or_else(current_timestamp);

    let blocks_sent = peer
        .get("blocks_sent")
        .or_else(|| peer.get("blocksSent"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let blocks_received = peer
        .get("blocks_received")
        .or_else(|| peer.get("blocksReceived"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let connected_at = peer
        .get("connected_at")
        .or_else(|| peer.get("connectedAt"))
        .or_else(|| peer.get("connection_time"))
        .and_then(|v| v.as_u64())
        .unwrap_or_else(current_timestamp);

    Some(DiscoveredPeer {
        address,
        node_id,
        version,
        capabilities,
        last_seen,
        blocks_sent,
        blocks_received,
        connected_at,
    })
}

/// Extract host from bootnode address in snr:// or enode:// format
fn extract_host_from_bootnode(bootnode: &str) -> Option<String> {
    // Format: snr://nodeaddress@host:port or enode://nodeaddress@host:port
    let stripped = bootnode
        .strip_prefix("snr://")
        .or_else(|| bootnode.strip_prefix("enode://"))
        .unwrap_or(bootnode);

    // Split at @ to get the host:port part
    let after_at = stripped
        .rsplit_once('@')
        .map(|(_, right)| right)
        .unwrap_or(stripped);

    // Remove any path component
    let host_port = after_at.split('/').next().unwrap_or(after_at);

    // Extract just the host (without port)
    host_port.rsplit_once(':').map(|(host, _)| host.to_string())
}

/// Get current Unix timestamp
fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_host_from_bootnode() {
        assert_eq!(
            extract_host_from_bootnode("snr://synv11xyz@bootnode1.synergynode.xyz:38638"),
            Some("bootnode1.synergynode.xyz".to_string())
        );

        assert_eq!(
            extract_host_from_bootnode("enode://abc123@192.168.1.1:30303"),
            Some("192.168.1.1".to_string())
        );

        assert_eq!(
            extract_host_from_bootnode("localhost:8545"),
            Some("localhost".to_string())
        );
    }

    #[test]
    fn test_current_timestamp() {
        let ts = current_timestamp();
        assert!(ts > 1700000000); // After Nov 2023
    }
}
