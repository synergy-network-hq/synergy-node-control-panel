import React, { useState, useEffect } from "react";
import "../styles.css";
import { invoke, showSaveDialog as save, writeTextFile } from "../lib/desktopClient";

function formatMonitorTimestamp(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("node-details");
  const [nodeInfo, setNodeInfo] = useState(null);
  const [network, setNetwork] = useState("devnet");
  const [publicKey, setPublicKey] = useState("");
  const [monitorInventoryPath, setMonitorInventoryPath] = useState("");
  const [monitorCapturedAt, setMonitorCapturedAt] = useState("N/A");
  const [monitorRoleSummary, setMonitorRoleSummary] = useState("N/A");
  const [monitorTopologySummary, setMonitorTopologySummary] = useState("N/A");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadSettings() {
      try {
        setIsLoading(true);
        setError(null);

        // Get node information
        const nodeInfo = await invoke("get_node_info");
        setNodeInfo(nodeInfo);

        // Get current network setting
        const currentNetwork = await invoke("get_network_setting");
        setNetwork(currentNetwork);

        // Get public key if available
        if (nodeInfo && nodeInfo.public_key) {
          setPublicKey(nodeInfo.public_key);
        }

        // Load monitor metadata for the subtle Settings panel.
        try {
          await invoke("monitor_initialize_workspace");
          await invoke("monitor_apply_devnet_topology");
          const [inventoryPath, monitorSnapshot] = await Promise.all([
            invoke("get_monitor_inventory_path"),
            invoke("get_monitor_snapshot"),
          ]);
          setMonitorInventoryPath(inventoryPath || "");
          setMonitorCapturedAt(formatMonitorTimestamp(monitorSnapshot?.captured_at_utc));

          const nodes = Array.isArray(monitorSnapshot?.nodes) ? monitorSnapshot.nodes : [];
          const roleCounts = {};
          nodes.forEach((entry) => {
            const group = entry?.node?.role_group || "unknown";
            roleCounts[group] = (roleCounts[group] || 0) + 1;
          });
          const roleSummary = Object.entries(roleCounts)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([group, count]) => `${group}: ${count}`)
            .join(" | ");
          setMonitorRoleSummary(roleSummary || "N/A");
          setMonitorTopologySummary(
            "25 node slots are distributed across 13 physical machines (machine-01 through machine-13).",
          );
        } catch (monitorErr) {
          console.warn("Failed to load monitor metadata in settings:", monitorErr);
        }

      } catch (err) {
        console.error("Failed to load settings:", err);
        setError("Failed to load settings: " + err.message);
      } finally {
        setIsLoading(false);
      }
    }

    loadSettings();
  }, []);

  const handleNetworkChange = async (newNetwork) => {
    try {
      // For now, only allow devnet (as requested)
      if (newNetwork === "devnet") {
        setNetwork(newNetwork);
        await invoke("set_network_setting", { network: newNetwork });
      }
    } catch (err) {
      console.error("Failed to change network:", err);
      setError("Failed to change network: " + err.message);
    }
  };

  const downloadSecretKey = async () => {
    try {
      if (!nodeInfo || !nodeInfo.node_id) {
        throw new Error("No node information available");
      }

      // Get the secret key from the backend
      const secretKey = await invoke("get_secret_key", {
        nodeId: nodeInfo.node_id
      });

      if (!secretKey) {
        throw new Error("No secret key available for this node");
      }

      // Save as .txt file
      const filePath = await save({
        filters: [{
          name: 'Text Files',
          extensions: ['txt']
        }]
      });

      if (filePath) {
        await writeTextFile(filePath, secretKey);
      }

    } catch (err) {
      console.error("Failed to download secret key:", err);
      setError("Failed to download secret key: " + err.message);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => {
        // Show temporary feedback
        const originalText = document.getElementById('copy-button').textContent;
        document.getElementById('copy-button').textContent = '✓ Copied!';
        setTimeout(() => {
          document.getElementById('copy-button').textContent = originalText;
        }, 2000);
      })
      .catch(err => {
        console.error('Failed to copy:', err);
        setError("Failed to copy to clipboard");
      });
  };

  if (isLoading) {
    return (
      <div className="settings-container">
        <h2>Settings</h2>
        <p>Loading settings...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="settings-container">
        <h2>Settings</h2>
        <div className="error-message">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="settings-container">
      <h2>Settings</h2>

      <div className="settings-tabs">
        <button
          className={`tab-button ${activeTab === "node-details" ? "active" : ""}`}
          onClick={() => setActiveTab("node-details")}
        >
          Node Details
        </button>
        <button
          className={`tab-button ${activeTab === "network" ? "active" : ""}`}
          onClick={() => setActiveTab("network")}
        >
          Network
        </button>
        <button
          className={`tab-button ${activeTab === "keys" ? "active" : ""}`}
          onClick={() => setActiveTab("keys")}
        >
          Key Management
        </button>
      </div>

      <div className="settings-content">
        {activeTab === "node-details" && (
          <div className="node-details-section">
            <h3>Node Details</h3>

            {nodeInfo ? (
              <div className="node-info">
                <div className="info-row">
                  <span className="info-label">Node ID:</span>
                  <span className="info-value">{nodeInfo.node_id}</span>
                </div>

                <div className="info-row">
                  <span className="info-label">Node Type:</span>
                  <span className="info-value">{nodeInfo.node_type}</span>
                </div>

                <div className="info-row">
                  <span className="info-label">Node Class:</span>
                  <span className="info-value">{nodeInfo.node_class}</span>
                </div>

                <div className="info-row">
                  <span className="info-label">Status:</span>
                  <span className="info-value">{nodeInfo.is_running ? "Running" : "Stopped"}</span>
                </div>

                <div className="info-row">
                  <span className="info-label">Uptime:</span>
                  <span className="info-value">{nodeInfo.uptime || "N/A"}</span>
                </div>

                <div className="info-row">
                  <span className="info-label">Version:</span>
                  <span className="info-value">{nodeInfo.version || "Unknown"}</span>
                </div>
              </div>
            ) : (
              <p>No node information available. Please set up a node first.</p>
            )}
          </div>
        )}

        {activeTab === "network" && (
          <div className="network-section">
            <h3>Network Configuration</h3>

            <div className="network-setting">
              <label htmlFor="network-select">Network:</label>
              <select
                id="network-select"
                value={network}
                onChange={(e) => handleNetworkChange(e.target.value)}
                disabled={network !== "devnet"} // Only allow devnet for now
              >
                <option value="devnet">Devnet</option>
                <option value="testnet" disabled>Testnet (Coming Soon)</option>
                <option value="mainnet" disabled>Mainnet-Beta (Coming Soon)</option>
              </select>
              <p className="network-note">
                Note: Only Devnet is available at this time. Other networks will be enabled in future updates.
              </p>
            </div>

            <div className="network-info">
              <h4>Current Network Details</h4>
              <div className="info-row">
                <span className="info-label">Network Name:</span>
                <span className="info-value">Synergy Devnet</span>
              </div>
              <div className="info-row">
                <span className="info-label">Chain ID:</span>
                <span className="info-value">338638</span>
              </div>
              <div className="info-row">
                <span className="info-label">RPC Endpoint:</span>
                <span className="info-value">74.208.227.23:38638</span>
              </div>
              <div className="info-row">
                <span className="info-label">P2P Port:</span>
                <span className="info-value">33863 (Synergy Protocol)</span>
              </div>
              <div className="info-row">
                <span className="info-label">Node Identifier:</span>
                <span className="info-value">SNR (Synergy Node Record)</span>
              </div>
            </div>

            <div className="monitor-metadata-subtle">
              <h5>Monitor Metadata</h5>
              <p>
                Inventory:
                {" "}
                <code>{monitorInventoryPath || "Not resolved"}</code>
              </p>
              <p>
                Captured:
                {" "}
                <span>{monitorCapturedAt}</span>
              </p>
              <p>{monitorRoleSummary}</p>
              <p>
                Topology mode:
                {" "}
                {monitorTopologySummary}
              </p>
            </div>
          </div>
        )}

        {activeTab === "keys" && (
          <div className="key-management-section">
            <h3>Key Management</h3>

            {publicKey ? (
              <div className="key-info">
                <div className="key-section">
                  <h4>Public Key</h4>
                  <div className="key-display">
                    <code>{publicKey}</code>
                  </div>
                  <button
                    id="copy-button"
                    className="copy-button"
                    onClick={() => copyToClipboard(publicKey)}
                  >
                    Copy Public Key
                  </button>
                </div>

                <div className="key-section">
                  <h4>Secret Key</h4>
                  <p>Your secret key is securely stored and encrypted.</p>
                  <button
                    className="download-button"
                    onClick={downloadSecretKey}
                  >
                    Download Secret Key (.txt)
                  </button>
                  <p className="security-note">
                    ⚠️ Keep your secret key secure! Never share it with anyone.
                  </p>
                </div>
              </div>
            ) : (
              <p>No key information available. Please set up a node first.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
