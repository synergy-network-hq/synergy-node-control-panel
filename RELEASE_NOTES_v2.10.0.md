# Release Notes — v2.10.0

**Release date:** 2026-03-09

---

## Overview

v2.10.0 introduces **remote agent lifecycle management** — the ability to push, install, and restart the `synergy-testbeta-agent` binary on remote machines directly from the control panel, without ever needing a manual SSH session. This closes the bootstrapping gap: previously, nodes whose agent was missing or running an outdated binary fell permanently offline with no recovery path inside the app. Now they can be repaired in one click.

---

## New Features

### Remote Agent Deployment (`deploy_agent` / Update Agent)

A new orchestrator action — `deploy_agent` — performs a full one-time SSH bootstrap of the `synergy-testbeta-agent` service on any remote machine.

**What it does:**

1. Detects the remote OS and CPU architecture (`uname -s` / `uname -m`) to select the correct pre-compiled binary.
2. Copies `node-inventory.csv` and `hosts.env` to the agent's workspace directory on the remote machine so it has the metadata it needs.
3. SCPs the matching `synergy-testbeta-agent-<platform>` binary (built by `scripts/build-sidecars.sh`) to `/opt/synergy/testbeta-agent/`.
4. Installs and starts the agent as a **systemd service** (`synergy-testbeta-agent.service`) if systemd is available; falls back to a `nohup` background process otherwise.
5. Restarts the service if it is already running, picking up the new binary.

**Routing:** This action always travels through the SSH orchestrator path — it never goes through the agent HTTP endpoint. This is intentional: the whole point is to recover agents that are absent, crashed, or running a binary that predates a given API surface (e.g. the `sync_node` action added in v2.9.4).

**Local nodes are skipped** automatically — if the node is on the same machine as the control panel, the action prints an informational message and exits cleanly (the local agent is bundled with the Electron app and is updated by rebuilding the app).

**Prerequisite:** Run `scripts/build-sidecars.sh` before using this action to ensure platform-matched binaries exist in the `binaries/` directory.

---

### "Update Agent" button — Node Detail Page

A new **Update Agent** button has been added to the node control panel on the node detail page, positioned between Sync Node and Reset Chain (Genesis).

- Styled in a distinct **teal/violet** color (`monitor-btn-agent`) to distinguish infrastructure-level actions from node lifecycle (blue), danger (red), and warning (amber) operations.
- Disabled when `update_agent_configured` is false (e.g. local-target nodes where SSH deployment is not applicable).
- Shows a confirmation dialog explaining the SSH mechanism and the `build-sidecars.sh` prerequisite before proceeding.
- Displays `Updating Agent...` while the operation is in progress, locking out other control actions for that node.

---

### "Update All Agents" button — Fleet Control Bar

A new **Update All Agents** fleet button has been added to the dashboard control bar, positioned between Sync All and Reset Chain to Genesis.

- Triggers the `deploy_agent` orchestrator action across all nodes in parallel via the standard fleet execution path.
- Uses the same teal/violet styling as the per-node button for visual consistency.
- Opens a modal confirmation dialog that:
  - States how many nodes are targeted.
  - Explains that local nodes are skipped automatically.
  - Reminds the operator to run `scripts/build-sidecars.sh` first.
- Result banner shows **"Agent update complete: X succeeded, Y failed"** on completion.

---

## Backend Changes

### `scripts/testbeta/remote-node-orchestrator.sh`

- Added `deploy_agent` to the script's usage documentation.
- Implemented the `deploy_agent()` function (~80 lines): platform detection, binary selection, workspace file sync, SCP, systemd service setup with sudo fallback, nohup fallback for non-systemd hosts.
- Added `deploy_agent)` case to the main action dispatcher.

### `control-service/src/monitor.rs`

- `MonitorControlCapabilities` struct: new `update_agent_configured: bool` field with doc comment.
- `resolve_control_commands()`: added `("update_agent", "deploy_agent")` to `default_custom_actions` — auto-wires the orchestrator command for every node without requiring explicit `hosts.env` entries.
- `build_control_capabilities()`: `update_agent` added to the role/infrastructure operation exclusion list so it does not appear in the generic "Custom Actions" section; `update_agent_configured` computed and surfaced in the capabilities payload.

### `src/styles/monitor.css`

- New `.monitor-btn-agent` class: teal (`rgba(0,210,180)`) to violet (`rgba(128,90,213)`) gradient, distinct from all existing button variants.

---

## Bug Fixes

- **node-04 / node-06 permanently OFFLINE:** Root cause identified — `synergy-testbeta-agent` was not deployed on the underlying machines (machine-03 at `10.50.0.3`, machine-04 at `10.50.0.4`). The `ssh … curl -sf http://127.0.0.1:47990/…` command pattern used by those nodes silently swallowed all errors when the agent was absent. Running **Update Agent** on those nodes deploys the agent and unblocks Start/Stop/Reset.
- **`sync_node` failing with "Unsupported testbeta agent action":** Remote agent binaries pre-dating v2.9.4 do not advertise `sync_node` in their supported action list. Running **Update Agent** redeploys the current binary and resolves the error.

---

## Upgrade Notes

1. **Build the agent binaries first:**
   ```bash
   scripts/build-sidecars.sh
   ```
   This compiles `synergy-testbeta-agent` for the current host platform and outputs the binary to `binaries/`. For cross-platform deployments (Mac control panel → Linux remotes), ensure your build environment produces a `binaries/synergy-testbeta-agent-linux-amd64` or `-linux-arm64` binary.

2. **Deploy to offline/stale-agent nodes:**
   - Navigate to any node that is OFFLINE or showing `sync_node` errors → click **Update Agent**.
   - Or use **Update All Agents** from the dashboard to push to the entire fleet at once.

3. **No hosts.env changes required.** The `update_agent` action is auto-wired via the orchestrator `default_custom_actions` mechanism for all nodes. No per-node `NODE_XX_ACTION_UPDATE_AGENT_CMD` entries are needed.

4. **Local node (node-01):** The Update Agent button is a no-op for local nodes — they are handled by the Electron desktop shell. To update the local agent, rebuild and relaunch the app.

---

## Files Changed

| File | Change |
|---|---|
| `scripts/testbeta/remote-node-orchestrator.sh` | +132 lines — `deploy_agent` action implementation |
| `control-service/src/monitor.rs` | +14 lines — capability struct field, default action wiring, capability computation |
| `src/components/NetworkMonitorDashboard.jsx` | +38 lines — Update All Agents button, fleet confirm dialog, result banner |
| `src/components/NetworkMonitorNodePage.jsx` | +15 lines — Update Agent button |
| `src/styles/monitor.css` | +11 lines — `.monitor-btn-agent` style |

---

*Previous release: [v2.9.4](./RELEASE_NOTES_v2.9.4.md) — sync_node / nodectl sync support*
