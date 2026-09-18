import { createPostgresRepository } from './postgres.ts';
import { runMigrations } from './migrate.ts';

const { pool } = createPostgresRepository();
try {
  const result = await runMigrations(pool);
  console.log(`migrations discovered=${result.discovered} applied=${result.applied}`);
} finally {
  await pool.end();
}
