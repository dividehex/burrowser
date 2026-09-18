import { access } from 'node:fs/promises';
import type { VirtualCredential } from './persistence.ts';
import { loadCredentials, saveCredentialsVerified } from './persistence.ts';

export type PlaywrightCredential = {
  id: string;
  rpId: string;
  userHandle: string;
  publicKey: string;
  privateKey: string;
};

export type CredentialsApi = {
  create(rpId: string, options: Omit<PlaywrightCredential, 'rpId'>): Promise<PlaywrightCredential>;
  install(): Promise<void>;
  get(filter?: { id?: string; rpId?: string }): Promise<PlaywrightCredential[]>;
};

export type CredentialContext = { credentials?: CredentialsApi };

function requireCredentialsApi(context: CredentialContext): CredentialsApi {
  if (!context.credentials) throw new Error('Playwright virtual credentials API is required (Playwright 1.61 or newer)');
  return context.credentials;
}

function toPlaywrightCredential(record: VirtualCredential): Omit<PlaywrightCredential, 'rpId'> {
  return { id: record.credentialId, userHandle: record.userHandle, publicKey: record.publicKey, privateKey: record.privateKey };
}

function toStoredCredential(record: PlaywrightCredential): VirtualCredential {
  return { rpId: record.rpId, credentialId: record.id, userHandle: record.userHandle, publicKey: record.publicKey, privateKey: record.privateKey };
}

export async function restoreCredentials(context: CredentialContext, path: string, key?: Buffer) {
  const credentials = requireCredentialsApi(context);
  let records: VirtualCredential[] = [];
  try {
    await access(path);
    records = await loadCredentials(path, key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const record of records) await credentials.create(record.rpId, toPlaywrightCredential(record));
  await credentials.install();
}

export async function persistCredentials(context: CredentialContext, path: string, key?: Buffer) {
  const credentials = requireCredentialsApi(context);
  const records = (await credentials.get()).map(toStoredCredential);
  await saveCredentialsVerified(path, records, key);
}
