# Changelog

Historical release notes reconstructed from local git tag ranges for the control panel versions shown in the screenshots. Where the underlying commits were too generic to support a precise summary, the entry is marked as a maintenance release with broader wording.

## v5.12.1 - 2026-04-03

- Corrected the Testnet-Beta release source pin so installer builds now compile `synergy-testbeta` from commit `476a159956eaeffe5d6f4cb4c1caf94156828716`, which includes the runtime-root detection fix required for validator workspaces launched outside the source checkout.
- Preserved the v5.12.0 control-service launcher fix that exports `SYNERGY_PROJECT_ROOT` and `SYNERGY_CONFIG_PATH`, while ensuring the bundled node binary now understands those runtime-root environment variables too.
- Disabled submodule cleanup for the pinned Testnet-Beta checkout in the release workflow so GitHub Actions no longer trips over the broken `node-control-panel` gitlink metadata during post-job cleanup.

## v5.12.0 - 2026-04-03

- Fixed Testnet-Beta node launches from generated validator workspaces by exporting `SYNERGY_PROJECT_ROOT` and `SYNERGY_CONFIG_PATH` into every control-service runner invocation, which stops the validator restart loop caused by runtime root detection failures.
- Added focused regression coverage for workspace-scoped runner environment propagation and strengthened the start-path test so it validates the local RPC readiness gate instead of depending on an ambient service on the default port.
- Regenerated the bundled testbeta runtime assets and installer bundles for the repaired workspace launch flow.

## v5.11.3 - 2026-04-03

- Fixed Jarvis Genesis Setup so validator `setup-package.json` files remain package-driven from selection through import instead of dropping into a manual ceremony-role prompt when the package role should already be known.
- Hardened ceremony import so the control service can infer the role directly from the approved validator package when no manual role is supplied, while preserving the explicit bootstrap-bundle role path for legacy bootnode and seed archives.
- Kept the discovery-only bootnode genesis-hash handshake allowance verified in the testbeta runtime and rebuilt the control-panel installers around the repaired Genesis Setup flow.

## v5.11.2 - 2026-04-02

- Completed the monitor/control-service rename from `vpn_ip` detection to machine-level `management_host` detection so the setup wizard, monitor dashboard, node page, and operator agent snapshot all use the same identity model.
- Fixed the headless control-service release build by shipping the matching monitor API and agent-health fields instead of a partial command rename.
- Regenerated the bundled `testbeta/runtime` assets and installers for the repaired release tag.

## v5.11.1 - 2026-04-02

- Reworked Jarvis genesis setup so the ceremony flow starts with the assigned setup package JSON, derives the role from that package, and pauses on an explicit machine-specific port-forwarding confirmation before sending the operator to the dashboard.
- Fixed the Testnet-Beta node details tabs so shared runtime/network values are available across the wallet and connectivity views instead of throwing render-time errors when those tabs open.
- Added the developer-mode live peer list to the node-details Connectivity tab and reduced initial dashboard/detail latency by caching local state and parallelizing the control-service live-status network probes.

## v5.11.0 - 2026-04-02

- Added a Settings-level `Developer Mode` toggle and exposed the live peer list on the dashboard Connectivity tab when that mode is enabled.
- Refreshed the bundled testbeta runtime defaults for genesis launch: removed the hard `max_validators = 4` ceiling while preserving `min_validators = 4`, and regenerated the runtime/genesis assets accordingly.
- Pinned the installer release workflow to the updated testbeta source commit that includes real network vote collection, explicit equivocation evidence handling, rolling missed-vote jailing/slashing, and the current RPC/runtime fixes needed for fresh binaries.

## v5.10.5 - 2026-04-02

- Fixed genesis validator crash loop on macOS arm64: the `synergy-testbeta-macos-arm64` binary search was incorrectly taking priority over the fixed `synergy-testbeta-darwin-arm64` binary. The control service binary search order now tries `darwin-arm64` first, with `macos-arm64` as a fallback only. The `macos-arm64` binary on disk has also been replaced with the fixed `darwin-arm64` build. This restored all 4 genesis validators to active quorum (`qc_cumulative_weight: 4.0`).
- Removed confidential payout equation from node detail view: `payoutEquation` no longer renders in the Rewards Standard definition panel or any associated copy-block paragraphs.
- Dashboard overhaul across all tabs: replaced the 4-card status grid and verbose Network Overview panel with a compact inline status strip showing live network metrics. Stripped all non-data description text from Connectivity, Rewards, Files, and Chain tabs. Added copy-to-clipboard buttons next to node and wallet addresses. Added "Open Workspace" and "Open Logs" directory shortcuts to the Files tab.
- Settings page enhancements: added "Check for Updates" button with live status feedback wired to the Electron auto-updater bridge. Added "Refresh All Bootstrap" to re-fetch and rewrite `peers.toml` from live seed servers for all nodes in one action. Workspace Inventory now shows direct "Logs" and "Details →" links per node.
- Connectivity tab: removed redundant stat descriptions from SXCP cards; fallback discovery sequence now displayed inline as a single `A → B → C` chain instead of a two-column grid.

