# WireGuard Reference Data

This directory is bundled only as reference metadata for the existing VPN.

The control panel does not generate or deploy WireGuard configs from here.

Default hub settings:
- public IP: `64.227.107.57`
- VPN IP: `10.50.0.254`
- port: `51820`

Authoritative deployed inventory:
- `deployed-topology.json`: live hub/peer VPN IPs, listen ports, and public keys used by the existing network
- Private keys are intentionally excluded; the control panel should not treat this repo as the source of truth for WireGuard secrets
