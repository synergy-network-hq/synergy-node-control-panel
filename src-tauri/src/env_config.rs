use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri::Manager;

/// Environment-backed configuration for Synergy testbeta.
/// Values are sourced in the following precedence:
/// 1) Process environment variables
/// 2) App config directory .env (when present)
/// 3) Working directory .env (development)
/// 4) Embedded .env fallback (testbeta defaults)
#[derive(Debug, Clone)]
pub struct EnvConfig {
    pub network: String,
    pub chain_id: u64,
    pub bootstrap_nodes: Vec<String>,
    pub seed_servers: Vec<String>,
    pub bootstrap_dns_records: Vec<String>,
    pub rpc_endpoint: String,
    pub rpc_fallbacks: Vec<String>,
    pub ws_endpoint: String,
    pub api_endpoint: String,
    pub sxcp_api_endpoint: String,
    pub sxcp_ws_endpoint: String,
    pub aegis_verify_endpoint: String,
    pub explorer_endpoint: String,
    pub indexer_endpoint: String,
    pub faucet_endpoint: String,
    pub binary_name: String,
    pub unified_binary_url: String,
    pub binary_platform_linux_amd64: String,
    pub binary_platform_linux_arm64: String,
    pub binary_platform_darwin_amd64: String,
    pub binary_platform_darwin_arm64: String,
    pub binary_platform_windows_amd64: String,
    pub default_p2p_port: u16,
    pub default_rpc_port: u16,
    pub default_ws_port: u16,
    pub default_metrics_port: u16,
    pub build_from_source: bool,
}

