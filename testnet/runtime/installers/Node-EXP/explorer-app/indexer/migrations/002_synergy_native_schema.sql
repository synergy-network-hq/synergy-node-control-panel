BEGIN;

DROP TABLE IF EXISTS token_transfers CASCADE;
DROP TABLE IF EXISTS contracts CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS blocks CASCADE;
DROP TABLE IF EXISTS validators_current CASCADE;
DROP TABLE IF EXISTS network_snapshots CASCADE;

CREATE TABLE blocks (
  number BIGINT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  parent_hash TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  validator_address TEXT,
  tx_count INTEGER,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_blocks_timestamp_desc ON blocks (timestamp DESC);
CREATE INDEX idx_blocks_validator ON blocks (validator_address);

CREATE TABLE transactions (
  hash TEXT PRIMARY KEY,
  block_number BIGINT NOT NULL REFERENCES blocks(number) ON DELETE CASCADE,
  tx_index INTEGER,
  sender_address TEXT,
  receiver_address TEXT,
  amount_nwei NUMERIC(78,0),
  fee_nwei NUMERIC(78,0),
  nonce BIGINT,
  data TEXT,
  status TEXT,
  signature_algorithm TEXT,
  timestamp_unix BIGINT,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transactions_block_number_desc ON transactions (block_number DESC);
CREATE INDEX idx_transactions_sender ON transactions (sender_address);
CREATE INDEX idx_transactions_receiver ON transactions (receiver_address);

CREATE TABLE validators_current (
  address TEXT PRIMARY KEY,
  name TEXT,
  stake_amount NUMERIC(78,0),
  synergy_score DOUBLE PRECISION,
  blocks_produced BIGINT,
  uptime_percentage DOUBLE PRECISION,
  cluster_id TEXT,
  cluster_address TEXT,
  last_active BIGINT,
  status TEXT,
  role_hint TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_validators_synergy_score_desc ON validators_current (synergy_score DESC NULLS LAST);

CREATE TABLE network_snapshots (
  id BIGSERIAL PRIMARY KEY,
  latest_block BIGINT NOT NULL,
  total_transactions BIGINT NOT NULL,
  active_validators INTEGER NOT NULL,
  total_validators INTEGER NOT NULL,
  average_synergy_score DOUBLE PRECISION,
  peer_count INTEGER NOT NULL,
  average_block_time_seconds DOUBLE PRECISION,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_network_snapshots_indexed_at_desc ON network_snapshots (indexed_at DESC);

COMMIT;
