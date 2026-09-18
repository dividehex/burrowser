import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileController } from '../src/controller.ts';

test('controller reconciles active profiles with fixed Secret-backed resources', async () => {
  const profile: any = { id: 'p', agentId: 'a', name: 'Main', pvcName: 'bw-p', state: 'ABSENT', createdAt: 0, lastUsedAt: Date.now() };
  const applied: string[] = []; const objects = new Map<string, unknown>();
  const kube: any = { get: async (kind: string, name: string) => objects.get(`${kind}/${name}`), apply: async (kind: string, name: string, value: unknown) => { applied.push(kind); objects.set(`${kind}/${name}`, value); }, delete: async () => {}, podStatus: async () => undefined };
  const controller = new ProfileController({ state: { async listProfiles() { return [profile]; }, async listLeases() { return []; } }, secrets: { async get() { return { controllerCredential: 'c', authenticatorKey: 'k', vncPassword: 'v' }; } }, kube, workerImage: `ghcr.io/x/worker@sha256:${'a'.repeat(64)}` });
  const result = await controller.reconcileOnce();
  assert.deepEqual(applied, ['secret', 'pvc', 'service', 'pod']); assert.equal(result.reconciled, 1); assert.equal(profile.state, 'STARTING');
});

test('controller does not recreate stopped profiles', async () => {
  const profile: any = { id: 'p', state: 'STOPPED' }; let secretCalls = 0;
  const controller = new ProfileController({ state: { async listProfiles() { return [profile]; }, async listLeases() { return []; } }, secrets: { async get() { secretCalls++; throw new Error('not called'); } }, kube: {} as any, workerImage: 'unused' });
  const result = await controller.reconcileOnce();
  assert.deepEqual(result, { reconciled: 0, reclaimed: 0 }); assert.equal(secretCalls, 0);
});

test('controller resets a profile stuck in STARTING after the timeout, then retries it fresh', async () => {
  const profile: any = { id: 'p', agentId: 'a', name: 'Main', pvcName: 'bw-p', state: 'STARTING', createdAt: 0, lastUsedAt: 0 };
  const objects = new Map<string, unknown>([['pvc/bw-p', {}], ['pod/bw-p', {}], ['service/bw-p', {}]]);
  const deleted: string[] = [];
  const kube: any = {
    get: async (kind: string, name: string) => objects.get(`${kind}/${name}`),
    apply: async (kind: string, name: string, value: unknown) => { objects.set(`${kind}/${name}`, value); },
    delete: async (kind: string, name: string) => { deleted.push(kind); objects.delete(`${kind}/${name}`); },
    podStatus: async () => ({ phase: 'Pending', ready: false }),
  };
  const controller = new ProfileController({ state: { async listProfiles() { return [profile]; }, async listLeases() { return []; } }, secrets: { async get() { return { controllerCredential: 'c', authenticatorKey: 'k', vncPassword: 'v' }; } }, kube, workerImage: `ghcr.io/x/worker@sha256:${'a'.repeat(64)}`, stuckMs: 300_000 });

  const first = await controller.reconcileOnce(0);
  assert.equal(first.reclaimed, 0); assert.equal(profile.state, 'STARTING');

  const second = await controller.reconcileOnce(400_000);
  assert.equal(second.reclaimed, 1); assert.equal(profile.state, 'FAILED');
  assert.ok(deleted.includes('pod')); assert.equal(objects.has('pvc/bw-p'), true, 'PVC is preserved');

  await controller.reconcileOnce(400_001);
  assert.equal(profile.state, 'STARTING', 'a fresh pod is scheduled on the next cycle');
});

test('controller stops a profile an agent asked to shut down: Pod and Service go, the PVC stays, and it ends STOPPED without being reconciled', async () => {
  const profile: any = { id: 'p', agentId: 'a', name: 'Main', pvcName: 'bw-p', state: 'DRAINING', createdAt: 0, lastUsedAt: Date.now() };
  const deleted: string[] = []; const persisted: string[] = []; let secretCalls = 0;
  const kube: any = { get: async () => undefined, apply: async () => { throw new Error('must not reconcile a draining profile'); }, delete: async (kind: string, name: string) => { deleted.push(`${kind}/${name}`); }, podStatus: async () => undefined };
  const controller = new ProfileController({
    state: { async listProfiles() { return [profile]; }, async listLeases() { return []; }, async updateProfileState(_id: string, state: string) { persisted.push(state); } },
    secrets: { async get() { secretCalls++; throw new Error('not called'); } }, kube, workerImage: 'unused',
  });
  await controller.reconcileOnce();
  assert.deepEqual(deleted, ['pod/bw-p', 'service/bw-p']);
  assert.equal(profile.state, 'STOPPED'); assert.deepEqual(persisted, ['STOPPED']); assert.equal(secretCalls, 0);
});
