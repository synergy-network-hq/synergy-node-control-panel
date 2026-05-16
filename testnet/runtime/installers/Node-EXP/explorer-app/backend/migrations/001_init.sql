-- Synergy Explorer (Testnet) — Postgres schema
--
-- This schema is intentionally small but covers the core explorer views:
--   - blocks
--   - transactions
--   - token transfers (ERC-20 Transfer events)
--   - contracts + verification metadata

BEGIN;

CREATE TABLE IF NOT EXISTS blocks (
  number               BIGINT PRIMARY KEY,
  hash                 TEXT NOT NULL UNIQUE,
  parent_hash          TEXT,
  timestamp            TIMESTAMPTZ NOT NULL,
  miner                TEXT,
  gas_used             BIGINT,
  gas_limit            BIGINT,
  base_fee_per_gas     BIGINT,
  tx_count             INTEGER,
  inserted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blocks_timestamp_desc ON blocks (timestamp DESC);

CREATE TABLE IF NOT EXISTS transactions (
  hash                 TEXT PRIMARY KEY,
  block_number         BIGINT NOT NULL REFERENCES blocks(number) ON DELETE CASCADE,
  tx_index             INTEGER,
  from_address         TEXT,
  to_address           TEXT,
  value_wei            NUMERIC(78,0),
  gas                  BIGINT,
  gas_price            BIGINT,
  nonce                BIGINT,
  input                TEXT,
  status               INTEGER,
  gas_used             BIGINT,
  effective_gas_price  BIGINT,
  contract_address     TEXT,
  inserted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_txs_block_number_desc ON transactions (block_number DESC);
CREATE INDEX IF NOT EXISTS idx_txs_from ON transactions (from_address);
CREATE INDEX IF NOT EXISTS idx_txs_to ON transactions (to_address);

CREATE TABLE IF NOT EXISTS token_transfers (
  id                   BIGSERIAL PRIMARY KEY,
  tx_hash              TEXT NOT NULL REFERENCES transactions(hash) ON DELETE CASCADE,
  log_index            INTEGER NOT NULL,
  token_address        TEXT NOT NULL,
  from_address         TEXT NOT NULL,
  to_address           TEXT NOT NULL,
  value_wei            NUMERIC(78,0) NOT NULL,
  block_number         BIGINT NOT NULL,
  inserted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_transfers_token_block_desc ON token_transfers (token_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON token_transfers (from_address);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON token_transfers (to_address);

CREATE TABLE IF NOT EXISTS contracts (
  address              TEXT PRIMARY KEY,
  creator_tx_hash      TEXT,
  block_number         BIGINT,
  creation_bytecode    TEXT,
  deployed_bytecode    TEXT,

  verified             BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at          TIMESTAMPTZ,
  verifier             TEXT,

  name                 TEXT,
  compiler_version     TEXT,
  optimizer_enabled    BOOLEAN,
  optimizer_runs       INTEGER,
  abi_json             JSONB,
  source_json          JSONB,

  inserted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contracts_verified ON contracts (verified);

COMMIT;
