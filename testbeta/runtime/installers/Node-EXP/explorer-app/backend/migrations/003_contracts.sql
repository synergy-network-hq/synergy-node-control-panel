-- Synergy Explorer — Genesis System Contracts table
-- Migration 003: contracts

BEGIN;

CREATE TABLE IF NOT EXISTS contracts (
  address          TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  contract_type    TEXT NOT NULL DEFAULT 'genesis_system',
  bytecode_hash    TEXT,
  bytecode         TEXT,
  init_params      JSONB,
  verified         BOOLEAN NOT NULL DEFAULT TRUE,
  deployed_block   BIGINT NOT NULL DEFAULT 0,
  deployed_at      TIMESTAMPTZ,
  inserted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contracts_contract_type ON contracts (contract_type);
CREATE INDEX IF NOT EXISTS idx_contracts_deployed_block_desc ON contracts (deployed_block DESC);

COMMIT;
