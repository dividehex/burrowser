import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dispatchTool } from '../src/mcp.ts';
import { createGateway, makeState } from '../src/server.ts';

type Call = (path: string, init?: any) => Promise<Response>;

async function enrollAgent(call: Call, displayName: string) {
  const pair: any = generateKeyPairSync('ed25519');
  const invite = await (await call('/admin/enrollments', { method: 'POST', headers: { authorization: 'Bearer admin-secret' } })).json() as any;
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const enrollProof = sign(null, Buffer.from(`${invite.id}:${invite.invitation}`), pair.privateKey).toString('base64url');
  const enrolled = await (await call('/v1/identity/enroll', { method: 'POST', body: JSON.stringify({ id: invite.id, invitation: invite.invitation, displayName, publicKey, proof: enrollProof }) })).json() as any;
  const challengeResp = await (await call('/v1/identity/challenge', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id }) })).json() as any;
  const authProof = sign(null, Buffer.from(challengeResp.challenge), pair.privateKey).toString('base64url');
  const tokenResp = await (await call('/v1/identity/token', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id, proof: authProof }) })).json() as any;
  return { agentId: enrolled.agent_id, token: tokenResp.access_token, challenge: challengeResp.challenge };
}

function textOf(result: any): string {
  return result.content[0].text;
}

test('MCP over the real SDK: initialize, tools/list, tenant isolation, and session-hijack rejection', async () => {
  const server = createGateway(makeState(), 'admin-secret', 'token-secret');
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const call: Call = (path, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

  const agentA = await enrollAgent(call, 'agent-a');
  const agentB = await enrollAgent(call, 'agent-b');

  const badOrigin = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${agentA.token}`, 'x-agent-challenge': agentA.challenge, origin: 'https://evil.example', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(badOrigin.status, 403);

  const clientA = new Client({ name: 'test-client-a', version: '1.0.0' });
  const transportA = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${agentA.token}`, 'x-agent-challenge': agentA.challenge } } });
  await clientA.connect(transportA);

  const tools = await clientA.listTools();
  assert.ok(tools.tools.some(t => t.name === 'browser_profiles_list'));
  assert.ok(tools.tools.some(t => t.name === 'browser_navigate'));

  const created = await clientA.callTool({ name: 'browser_profiles_create', arguments: { name: 'Main' } });
  const profile = JSON.parse(textOf(created));
  assert.equal(profile.name, 'Main');

  const listA = await clientA.callTool({ name: 'browser_profiles_list', arguments: {} });
  assert.equal(JSON.parse(textOf(listA)).length, 1);

  const clientB = new Client({ name: 'test-client-b', version: '1.0.0' });
  const transportB = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${agentB.token}`, 'x-agent-challenge': agentB.challenge } } });
  await clientB.connect(transportB);
  const listB = await clientB.callTool({ name: 'browser_profiles_list', arguments: {} });
  assert.deepEqual(JSON.parse(textOf(listB)), []);

  const unknownTool = await clientA.callTool({ name: 'browser_evaluate', arguments: {} });
  assert.equal(unknownTool.isError, true);

  const hijack = await call('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${agentB.token}`, 'x-agent-challenge': agentB.challenge, accept: 'application/json, text/event-stream', 'mcp-session-id': transportA.sessionId! },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
  });
  assert.equal(hijack.status, 400);

  await clientA.close();
  await clientB.close();
  server.close();
});

test('MCP profile tools use durable profile and lease operations', async () => {
  const profiles: any[] = [];
  const leases = new Map<string, any>();
  const durable = {
    async listProfiles(agentId: string) { return profiles.filter(profile => profile.agentId === agentId); },
    async createProfile(profile: any) { profiles.push(profile); return profile; },
    async acquireLease(profileId: string, agentId: string, clientId: string, now: Date) {
      const current = leases.get(profileId);
      if (current && current.expiresAt > now.getTime() && current.ownerClientId !== clientId) throw new Error('profile busy');
      const lease = { profileId, ownerClientId: clientId, fencingGeneration: (current?.fencingGeneration ?? 0) + 1, expiresAt: now.getTime() + 30_000 };
      leases.set(profileId, lease); return lease;
    },
    async releaseLease(profileId: string, clientId: string, generation: number) {
      const lease = leases.get(profileId);
      if (!lease || lease.ownerClientId !== clientId || lease.fencingGeneration !== generation) throw new Error('lease required or expired');
      leases.delete(profileId);
    },
    async getLease(profileId: string) { return leases.get(profileId); },
  };
  const agent: any = { id: 'a', displayName: 'a', publicKey: 'key' };
  const profile: any = await dispatchTool(durable, agent, undefined, 'browser_profiles_create', { name: 'Durable' }, 1000);
  const lease: any = await dispatchTool(durable, agent, undefined, 'browser_profile_open', { profile_id: profile.id, client_id: 'c' }, 1000);
  assert.equal(lease.ownerClientId, 'c');
  assert.deepEqual(await dispatchTool(durable, agent, undefined, 'browser_profile_release', { profile_id: profile.id, client_id: 'c', fencing_generation: lease.fencingGeneration }, 1000), { released: true });
});

test('MCP worker-touching tools validate the durable lease instead of an in-memory map', async () => {
  const profiles: any[] = [];
  const leases = new Map<string, any>();
  const durable = {
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
  const agent: any = { id: 'a', displayName: 'a', publicKey: 'key' };
  const worker: any = { snapshot: async () => ({ ok: true }) };
  const profile: any = await dispatchTool(durable, agent, undefined, 'browser_profiles_create', { name: 'Durable' }, 1000);
  const lease: any = await dispatchTool(durable, agent, undefined, 'browser_profile_open', { profile_id: profile.id, client_id: 'c' }, 1000);
  assert.deepEqual(await dispatchTool(durable, agent, worker, 'browser_snapshot', { profile_id: profile.id, client_id: 'c', fencing_generation: lease.fencingGeneration }, 1000), { ok: true });
  await assert.rejects(() => dispatchTool(durable, agent, worker, 'browser_snapshot', { profile_id: profile.id, client_id: 'c', fencing_generation: lease.fencingGeneration + 1 }, 1000));
  await assert.rejects(() => dispatchTool(durable, agent, worker, 'browser_snapshot', { profile_id: profile.id, client_id: 'other', fencing_generation: lease.fencingGeneration }, 1000));
});