## v5.10.3 - 2026-04-01
- Bundled updated testbeta node binaries (darwin-arm64, linux-amd64, windows-amd64) built from the mutex deadlock fix in `token.rs` and the seed-server registration fix in `networking.rs`.
- Redesigned the Settings page Operator Console button section: buttons are now grouped in compact inline rows with distinct color-coded group labels (Services, Connectivity, Processes, Logs) instead of large card layouts.
- Added new operator actions: Show Disk Usage, Flush DNS Cache, Find Zombie Processes, Kill Zombie Processes, Kill All Nodes, Tail Node Logs, Clear Log Files.

## v2.9.2 - 2026-03-08
- Updated the `synergy-testbeta-agent` sidecar crate dependencies, including adding `reqwest` to support follow-on agent networking and sync work.
- Maintenance release with no large UI or workflow delta clearly exposed in the tag range.

## v2.8.3 - 2026-03-08
- Added placeholder lab surfaces for `Test Transactions` and `Let's Break Stuff`, built on a reusable `FutureLabPage` and new supporting styles.
- Expanded updater handling with version comparison helpers and Linux install-mode awareness.
- Refined monitor and backend integration around topology-aware node views and app update behavior.

## v2.8.1 - 2026-03-08
- Regenerated `runtime` installer bundles after topology changes across the testbeta fleet.
- Updated per-node install/start scripts and binary status markers.
- Primarily a topology and installer refresh release.

## v2.8.0 - 2026-03-08
- Hardened fleet sync behavior and dashboard machine metadata handling.
- Fixed Windows installer refresh when a node binary is already running.
- Reworked `runtime` topology assets, including genesis data, node roles, hosts examples, installer configs, and cross-platform install scripts.

## v2.7.2 - 2026-03-07
- Fixed Windows node setup scripts and process launch behavior to avoid broken or stuck installs.
- Added stronger stop/restart cleanup in the testbeta agent so orphaned node processes are killed before resets or restarts.
- Improved updater UX with app relaunch support and clearer Linux manual-update messaging.

## v2.7.1 - 2026-03-07
- Prevented setup freezes by offloading long-running agent and terminal commands and increasing timeouts for setup, start, and reset operations.
- Added fleet-control functions and resume logic so setup can infer the target machine from existing SSH bindings when VPN detection is unavailable.
- Cleaned up chain ID presentation so the dashboard shows the observed value directly instead of rewriting it.

## v2.6.11 - 2026-03-06
- Fixed Windows PowerShell command execution in the monitor terminal runner, including quoted-argument handling.
- Prevented partial installer rebuilds by making installer output paths configurable and tightening release preflight behavior.
- Reliability release focused on Windows setup and release-pipeline stability.

## v2.6.10 - 2026-03-06
- Split `synergy-testbeta-agent` into a dedicated sidecar crate and updated sidecar builds to use the new manifest and target directory.
- Strengthened release asset generation by normalizing filenames, validating `latest.json`, URL-encoding asset names, and requiring updater signatures.
- Refined topology application and machine-control plumbing, including regenerated `hosts.env`, fallback node-address discovery, and remote-path normalization.
- Refreshed a large set of generated installer and sidecar artifacts as part of the release.

## v2.6.8 - 2026-03-06
- Added the machine agent used for fleet control.
- Added agent reachability visibility in the control panel.
- Clarified the difference between machines and nodes across inventory, tooling, and fleet-control flows.
- Various fixes and improvements around the fleet-control rollout.

## v2.6.4 - 2026-03-06
- Fixed Linux installer refresh failures caused by `ETXTBSY` when replacing in-use binaries.
- Maintenance release focused on installer-asset refresh reliability.

## v2.6.3 - 2026-03-06
- Fixed monitor startup recursion.
- Stability release for monitor boot and initialization.

## v2.6.2 - 2026-03-06
- Restored the macOS updater bundle target in the release pipeline, including special handling for Intel mac builds.
- Added missing workflow permissions to satisfy code-scanning and security requirements.

## v2.4.2 - 2026-03-04
- Updated `runtime` machine installer configs and validator allowlists in the node inventory.
- Temporarily disabled the in-app updater path and removed updater UI while signing and release configuration was being corrected.
- Simplified release workflow signing setup during that transition.

## v2.2.4 - 2026-03-04
- Maintenance/versioning release. The tag range does not show clear functional changes beyond version and package metadata updates.
- Various fixes and improvements.

## v2.0.7 - 2026-03-03
- Updated node inventory and orchestration scripts to better handle multiple logical nodes sharing a physical machine.
- Improved machine-level network generation so shared physical machines reuse the same machine-level identity.
- Added stale-process cleanup to remote stop, restart, and reset flows, and refreshed setup/operator UI around the updated topology.

## v2.0.6 - 2026-03-03
- Added explicit release versioning updates in the GitHub Actions workflow and release messaging.
- Fixed Windows multi-node stop handling by invoking `taskkill` during forced shutdown cleanup.
