import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials, saveCredentials } from './persistence.ts';

test('credentials persist encrypted and authenticate on reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'burrowser-')); const path = join(dir, 'authenticator', 'credentials.enc'); const key = Buffer.alloc(32, 7); const records: any = [{ rpId: 'example.com', credentialId: 'id', userHandle: 'user', publicKey: 'pub', privateKey: 'secret' }];
  await saveCredentials(path, records, key); const raw = await readFile(path, 'utf8'); assert.equal(raw.includes('secret'), false); assert.deepEqual(await loadCredentials(path, key), records); assert.rejects(() => loadCredentials(path, Buffer.alloc(32, 8)));
});
test('malformed and unsupported credential data is rejected', async () => { const dir = await mkdtemp(join(tmpdir(), 'burrowser-')); const path = join(dir, 'credentials.enc'); const key = Buffer.alloc(32); await assert.rejects(() => saveCredentials(path, [{ rpId: 'bad host!', credentialId: 'x' } as any], key)); await saveCredentials(path, [], key); const raw = JSON.parse(await readFile(path, 'utf8')); raw.version = 99; const { writeFile } = await import('node:fs/promises'); await writeFile(path, JSON.stringify(raw)); await assert.rejects(() => loadCredentials(path, key)); });
