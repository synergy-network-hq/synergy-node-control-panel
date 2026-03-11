Synergy Lean 15 Devnet Installer
================================

Node Slot: node-12
Role Group: interop
Role: witness
Node Type: witness

Quick Start (Linux/macOS)
-------------------------
1) Copy this entire folder to the target machine.
2) Run:
   ./install_and_start.sh
3) Verify:
   ./nodectl.sh status
   ./nodectl.sh logs --follow

Quick Start (Windows)
---------------------
1) Copy this entire folder to the target machine.
2) Run in PowerShell:
   powershell -ExecutionPolicy Bypass -File .\install_and_start.ps1
3) Verify:
   powershell -ExecutionPolicy Bypass -File .\nodectl.ps1 status
   powershell -ExecutionPolicy Bypass -File .\nodectl.ps1 logs -Follow

Notes
-----
- The installer includes Linux x86_64, macOS arm64, and Windows x86_64 binaries.
- Linux firewall automation supports ufw, firewalld, and iptables.
- In WireGuard mode, firewall rules are scoped to VPN CIDR traffic.
- Windows firewall automation prompts for elevation when needed and otherwise prints the required TCP ports.
- This folder is self-contained for this node instance.
- Public DNS should resolve to public hosts only; never point public DNS at private VPN IPs.
- See BINARY_STATUS.txt for bundled binary paths and SHA-256 checksums.
