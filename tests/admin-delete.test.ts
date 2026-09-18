import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { ProfileController } from '../src/controller.ts';
import { dispatchTool } from '../src/mcp.ts';
import { LEASE_TTL_MS } from '../src/profiles.ts';
import { PostgresRepository, type DbClient, type DbPool, type QueryResult } from '../src/repository.ts';
import { createGateway, makeState } from '../src/server.ts';

class FakeClient implements DbClient {
  readonly calls: string[] = [];
  readonly values: unknown[][] = [];
  private readonly responses: QueryResult[];
  constructor(responses: QueryResult[] = []) { this.responses = responses; }
  async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.calls.push(text); this.values.push([...values]);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] } as QueryResult<Row>;
    return (this.responses.shift() ?? { rows: [] }) as QueryResult<Row>;
  }
  release() {}
}
const repositoryWith = (...responses: QueryResult[]) => { const client = new FakeClient(responses); return { client, repository: new PostgresRepository({ async connect() { return client; } } as DbPool) }; };

test('requestProfileDeletion ends the lease, marks the profile DELETING, and audits who asked', async () => {
  const { client, repository } = repositoryWith({ rows: [{ state: 'READY' }] });
  await repository.requestProfileDeletion('p1', 'bootstrap');
  assert.deepEqual(client.calls.map(call => call.split(' ').slice(0, 3).join(' ')), ['BEGIN', 'SELECT state FROM', 'DELETE FROM control_leases', 'UPDATE profiles SET', 'INSERT INTO audit_events', 'COMMIT']);
  assert.deepEqual(client.values[4], ['admin', 'bootstrap', 'profile.delete.requested', 'p1', null, 'success']);
});

test('requestProfileDeletion is idempotent for a profile already DELETING and 404s for an unknown one', async () => {
  const already = repositoryWith({ rows: [{ state: 'DELETING' }] });
  await already.repository.requestProfileDeletion('p1', 'session');
  assert.ok(!already.client.calls.some(call => call.startsWith('UPDATE profiles')), 'no second transition');

  const missing = repositoryWith({ rows: [] });
  await assert.rejects(() => missing.repository.requestProfileDeletion('nope', 'session'), { status: 404 });
  assert.ok(missing.client.calls.includes('ROLLBACK'));
});

test('finalizeProfileDeletion removes the profile only if it is still DELETING, and audits it as the controller', async () => {
  const done = repositoryWith({ rows: [{ state: 'DELETING' }] });
  await done.repository.finalizeProfileDeletion('p1');
  assert.ok(done.client.calls.some(call => call.startsWith('DELETE FROM profiles')));
  assert.deepEqual(done.client.values.at(-2), ['system', 'controller', 'profile.delete.completed', 'p1', null, 'success']);

  const revived = repositoryWith({ rows: [{ state: 'READY' }] });
  await revived.repository.finalizeProfileDeletion('p1');
  assert.ok(!revived.client.calls.some(call => call.startsWith('DELETE FROM profiles')), 'a profile that is no longer DELETING is left alone');
});

test('deleteAgent refuses while the agent still owns profiles, and otherwise detaches invitations and deletes it', async () => {
  const blocked = repositoryWith({ rows: [{ id: 'a' }] }, { rows: [{ count: '2' }] });
  await assert.rejects(() => blocked.repository.deleteAgent('a', 'bootstrap'), { status: 409, message: /2 profile/ });
  assert.ok(!blocked.client.calls.some(call => call.startsWith('DELETE FROM agents')));

  const ok = repositoryWith({ rows: [{ id: 'a' }] }, { rows: [{ count: '0' }] });
  await ok.repository.deleteAgent('a', 'bootstrap');
  assert.ok(ok.client.calls.some(call => call.startsWith('UPDATE enrollment_invitations SET assigned_agent_id = NULL')));
  assert.ok(ok.client.calls.some(call => call.startsWith('DELETE FROM agents')));
  assert.deepEqual(ok.client.values.at(-2), ['admin', 'bootstrap', 'agent.deleted', null, 'a', 'success']);

  await assert.rejects(() => repositoryWith({ rows: [] }).repository.deleteAgent('nope', 'session'), { status: 404 });
});

test('a profile being deleted can neither be re-leased nor have its state overwritten by a stale reconcile', async () => {
  const lease = repositoryWith({ rows: [] });
  await assert.rejects(() => lease.repository.acquireLease('p', 'a', 'c', new Date()), /profile not found/);
  assert.match(lease.client.calls[1], /state <> 'DELETING'/);

  const update = repositoryWith();
  await update.repository.updateProfileState('p', 'READY');
  assert.match(update.client.calls[0], /state <> 'DELETING'/);
});

