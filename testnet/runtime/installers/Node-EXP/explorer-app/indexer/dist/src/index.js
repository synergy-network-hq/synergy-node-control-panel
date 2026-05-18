import dotenv from 'dotenv';
import path from 'node:path';
import { Pool } from 'pg';
import pino from 'pino';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const synergyEnv = (process.env.SYNERGY_ENV || 'testnet');
const defaultsByEnv = {
    testnet: { coreRpc: 'https://testnet-core-rpc.synergy-network.io' },
    'mainnet-beta': { coreRpc: 'https://mainnet-beta-core-rpc.synergy-network.io' },
    mainnet: { coreRpc: 'https://mainnet-core-rpc.synergy-network.io' },
};
const rpcUrl = process.env.SYNERGY_CORE_RPC_URL || defaultsByEnv[synergyEnv].coreRpc;
const fallbackRpcUrl = process.env.SYNERGY_CORE_RPC_FALLBACK_URL || defaultsByEnv[synergyEnv].fallback;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL (postgres://...)');
}
const rpcTimeoutMs = Math.max(250, Number(process.env.SYNERGY_RPC_TIMEOUT_MS || 2500));
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 2000);
const batchSize = Math.max(1, Math.min(250, Number(process.env.BATCH_SIZE || 50)));
const dagIndexLimit = Math.max(1, Math.min(1000, Number(process.env.DAG_INDEX_LIMIT || 500)));
const dagRebuildBlockLimit = Math.max(1, Math.min(10000, Number(process.env.DAG_REBUILD_BLOCK_LIMIT || 5000)));
const startBlockEnv = process.env.START_BLOCK;
const pool = new Pool({ connectionString: databaseUrl });
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeAddress(value) {
    if (!value)
        return null;
    return String(value).trim().toLowerCase();
}
function normalizeHash(value) {
    if (!value)
        return null;
    return String(value).trim().toLowerCase();
}
function asStringNumber(value) {
    if (value === null || value === undefined || value === '')
        return null;
    return String(value);
}
function serializePayload(value) {
    if (value === null || value === undefined || value === '')
        return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
}
function timestampIso(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return new Date(0).toISOString();
    }
    return new Date(numeric * 1000).toISOString();
}
function parsePercent(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const numeric = Number(String(value).replace('%', ''));
    return Number.isFinite(numeric) ? numeric : null;
}
async function rpcCall(endpoint, method, params = []) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), rpcTimeoutMs);
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: controller.signal,
        });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`RPC ${method} failed at ${endpoint}: ${reason}`);
    }
    finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        throw new Error(`RPC ${method} failed at ${endpoint}: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json());
    if (payload.error) {
        throw new Error(`RPC ${method} failed at ${endpoint}: ${payload.error.message}`);
    }
    if (payload.result === undefined) {
        throw new Error(`RPC ${method} returned no result from ${endpoint}`);
    }
    return payload.result;
}
async function rpcCallWithFallback(method, params = []) {
    try {
        return await rpcCall(rpcUrl, method, params);
    }
    catch (primaryError) {
        if (!fallbackRpcUrl) {
            throw primaryError;
        }
        logger.warn({ method, error: primaryError instanceof Error ? primaryError.message : String(primaryError) }, 'Primary Atlas source RPC failed, using fallback');
        return rpcCall(fallbackRpcUrl, method, params);
    }
}
async function getLatestBlockNumber() {
    const latest = await rpcCallWithFallback('synergy_getBlockNumber');
    return Number(latest || 0);
}
async function getLastIndexedBlock() {
    const result = await pool.query('SELECT MAX(number)::text AS max FROM blocks');
    return result.rows[0]?.max ? Number(result.rows[0].max) : null;
}
async function upsertBlock(block) {
    await pool.query(`INSERT INTO blocks (number, hash, parent_hash, timestamp, validator_address, tx_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (number) DO UPDATE SET
       hash = EXCLUDED.hash,
       parent_hash = EXCLUDED.parent_hash,
       timestamp = EXCLUDED.timestamp,
       validator_address = EXCLUDED.validator_address,
       tx_count = EXCLUDED.tx_count`, [
        block.block_index.toString(),
        normalizeHash(block.hash),
        normalizeHash(block.parent_hash || block.previous_hash),
        timestampIso(block.timestamp),
        normalizeAddress(block.validator || block.validator_id),
        block.tx_count || block.transactions?.length || 0,
    ]);
}
async function upsertTransaction(transaction, block, index) {
    const txHash = normalizeHash(transaction.hash || transaction.tx_hash);
    if (!txHash) {
        logger.warn({ block: block.block_index, index, transaction }, 'Skipping transaction without hash');
        return;
    }
    await pool.query(`INSERT INTO transactions (
       hash, block_number, tx_index, sender_address, receiver_address, amount_nwei, fee_nwei,
       nonce, data, status, signature_algorithm, timestamp_unix
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (hash) DO UPDATE SET
       block_number = EXCLUDED.block_number,
       tx_index = EXCLUDED.tx_index,
       sender_address = EXCLUDED.sender_address,
       receiver_address = EXCLUDED.receiver_address,
       amount_nwei = EXCLUDED.amount_nwei,
       fee_nwei = EXCLUDED.fee_nwei,
       nonce = EXCLUDED.nonce,
       data = EXCLUDED.data,
       status = EXCLUDED.status,
       signature_algorithm = EXCLUDED.signature_algorithm,
       timestamp_unix = EXCLUDED.timestamp_unix`, [
        txHash,
        block.block_index.toString(),
        transaction.transaction_index ?? transaction.tx_index ?? index,
        normalizeAddress(transaction.sender_address || transaction.sender || transaction.from),
        normalizeAddress(transaction.receiver_address || transaction.receiver || transaction.to),
        asStringNumber(transaction.amount_nwei ?? transaction.amount),
        asStringNumber(transaction.fee_nwei ?? transaction.fee),
        transaction.nonce ?? null,
        serializePayload(transaction.data),
        transaction.status || 'confirmed',
        transaction.signature_algorithm || transaction.signatureAlgorithm || null,
        asStringNumber(transaction.timestamp_unix ?? transaction.timestamp),
    ]);
}
async function upsertDagVertex(vertex) {
    const vertexHash = normalizeHash(vertex.hash);
    if (!vertexHash) {
        logger.warn({ vertex }, 'Skipping DAG vertex without hash');
        return;
    }
    const transactionHashes = Array.isArray(vertex.transaction_hashes) && vertex.transaction_hashes.length > 0
        ? vertex.transaction_hashes
        : (vertex.transactions || []).map((tx) => tx.hash || tx.tx_hash).filter(Boolean);
    const parentHashes = Array.isArray(vertex.parent_hashes) ? vertex.parent_hashes : [];
    await pool.query(`INSERT INTO dag_vertices (
       hash, status, proposer_address, height_hint, block_number, block_hash,
       created_at, availability_cert, tx_count, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (hash) DO UPDATE SET
       status = EXCLUDED.status,
       proposer_address = EXCLUDED.proposer_address,
       height_hint = EXCLUDED.height_hint,
       block_number = EXCLUDED.block_number,
       block_hash = EXCLUDED.block_hash,
       created_at = EXCLUDED.created_at,
       availability_cert = EXCLUDED.availability_cert,
       tx_count = EXCLUDED.tx_count,
       updated_at = NOW()`, [
        vertexHash,
        vertex.status || 'committed',
        normalizeAddress(vertex.proposer),
        vertex.height_hint == null ? null : String(vertex.height_hint),
        vertex.block_number == null ? null : String(vertex.block_number),
        normalizeHash(vertex.block_hash || undefined),
        timestampIso(vertex.created_at),
        normalizeHash(vertex.availability_cert || undefined),
        transactionHashes.length,
    ]);
    await pool.query('DELETE FROM dag_edges WHERE child_hash = $1', [vertexHash]);
    for (const parentHashRaw of parentHashes) {
        const parentHash = normalizeHash(parentHashRaw);
        if (!parentHash)
            continue;
        await pool.query(`INSERT INTO dag_edges (parent_hash, child_hash)
       VALUES ($1, $2)
       ON CONFLICT (parent_hash, child_hash) DO NOTHING`, [parentHash, vertexHash]);
    }
    await pool.query('DELETE FROM dag_vertex_transactions WHERE vertex_hash = $1', [vertexHash]);
    for (let index = 0; index < transactionHashes.length; index += 1) {
        const txHash = normalizeHash(transactionHashes[index]);
        if (!txHash)
            continue;
        await pool.query(`INSERT INTO dag_vertex_transactions (vertex_hash, tx_hash, tx_index)
       VALUES ($1, $2, $3)
       ON CONFLICT (vertex_hash, tx_hash) DO UPDATE SET tx_index = EXCLUDED.tx_index`, [vertexHash, txHash, index]);
    }
}
async function refreshDagIndex() {
    const response = await rpcCallWithFallback('synergy_getDagVertices', [{ limit: dagIndexLimit }]).catch((error) => {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'DAG runtime RPC unavailable');
        return null;
    });
    const vertices = Array.isArray(response?.items) ? response.items : [];
    for (const vertex of vertices) {
        await upsertDagVertex(vertex);
    }
    if (vertices.length > 0) {
        logger.info({ indexed: vertices.length }, 'Indexed Synergy DAG vertices');
        return vertices.length;
    }
    const rebuilt = await rebuildDagFromIndexedBlocks();
    if (rebuilt > 0) {
        logger.warn({ indexed: rebuilt, source: 'committed_blocks', reason: response ? 'empty_runtime_dag' : 'runtime_rpc_unavailable' }, 'Rebuilt Synergy DAG index from committed transaction blocks');
    }
    return rebuilt;
}
async function rebuildDagFromIndexedBlocks() {
    const result = await pool.query(`WITH recent_transaction_blocks AS (
       SELECT b.number, b.hash, b.timestamp, b.validator_address
         FROM blocks b
        WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.block_number = b.number)
        ORDER BY b.number DESC
        LIMIT $1
     )
     SELECT b.number::text AS number,
            b.hash,
            EXTRACT(EPOCH FROM b.timestamp)::bigint::text AS timestamp_unix,
            b.validator_address,
            ARRAY_AGG(t.hash ORDER BY t.tx_index NULLS LAST, t.hash) AS tx_hashes
       FROM recent_transaction_blocks b
       JOIN transactions t ON t.block_number = b.number
      GROUP BY b.number, b.hash, b.timestamp, b.validator_address
      ORDER BY b.number ASC`, [dagRebuildBlockLimit]);
    let parentHashes = ['synergy-dag-root'];
    let indexed = 0;
    for (const block of result.rows) {
        const vertexHash = normalizeHash(block.hash);
        const txHashes = Array.isArray(block.tx_hashes)
            ? block.tx_hashes.map((hash) => normalizeHash(hash)).filter(Boolean)
            : [];
        if (!vertexHash || txHashes.length === 0) {
            continue;
        }
        await upsertDagVertex({
            hash: vertexHash,
            parent_hashes: parentHashes,
            transaction_hashes: txHashes,
            proposer: block.validator_address || undefined,
            created_at: block.timestamp_unix || undefined,
            height_hint: block.number,
            block_hash: block.hash,
            block_number: block.number,
            status: 'committed',
            availability_cert: block.hash,
        });
        parentHashes = [vertexHash];
        indexed += 1;
    }
    return indexed;
}
async function fetchTransactionsForBlock(block) {
    if (Array.isArray(block.transactions)) {
        return block.transactions;
    }
    if ((block.tx_count || 0) === 0) {
        return [];
    }
    return rpcCallWithFallback('synergy_getTransactionsInBlock', [block.block_index]).catch(() => []);
}
async function indexRange(start, end) {
    const blocks = await rpcCallWithFallback('synergy_getBlockRange', [start, end]);
    if (!Array.isArray(blocks) || blocks.length === 0) {
        return 0;
    }
    for (const block of blocks) {
        await upsertBlock(block);
        const transactions = await fetchTransactionsForBlock(block);
        for (let index = 0; index < transactions.length; index += 1) {
            await upsertTransaction(transactions[index], block, index);
        }
    }
    logger.info({ start, end, indexed: blocks.length }, 'Indexed Synergy block range');
    return blocks.length;
}
async function refreshValidatorSnapshot() {
    const activity = await rpcCallWithFallback('synergy_getValidatorActivity').catch(() => null);
    const validators = Array.isArray(activity?.validators) ? activity.validators : [];
    await pool.query('DELETE FROM validators_current');
    for (const validator of validators) {
        await pool.query(`INSERT INTO validators_current (
         address, name, stake_amount, synergy_score, blocks_produced,
         uptime_percentage, cluster_id, cluster_address, last_active, status, role_hint, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`, [
            normalizeAddress(validator.address),
            validator.name || null,
            validator.stake_amount == null ? null : String(validator.stake_amount),
            validator.synergy_score ?? null,
            validator.blocks_produced == null ? null : String(validator.blocks_produced),
            parsePercent(validator.uptime),
            validator.cluster_id == null ? null : String(validator.cluster_id),
            normalizeAddress(validator.cluster_address),
            validator.last_active == null ? null : String(validator.last_active),
            'active',
            'validator',
        ]);
    }
    return {
        totalActive: validators.length,
        averageSynergyScore: activity?.average_synergy_score ?? null,
    };
}
async function refreshNetworkSnapshot() {
    const [networkStats, validatorStats, nodeStatus, validatorSnapshot, latestIndexed] = await Promise.all([
        rpcCallWithFallback('synergy_getNetworkStats').catch(() => null),
        rpcCallWithFallback('synergy_getValidatorStats').catch(() => null),
        rpcCallWithFallback('synergy_getNodeStatus').catch(() => null),
        refreshValidatorSnapshot(),
        getLastIndexedBlock(),
    ]);
    await pool.query(`INSERT INTO network_snapshots (
       latest_block, total_transactions, active_validators, total_validators,
       average_synergy_score, peer_count, average_block_time_seconds, indexed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`, [
        String(latestIndexed ?? networkStats?.block_height ?? 0),
        String(networkStats?.total_transactions ?? 0),
        String(validatorSnapshot.totalActive),
        String(validatorStats?.total_validators ?? validatorSnapshot.totalActive ?? 0),
        validatorSnapshot.averageSynergyScore,
        String(nodeStatus?.peer_count ?? nodeStatus?.peers_connected ?? nodeStatus?.peers ?? 0),
        nodeStatus?.average_block_time == null ? null : Number(nodeStatus.average_block_time),
    ]);
}
async function main() {
    logger.info({ rpcUrl, fallbackRpcUrl }, 'Starting Synergy Atlas indexer');
    await pool.query('SELECT 1');
    while (true) {
        try {
            const latestBlock = await getLatestBlockNumber();
            const lastIndexed = await getLastIndexedBlock();
            let cursor = lastIndexed == null
                ? (startBlockEnv != null && startBlockEnv !== '' ? Number(startBlockEnv) : 0)
                : lastIndexed + 1;
            while (cursor <= latestBlock) {
                const end = Math.min(cursor + batchSize - 1, latestBlock);
                const indexed = await indexRange(cursor, end);
                if (indexed === 0) {
                    logger.warn({ cursor, end }, 'RPC returned no blocks for requested range');
                    break;
                }
                cursor = end + 1;
            }
            await refreshNetworkSnapshot();
            await refreshDagIndex();
        }
        catch (error) {
            logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Indexer loop failed');
        }
        await sleep(pollIntervalMs);
    }
}
main().catch((error) => {
    logger.fatal({ error: error instanceof Error ? error.message : String(error) }, 'Indexer crashed');
    process.exit(1);
});
