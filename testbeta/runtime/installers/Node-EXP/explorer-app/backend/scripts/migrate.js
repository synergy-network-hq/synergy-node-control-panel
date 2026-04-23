import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error('Missing DATABASE_URL environment variable (DATABASE_URL=postgres://...)');
}
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const migrationsDir = process.env.MIGRATIONS_DIR
    ? path.resolve(process.env.MIGRATIONS_DIR)
    : path.resolve(packageDir, 'migrations');
async function ensureMigrationsTable(pool) {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
function listMigrationFiles() {
    if (!fs.existsSync(migrationsDir)) {
        throw new Error(`Migrations directory not found: ${migrationsDir}`);
    }
    return fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql') && !f.startsWith('.') && !f.startsWith('._'))
        .sort();
}
async function getAppliedMigrations(pool) {
    const res = await pool.query('SELECT id FROM schema_migrations ORDER BY id ASC');
    return new Set(res.rows.map((r) => r.id));
}
async function applyMigrations() {
    console.log(`[migrate] Using migrations directory: ${migrationsDir}`);
    console.log('[migrate] Connecting to database...');
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
        // Test connection
        await pool.query('SELECT 1');
        console.log('[migrate] Database connection successful');
        await ensureMigrationsTable(pool);
        const files = listMigrationFiles();
        if (files.length === 0) {
            throw new Error(`No SQL migration files found in ${migrationsDir}`);
        }
        const applied = await getAppliedMigrations(pool);
        const toApply = files.filter((f) => !applied.has(f));
        if (toApply.length === 0) {
            console.log('[migrate] No migrations to apply.');
            return;
        }
        for (const file of toApply) {
            const fullPath = path.join(migrationsDir, file);
            const sql = fs.readFileSync(fullPath, 'utf8');
            console.log(`[migrate] Applying ${file}...`);
            await pool.query('BEGIN');
            try {
                await pool.query(sql);
                await pool.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
                await pool.query('COMMIT');
            }
            catch (err) {
                await pool.query('ROLLBACK');
                throw err;
            }
        }
        console.log(`[migrate] Applied ${toApply.length} migration(s).`);
    }
    finally {
        await pool.end();
    }
}
applyMigrations().catch((err) => {
    console.error('[migrate] Failed:');
    console.error(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
        console.error(err.stack);
    }
    process.exit(1);
});
