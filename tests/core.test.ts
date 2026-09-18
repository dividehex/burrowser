import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { issueInvitation, redeemInvitation, verifyAccessToken, issueAccessToken, revokeAgent, issueChallengeFor, peekChallenge, type ChallengeStore } from '../src/identity.ts';
import { acquireLease, createProfile } from '../src/profiles.ts';
import { workerResources, workerSecretResource } from '../src/kube.ts';
import { validateBrowserUrl } from '../src/url-policy.ts';
import { reconcileProfile, reclaimIdleProfiles, reclaimStuckProfiles, stopProfile } from '../src/reconcile.ts';
import { dispatchTool, MCP_TOOLS } from '../src/mcp.ts';

const keys = () => generateKeyPairSync('ed25519');
const pub = (key: any) => key.export({ format: 'der', type: 'spki' }).toString('base64url');
test('invitation is single use and requires proof of possession', () => {
  const store: any = { invitations: new Map(), agents: new Map() }; const pair: any = keys(); const inv = issueInvitation(store, 0);
  const proof = sign(null, Buffer.from(`${inv.id}:${inv.invitation}`), pair.privateKey).toString('base64url');
  const agent = redeemInvitation(store, { id: inv.id, invitation: inv.invitation, displayName: 'social', publicKey: pub(pair.publicKey), proof }, 1);
  assert.equal(agent.displayName, 'social'); assert.throws(() => redeemInvitation(store, { id: inv.id, invitation: inv.invitation, displayName: 'x', publicKey: pub(pair.publicKey), proof }, 1));
});
test('token verifies and revocation/expiry are enforced', () => {
  const pair: any = keys(); const agent: any = { id: 'a', displayName: 'a', publicKey: pub(pair.publicKey) }; const store: any = { agents: new Map([['a', agent]]) };
  const token = issueAccessToken(agent, 'c', 'server-key', 1000, 100); assert.equal(verifyAccessToken(store, token, 'c', 'server-key', 1050).id, 'a'); assert.throws(() => verifyAccessToken(store, token, 'wrong', 'server-key', 1050)); revokeAgent(store, 'a', 1); assert.throws(() => verifyAccessToken(store, token, 'c', 'server-key', 1050));
  assert.throws(() => revokeAgent(store, 'missing'), /agent not found/);
});
test('challenges expire, are bounded, and only a matching non-expired one verifies', () => {
  const store: ChallengeStore = new Map();
  const value = issueChallengeFor(store, 'a', 0, 1000);
  assert.equal(peekChallenge(store, 'a', 500), value);
  assert.throws(() => peekChallenge(store, 'a', 1500), /challenge required/);
  assert.throws(() => peekChallenge(store, 'unknown', 500), /challenge required/);
  issueChallengeFor(store, 'b', 2000, 1000);
  assert.equal(store.has('a'), false, 'expired entries are swept on the next issuance');
  assert.throws(() => issueChallengeFor(store, 'overflow', 0, 1000, 1), /too many outstanding/);
});
test('profiles are tenant scoped and leases are exclusive', () => {
  const store: any = { profiles: new Map(), leases: new Map() }; const a: any = { id: 'a' }; const b: any = { id: 'b' }; const p = createProfile(store, a, 'Main'); assert.throws(() => createProfile(store, a, 'Main')); assert.throws(() => (createProfile as any)(store, b, '../secret')); const l = acquireLease(store, p, 'client-a', 0); assert.throws(() => acquireLease(store, p, 'client-b', 1)); assert.equal(l.fencingGeneration, 1);
});
test('worker manifests are fixed and require the reviewed local seccomp profile', () => { const p: any = { id: 'abc', pvcName: 'ab-abc' }; assert.throws(() => workerResources(p)); const r = workerResources(p, `ghcr.io/x/worker@sha256:${'a'.repeat(64)}`); assert.equal(r.pod.spec.automountServiceAccountToken, false); assert.deepEqual(r.pod.spec.securityContext.seccompProfile, { type: 'Localhost', localhostProfile: 'agent-browser/chromium.json' }); assert.equal(r.pod.spec.volumes[0].persistentVolumeClaim.claimName, p.pvcName); assert.equal(r.pod.spec.containers[0].env[0].valueFrom.secretKeyRef.key, 'WORKER_CONTROLLER_CREDENTIAL'); assert.deepEqual(r.service.spec.ports.map((port: any) => port.name), ['rpc', 'vnc']); assert.equal(r.pod.spec.containers[0].env.find((e: any) => e.name === 'AGENT_BROWSER_VNC_PASSWORD').valueFrom.secretKeyRef.key, 'AGENT_BROWSER_VNC_PASSWORD'); });
test('every worker Pod carries bounded CPU/memory requests and limits, so one runaway session cannot starve the node', () => {
  const p: any = { id: 'abc', pvcName: 'ab-abc' };
  const r = workerResources(p, `ghcr.io/x/worker@sha256:${'a'.repeat(64)}`);
  const resources = r.pod.spec.containers[0].resources;
  assert.ok(resources, 'the worker container must declare resources');
  assert.ok(resources.requests?.cpu && resources.requests?.memory, 'requests must be set so the scheduler can bin-pack correctly');
  assert.ok(resources.limits?.cpu && resources.limits?.memory, 'limits must be set so a single session cannot exhaust node capacity');
});
test('worker credentials are delivered through a Kubernetes Secret, not pod arguments', () => { const p: any = { id: 'abc', pvcName: 'ab-abc' }; const secret: any = workerSecretResource(p, { controllerCredential: 'controller', authenticatorKey: 'key', vncPassword: 'vncpass' }); assert.equal(secret.stringData.WORKER_CONTROLLER_CREDENTIAL, 'controller'); assert.equal(secret.stringData.AGENT_BROWSER_AUTHENTICATOR_KEY, 'key'); assert.equal(secret.stringData.AGENT_BROWSER_VNC_PASSWORD, 'vncpass'); assert.equal(JSON.stringify(workerResources(p, `ghcr.io/x/worker@sha256:${'a'.repeat(64)}`)).includes('controller'), false); });
test('browser URL policy rejects local and credential-bearing destinations', () => { assert.throws(() => validateBrowserUrl('http://127.0.0.1:8080')); assert.throws(() => validateBrowserUrl('http://172.20.0.1')); assert.throws(() => validateBrowserUrl('http://100.64.0.1')); assert.throws(() => validateBrowserUrl('http://[fd00::1]')); assert.throws(() => validateBrowserUrl('http://[fe80::1]')); assert.throws(() => validateBrowserUrl('https://u:p@example.com')); assert.equal(validateBrowserUrl('https://example.com/path'), 'https://example.com/path'); });
test('reconciliation is idempotent and pod shutdown preserves PVC', async () => {
  const p: any = { id: 'abc', pvcName: 'ab-abc', state: 'ABSENT' }; const objects = new Map(); const operations: string[] = [];
  const kube: any = { get: async (kind: string, name: string) => objects.get(`${kind}/${name}`), apply: async (kind: string, name: string, value: unknown) => { operations.push(`apply:${kind}`); objects.set(`${kind}/${name}`, value); }, delete: async (kind: string, name: string) => { operations.push(`delete:${kind}`); objects.delete(`${kind}/${name}`); }, podStatus: async () => ({ phase: 'Running', ready: true }) };
  const image = `ghcr.io/x/worker@sha256:${'a'.repeat(64)}`;
  assert.equal(await reconcileProfile(p, kube, image), 'STARTING'); assert.equal(await reconcileProfile(p, kube, image), 'READY');
  await stopProfile(p, kube); assert.equal(p.state, 'STOPPED'); assert.ok(objects.has('pvc/ab-abc')); assert.deepEqual(operations.slice(-2), ['delete:pod', 'delete:service']);
});
test('idle reclamation skips active leases, drains expired profiles, and preserves PVCs', async () => {
  const old: any = { id: 'old', pvcName: 'ab-old', state: 'READY', lastUsedAt: 0 }; const active: any = { id: 'active', pvcName: 'ab-active', state: 'READY', lastUsedAt: 0 }; const store: any = { profiles: new Map([['old', old], ['active', active]]), leases: new Map([['active', { profileId: 'active', ownerClientId: 'c', fencingGeneration: 1, expiresAt: 999_999 }]]) }; const objects = new Map([['pvc/ab-old', {}], ['pvc/ab-active', {}], ['pod/ab-old', {}], ['service/ab-old', {}], ['pod/ab-active', {}], ['service/ab-active', {}]]); const kube: any = { get: async (kind: string, name: string) => objects.get(`${kind}/${name}`), apply: async () => {}, delete: async (kind: string, name: string) => { objects.delete(`${kind}/${name}`); }, podStatus: async () => ({ phase: 'Running', ready: true }) };
  assert.equal(await reclaimIdleProfiles(store, kube, 900_000, 900_000), 1); assert.equal(old.state, 'STOPPED'); assert.equal(active.state, 'READY'); assert.equal(objects.has('pvc/ab-old'), true); assert.equal(objects.has('pod/ab-old'), false);
});
test('stuck reclamation only fires after the grace period, tracks per profile, and preserves PVCs', async () => {
  const stuck: any = { id: 's', pvcName: 'ab-s', state: 'STARTING' }; const fresh: any = { id: 'n', pvcName: 'ab-n', state: 'STARTING' }; const ready: any = { id: 'r', pvcName: 'ab-r', state: 'READY' };
  const store: any = { profiles: new Map([['s', stuck], ['n', fresh], ['r', ready]]), leases: new Map() };
  const objects = new Map([['pvc/ab-s', {}], ['pod/ab-s', {}], ['service/ab-s', {}]]);
  const kube: any = { get: async () => undefined, apply: async () => {}, delete: async (kind: string, name: string) => { objects.delete(`${kind}/${name}`); }, podStatus: async () => undefined };
  const stuckSince = new Map<string, number>([['s', 0]]);
  assert.equal(await reclaimStuckProfiles(store, kube, stuckSince, 100_000, 300_000), 0, 'grace period has not elapsed yet');
  assert.equal(stuck.state, 'STARTING'); assert.equal(stuckSince.get('n'), 100_000, 'a newly seen starting profile begins its own grace period');
  assert.equal(await reclaimStuckProfiles(store, kube, stuckSince, 350_000, 300_000), 1, 'only the profile whose grace period actually elapsed is reclaimed');
  assert.equal(stuck.state, 'FAILED'); assert.equal(objects.has('pvc/ab-s'), true); assert.equal(objects.has('pod/ab-s'), false);
  assert.equal(stuckSince.has('s'), false, 'cleared once reclaimed'); assert.equal(fresh.state, 'STARTING'); assert.equal(ready.state, 'READY');
});
test('MCP is allowlisted, tenant scoped, and lease gated', async () => {
  const store: any = { profiles: new Map(), leases: new Map() }; const agent: any = { id: 'a' }; const other: any = { id: 'b' }; const profile = await dispatchTool(store, agent, undefined, 'browser_profiles_create', { name: 'Main' });
  assert.equal(MCP_TOOLS.includes('browser_navigate'), true); assert.equal((await dispatchTool(store, agent, undefined, 'browser_profiles_list', {})).length, 1); assert.equal((await dispatchTool(store, other, undefined, 'browser_profiles_list', {})).length, 0);
  const lease: any = await dispatchTool(store, agent, undefined, 'browser_profile_open', { profile_id: profile.id, client_id: 'c' });
  const worker: any = { navigate: async (url: string) => url, snapshot: async () => ({ text: 'safe' }), click: async () => ({}), type: async () => ({}), authStatus: async () => ({ authenticated: false }) };
  assert.equal(await dispatchTool(store, agent, worker, 'browser_navigate', { profile_id: profile.id, client_id: 'c', fencing_generation: lease.fencingGeneration, url: 'https://example.com' }), 'https://example.com/');
  await assert.rejects(() => dispatchTool(store, other, worker, 'browser_snapshot', { profile_id: profile.id, client_id: 'x', fencing_generation: lease.fencingGeneration })); await assert.rejects(() => dispatchTool(store, agent, worker, 'browser_evaluate', {}));
});
