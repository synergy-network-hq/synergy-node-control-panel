/**
 * seed-genesis-contracts.ts
 *
 * Reads the canonical genesis.json and upserts all genesis system contracts
 * into the explorer Postgres database.
 *
 * Usage (from backend/):
 *   npx ts-node --esm scripts/seed-genesis-contracts.ts
 *   # or after build:
 *   node dist/scripts/seed-genesis-contracts.js
 *
 * Requires DATABASE_URL in .env (same as the API).
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
    process.exit(1);
}
// Resolve genesis.json relative to the repo root
const GENESIS_PATH = path.resolve(process.cwd(), '../../../synergy-testnet-beta/config/genesis.json');
// Human-readable labels for each genesis contract key
const CONTRACT_LABELS = {
    governance: 'Governance',
    identity: 'Identity',
    reward_distributor: 'RewardDistributor',
    slashing: 'Slashing',
    staking: 'Staking',
    synergy_oracle: 'SynergyOracle',
    treasury: 'Treasury',
    validator_registry: 'ValidatorRegistry',
};
async function main() {
    const pool = new Pool({ connectionString: DB_URL });
    let genesis;
    try {
        genesis = JSON.parse(readFileSync(GENESIS_PATH, 'utf-8'));
    }
    catch (err) {
        console.error(`Failed to read genesis.json at ${GENESIS_PATH}: ${err.message}`);
        process.exit(1);
    }
    const contracts = genesis['contracts'];
    if (!contracts || typeof contracts !== 'object') {
        console.error('genesis.json has no "contracts" section.');
        process.exit(1);
    }
    const genesisTimestamp = genesis?.header?.timestamp || null;
    console.log(`Seeding ${Object.keys(contracts).length} genesis contracts…\n`);
    let upserted = 0;
    for (const [key, data] of Object.entries(contracts)) {
        const address = data.address;
        const bytecodeHash = data.bytecode_hash ?? null;
        const bytecode = data.bytecode ?? null;
        const initParams = data.init_params ?? null;
        const name = CONTRACT_LABELS[key] ?? key;
        await pool.query(`INSERT INTO contracts
         (address, name, contract_type, bytecode_hash, bytecode, init_params,
          verified, deployed_block, deployed_at)
       VALUES ($1, $2, 'genesis_system', $3, $4, $5, TRUE, 0, $6)
       ON CONFLICT (address) DO UPDATE SET
         name          = EXCLUDED.name,
         bytecode_hash = EXCLUDED.bytecode_hash,
         bytecode      = EXCLUDED.bytecode,
         init_params   = EXCLUDED.init_params,
         verified      = EXCLUDED.verified,
         deployed_at   = EXCLUDED.deployed_at`, [address, name, bytecodeHash, bytecode, initParams ? JSON.stringify(initParams) : null, genesisTimestamp]);
        console.log(`  ✅  ${name.padEnd(22)} ${address}`);
        upserted++;
    }
    console.log(`\n🟢  Seeded ${upserted} contracts into the database.`);
    await pool.end();
}
main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
});
