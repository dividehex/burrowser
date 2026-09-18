import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresKubernetesController } from '../src/controller-factory.ts';

test('controller factory composes repository and Kubernetes Secret dependencies', async () => {
  const profile: any = { id: 'p', agentId: 'a', name: 'Main', pvcName: 'bw-p', state: 'STOPPED', createdAt: 0, lastUsedAt: 0 };
  const repository = { async listControllerProfiles() { return [profile]; }, async listControllerLeases() { return []; } };
  const controller = createPostgresKubernetesController(repository, {} as any, `ghcr.io/x/worker@sha256:${'a'.repeat(64)}`);
  assert.deepEqual(await controller.reconcileOnce(), { reconciled: 0, reclaimed: 0 });
});
