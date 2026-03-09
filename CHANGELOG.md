# Changelog

Historical release notes reconstructed from local git tag ranges for the control panel versions shown in the screenshots. Where the underlying commits were too generic to support a precise summary, the entry is marked as a maintenance release with broader wording.

## v2.9.2 - 2026-03-08
- Updated the `synergy-devnet-agent` sidecar crate dependencies, including adding `reqwest` to support follow-on agent networking and sync work.
- Maintenance release with no large UI or workflow delta clearly exposed in the tag range.

## v2.8.3 - 2026-03-08
- Added placeholder lab surfaces for `Test Transactions` and `Let's Break Stuff`, built on a reusable `FutureLabPage` and new supporting styles.
- Expanded updater handling with version comparison helpers and Linux install-mode awareness.
- Refined monitor and backend integration around topology-aware node views and app update behavior.

## v2.8.1 - 2026-03-08
- Regenerated `lean15` installer bundles after topology changes across the devnet fleet.
- Updated per-node install/start scripts and binary status markers.
- Primarily a topology and installer refresh release.

## v2.8.0 - 2026-03-08
- Hardened fleet sync behavior and dashboard machine metadata handling.
- Fixed Windows installer refresh when a node binary is already running.
- Reworked `lean15` topology assets, including genesis data, node roles, hosts examples, installer configs, and cross-platform install scripts.

## v2.7.2 - 2026-03-07
- Fixed Windows node setup scripts and process launch behavior to avoid broken or stuck installs.
- Added stronger stop/restart cleanup in the devnet agent so orphaned node processes are killed before resets or restarts.
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
- Split `synergy-devnet-agent` into a dedicated sidecar crate and updated sidecar builds to use the new manifest and target directory.
- Strengthened release asset generation by normalizing filenames, validating `latest.json`, URL-encoding asset names, and requiring updater signatures.
- Refined topology application and machine-control plumbing, including regenerated `hosts.env`, fallback node-address discovery, and remote-path normalization.
- Refreshed a large set of generated installer and sidecar artifacts as part of the release.

## v2.6.8 - 2026-03-06
- Added the WireGuard-based machine agent used for fleet control.
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
- Updated `lean15` machine installer configs and validator allowlists in the node inventory.
- Temporarily disabled the in-app updater path and removed updater UI while signing and release configuration was being corrected.
- Simplified release workflow signing setup during that transition.

## v2.2.4 - 2026-03-04
- Maintenance/versioning release. The tag range does not show clear functional changes beyond version and package metadata updates.
- Various fixes and improvements.

## v2.0.7 - 2026-03-03
- Updated node inventory and orchestration scripts to better handle multiple logical nodes sharing a physical machine.
- Improved WireGuard mesh generation so shared physical machines reuse the same machine-level network identity.
- Added stale-process cleanup to remote stop, restart, and reset flows, and refreshed setup/operator UI around the updated topology.

## v2.0.6 - 2026-03-03
- Added explicit release versioning updates in the GitHub Actions workflow and release messaging.
- Fixed Windows multi-node stop handling by invoking `taskkill` during forced shutdown cleanup.
