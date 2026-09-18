import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { ProfileController } from '../src/controller.ts';
import { createGateway, makeState } from '../src/server.ts';

test('the controller reconciles a large number of profiles in one tick without errors or runaway latency', async () => {
  const PROFILE_COUNT = 250;
  const profiles: any[] = Array.from({ length: PROFILE_COUNT }, (_, i) => ({ id: `p${i}`, agentId: 'a', name: `Profile ${i}`, pvcName: `ab-p${i}`, state: 'ABSENT', createdAt: 0, lastUsedAt: Date.now() }));
  const objects = new Map<string, unknown>();
  const kube: any = {
    get: async (kind: string, name: string) => objects.get(`${kind}/${name}`),
    apply: async (kind: string, name: string, value: unknown) => { objects.set(`${kind}/${name}`, value); },
    delete: async () => {},
    podStatus: async () => undefined,
  };
  const controller = new ProfileController({
    state: { async listProfiles() { return profiles; }, async listLeases() { return []; } },
    secrets: { async get() { return { controllerCredential: 'c', authenticatorKey: 'k', vncPassword: 'v' }; } },
    kube,
    workerImage: `ghcr.io/x/worker@sha256:${'a'.repeat(64)}`,
  });

  const startedAt = Date.now();
  const result = await controller.reconcileOnce();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.reconciled, PROFILE_COUNT);
  assert.ok(profiles.every(profile => profile.state === 'STARTING'));
  assert.ok(elapsedMs < 5000, `reconciling ${PROFILE_COUNT} fake profiles took ${elapsedMs}ms - something is scaling far worse than linearly`);
});

test('many concurrent profile-create requests for the same agent all succeed with distinct ids and no cross-request corruption', async () => {
  const server = createGateway(makeState(), 'admin-secret', 'token-secret');
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const call = (path: string, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

  const pair: any = generateKeyPairSync('ed25519');
  const invite = await (await call('/admin/enrollments', { method: 'POST', headers: { authorization: 'Bearer admin-secret' } })).json() as any;
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const proof = sign(null, Buffer.from(`${invite.id}:${invite.invitation}`), pair.privateKey).toString('base64url');
  const enrolled = await (await call('/v1/identity/enroll', { method: 'POST', body: JSON.stringify({ id: invite.id, invitation: invite.invitation, displayName: 'agent', publicKey, proof }) })).json() as any;
  const challengeResp = await (await call('/v1/identity/challenge', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id }) })).json() as any;
  const authProof = sign(null, Buffer.from(challengeResp.challenge), pair.privateKey).toString('base64url');
  const tokenResp = await (await call('/v1/identity/token', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id, proof: authProof }) })).json() as any;
  const authHeaders = { authorization: `Bearer ${tokenResp.access_token}`, 'x-agent-challenge': challengeResp.challenge };

  const CONCURRENCY = 40;
  const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) =>
    call('/v1/profiles', { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: `concurrent-${i}` }) }).then(r => r.json()),
  ));

  const ids = new Set(results.map((profile: any) => profile.id));
  assert.equal(ids.size, CONCURRENCY, 'every concurrent create must get its own unique profile id');
  const listed = await (await call('/v1/profiles', { headers: authHeaders })).json() as any;
  assert.equal(listed.profiles.length, CONCURRENCY, 'the store must end up with exactly the profiles that were actually created, nothing lost or duplicated');

  server.close();
});

test('concurrent lease-acquisition attempts on the same profile from many different clients yield exactly one winner, never a double grant', async () => {
  const server = createGateway(makeState(), 'admin-secret', 'token-secret');
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const call = (path: string, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

  const pair: any = generateKeyPairSync('ed25519');
  const invite = await (await call('/admin/enrollments', { method: 'POST', headers: { authorization: 'Bearer admin-secret' } })).json() as any;
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const proof = sign(null, Buffer.from(`${invite.id}:${invite.invitation}`), pair.privateKey).toString('base64url');
  const enrolled = await (await call('/v1/identity/enroll', { method: 'POST', body: JSON.stringify({ id: invite.id, invitation: invite.invitation, displayName: 'agent', publicKey, proof }) })).json() as any;
  const challengeResp = await (await call('/v1/identity/challenge', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id }) })).json() as any;
  const authProof = sign(null, Buffer.from(challengeResp.challenge), pair.privateKey).toString('base64url');
  const tokenResp = await (await call('/v1/identity/token', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id, proof: authProof }) })).json() as any;
  const authHeaders = { authorization: `Bearer ${tokenResp.access_token}`, 'x-agent-challenge': challengeResp.challenge };
  const profile = await (await call('/v1/profiles', { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'contested' }) })).json() as any;

  const CONCURRENCY = 20;
  const attempts = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) =>
    call(`/v1/profiles/${profile.id}/acquire`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ client_id: `client-${i}` }) }).then(r => ({ status: r.status })),
  ));

  const winners = attempts.filter(a => a.status === 200);
  const losers = attempts.filter(a => a.status !== 200);
  assert.equal(winners.length, 1, `expected exactly one of ${CONCURRENCY} concurrent acquire attempts to win the lease, got ${winners.length}`);
  assert.equal(losers.length, CONCURRENCY - 1);
  assert.ok(losers.every(a => a.status === 409), 'every loser must fail closed with a busy response, not silently succeed');

  server.close();
});
