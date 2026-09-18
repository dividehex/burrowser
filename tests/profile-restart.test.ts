import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileController } from '../src/controller.ts';
import { PostgresRepository, type DbClient, type DbPool, type QueryResult } from '../src/repository.ts';

class FakeClient implements DbClient {
  readonly calls: string[] = [];
  private readonly responses: QueryResult[];
  constructor(responses: QueryResult[]) { this.responses = responses; }
  async query<Row = Record<string, unknown>>(text: string) {
    this.calls.push(text);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] } as QueryResult<Row>;
    return (this.responses.shift() ?? { rows: [] }) as QueryResult<Row>;
  }
  release() {}
}

test('acquiring a lease moves a STOPPED profile to ABSENT (and leaves every other state alone) in the same locked transaction', async () => {
  const lease = { profile_id: 'p', owner_client_id: 'c', fencing_generation: 1, expires_at: new Date(Date.now() + 1000) };
  const client = new FakeClient([{ rows: [{ id: 'p' }] }, { rows: [] }, { rows: [lease] }]);
  await new PostgresRepository({ async connect() { return client; } } as DbPool).acquireLease('p', 'a', 'c', new Date());
  const update = client.calls.find(call => call.startsWith('UPDATE profiles SET last_used_at'))!;
  assert.match(update, /state = CASE WHEN state = 'STOPPED' THEN 'ABSENT' ELSE state END/);
  assert.match(client.calls[1], /FOR UPDATE/, 'the profile row is locked before the state is changed');
});

test('the controller does not re-persist an unchanged STOPPED profile, so it cannot clobber a restart requested mid-pass', async () => {
  const stopped: any = { id: 'p', agentId: 'a', name: 'main', pvcName: 'bw-p', state: 'STOPPED', createdAt: 0, lastUsedAt: 0 };
  const idle: any = { id: 'q', agentId: 'a', name: 'idle', pvcName: 'bw-q', state: 'READY', createdAt: 0, lastUsedAt: 0 };
  const written: string[] = [];
  const objects = new Map<string, unknown>([['pvc/bw-q', {}], ['pod/bw-q', {}], ['service/bw-q', {}], ['secret/bw-q-worker-auth', {}]]);
  const kube: any = { get: async (kind: string, name: string) => objects.get(`${kind}/${name}`), apply: async () => {}, delete: async (kind: string, name: string) => { objects.delete(`${kind}/${name}`); }, podStatus: async () => ({ phase: 'Running', ready: true }) };
  const controller = new ProfileController({
    state: { async listProfiles() { return [stopped, idle]; }, async listLeases() { return []; }, async updateProfileState(id, state) { written.push(`${id}:${state}`); } },
    secrets: { async get() { return { controllerCredential: 'c', authenticatorKey: 'k', vncPassword: 'v' }; } },
    kube, workerImage: `ghcr.io/x/worker@sha256:${'a'.repeat(64)}`,
  });
  await controller.reconcileOnce(20 * 60_000);
  assert.ok(!written.includes('p:STOPPED'), 'a profile that was already STOPPED at the start of the pass is left alone');
  assert.ok(written.includes('q:STOPPED'), 'a profile reclaimed for idleness in this pass is persisted');
});
