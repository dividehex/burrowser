import { migrate, loadMigrationFiles } from 'postgres-migrations';
import type { Pool } from 'pg';

export async function runMigrations(pool: Pool, directory = new URL('../db/migrations/', import.meta.url).pathname) {
  const discovered = (await loadMigrationFiles(directory)).length;
  const client = await pool.connect();
  try {
    const applied = await migrate({ client }, directory);
    return { discovered, applied: applied.length };
  } finally {
    client.release();
  }
}
