import test from 'node:test';
import assert from 'node:assert/strict';
import { workerSecretName } from '../src/kube.ts';
import { KubernetesWorkerSecretProvider } from '../src/worker-secrets.ts';

test('Kubernetes worker Secret provider decodes and validates expected keys', async () => {
  const profile: any = { id: 'p' }; const key = Buffer.alloc(32, 8).toString('base64url');
  const provider = new KubernetesWorkerSecretProvider({ get: async (_kind, name) => { assert.equal(name, workerSecretName(profile)); return { data: { WORKER_CONTROLLER_CREDENTIAL: Buffer.from('controller').toString('base64'), BURROWSER_AUTHENTICATOR_KEY: Buffer.from(key).toString('base64'), BURROWSER_VNC_PASSWORD: Buffer.from('vncpass').toString('base64') } }; }, apply: async () => {}, delete: async () => {}, podStatus: async () => undefined });
  assert.deepEqual(await provider.get(profile), { controllerCredential: 'controller', authenticatorKey: key, vncPassword: 'vncpass' });
});

test('Kubernetes worker Secret provider fails closed on missing or malformed Secrets', async () => {
  const profile: any = { id: 'p' }; const kube: any = { get: async () => undefined };
  await assert.rejects(() => new KubernetesWorkerSecretProvider(kube).get(profile), /Secret missing/);
  kube.get = async () => ({ data: { WORKER_CONTROLLER_CREDENTIAL: Buffer.from('controller').toString('base64'), BURROWSER_AUTHENTICATOR_KEY: Buffer.from('short').toString('base64'), BURROWSER_VNC_PASSWORD: Buffer.from('vncpass').toString('base64') } });
  await assert.rejects(() => new KubernetesWorkerSecretProvider(kube).get(profile), /Secret malformed/);
  kube.get = async () => ({ data: { WORKER_CONTROLLER_CREDENTIAL: Buffer.from('controller').toString('base64'), BURROWSER_AUTHENTICATOR_KEY: Buffer.from('short').toString('base64') } });
  await assert.rejects(() => new KubernetesWorkerSecretProvider(kube).get(profile), /Secret malformed/, 'missing vncPassword also fails closed');
});

test('Kubernetes worker Secret provider creates a fresh Secret exactly once', async () => {
  const profile: any = { id: 'new-profile' }; let created: any;
  const kube: any = {
    get: async () => undefined,
    apply: async (_kind: string, name: string, resource: unknown) => { created = { name, resource }; },
  };
  const material = await new KubernetesWorkerSecretProvider(kube).ensure(profile);
  assert.equal(created.name, workerSecretName(profile));
  assert.equal(material.controllerCredential.length > 20, true);
  assert.equal(Buffer.from(material.authenticatorKey, 'base64url').length, 32);
  assert.equal(material.vncPassword.length > 20, true);
  assert.equal((created.resource as any).stringData.WORKER_CONTROLLER_CREDENTIAL, material.controllerCredential);
  assert.equal((created.resource as any).stringData.BURROWSER_VNC_PASSWORD, material.vncPassword);
});
