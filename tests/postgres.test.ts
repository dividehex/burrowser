import test from 'node:test';
import assert from 'node:assert/strict';

test('PostgreSQL factory requires an explicit connection string', async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { createPostgresRepository } = await import('../src/postgres.ts');
    assert.throws(() => createPostgresRepository(), /DATABASE_URL is required/);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
