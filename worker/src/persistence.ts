import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export type VirtualCredential = { rpId: string; credentialId: string; userHandle: string; publicKey: string; privateKey: string; signCount?: number };
type Envelope = { version: 1; iv: string; tag: string; ciphertext: string };

function keyFromEnv(value = process.env.BURROWSER_AUTHENTICATOR_KEY) {
  if (!value) throw new Error('authenticator encryption key is required outside the profile volume');
  const key = Buffer.from(value, 'base64url'); if (key.length !== 32) throw new Error('authenticator encryption key must be 32 bytes'); return key;
}
export function isValidRpId(rpId: unknown): rpId is string {
  return typeof rpId === 'string' && /^[a-z0-9.-]+$/i.test(rpId);
}

function validate(records: unknown): VirtualCredential[] {
  if (!Array.isArray(records)) throw new Error('credential record must be an array');
  for (const record of records) {
    if (!record || typeof record !== 'object' || typeof (record as any).rpId !== 'string' || typeof (record as any).credentialId !== 'string' || typeof (record as any).userHandle !== 'string' || typeof (record as any).publicKey !== 'string' || typeof (record as any).privateKey !== 'string') throw new Error('malformed credential record');
    if (!isValidRpId((record as any).rpId) || !(record as any).credentialId || !(record as any).privateKey) throw new Error('invalid credential fields');
  }
  return records as VirtualCredential[];
}

export async function saveCredentials(path: string, records: VirtualCredential[], key?: Buffer) {
  const valid = validate(records); const encryptionKey = key ?? keyFromEnv(); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv); const ciphertext = Buffer.concat([cipher.update(JSON.stringify(valid), 'utf8'), cipher.final()]);
  const envelope: Envelope = { version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  await mkdir(path.substring(0, path.lastIndexOf('/')), { recursive: true }); const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`; await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 }); await rename(temporary, path);
}

export async function saveCredentialsVerified(path: string, records: VirtualCredential[], key?: Buffer) {
  await saveCredentials(path, records, key);
  const saved = await loadCredentials(path, key);
  if (JSON.stringify(saved) !== JSON.stringify(validate(records))) throw new Error('credential persistence verification failed');
}

export async function loadCredentials(path: string, key?: Buffer): Promise<VirtualCredential[]> {
  const envelope = JSON.parse(await readFile(path, 'utf8')) as Envelope; if (envelope.version !== 1) throw new Error('unsupported credential format');
  const decipher = createDecipheriv('aes-256-gcm', key ?? keyFromEnv(), Buffer.from(envelope.iv, 'base64url')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return validate(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8')));
}
