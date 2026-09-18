import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials } from './persistence.ts';
import { persistCredentials, restoreCredentials, type CredentialsApi, type PlaywrightCredential } from './credentials.ts';

function fakeCredentials(seed: PlaywrightCredential[] = []): CredentialsApi {
  const records = [...seed];
  return {
    async create(rpId, options) { const record = { rpId, ...options }; records.push(record); return record; },
    async install() {},
    async get() { return [...records]; },
  };
}

test('restores encrypted credentials before installation and persists current authenticator state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'burrowser-'));
  const path = join(dir, 'authenticator', 'credentials.enc');
  const key = Buffer.alloc(32, 4);
  const seed = fakeCredentials([{ rpId: 'example.com', id: 'id', userHandle: 'user', publicKey: 'pub', privateKey: 'secret' }]);
  await persistCredentials({ credentials: seed }, path, key);

  const calls: string[] = [];
  const restored = fakeCredentials();
  const originalCreate = restored.create;
  restored.create = async (...args) => { calls.push('create'); return originalCreate(...args); };
  restored.install = async () => { calls.push('install'); };
  await restoreCredentials({ credentials: restored }, path, key);
  assert.deepEqual(calls, ['create', 'install']);
  await persistCredentials({ credentials: restored }, path, key);
  assert.deepEqual(await loadCredentials(path, key), [{ rpId: 'example.com', credentialId: 'id', userHandle: 'user', publicKey: 'pub', privateKey: 'secret' }]);
});

test('missing credential file installs an empty authenticator', async () => {
  const credentials = fakeCredentials();
  await restoreCredentials({ credentials }, '/tmp/burrowser-no-such-profile/credentials.enc', Buffer.alloc(32));
  assert.deepEqual(await credentials.get(), []);
});

test('missing Playwright credentials API fails before browser access', async () => {
  await assert.rejects(() => restoreCredentials({}, '/tmp/unused', Buffer.alloc(32)), /virtual credentials API/);
});
