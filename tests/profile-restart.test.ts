import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileController } from '../src/controller.ts';
import { dispatchTool } from '../src/mcp.ts';
import { PostgresRepository, type DbClient, type DbPool, type QueryResult } from '../src/repository.ts';

const agent: any = { id: 'a', displayName: 'a', publicKey: '' };
function durableStoreWith(state: string) {
  const profile: any = { id: 'p', agentId: 'a', name: 'main', pvcName: 'bw-p', state, createdAt: 0, lastUsedAt: 0 };
  const store: any = {
    listProfiles: async () => [profile],
    acquireLease: async (profileId: string, _agent: string, clientId: string, now: Date) => ({ profileId, ownerClientId: clientId, fencingGeneration: 1, expiresAt: now.getTime() + 120_000 }),
    getLease: async () => ({ profileId: 'p', ownerClientId: 'c', fencingGeneration: 1, expiresAt: Date.now() + 60_000 }),
  };
  return store;
}

test('opening a profile that was stopped for idleness reports it is restarting and says how to wait', async () => {
  const opened: any = await dispatchTool(durableStoreWith('STOPPED'), agent, undefined, 'browser_profile_open', { profile_id: 'p', client_id: 'c' });
  assert.equal(opened.profileState, 'ABSENT', 'the repository hands a STOPPED profile back to the controller as ABSENT');
  assert.equal(opened.fencingGeneration, 1);
  assert.match(opened.hint, /poll browser_profiles_list until it is READY/);

  const ready: any = await dispatchTool(durableStoreWith('READY'), agent, undefined, 'browser_profile_open', { profile_id: 'p', client_id: 'c' });
  assert.equal(ready.profileState, 'READY');
  assert.equal(ready.hint, undefined);
});

test('browser tools on a profile that is not READY fail with an explanation instead of a connection error', async () => {
  const worker: any = { navigate: async () => { throw new Error('should not be reached'); } };
  const args = { profile_id: 'p', client_id: 'c', fencing_generation: 1, url: 'https://example.com/' };
  for (const state of ['ABSENT', 'STARTING', 'STOPPED', 'FAILED', 'DELETING']) {
    await assert.rejects(() => dispatchTool(durableStoreWith(state), agent, worker, 'browser_navigate', args), new RegExp(`the profile is ${state}, not READY yet`));
  }
  await dispatchTool(durableStoreWith('READY'), agent, { navigate: async (url: string) => ({ url }) } as any, 'browser_navigate', args);
});

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
