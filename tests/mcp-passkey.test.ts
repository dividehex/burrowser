import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTool } from '../src/mcp.ts';

function durableStore() {
  const profiles: any[] = [];
  const leases = new Map<string, any>();
  return {
    async listProfiles(agentId: string) { return profiles.filter(profile => profile.agentId === agentId); },
    async createProfile(profile: any) { profiles.push(profile); return profile; },
    async acquireLease(profileId: string, agentId: string, clientId: string, now: Date) {
      const current = leases.get(profileId);
      const lease = { profileId, ownerClientId: clientId, fencingGeneration: (current?.fencingGeneration ?? 0) + 1, expiresAt: now.getTime() + 30_000 };
      leases.set(profileId, lease); return lease;
    },
    async releaseLease() {},
    async getLease(profileId: string) { return leases.get(profileId); },
  };
}

async function openedProfile(store: ReturnType<typeof durableStore>, agent: any) {
  const profile: any = await dispatchTool(store, agent, undefined, 'browser_profiles_create', { name: 'Durable' }, 1000);
  const lease: any = await dispatchTool(store, agent, undefined, 'browser_profile_open', { profile_id: profile.id, client_id: 'c' }, 1000);
  return { args: { profile_id: profile.id, client_id: 'c', fencing_generation: lease.fencingGeneration } };
}

test('browser_passkey_enrollment_request forwards the relying party id to the worker', async () => {
  const agent: any = { id: 'a', displayName: 'a', publicKey: 'key' };
  const store = durableStore();
  const { args } = await openedProfile(store, agent);
  let seenRpId: string | undefined;
  const worker: any = { passkeyEnrollBegin: async (rpId: string) => { seenRpId = rpId; return { status: 'awaiting_ceremony', rpId, expiresAt: 5000 }; } };
  const result: any = await dispatchTool(store, agent, worker, 'browser_passkey_enrollment_request', { ...args, rp_id: 'example.com' }, 1000);
  assert.equal(seenRpId, 'example.com');
  assert.equal(result.status, 'awaiting_ceremony');
});

test('browser_passkey_status reports metadata-only credentials and enrollment progress, never key material', async () => {
  const agent: any = { id: 'a', displayName: 'a', publicKey: 'key' };
  const store = durableStore();
  const { args } = await openedProfile(store, agent);
  const worker: any = {
    passkeyEnrollPoll: async () => ({ status: 'completed', rpId: 'example.com', credentialId: 'cred-1' }),
    passkeyList: async () => ({ credentials: [{ id: 'cred-1', rpId: 'example.com', userHandle: 'user' }] }),
  };
  const result: any = await dispatchTool(store, agent, worker, 'browser_passkey_status', args, 1000);
  assert.deepEqual(result, {
    supported: true,
    credentials: [{ id: 'cred-1', rpId: 'example.com', userHandle: 'user' }],
    enrollment: { status: 'completed', rpId: 'example.com', credentialId: 'cred-1' },
  });
  assert.equal(JSON.stringify(result).includes('privateKey'), false);
  assert.equal(JSON.stringify(result).includes('publicKey'), false);
});

test('passkey tools require a valid lease like other worker-touching tools', async () => {
  const agent: any = { id: 'a', displayName: 'a', publicKey: 'key' };
  const store = durableStore();
  const { args } = await openedProfile(store, agent);
  const worker: any = { passkeyEnrollBegin: async () => ({ status: 'awaiting_ceremony' }) };
  await assert.rejects(() => dispatchTool(store, agent, worker, 'browser_passkey_enrollment_request', { ...args, rp_id: 'example.com', fencing_generation: args.fencing_generation + 1 }, 1000));
});