test('renewLease slides expiry for the current holder only and refreshes last_used_at when it did', async () => {
  const held = repositoryWith({ rows: [], rowCount: 1 });
  await held.repository.renewLease('p', 'c', 3, new Date(1000));
  assert.match(held.client.calls[1], /UPDATE control_leases SET expires_at/);
  assert.equal((held.client.values[1][3] as Date).getTime(), 1000 + LEASE_TTL_MS);
  assert.ok(held.client.calls.some(call => call.startsWith('UPDATE profiles SET last_used_at')));

  const lost = repositoryWith({ rows: [], rowCount: 0 });
  await lost.repository.renewLease('p', 'c', 3, new Date(1000));
  assert.ok(!lost.client.calls.some(call => call.startsWith('UPDATE profiles SET last_used_at')));
});

test('the controller tears down a DELETING profile including its PVC, and finalizes only once everything is gone', async () => {
  const profile: any = { id: 'p', agentId: 'a', name: 'Main', pvcName: 'bw-p', state: 'DELETING', createdAt: 0, lastUsedAt: 0 };
  const objects = new Map<string, unknown>([['pod/bw-p', {}], ['service/bw-p', {}], ['secret/bw-p-worker-auth', {}], ['pvc/bw-p', {}]]);
  let pvcTerminating = true;
  const deleted: string[] = [];
  const kube: any = {
    get: async (kind: string, name: string) => objects.get(`${kind}/${name}`),
    apply: async () => { throw new Error('a DELETING profile must never be re-provisioned'); },
    delete: async (kind: string, name: string) => { deleted.push(kind); if (kind === 'pvc' && pvcTerminating) return; objects.delete(`${kind}/${name}`); },
    podStatus: async () => undefined,
  };
  const finalized: string[] = [];
  const controller = new ProfileController({
    state: { async listProfiles() { return [profile]; }, async listLeases() { return []; }, async finalizeProfileDeletion(id) { finalized.push(id); } },
    secrets: { async get() { throw new Error('worker credentials must not be created for a DELETING profile'); } },
    kube, workerImage: 'unused',
  });

  const first = await controller.reconcileOnce();
  assert.deepEqual(first, { reconciled: 0, reclaimed: 0 });
  assert.deepEqual(deleted.sort(), ['pod', 'pvc', 'secret', 'service']);
  assert.deepEqual(finalized, [], 'the PVC is still Terminating, so the profile row must stay');

  pvcTerminating = false;
  await controller.reconcileOnce();
  assert.deepEqual(finalized, ['p']);
});

test('every successful worker tool call slides the lease forward, and an expired lease says how to recover', async () => {
  const agent: any = { id: 'a', displayName: 'a', publicKey: '' };
  const store: any = { profiles: new Map(), leases: new Map() };
  const worker: any = { navigate: async (url: string) => ({ url }) };
  const profile: any = await dispatchTool(store, agent, undefined, 'browser_profiles_create', { name: 'main' }, 0);
  const lease: any = await dispatchTool(store, agent, undefined, 'browser_profile_open', { profile_id: profile.id, client_id: 'c' }, 1000);
  const args = { profile_id: profile.id, client_id: 'c', fencing_generation: lease.fencingGeneration, url: 'https://example.com/' };

  await dispatchTool(store, agent, worker, 'browser_navigate', args, 100_000);
  assert.equal(store.leases.get(profile.id).expiresAt, 100_000 + LEASE_TTL_MS);
  assert.equal(store.profiles.get(profile.id).lastUsedAt, 100_000);
  await dispatchTool(store, agent, worker, 'browser_navigate', args, 200_000);

  await assert.rejects(() => dispatchTool(store, agent, worker, 'browser_navigate', args, 200_000 + LEASE_TTL_MS + 1), /call browser_profile_open again/);
});

test('durable stores get renewLease called after the lease check passes', async () => {
  const agent: any = { id: 'a', displayName: 'a', publicKey: '' };
  const profile: any = { id: 'p', agentId: 'a', name: 'main', pvcName: 'bw-p', state: 'READY', createdAt: 0, lastUsedAt: 0 };
  const renewed: unknown[][] = [];
  const store: any = {
    listProfiles: async () => [profile],
    getLease: async () => ({ profileId: 'p', ownerClientId: 'c', fencingGeneration: 4, expiresAt: 10_000 }),
    renewLease: async (...args: unknown[]) => { renewed.push(args); },
  };
  await dispatchTool(store, agent, { navigate: async () => ({}) } as any, 'browser_navigate', { profile_id: 'p', client_id: 'c', fencing_generation: 4, url: 'https://example.com/' }, 5000);
  assert.deepEqual(renewed.map(([id, client, generation]) => [id, client, generation]), [['p', 'c', 4]]);
  await assert.rejects(() => dispatchTool(store, agent, { navigate: async () => ({}) } as any, 'browser_navigate', { profile_id: 'p', client_id: 'c', fencing_generation: 3, url: 'https://example.com/' }, 5000), /lease required or expired/);
  assert.equal(renewed.length, 1, 'a wrong fencing generation must not renew anything');
});

