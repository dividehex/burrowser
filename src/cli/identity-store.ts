import { access, chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { CliError } from './cli-error.ts';

/** Everything an agent needs to authenticate to a gateway. The private key never leaves this file. */
export type Identity = { version: 1; url: string; agentId: string; displayName: string; publicKey: string; privateKey: string };

export const identityDir = (env: NodeJS.ProcessEnv = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'burrowser', 'identities');

const stem = (name: string) => {
  const safe = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '');
  if (!safe) throw new CliError(`"${name}" cannot be used as an identity name`, 2);
  return safe;
};
export const identityPath = (name: string, dir = identityDir()) => join(dir, `${stem(name)}.json`);

export const identityExists = (name: string, dir = identityDir()) => access(identityPath(name, dir)).then(() => true, () => false);

export function newKeyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

export function signWith(identity: Pick<Identity, 'privateKey'>, message: string) {
  return sign(null, Buffer.from(message), createPrivateKey(identity.privateKey)).toString('base64url');
}

/** Writes the identity owner-only, and refuses to replace an existing one unless forced. */
export async function saveIdentity(identity: Identity, options: { force?: boolean; dir?: string } = {}) {
  const dir = options.dir ?? identityDir();
  const path = identityPath(identity.displayName, dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600, flag: options.force ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`an identity named "${identity.displayName}" already exists at ${path}; pass --force to replace it (its old key is lost)`);
    throw error;
  }
  await chmod(path, 0o600);
  return path;
}

export async function listIdentities(dir = identityDir()): Promise<string[]> {
  try { return (await readdir(dir)).filter(file => file.endsWith('.json')).map(file => file.slice(0, -'.json'.length)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

/** With no name, uses the only identity there is; with several, asks the user to choose. */
export async function loadIdentity(name: string | undefined, dir = identityDir()): Promise<Identity> {
  let chosen = name;
  if (!chosen) {
    const all = await listIdentities(dir);
    if (all.length === 0) throw new CliError('no identity found; enroll one first with "burrowser enroll"');
    if (all.length > 1) throw new CliError(`several identities exist (${all.join(', ')}); choose one with --identity`, 2);
    chosen = all[0];
  }
  const path = identityPath(chosen, dir);
  let parsed: Partial<Identity>;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError(`no identity named "${chosen}" (looked for ${path})`);
    throw new CliError(`identity file ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.version !== 1 || !parsed.url || !parsed.agentId || !parsed.displayName || !parsed.publicKey || !parsed.privateKey) throw new CliError(`identity file ${path} is incomplete or from an unknown version`);
  return parsed as Identity;
}
