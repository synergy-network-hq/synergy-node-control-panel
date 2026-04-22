import { Pool } from 'pg';
export function createPool(dbUrl) {
    return new Pool({ connectionString: dbUrl });
}
