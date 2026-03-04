Synergy Lean 15 Devnet Installer
================================

Machine: machine-10
Role Group: governance
Role: security-council
Node Type: security-council

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
- Windows firewall automation uses New-NetFirewallRule when run as Administrator.
- This folder is self-contained for this node instance.
- Public DNS should resolve to public hosts only; never point public DNS at private VPN IPs.
- Binary provenance:
  - Linux: fallback-prebuilt(binaries/synergy-devnet-linux-amd64)
  - macOS: fresh-local-build(target/release/synergy-devnet)
  - Windows: fallback-prebuilt(binaries/synergy-devnet-windows-amd64.exe)
- See BINARY_STATUS.txt for SHA-256 checksums and build-source details.
