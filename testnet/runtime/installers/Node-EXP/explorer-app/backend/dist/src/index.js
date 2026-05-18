import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import sensible from '@fastify/sensible';
import dotenv from 'dotenv';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { isSynergyAddress, isSynergyTransactionHash, isSynergyValidatorAddress, normalizeAddress, normalizeTxHash, rpcCallWithFallback } from './synergy.js';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const cfg = loadConfig(process.env);
const pool = createPool(cfg.dbUrl);
const rpc = {
    primary: cfg.synergyCoreRpcUrl,
    fallback: cfg.synergyCoreRpcFallbackUrl,
};
const RESET_RATE_LIMIT_MS = 60 * 1000;
const NWEI_PER_SNRG = 1000000000n;
let lastResetRequestAt = 0;
const app = Fastify({
    logger: {
        level: cfg.nodeEnv === 'development' ? 'info' : 'info'
    }
});
await app.register(cors, { origin: cfg.corsOrigin });
await app.register(sensible);
await app.register(swagger, {
    openapi: {
        info: {
            title: 'Synergy Atlas API',
            version: '0.2.0'
        }
    }
});
await app.register(swaggerUi, { routePrefix: '/docs' });
app.get('/healthz', async () => ({ ok: true }));
app.get('/readyz', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
});
app.get('/version', async () => ({
    name: 'synergy-atlas-api',
    version: '0.2.0',
    env: cfg.synergyEnv,
    coreRpc: cfg.synergyCoreRpcUrl,
    fallbackRpc: cfg.synergyCoreRpcFallbackUrl || null,
}));
function parseLimitPage(q) {
    const limit = Math.max(1, Math.min(100, Number(q.limit || 20)));
    const page = Math.max(1, Number(q.page || 1));
    const offset = (page - 1) * limit;
    return { limit, page, offset };
}
function nullableString(value) {
    if (value === null || value === undefined)
        return null;
    return String(value);
}
function rpcTransactionToRow(tx) {
    return {
        hash: tx.hash,
        block_number: nullableString(tx.block_number),
        block_timestamp: null,
        tx_index: tx.transaction_index ?? null,
        sender_address: tx.sender || tx.from || null,
        receiver_address: tx.receiver || tx.to || null,
        amount_nwei: nullableString(tx.amount),
        fee_nwei: nullableString(tx.fee),
        nonce: nullableString(tx.nonce),
        data: tx.data || null,
        status: tx.status || (tx.block_number == null ? 'pending' : 'confirmed'),
        signature_algorithm: tx.signature_algorithm || null,
        timestamp_unix: nullableString(tx.timestamp),
    };
}
async function getRpcTransactionRow(hash) {
    const tx = await rpcCallWithFallback(rpc, 'synergy_getTransactionByHash', [hash]).catch(() => null);
    if (!tx || !tx.hash)
        return null;
    return rpcTransactionToRow(tx);
}
function parseBigInt(value) {
    if (value === null || value === undefined || value === '')
        return 0n;
    const normalized = String(value).trim();
    if (!/^-?\d+$/.test(normalized))
        return 0n;
    return BigInt(normalized);
}
function formatWholeNumber(value) {
    const text = value.toString();
    return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function formatSnrgAmount(valueNwei) {
    const raw = parseBigInt(valueNwei);
    const whole = raw / NWEI_PER_SNRG;
    const fraction = raw % NWEI_PER_SNRG;
    if (fraction === 0n)
        return `${formatWholeNumber(whole)} SNRG`;
    const decimals = fraction.toString().padStart(9, '0').replace(/0+$/, '');
    return `${formatWholeNumber(whole)}.${decimals} SNRG`;
}
function numberFrom(value) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}
function getRequesterIp(req) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    return String(req.ip || req.socket?.remoteAddress || '');
}
function isAllowedResetRequester(req) {
    const configuredToken = cfg.explorerResetToken?.trim();
    if (configuredToken) {
        const authHeader = String(req.headers?.authorization || '');
        const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        const headerToken = String(req.headers?.['x-synergy-reset-token'] || '').trim();
        return bearerToken === configuredToken || headerToken === configuredToken;
    }
    const ip = getRequesterIp(req);
    return ip === '127.0.0.1'
        || ip === '::1'
        || ip.startsWith('::ffff:127.');
}
async function resetIndexedChainState() {
    const previousBlockHeightRes = await pool.query('SELECT MAX(number)::text AS max FROM blocks');
    const previousBlockHeight = previousBlockHeightRes.rows[0]?.max ? Number(previousBlockHeightRes.rows[0].max) : 0;
    await pool.query('BEGIN');
    try {
        await pool.query('TRUNCATE TABLE transactions, blocks, validators_current, network_snapshots, contracts RESTART IDENTITY CASCADE');
        await pool.query('COMMIT');
    }
    catch (error) {
        await pool.query('ROLLBACK');
        throw error;
    }
    return previousBlockHeight;
}
async function handleReindexFromGenesis(req, reply) {
    if (!isAllowedResetRequester(req)) {
        throw req.server.httpErrors.forbidden('Reset endpoint is restricted to localhost callers or a valid reset token');
    }
    const action = req.body && typeof req.body === 'object' ? String(req.body.action || '') : '';
    if (action && action !== 'reindex_from_genesis') {
        throw req.server.httpErrors.badRequest('Unsupported reset action');
    }
    const now = Date.now();
    if (now - lastResetRequestAt < RESET_RATE_LIMIT_MS) {
        return reply.status(202).send({
            status: 'accepted',
            message: 'Reindex from genesis was already initiated recently. Explorer is continuing to rebuild indexed state.',
            previous_block_height: 0,
            new_block_height: 0,
        });
    }
    const previousBlockHeight = await resetIndexedChainState();
    lastResetRequestAt = now;
    req.server.log.warn({
        requesterIp: getRequesterIp(req),
        reason: req.body?.reason || 'unspecified',
        timestampUtc: req.body?.timestamp_utc || null,
        previousBlockHeight,
    }, 'Explorer reindex-from-genesis requested');
    return reply.status(202).send({
        status: 'accepted',
        message: 'Reindex from genesis initiated. Explorer will show new chain data within ~60 seconds.',
        previous_block_height: previousBlockHeight,
        new_block_height: 0,
    });
}
app.post('/v1/admin/reindex-from-genesis', handleReindexFromGenesis);
async function queryLatestSnapshot() {
    const res = await pool.query(`SELECT latest_block, total_transactions, active_validators, total_validators,
            average_synergy_score, peer_count, average_block_time_seconds, indexed_at
       FROM network_snapshots
      ORDER BY indexed_at DESC
      LIMIT 1`);
    return res.rows[0] || null;
}
async function queryAverageBlockTimeSeconds() {
    const res = await pool.query('SELECT * FROM blocks ORDER BY number DESC LIMIT 25');
    if (res.rows.length < 2)
        return null;
    const times = res.rows.map((row) => new Date(row.timestamp).getTime()).sort((a, b) => a - b);
    const spanMs = times[times.length - 1] - times[0];
    if (spanMs <= 0)
        return null;
    return spanMs / 1000 / (times.length - 1);
}
app.register(async (api) => {
    api.post('/admin/reindex-from-genesis', handleReindexFromGenesis);
    api.get('/network/summary', async () => {
        const [snapshot, latestBlockRes, avgBlockTimeSeconds, networkStats, nodeInfo] = await Promise.all([
            queryLatestSnapshot().catch(() => null),
            pool.query('SELECT MAX(number)::text AS number FROM blocks'),
            queryAverageBlockTimeSeconds().catch(() => null),
            rpcCallWithFallback(rpc, 'synergy_getNetworkStats').catch(() => null),
            rpcCallWithFallback(rpc, 'synergy_nodeInfo').catch(() => null),
        ]);
        return {
            env: cfg.synergyEnv,
            chainId: String(nodeInfo?.chainId || nodeInfo?.networkId || 1262),
            latestBlock: latestBlockRes.rows[0]?.number || String(snapshot?.latest_block || networkStats?.block_height || 0),
            avgBlockTimeSeconds: avgBlockTimeSeconds ?? snapshot?.average_block_time_seconds ?? null,
            totalTransactions: String(snapshot?.total_transactions || networkStats?.total_transactions || 0),
            activeValidators: String(snapshot?.active_validators || networkStats?.active_validators || 0),
            totalValidators: String(snapshot?.total_validators || networkStats?.active_validators || 0),
            averageSynergyScore: snapshot?.average_synergy_score ?? null,
            peerCount: String(snapshot?.peer_count || nodeInfo?.peers || nodeInfo?.peerCount || 0),
            indexedAt: snapshot?.indexed_at || null,
            sourceRpc: cfg.synergyCoreRpcUrl,
            fallbackRpc: cfg.synergyCoreRpcFallbackUrl || null,
        };
    });
    api.get('/blocks', async (req) => {
        const { limit, page, offset } = parseLimitPage(req.query);
        const res = await pool.query(`SELECT number, hash, parent_hash, timestamp, validator_address, tx_count
         FROM blocks
        ORDER BY number DESC
        LIMIT $1 OFFSET $2`, [limit, offset]);
        const totalRes = await pool.query('SELECT COUNT(*)::text AS count FROM blocks');
        return { page, limit, total: totalRes.rows[0]?.count || '0', items: res.rows };
    });
    api.get('/blocks/:id', async (req) => {
        const id = String(req.params.id);
        const includeTx = String(req.query?.includeTx || 'false') === 'true';
        const isNumeric = /^\d+$/.test(id);
        const blockRes = isNumeric
            ? await pool.query('SELECT number, hash, parent_hash, timestamp, validator_address, tx_count FROM blocks WHERE number = $1', [id])
            : await pool.query('SELECT number, hash, parent_hash, timestamp, validator_address, tx_count FROM blocks WHERE hash = $1', [normalizeTxHash(id)]);
        if (blockRes.rows.length === 0) {
            throw api.httpErrors.notFound('Block not found');
        }
        const block = blockRes.rows[0];
        let transactions = [];
        if (includeTx) {
            const txRes = await pool.query(`SELECT hash, block_number, tx_index, sender_address, receiver_address, amount_nwei, fee_nwei,
                nonce, data, status, signature_algorithm, timestamp_unix
           FROM transactions
          WHERE block_number = $1
          ORDER BY tx_index ASC NULLS LAST`, [block.number]);
            transactions = txRes.rows;
        }
        return {
            number: block.number,
            hash: block.hash,
            parentHash: block.parent_hash,
            timestamp: block.timestamp,
            validatorAddress: block.validator_address,
            txCount: block.tx_count,
            transactions,
        };
    });
    api.get('/txs', async (req) => {
        const { limit, page, offset } = parseLimitPage(req.query);
        const res = await pool.query(`SELECT t.hash, t.block_number, b.timestamp AS block_timestamp, t.tx_index, t.sender_address,
              t.receiver_address, t.amount_nwei, t.fee_nwei, t.nonce, t.data, t.status,
              t.signature_algorithm, t.timestamp_unix
         FROM transactions t
         JOIN blocks b ON b.number = t.block_number
        ORDER BY t.block_number DESC, t.tx_index DESC NULLS LAST
        LIMIT $1 OFFSET $2`, [limit, offset]);
        const totalRes = await pool.query('SELECT COUNT(*)::text AS count FROM transactions');
        return { page, limit, total: totalRes.rows[0]?.count || '0', items: res.rows };
    });
    api.get('/txs/:hash', async (req) => {
        const hash = normalizeTxHash(String(req.params.hash));
        if (!isSynergyTransactionHash(hash)) {
            throw api.httpErrors.badRequest('Invalid Synergy transaction hash');
        }
        const txRes = await pool.query(`SELECT t.hash, t.block_number, b.timestamp AS block_timestamp, t.tx_index, t.sender_address,
              t.receiver_address, t.amount_nwei, t.fee_nwei, t.nonce, t.data, t.status,
              t.signature_algorithm, t.timestamp_unix
         FROM transactions t
         JOIN blocks b ON b.number = t.block_number
        WHERE t.hash = $1`, [hash]);
        if (txRes.rows.length === 0) {
            const rpcTx = await getRpcTransactionRow(hash);
            if (!rpcTx) {
                throw api.httpErrors.notFound('Transaction not found');
            }
            return {
                ...rpcTx,
                blockNumber: rpcTx.block_number,
                blockTimestamp: rpcTx.block_timestamp,
                txIndex: rpcTx.tx_index,
                sender: rpcTx.sender_address,
                receiver: rpcTx.receiver_address,
                amountNwei: rpcTx.amount_nwei,
                feeNwei: rpcTx.fee_nwei,
                signatureAlgorithm: rpcTx.signature_algorithm,
                timestampUnix: rpcTx.timestamp_unix,
                indexed: false,
            };
        }
        const tx = txRes.rows[0];
        return {
            hash: tx.hash,
            block_number: tx.block_number,
            block_timestamp: tx.block_timestamp,
            tx_index: tx.tx_index,
            sender_address: tx.sender_address,
            receiver_address: tx.receiver_address,
            amount_nwei: tx.amount_nwei,
            fee_nwei: tx.fee_nwei,
            nonce: tx.nonce,
            data: tx.data,
            status: tx.status,
            signature_algorithm: tx.signature_algorithm,
            timestamp_unix: tx.timestamp_unix,
            blockNumber: tx.block_number,
            blockTimestamp: tx.block_timestamp,
            txIndex: tx.tx_index,
            sender: tx.sender_address,
            receiver: tx.receiver_address,
            amountNwei: tx.amount_nwei,
            feeNwei: tx.fee_nwei,
            signatureAlgorithm: tx.signature_algorithm,
            timestampUnix: tx.timestamp_unix,
            indexed: true,
        };
    });
    api.get('/address/:address', async (req) => {
        const address = normalizeAddress(String(req.params.address));
        if (!isSynergyAddress(address)) {
            throw api.httpErrors.badRequest('Invalid Synergy address');
        }
        const [txsRes, wallet, balance, staked, stakingInfo, transferHistory] = await Promise.all([
            pool.query(`SELECT t.hash, t.block_number, b.timestamp AS block_timestamp, t.tx_index, t.sender_address,
                t.receiver_address, t.amount_nwei, t.fee_nwei, t.nonce, t.data, t.status,
                t.signature_algorithm, t.timestamp_unix
           FROM transactions t
           JOIN blocks b ON b.number = t.block_number
          WHERE t.sender_address = $1 OR t.receiver_address = $1
          ORDER BY t.block_number DESC, t.tx_index DESC NULLS LAST
          LIMIT 100`, [address]),
            rpcCallWithFallback(rpc, 'synergy_getWallet', [address]).catch(() => null),
            rpcCallWithFallback(rpc, 'synergy_getTokenBalance', [address, 'SNRG']).catch(() => 0),
            rpcCallWithFallback(rpc, 'synergy_getStakedBalance', [address, 'SNRG']).catch(() => ({ balance: 0 })),
            rpcCallWithFallback(rpc, 'synergy_getStakingInfo', [address]).catch(() => null),
            rpcCallWithFallback(rpc, 'synergy_getTransferHistory', [address, 100]).catch(() => []),
        ]);
        return {
            address,
            wallet,
            walletBalanceNwei: String(balance || 0),
            stakedBalanceNwei: String(staked?.balance || 0),
            stakingInfo,
            recentTransactions: txsRes.rows,
            transferHistory,
        };
    });
    api.get('/validators', async (req) => {
        const { limit, page, offset } = parseLimitPage(req.query);
        const res = await pool.query(`SELECT address, name, stake_amount, synergy_score, blocks_produced, uptime_percentage,
              cluster_id, cluster_address, last_active, status, role_hint
         FROM validators_current
        ORDER BY synergy_score DESC NULLS LAST, stake_amount::numeric DESC NULLS LAST, address ASC
        LIMIT $1 OFFSET $2`, [limit, offset]);
        const totalRes = await pool.query('SELECT COUNT(*)::text AS count FROM validators_current');
        return { page, limit, total: totalRes.rows[0]?.count || '0', items: res.rows };
    });
    api.get('/validators/:address', async (req) => {
        const address = normalizeAddress(String(req.params.address));
        if (!isSynergyValidatorAddress(address)) {
            throw api.httpErrors.badRequest('Invalid Synergy validator address');
        }
        const [validatorRpc, synergyBreakdownRpc, stakingInfo, walletBalance, stakedBalance, recentTransactions] = await Promise.all([
            rpcCallWithFallback(rpc, 'synergy_getValidator', [address]).catch(() => null),
            rpcCallWithFallback(rpc, 'synergy_getSynergyScoreBreakdown', [address]).catch(() => null),
            rpcCallWithFallback(rpc, 'synergy_getStakingInfo', [address]).catch(() => null),
            rpcCallWithFallback(rpc, 'synergy_getTokenBalance', [address, 'SNRG']).catch(() => 0),
            rpcCallWithFallback(rpc, 'synergy_getStakedBalance', [address, 'SNRG']).catch(() => ({ balance: 0 })),
            pool.query(`SELECT t.hash, t.block_number, b.timestamp AS block_timestamp, t.tx_index, t.sender_address,
                t.receiver_address, t.amount_nwei, t.fee_nwei, t.nonce, t.data, t.status,
                t.signature_algorithm, t.timestamp_unix
           FROM transactions t
           JOIN blocks b ON b.number = t.block_number
          WHERE t.sender_address = $1 OR t.receiver_address = $1
          ORDER BY t.block_number DESC, t.tx_index DESC NULLS LAST
          LIMIT 50`, [address]),
        ]);
        const stakingEntries = Array.isArray(stakingInfo) ? stakingInfo : [];
        const stakingEntryTotal = stakingEntries.reduce((total, entry) => {
            if (entry?.is_active === false)
                return total;
            return total + parseBigInt(entry?.amount);
        }, 0n);
        const validatorStakeNwei = parseBigInt(validatorRpc?.stake_amount);
        const rpcStakedBalanceNwei = parseBigInt(stakedBalance?.balance);
        const effectiveStakeNwei = rpcStakedBalanceNwei > 0n ? rpcStakedBalanceNwei :
            stakingEntryTotal > 0n ? stakingEntryTotal :
                validatorStakeNwei;
        const stakedBalanceNwei = effectiveStakeNwei.toString();
        const hasStake = effectiveStakeNwei > 0n || stakingEntries.length > 0;
        if (!validatorRpc && !hasStake) {
            throw api.httpErrors.notFound('Validator not found');
        }
        const validator = validatorRpc || {
            address,
            name: null,
            stake_amount: stakedBalanceNwei,
            synergy_score: null,
            total_blocks_produced: 0,
            uptime_percentage: null,
            cluster_id: null,
            cluster_address: null,
            last_active: null,
            status: hasStake ? 'Staked' : 'Inactive',
            role_hint: 'validator',
        };
        const consensusActive = String(validator.status || '').toLowerCase() === 'active';
        const synergyBreakdown = synergyBreakdownRpc && !synergyBreakdownRpc.error ? synergyBreakdownRpc : null;
        return {
            validator,
            synergyBreakdown,
            stakingInfo: stakingEntries,
            walletBalanceNwei: String(walletBalance || 0),
            stakedBalanceNwei,
            hasStake,
            consensusActive,
            clusterAddress: validator.cluster_address || null,
            recentTransactions: recentTransactions.rows,
        };
    });
    api.get('/tokens', async () => {
        const [tokenStatsResult, networkStats, transfers24hRes, recentTransfersRes, topHoldersRes, distinctHoldersRes] = await Promise.all([
            rpcCallWithFallback(rpc, 'synergy_getTokenStats', ['SNRG']).catch(() => null),
            rpcCallWithFallback(rpc, 'synergy_getNetworkStats').catch(() => null),
            pool.query(`SELECT COUNT(*)::text AS count
           FROM transactions t
           JOIN blocks b ON b.number = t.block_number
          WHERE t.amount_nwei IS NOT NULL
            AND t.amount_nwei::numeric > 0
            AND b.timestamp >= NOW() - INTERVAL '24 hours'`),
            pool.query(`SELECT t.hash AS tx_hash, t.block_number AS block_height,
                t.sender_address AS from, t.receiver_address AS to,
                t.amount_nwei AS amount, t.fee_nwei AS fee,
                EXTRACT(EPOCH FROM b.timestamp)::bigint::text AS timestamp
           FROM transactions t
           JOIN blocks b ON b.number = t.block_number
          WHERE t.amount_nwei IS NOT NULL
            AND t.amount_nwei::numeric > 0
          ORDER BY t.block_number DESC, t.tx_index DESC NULLS LAST
          LIMIT 25`),
            pool.query(`SELECT COALESCE(name, 'Validator') AS label, address, stake_amount AS amount_nwei
           FROM validators_current
          WHERE stake_amount IS NOT NULL
          ORDER BY stake_amount::numeric DESC, address ASC
          LIMIT 5`),
            pool.query(`SELECT COUNT(DISTINCT address)::text AS count
           FROM (
             SELECT sender_address AS address FROM transactions WHERE sender_address IS NOT NULL
             UNION
             SELECT receiver_address AS address FROM transactions WHERE receiver_address IS NOT NULL
           ) addresses`),
        ]);
        const statsArray = Array.isArray(tokenStatsResult)
            ? tokenStatsResult
            : tokenStatsResult
                ? [tokenStatsResult]
                : [];
        const snrgStats = statsArray.find((item) => String(item.symbol || '').toUpperCase() === 'SNRG') || statsArray[0] || null;
        const totalSupplyNwei = snrgStats?.total_supply ?? networkStats?.total_supply ?? '0';
        const holders = numberFrom(snrgStats?.holders) || numberFrom(distinctHoldersRes.rows[0]?.count);
        const transfers24h = numberFrom(transfers24hRes.rows[0]?.count);
        const topHolderStakeTotal = topHoldersRes.rows.reduce((sum, row) => sum + parseBigInt(row.amount_nwei), 0n);
        return {
            totalHolders: holders,
            totalTransfers24h: transfers24h,
            items: [
                {
                    symbol: 'SNRG',
                    name: 'Synergy Testnet Token',
                    category: 'Native testnet beta token',
                    summary: 'Native Synergy Testnet asset used for balances, transfers, fees, staking, and validator onboarding.',
                    priceUsd: '0.00 USD',
                    change24h: '0.00%',
                    holders,
                    transferCount24h: transfers24h,
                    circulatingSupply: formatSnrgAmount(totalSupplyNwei),
                    contractAddress: null,
                    topHolders: topHoldersRes.rows.map((holder, index) => {
                        const amount = parseBigInt(holder.amount_nwei);
                        const allocationPercent = topHolderStakeTotal > 0n ? Number((amount * 10000n) / topHolderStakeTotal) / 100 : 0;
                        return {
                            label: holder.label || `Holder ${index + 1}`,
                            address: holder.address,
                            allocationPercent,
                        };
                    }),
                    recentTransfers: recentTransfersRes.rows,
                },
            ],
        };
    });
    // ── Contracts ────────────────────────────────────────────────────────────────
    api.get('/contracts', async (req) => {
        const { limit, page, offset } = parseLimitPage(req.query);
        const contractType = req.query?.type ? String(req.query.type) : null;
        const whereClause = contractType ? 'WHERE contract_type = $3' : '';
        const params = contractType
            ? [limit, offset, contractType]
            : [limit, offset];
        const res = await pool.query(`SELECT address, name, contract_type, bytecode_hash, verified, deployed_block, deployed_at
         FROM contracts
         ${whereClause}
        ORDER BY deployed_block ASC, name ASC
        LIMIT $1 OFFSET $2`, params);
        const totalRes = await pool.query(contractType
            ? 'SELECT COUNT(*)::text AS count FROM contracts WHERE contract_type = $1'
            : 'SELECT COUNT(*)::text AS count FROM contracts', contractType ? [contractType] : []);
        return { page, limit, total: totalRes.rows[0]?.count || '0', items: res.rows };
    });
    api.get('/contracts/:address', async (req) => {
        const address = normalizeAddress(String(req.params.address));
        if (!isSynergyAddress(address)) {
            throw api.httpErrors.badRequest('Invalid Synergy address');
        }
        const res = await pool.query(`SELECT address, name, contract_type, bytecode_hash, bytecode, init_params,
              verified, deployed_block, deployed_at, inserted_at
         FROM contracts
        WHERE address = $1`, [address]);
        if (res.rows.length === 0) {
            throw api.httpErrors.notFound('Contract not found');
        }
        const c = res.rows[0];
        return {
            address: c.address,
            name: c.name,
            contractType: c.contract_type,
            bytecodeHash: c.bytecode_hash,
            bytecode: c.bytecode,
            initParams: c.init_params,
            verified: c.verified,
            deployedBlock: c.deployed_block,
            deployedAt: c.deployed_at,
        };
    });
}, { prefix: '/api/v1' });
app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const statusCode = typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number'
        ? err.statusCode
        : 500;
    const errorName = err instanceof Error ? err.name : 'Error';
    const errorMessage = err instanceof Error ? err.message : 'Internal server error';
    reply.status(statusCode).send({
        ok: false,
        error: errorName,
        message: errorMessage,
    });
});
await app.listen({ port: cfg.port, host: cfg.host });
app.log.info(`Synergy Atlas API listening on ${cfg.host}:${cfg.port}`);
