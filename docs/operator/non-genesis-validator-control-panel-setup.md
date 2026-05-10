# Non-Genesis Validator Setup With Synergy Node Control Panel

This guide explains how to bring a new validator onto Testnet-Beta after genesis. It is for operators using Synergy Node Control Panel, not for the five genesis validators that are already in the genesis file.

The current validator lifecycle in the control panel is:

1. Install or import a validator workspace.
2. Start the node and let it sync close to chain head.
3. Register the node with the seed servers.
4. Fund the validator address with liquid SNRG.
5. Bond the required validator stake.
6. Activate the validator so it can join consensus.

## Prerequisites

- A current Synergy Node Control Panel build.
- A machine with a stable public IP or DNS name.
- A validator setup package for the new non-genesis validator.
- Open inbound P2P on the validator port shown in the setup package.
- Enough SNRG in the faucet or funding wallet to send the required stake.
- Access to the public RPC endpoint: `https://testbeta-core-rpc.synergy-network.io`.

The required stake is `50,000 SNRG`, which is `50,000,000,000,000 nWei`.

## Address Rule

Fund and stake the validator address only.

The validator address must start with `synv1`. Do not send the staking funds to a regular wallet address that starts with `synw`. A `synw` address can hold wallet funds, but it is not the validator identity that the control panel stakes and activates.

In the control panel, use the address shown on the validator node detail page as the node address. You can also confirm it from the installed workspace:

```bash
cat ~/.synergy/testnet-beta/nodes/validator-workspace/keys/address.txt
```

## 1. Prepare The Machine

1. Assign a public IP or DNS name that other peers can reach.
2. Open the P2P port from the setup package.
3. Keep RPC and metrics local unless the package explicitly exposes them.
4. Install Synergy Node Control Panel on the machine.
5. Launch the control panel once so the local testbeta agent is installed.

For a Linux validator installed by the current packages, the managed workspace is:

```bash
~/.synergy/testnet-beta/nodes/validator-workspace
```

## 2. Install Or Import The Validator Workspace

1. Open Synergy Node Control Panel.
2. Go to the setup or node installation flow.
3. Select the validator setup package for the new validator.
4. Install the selected node slot.
5. Open the node detail page for that validator.
6. Confirm the role is `validator`.
7. Confirm the node address starts with `synv1`.

Do not reuse one of the five genesis validator packages for a new validator. A new non-genesis validator needs its own validator identity and setup package.

## 3. Start And Sync

On the validator node detail page:

1. Click `Start`.
2. Wait for the runtime state to show the node is running.
3. Click `Bootstrap / reconnect` if the node has no peers or is behind.
4. Wait until the sync lag is near zero.

The activation preflight currently accepts a sync gap of `32` blocks or less.
The packaged validator config allows up to `100` active consensus validators, so a bonded and activated non-genesis validator is not capped out by the five genesis validators.

You can verify sync from the machine:

```bash
curl -s http://127.0.0.1:5640 \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"synergy_blockNumber","params":[]}'
```

Compare that value with the public chain:

```bash
curl -s https://testbeta-core-rpc.synergy-network.io \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"synergy_blockNumber","params":[]}'
```

## 4. Register With Seed Servers

On the validator node detail page:

1. Click `Re-register`.
2. Refresh the node detail page.
3. Confirm peer visibility is non-zero.
4. Run `Activation Preflight`.

The preflight should show the seed registration check as passing before activation.

## 5. Fund The Validator Address

Send at least `50,000 SNRG` to the validator `synv1...` address from the faucet or another funded wallet.

After sending, verify the liquid balance against the same validator address:

```bash
VALIDATOR_ADDRESS='synv1...'

curl -s https://testbeta-core-rpc.synergy-network.io \
  -H 'Content-Type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"synergy_getBalance\",\"params\":[\"$VALIDATOR_ADDRESS\"]}"
```

The returned value is in nWei. `50,000 SNRG` is `50000000000000` nWei.

If the faucet transaction has a hash, check the transaction and the receiver address before assuming the node is unfunded. The receiver must exactly match the validator `synv1...` address.

## 6. Bond The Stake

On the validator node detail page:

1. Click `Activation Preflight`.
2. Confirm `Wallet funding` passes.
3. Click `Stake Validator`.
4. Wait for the submitted transaction to be included.
5. Click `Activation Preflight` again.
6. Confirm `Bonded stake` passes.

The control panel submits:

```text
synergy_stakeTokens(validator_address, validator_address, "SNRG", 50000)
```

You can verify bonded stake with:

```bash
VALIDATOR_ADDRESS='synv1...'

curl -s https://testbeta-core-rpc.synergy-network.io \
  -H 'Content-Type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"synergy_getStakedBalance\",\"params\":[\"$VALIDATOR_ADDRESS\",\"SNRG\"]}"
```

The bonded balance must be at least `50000000000000` nWei.

## 7. Activate The Validator

Run `Activation Preflight` again and confirm these checks pass:

- Validator role
- Public P2P endpoint
- Local RPC ready
- Synced near chain head
- Peers visible
- Seed registration
- Wallet funding
- Bonded stake

Then click `Activate Validator`.

The control panel submits:

```text
synergy_activateValidator(validator_address, display_name, 50000)
```

The validator joins consensus after the activation transaction is included and observed by the active validator set.
Keep the validator running after activation. The runtime watches the synced validator registry and starts consensus automatically when it sees its own activation; if the node was stopped during activation, start it again after the transaction is included.

## 8. Confirm Consensus Participation

Check the public validator list:

```bash
curl -s https://testbeta-core-rpc.synergy-network.io \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"synergy_getValidators","params":[]}'
```

Then check Atlas:

```bash
curl -s https://testbeta-explorer.synergy-network.io/api/v1/validators
```

The validator should appear as active after indexing catches up. It should also begin showing block production or consensus activity over time.

## Troubleshooting Funding

If a faucet transfer appears to send but the validator balance does not change:

- Confirm the destination was the validator `synv1...` address, not a `synw...` wallet address.
- Confirm the amount was sent as SNRG in the wallet UI. RPC balance values are nWei.
- Confirm the public RPC is current by checking `synergy_blockNumber`.
- Check the transaction hash in Atlas after the indexer catches up.
- Check the receiver field in the transaction detail. It must match the validator address exactly.
- Re-run `Activation Preflight`; it reads the same validator address the control panel will stake.

If the transaction exists on-chain but Atlas does not show details, use the RPC result as source of truth and let the indexer catch up. Atlas transaction detail pages are expected to expose the indexed snake_case transaction fields used by the frontend.

## Troubleshooting Activation

If `Activation Preflight` fails:

- `Public P2P endpoint`: fix the public host or firewall before trying again.
- `Local RPC ready`: start or restart the node.
- `Synced near chain head`: click `Bootstrap / reconnect` and wait.
- `Peers visible`: check P2P reachability and seed registration.
- `Seed registration`: click `Re-register`.
- `Wallet funding`: send SNRG to the validator `synv1...` address.
- `Bonded stake`: click `Stake Validator` after funding is visible.

Do not activate a validator that is not synced. A validator that joins consensus without current state can destabilize consensus participation.
