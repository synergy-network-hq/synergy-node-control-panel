use reqwest;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct RpcClient {
    client: reqwest::Client,
    endpoint: String,
}

#[derive(Debug, Deserialize)]
pub struct RpcResponse<T> {
    pub jsonrpc: String,
    pub id: u64,
    pub result: Option<T>,
    pub error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcClient {
    pub fn new(endpoint: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        Self { client, endpoint }
    }

    pub async fn call_method<T>(&self, method: &str, params: Value) -> Result<T, String>
    where
        T: for<'de> Deserialize<'de>,
    {
        let request_body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        });

        let response = self
            .client
            .post(&self.endpoint)
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("Failed to send RPC request: {}", e))?;

        let response_text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read RPC response: {}", e))?;

        let rpc_response: RpcResponse<T> = serde_json::from_str(&response_text)
            .map_err(|e| format!("Failed to parse RPC response: {}", e))?;

        match rpc_response.error {
            Some(error) => Err(format!("RPC error {}: {}", error.code, error.message)),
            None => rpc_response
                .result
                .ok_or_else(|| "RPC response has no result".to_string()),
        }
    }

    pub async fn get_block_number(&self) -> Result<u64, String> {
        let result: String = self.call_method("synergy_blockNumber", json!([])).await?;
        let block_number = u64::from_str_radix(result.trim_start_matches("0x"), 16)
            .map_err(|e| format!("Failed to parse block number: {}", e))?;
        Ok(block_number)
    }

    pub async fn get_network_peers(&self) -> Result<Vec<String>, String> {
        let peers: Vec<String> = self.call_method("synergy_getPeers", json!([])).await?;
        Ok(peers)
    }

    pub async fn get_synergy_score(&self, address: &str) -> Result<f64, String> {
        let result: Value = self
            .call_method("synergy_getSynergyScore", json!([address]))
            .await?;

        if let Some(score) = result.as_f64() {
            Ok(score)
        } else {
            Err("Invalid synergy score format".to_string())
        }
    }

    pub async fn get_validator_info(&self, address: &str) -> Result<Value, String> {
        let result: Value = self
            .call_method("synergy_getValidatorInfo", json!([address]))
            .await?;
        Ok(result)
    }

    pub async fn get_validator_cluster_id(&self, address: &str) -> Result<Option<u64>, String> {
        let validator_info = self.get_validator_info(address).await?;
        Ok(validator_info.get("cluster_id").and_then(|id| id.as_u64()))
    }

    pub async fn get_block_by_number(&self, block_number: u64) -> Result<Value, String> {
        let block_hex = format!("0x{:x}", block_number);
        let result: Value = self
            .call_method("synergy_getBlockByNumber", json!([block_hex, false]))
            .await?;
        Ok(result)
    }

    pub async fn get_validators(&self) -> Result<Vec<Value>, String> {
        let result: Vec<Value> = self.call_method("synergy_getValidators", json!([])).await?;
        Ok(result)
    }

    pub async fn get_node_info(&self, address: &str) -> Result<Value, String> {
        let result: Value = self
            .call_method("synergy_getNodeInfo", json!([address]))
            .await?;
        Ok(result)
    }

    pub async fn get_network_info(&self) -> Result<Value, String> {
        let result: Value = self
            .call_method("synergy_getNetworkInfo", json!([]))
            .await?;
        Ok(result)
    }
}