test('admin agent/profile listing and deletion over HTTP (bootstrap bearer, confirmation, ownership rules)', async () => {
  const server = createGateway(makeState(), 'admin-secret', 'token-secret');
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const call = (path: string, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const admin = { authorization: 'Bearer admin-secret' };

  const invite = await (await call('/admin/enrollments', { method: 'POST', headers: admin })).json() as any;
  const pair: any = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const proof = sign(null, Buffer.from(`${invite.id}:${invite.invitation}`), pair.privateKey).toString('base64url');
  const enrolled = await (await call('/v1/identity/enroll', { method: 'POST', body: JSON.stringify({ id: invite.id, invitation: invite.invitation, displayName: 'doomed', publicKey, proof }) })).json() as any;
  const challenge = (await (await call('/v1/identity/challenge', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id }) })).json() as any).challenge;
  const token = (await (await call('/v1/identity/token', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id, proof: sign(null, Buffer.from(challenge), pair.privateKey).toString('base64url') }) })).json() as any).access_token;
  const agentHeaders = { authorization: `Bearer ${token}`, 'x-agent-challenge': challenge };
  const profile = await (await call('/v1/profiles', { method: 'POST', headers: agentHeaders, body: JSON.stringify({ name: 'main' }) })).json() as any;

  assert.equal((await call('/admin/agents')).status, 401);
  assert.equal((await call('/admin/agents', { headers: { authorization: 'Bearer admin-secreX' } })).status, 401, 'a near-miss bootstrap token is rejected');
  assert.equal((await call('/admin/agents', { headers: agentHeaders })).status, 401, 'an agent token is not an admin credential');
  const agents = (await (await call('/admin/agents', { headers: admin })).json() as any).agents;
  assert.deepEqual(agents.map((agent: any) => [agent.displayName, agent.status, agent.profileCount]), [['doomed', 'active', 1]]);
  const profiles = (await (await call('/admin/profiles', { headers: admin })).json() as any).profiles;
  assert.deepEqual(profiles.map((entry: any) => [entry.name, entry.agentDisplayName]), [['main', 'doomed']]);

  assert.equal((await call(`/admin/agents/${enrolled.agent_id}?confirm=${enrolled.agent_id}`, { method: 'DELETE', headers: admin })).status, 409, 'cannot delete an agent that still owns a profile');
  assert.equal((await call(`/admin/profiles/${profile.id}`, { method: 'DELETE', headers: admin })).status, 400, 'confirmation is mandatory');
  assert.equal((await call(`/admin/profiles/${profile.id}?confirm=wrong`, { method: 'DELETE', headers: admin })).status, 400);
  assert.equal((await call(`/admin/profiles/${profile.id}?confirm=${profile.id}`, { method: 'DELETE', headers: agentHeaders })).status, 401, 'an agent cannot delete its own profile');
  assert.equal((await call(`/admin/profiles/${profile.id}?confirm=${profile.id}`, { method: 'DELETE' })).status, 401);

  const deleted = await call(`/admin/profiles/${profile.id}?confirm=${profile.id}`, { method: 'DELETE', headers: admin });
  assert.equal(deleted.status, 200);
  assert.equal((await call(`/admin/profiles/${profile.id}?confirm=${profile.id}`, { method: 'DELETE', headers: admin })).status, 404);
  assert.deepEqual((await (await call('/admin/profiles', { headers: admin })).json() as any).profiles, []);

  assert.equal((await call(`/admin/agents/${enrolled.agent_id}?confirm=${enrolled.agent_id}`, { method: 'DELETE', headers: admin })).status, 204);
  assert.deepEqual((await (await call('/admin/agents', { headers: admin })).json() as any).agents, []);
  assert.equal((await call('/v1/profiles', { headers: agentHeaders })).status, 401, 'a deleted agent can no longer authenticate');
  assert.equal((await call('/admin/agents/nope?confirm=nope', { method: 'DELETE', headers: admin })).status, 404);
  server.close();
});
