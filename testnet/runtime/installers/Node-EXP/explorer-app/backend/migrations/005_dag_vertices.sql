BEGIN;

CREATE TABLE IF NOT EXISTS dag_vertices (
  hash TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  proposer_address TEXT,
  height_hint BIGINT,
  block_number BIGINT REFERENCES blocks(number) ON DELETE SET NULL,
  block_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  availability_cert TEXT,
  tx_count INTEGER NOT NULL DEFAULT 0,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dag_vertices_block_desc ON dag_vertices (block_number DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_dag_vertices_status ON dag_vertices (status);

CREATE TABLE IF NOT EXISTS dag_edges (
  parent_hash TEXT NOT NULL,
  child_hash TEXT NOT NULL REFERENCES dag_vertices(hash) ON DELETE CASCADE,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_hash, child_hash)
);

CREATE INDEX IF NOT EXISTS idx_dag_edges_parent ON dag_edges (parent_hash);
CREATE INDEX IF NOT EXISTS idx_dag_edges_child ON dag_edges (child_hash);

CREATE TABLE IF NOT EXISTS dag_vertex_transactions (
  vertex_hash TEXT NOT NULL REFERENCES dag_vertices(hash) ON DELETE CASCADE,
  tx_hash TEXT NOT NULL,
  tx_index INTEGER,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vertex_hash, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_dag_vertex_transactions_tx ON dag_vertex_transactions (tx_hash);

COMMIT;