impl EnvConfig {
    pub fn load(app_handle: Option<&AppHandle>) -> Result<Self, String> {
        let mut layered = LayeredEnv::new();

        layered.absorb_env_file(&Self::config_dir_env_path(app_handle)?)?;
        layered.absorb_env_file(&Self::cwd_env_path()?)?;
        layered.absorb_embedded_env()?;

        let network = layered.require_string("SYNERGY_NETWORK")?;
        let chain_id = layered.require_u64("SYNERGY_CHAIN_ID")?;
        let bootstrap_nodes = layered
            .require_string("SYNERGY_BOOTSTRAP_NODES")?
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .collect::<Vec<_>>();
        if bootstrap_nodes.is_empty() {
            return Err("SYNERGY_BOOTSTRAP_NODES is empty".to_string());
        }
        let seed_servers = layered
            .optional_string("SYNERGY_SEED_SERVERS")
            .map(|value| split_endpoints(&value))
            .unwrap_or_default();
        let bootstrap_dns_records = layered
            .optional_string("SYNERGY_BOOTSTRAP_DNS_RECORDS")
            .map(|value| split_endpoints(&value))
            .unwrap_or_default();

        let rpc_endpoint = layered.require_string("SYNERGY_RPC_ENDPOINT")?;
        let rpc_fallbacks = layered
            .optional_string("SYNERGY_RPC_FALLBACKS")
            .map(|value| split_endpoints(&value))
            .unwrap_or_default();
        let ws_endpoint = layered.require_string("SYNERGY_WS_ENDPOINT")?;
        let api_endpoint = layered.require_string("SYNERGY_API_ENDPOINT")?;

        // SXCP + Aegis endpoints are required for SXCP-enabled tooling, but we treat them as
        // optional to preserve backwards compatibility with older .env files.
        let sxcp_api_endpoint = layered
            .optional_string("SYNERGY_SXCP_API_ENDPOINT")
            .unwrap_or_else(|| match network.as_str() {
                "testbeta" => "https://testbeta-sxcp-api.synergy-network.io".to_string(),
                _ => String::new(),
            });
        let sxcp_ws_endpoint = layered
            .optional_string("SYNERGY_SXCP_WS_ENDPOINT")
            .unwrap_or_else(|| match network.as_str() {
                "testbeta" => "wss://testbeta-sxcp-ws.synergy-network.io".to_string(),
                _ => String::new(),
            });
        let aegis_verify_endpoint = layered
            .optional_string("SYNERGY_AEGIS_VERIFY_ENDPOINT")
            .unwrap_or_else(|| match network.as_str() {
                "testbeta" => "https://testbeta-aegis-verify.synergy-network.io".to_string(),
                _ => String::new(),
            });

        let explorer_endpoint = layered.require_string("SYNERGY_EXPLORER_ENDPOINT")?;
        let indexer_endpoint = layered.require_string("SYNERGY_INDEXER_ENDPOINT")?;
        let faucet_endpoint = layered.require_string("SYNERGY_FAUCET_ENDPOINT")?;
        let binary_name = layered.require_string("SYNERGY_BINARY_NAME")?;
        let unified_binary_url = layered.require_string("SYNERGY_UNIFIED_BINARY_URL")?;

        let default_p2p_port = layered.require_u16("SYNERGY_DEFAULT_P2P_PORT")?;
        let default_rpc_port = layered.require_u16("SYNERGY_DEFAULT_RPC_PORT")?;
        let default_ws_port = layered.require_u16("SYNERGY_DEFAULT_WS_PORT")?;
        let default_metrics_port = layered.require_u16("SYNERGY_DEFAULT_METRICS_PORT")?;

        let build_from_source = layered
            .require_bool("SYNERGY_BUILD_FROM_SOURCE")
            .unwrap_or(false);

        let config = Self {
            network,
            chain_id,
            bootstrap_nodes,
            seed_servers,
            bootstrap_dns_records,
            rpc_endpoint,
            rpc_fallbacks,
            ws_endpoint,
            api_endpoint,
            sxcp_api_endpoint,
            sxcp_ws_endpoint,
            aegis_verify_endpoint,
            explorer_endpoint,
            indexer_endpoint,
            faucet_endpoint,
            binary_name,
            unified_binary_url,
            binary_platform_linux_amd64: layered
                .require_string("SYNERGY_BINARY_PLATFORM_LINUX_AMD64")?,
            binary_platform_linux_arm64: layered
                .require_string("SYNERGY_BINARY_PLATFORM_LINUX_ARM64")?,
            binary_platform_darwin_amd64: layered
                .require_string("SYNERGY_BINARY_PLATFORM_DARWIN_AMD64")?,
            binary_platform_darwin_arm64: layered
                .require_string("SYNERGY_BINARY_PLATFORM_DARWIN_ARM64")?,
            binary_platform_windows_amd64: layered
                .require_string("SYNERGY_BINARY_PLATFORM_WINDOWS_AMD64")?,
            default_p2p_port,
            default_rpc_port,
            default_ws_port,
            default_metrics_port,
            build_from_source,
        };

        // Persist a resolved .env into the config directory for packaged builds if missing.
        if let Some(config_env_path) = Self::config_dir_env_path(app_handle)? {
            if let Some(parent) = config_env_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create config dir: {}", e))?;
            }
            if !config_env_path.exists() {
                layered.persist(&config_env_path)?;
            }
        }

        Ok(config)
    }

    pub fn platform_key(&self) -> String {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        return self.binary_platform_darwin_arm64.clone();

        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        return self.binary_platform_darwin_amd64.clone();

        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        return self.binary_platform_linux_amd64.clone();

        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        return self.binary_platform_linux_arm64.clone();

        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        return self.binary_platform_windows_amd64.clone();

        #[allow(unreachable_code)]
        "unsupported".to_string()
    }

    pub fn rpc_endpoints(&self) -> Vec<String> {
        let mut endpoints = Vec::new();
        endpoints.extend(split_endpoints(&self.rpc_endpoint));
        endpoints.extend(self.rpc_fallbacks.iter().cloned());

        let mut unique = endpoints
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>();
        unique.sort();
        unique.dedup();
        unique
    }

    fn cwd_env_path() -> Result<Option<PathBuf>, String> {
        let cwd = env::current_dir().map_err(|e| format!("Failed to read current dir: {}", e))?;
        Ok(Some(cwd.join(".env")))
    }

    fn config_dir_env_path(app_handle: Option<&AppHandle>) -> Result<Option<PathBuf>, String> {
        if let Some(handle) = app_handle {
            if let Ok(path) = handle.path().app_config_dir() {
                return Ok(Some(path.join(".env")));
            }
        }

        if let Some(base) = dirs::config_dir() {
            return Ok(Some(
                base.join("synergy").join("control-panel").join(".env"),
            ));
        }

        Ok(None)
    }
}

