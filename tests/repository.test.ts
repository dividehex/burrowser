import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRepository, type DbClient, type DbPool, type QueryResult } from '../src/repository.ts';

class FakeClient implements DbClient {
  readonly calls: string[] = [];
  readonly values: unknown[][] = [];
  private readonly responses: QueryResult[];
  released = false;

  constructor(responses: QueryResult[] = []) { this.responses = responses; }
  async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.calls.push(text); this.values.push([...values]);
    if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] } as QueryResult<Row>;
    if (text === 'COMMIT') {
      if (this.responses.some(response => response.rows[0] === 'fail-commit')) throw new Error('commit failed');
      return { rows: [] } as QueryResult<Row>;
    }
    return (this.responses.shift() ?? { rows: [] }) as QueryResult<Row>;
  }
  release() { this.released = true; }
}

class FakePool implements DbPool {
  readonly client: FakeClient;
  constructor(client: FakeClient) { this.client = client; }
  async connect() { return this.client; }
}

test('transaction commits and always releases the client', async () => {
  const client = new FakeClient([{ rows: [{ id: 'p', owner_client_id: 'c', fencing_generation: 1, expires_at: new Date(Date.now() + 10_000) }] }]);
  const repository = new PostgresRepository(new FakePool(client));
  const lease = await repository.releaseLease('p', 'c', 1, new Date());
  assert.equal(lease, undefined);
  assert.deepEqual(client.calls, ['BEGIN', 'SELECT profile_id, owner_client_id, fencing_generation, expires_at FROM control_leases WHERE profile_id = $1 FOR UPDATE', 'DELETE FROM control_leases WHERE profile_id = $1', 'COMMIT']);
  assert.equal(client.released, true);
});

test('transaction rolls back and releases when lease ownership fails', async () => {
  const client = new FakeClient([{ rows: [] }]);
  const repository = new PostgresRepository(new FakePool(client));
  await assert.rejects(() => repository.releaseLease('p', 'wrong-client', 1, new Date()), /lease required/);
  assert.deepEqual(client.calls, ['BEGIN', 'SELECT profile_id, owner_client_id, fencing_generation, expires_at FROM control_leases WHERE profile_id = $1 FOR UPDATE', 'ROLLBACK']);
  assert.equal(client.released, true);
});

test('lease acquisition locks the profile and existing lease in one transaction', async () => {
  const now = new Date('2026-09-17T12:00:00Z');
  const client = new FakeClient([
    { rows: [{ id: 'p' }] },
    { rows: [] },
    { rows: [{ profile_id: 'p', owner_client_id: 'c', fencing_generation: 1, expires_at: new Date('2026-09-17T12:00:30Z') }] },
    { rows: [] },
  ]);
  const repository = new PostgresRepository(new FakePool(client));
  const lease = await repository.acquireLease('p', 'a', 'c', now);
  assert.equal(lease.fencingGeneration, 1);
  assert.match(client.calls[1], /FOR UPDATE/);
  assert.match(client.calls[2], /FOR UPDATE/);
  assert.equal(client.calls.at(-1), 'COMMIT');
});

test('invitation redemption locks before inserting and consuming', async () => {
  const now = new Date('2026-09-17T12:00:00Z');
  const client = new FakeClient([
    { rows: [{ id: 'i', expires_at: new Date('2026-09-17T12:01:00Z'), consumed_at: null }] },
    { rows: [{ id: 'a', display_name: 'Agent', public_key: Buffer.from('public-key'), revoked_at: null }] },
    { rows: [] },
  ]);
  const repository = new PostgresRepository(new FakePool(client));
  const agent = await repository.redeemInvitation('i', now, { id: 'a', displayName: 'Agent', publicKey: Buffer.from('public-key').toString('base64url') });
  assert.equal(agent.id, 'a');
  assert.match(client.calls[2], /INSERT INTO agents/);
  assert.match(client.calls[3], /UPDATE enrollment_invitations/);
  assert.equal(client.calls.at(-1), 'COMMIT');
});

test('revokeAgent updates the row and fails closed when the agent is missing', async () => {
  const client = new FakeClient([{ rows: [], rowCount: 1 }]);
  const repository = new PostgresRepository(new FakePool(client));
  const now = new Date('2026-09-17T12:00:00Z');
  await repository.revokeAgent('a', now);
  assert.deepEqual(client.calls, ['UPDATE agents SET revoked_at = $2 WHERE id = $1']);
  assert.deepEqual(client.values[0], ['a', now]);

  const missing = new FakeClient([{ rows: [], rowCount: 0 }]);
  await assert.rejects(() => new PostgresRepository(new FakePool(missing)).revokeAgent('missing', now), /agent not found/);
});

test('controller queries are not tenant-filtered and return active durable state', async () => {
  const client = new FakeClient([
    { rows: [{ id: 'p', agent_id: 'a', name: 'Main', pvc_name: 'ab-p', state: 'READY', created_at: new Date(0), last_used_at: new Date(0) }] },
    { rows: [{ profile_id: 'p', owner_client_id: 'c', fencing_generation: '2', expires_at: new Date(1000) }] },
  ]);
  const repository = new PostgresRepository(new FakePool(client));
  assert.equal((await repository.listControllerProfiles()).length, 1);
  assert.equal((await repository.listControllerLeases())[0].fencingGeneration, 2);
  assert.match(client.calls[0], /deleted_at IS NULL/);
  assert.match(client.calls[1], /FROM control_leases/);
  assert.equal(client.released, true);
});
