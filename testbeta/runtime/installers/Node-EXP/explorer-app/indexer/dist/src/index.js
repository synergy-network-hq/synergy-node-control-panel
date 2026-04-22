import dotenv from 'dotenv';
import path from 'node:path';
import { Pool } from 'pg';
import pino from 'pino';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const synergyEnv = (process.env.SYNERGY_ENV || 'testnet-beta');
const defaultsByEnv = {
    'testnet-beta': { coreRpc: 'https://testbeta-core-rpc.synergy-network.io' },
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
        normalizeHash(transaction.hash),
        block.block_index.toString(),
        transaction.transaction_index ?? index,
        normalizeAddress(transaction.sender || transaction.from),
        normalizeAddress(transaction.receiver || transaction.to),
        transaction.amount == null ? null : String(transaction.amount),
        transaction.fee == null ? null : String(transaction.fee),
        transaction.nonce ?? null,
        transaction.data ?? null,
        transaction.status || 'confirmed',
        transaction.signature_algorithm || null,
        transaction.timestamp == null ? null : String(transaction.timestamp),
    ]);
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
         uptime_percentage, cluster_id, last_active, status, role_hint, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`, [
            normalizeAddress(validator.address),
            validator.name || null,
            validator.stake_amount == null ? null : String(validator.stake_amount),
            validator.synergy_score ?? null,
            validator.blocks_produced == null ? null : String(validator.blocks_produced),
            parsePercent(validator.uptime),
            validator.cluster_id == null ? null : String(validator.cluster_id),
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