struct LayeredEnv {
    files: HashMap<String, String>,
}

impl LayeredEnv {
    fn new() -> Self {
        Self {
            files: HashMap::new(),
        }
    }

    fn absorb_env_file(&mut self, path: &Option<PathBuf>) -> Result<(), String> {
        if let Some(p) = path {
            if p.exists() {
                // Try strict parser first; if it fails (e.g., unquoted spaces), fall back to tolerant parser.
                match dotenvy::from_path_iter(p) {
                    Ok(iter) => {
                        for item in iter {
                            let (k, v) = item
                                .map_err(|e| format!("Failed to parse {}: {}", p.display(), e))?;
                            self.files.entry(k).or_insert(v);
                        }
                    }
                    Err(_) => {
                        let content = fs::read_to_string(p)
                            .map_err(|e| format!("Failed to read {}: {}", p.display(), e))?;
                        for (k, v) in parse_lines(&content) {
                            self.files.entry(k).or_insert(v);
                        }
                    }
                };
            }
        }
        Ok(())
    }

    fn absorb_embedded_env(&mut self) -> Result<(), String> {
        let embedded = include_str!("../../.env");
        for (k, v) in parse_lines(embedded) {
            self.files.entry(k).or_insert(v);
        }
        Ok(())
    }

    fn require_string(&self, key: &str) -> Result<String, String> {
        if let Ok(val) = env::var(key) {
            if !val.is_empty() {
                return Ok(val);
            }
        }
        if let Some(val) = self.files.get(key) {
            if !val.is_empty() {
                return Ok(val.clone());
            }
        }
        Err(format!("Missing required env var: {}", key))
    }

    fn require_u64(&self, key: &str) -> Result<u64, String> {
        let raw = self.require_string(key)?;
        raw.parse::<u64>()
            .map_err(|e| format!("Invalid value for {}: {}", key, e))
    }

    fn require_u16(&self, key: &str) -> Result<u16, String> {
        let raw = self.require_string(key)?;
        raw.parse::<u16>()
            .map_err(|e| format!("Invalid value for {}: {}", key, e))
    }

    fn require_bool(&self, key: &str) -> Result<bool, String> {
        let raw = self.require_string(key)?;
        raw.parse::<bool>()
            .map_err(|e| format!("Invalid value for {}: {}", key, e))
    }

    fn optional_string(&self, key: &str) -> Option<String> {
        if let Ok(val) = env::var(key) {
            if !val.is_empty() {
                return Some(val);
            }
        }
        self.files.get(key).filter(|val| !val.is_empty()).cloned()
    }

    fn persist(&self, path: &Path) -> Result<(), String> {
        let mut buffer = String::new();
        for (k, v) in &self.files {
            buffer.push_str(&format!("{}={}\n", k, v));
        }

        let mut file = fs::File::create(path)
            .map_err(|e| format!("Failed to create {}: {}", path.display(), e))?;
        file.write_all(buffer.as_bytes())
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
        Ok(())
    }
}

fn parse_lines(content: &str) -> Vec<(String, String)> {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return None;
            }
            let mut parts = trimmed.splitn(2, '=');
            let key = parts.next()?.trim();
            let value = parts.next().unwrap_or("").trim_start();
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

fn split_endpoints(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.to_string())
        .collect()
}
