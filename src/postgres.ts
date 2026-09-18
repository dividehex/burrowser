import { Pool } from 'pg';
import { PostgresRepository } from './repository.ts';

export function createPostgresRepository(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
  return { repository: new PostgresRepository(pool), pool };
}
