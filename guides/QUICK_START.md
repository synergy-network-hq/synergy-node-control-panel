# Synergy Testnet-Beta - Quick Start

## Build & Run in 3 Steps

```bash
# 1. Build the binary
./testbeta.sh build

# 2. Start a node (choose any of the 19 types)
./testbeta.sh start validator

# 3. Check status
./testbeta.sh status
```

## Common Commands

```bash
# List all available node types
./testbeta.sh list

# Start different node types
./testbeta.sh start validator      # Core validator
./testbeta.sh start oracle          # Oracle node
./testbeta.sh start ai-inference    # AI inference node
./testbeta.sh start rpc-gateway     # RPC gateway

# View logs
./testbeta.sh logs                  # View recent logs
./testbeta.sh logs follow           # Follow logs in real-time

# Control nodes
./testbeta.sh stop                  # Stop the node
./testbeta.sh restart validator     # Restart with new type
./testbeta.sh status                # Check if running

# Maintenance
./testbeta.sh clean                 # Clean all data (requires confirmation)
```

## Available Node Types (19 Total)

**Class I - Validators & Governance:**
- validator
- archive-validator
- audit-validator
- committee
- governance-auditor
- security-council
- treasury-controller

**Class II - Data & Infrastructure:**
- oracle
- observer
- indexer
- data-availability
- cross-chain-verifier
- relayer
- rpc
- rpc-gateway
- witness

**Class III - Compute & AI:**
- ai-inference
- compute
- pqc-crypto
- uma-coordinator

## Binary Commands (Alternative)

```bash
# Direct binary usage
./target/release/synergy-testbeta start --node-type validator
./target/release/synergy-testbeta list-templates
./target/release/synergy-testbeta generate-keypair
./target/release/synergy-testbeta version
./target/release/synergy-testbeta logs --follow
./target/release/synergy-testbeta stop
```

## Default Ports

- **P2P**: 38638
- **RPC**: 48638
- **WebSocket**: 58638

## Files & Directories

- **Binary**: `./target/release/synergy-testbeta`
- **Templates**: `./templates/`
- **Config**: `./config/node.toml`
- **Data**: `./data/chain/`
- **Logs**: `./data/logs/`
- **PID File**: `./data/synergy-testbeta.pid`

## Troubleshooting

```bash
# If node won't stop
pkill -9 synergy-testbeta
rm -f data/synergy-testbeta.pid

# Clean restart
./testbeta.sh stop
./testbeta.sh clean
./testbeta.sh start validator

# Change ports (if in use)
export SYNERGY_RPC_PORT=58638
export SYNERGY_P2P_PORT=30304
./testbeta.sh start validator
```

## Running Multiple Nodes

Open multiple terminals:

```bash
# Terminal 1: Validator
export SYNERGY_RPC_PORT=48638 && export SYNERGY_P2P_PORT=38638
./target/release/synergy-testbeta start --node-type validator

# Terminal 2: Oracle
export SYNERGY_RPC_PORT=58638 && export SYNERGY_P2P_PORT=30304
./target/release/synergy-testbeta start --node-type oracle

# Terminal 3: RPC Gateway
export SYNERGY_RPC_PORT=8547 && export SYNERGY_P2P_PORT=30305
./target/release/synergy-testbeta start --node-type rpc-gateway
```

## Next Steps

For detailed documentation, see [TESTBETA_GUIDE.md](TESTBETA_GUIDE.md)
