# Technical Specification: Testnet-Beta Transport Migration

**Document Status:** Draft
**Version:** 0.1
**Date:** 2026-03-10

## Executive Summary

The current control panel is built for a closed testbeta with WireGuard-only reachability, VPN-based machine identity, and agent trust derived from the private `10.50.0.0/24` network. That model is causing operational friction and does not fit a broader testnet-beta where each node publishes its own stable public endpoint.

The migration target is a public-endpoint testnet-beta where:
- every node has a public RPC hostname such as `node0202.synergynode.net`
- node health and status checks use public endpoints
- local same-machine operations do not require VPN identity
- remote control is no longer coupled to "must be on WireGuard"

## Problem

The current design assumes:
- `host` and `vpn_ip` are effectively the same private address
- local machine identity is derived from a `10.50.0.x` address
- the testbeta agent is reachable only from WireGuard peers
- installer generation rewrites config and inventory around private overlay addresses

That is appropriate for a closed testbeta and inappropriate for a public testnet-beta.

## Goals

- Support public per-node RPC endpoints in inventory.
- Decouple read-path monitoring from private control transport.
- Allow same-machine local actions without VPN detection.
- Preserve backward compatibility while the old testbeta profile still exists.

## Non-Goals

- Exposing the current unauthenticated testbeta agent directly to the public internet.
- Rewriting the entire testbeta/bootstrap pipeline in one cutover.
- Removing every WireGuard code path in the same change.

## Transport Model

### Read Path

Public status, RPC, and diagnostics should use explicit public endpoint data from inventory:
- `public_rpc_url`
- `public_rpc_host`
- `rpc_host`
- `public_host`

These fields are ordered from most explicit to least explicit. If none are present, the system falls back to the current `host` field.

### Control Path

Control must be separated from public RPC:
- local same-machine actions can run `nodectl` directly
- operator-managed SSH can remain an optional compatibility path
- any future public control plane needs authentication and authorization, not IP-based trust

### Local Machine Identity

For testnet-beta and non-VPN deployments, local identity should be allowed via:
- `SYNERGY_MACHINE_ID=<physical_machine_id>`

This provides a deterministic local-machine mapping when no WireGuard address exists.

## First Slice Implemented

The current repo changes support:
- inventory-driven public RPC resolution without changing control host semantics
- `SYNERGY_MACHINE_ID` as a local identity override for same-machine actions

This is enough to begin migrating the read path to public node endpoints.

## Follow-Up Work Required

### P0

- Introduce an explicit control transport model instead of overloading `host`.
- Add inventory columns for `control_host` and `public_rpc_url`.
- Rename UI/documentation from "closed testbeta" to "testnet-beta" for the selected profile.

### P1

- Replace WireGuard-only agent trust with authenticated control.
- Add per-operator credentials or signed action tokens.
- Allow agent reachability checks against authenticated public control endpoints.

### P2

- Remove topology rewrites that force `host` and `vpn_ip` to the same private address.
- Add a dedicated `testnet-beta` inventory/profile beside `testbeta/lean15`.
- Rework installer templates so bind/public addresses are not forced to private overlay IPs.

## Acceptance Criteria

- A node inventory row can specify a public RPC target and the dashboard uses it for health checks.
- A same-machine operator can run local control actions with `SYNERGY_MACHINE_ID` set and no VPN present.
- Existing closed-testbeta inventory continues to work unchanged.
