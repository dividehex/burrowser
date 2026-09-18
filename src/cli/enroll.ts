import { parse, requireUrl } from './args.ts';
import { CliError, usageError } from './cli-error.ts';
import { AgentSession, GatewayClient, warnIfInsecure } from './gateway.ts';
import { identityExists, identityPath, loadIdentity, newKeyPair, saveIdentity, signWith } from './identity-store.ts';
import { readSecret } from './input.ts';

/** "<id>.<secret>", exactly as printed by `burrowser admin invite`. */
export function parseInvitationToken(token: string): { id: string; invitation: string } {
  const dot = token.indexOf('.');
  const id = token.slice(0, dot);
  const invitation = token.slice(dot + 1);
  if (dot < 0 || !/^[0-9a-f]{32}$/.test(id) || !/^[A-Za-z0-9_-]{20,}$/.test(invitation)) throw usageError('the invitation token is malformed; paste the value printed by "burrowser admin invite"');
  return { id, invitation };
}

export async function enrollCommand(argv: string[]) {
  const { values } = parse({ args: argv, strict: true, options: { url: { type: 'string' }, name: { type: 'string' }, 'invitation-file': { type: 'string' }, force: { type: 'boolean' } } });
  const name = values.name as string | undefined;
  if (!name) throw usageError('--name is required: the display name for this agent, also the name of its local identity');
  const gateway = new GatewayClient(requireUrl(values.url));
  warnIfInsecure(gateway.baseUrl, 'the invitation is sent');

  // The invitation is single-use, so make sure the identity can be saved before spending it.
  if (!values.force && await identityExists(name)) throw new CliError(`an identity named "${name}" already exists at ${identityPath(name)}; pass --force to replace it (its old key is lost)`);

  const { id, invitation } = parseInvitationToken(await readSecret({ file: values['invitation-file'] as string | undefined, label: 'invitation token' }));
  const { publicKey, privateKey } = newKeyPair();
  const enrolled = await gateway.json<{ agent_id: string }>('POST', '/v1/identity/enroll', {
    body: { id, invitation, displayName: name, publicKey, proof: signWith({ privateKey }, `${id}:${invitation}`) },
  });
  const path = await saveIdentity({ version: 1, url: gateway.baseUrl, agentId: enrolled.agent_id, displayName: name, publicKey, privateKey }, { force: Boolean(values.force) });
  console.log(`Enrolled "${name}" as agent ${enrolled.agent_id}`);
  console.log(`Identity saved to ${path} (owner-only; it holds this agent's private key)`);
}

export async function whoamiCommand(argv: string[]) {
  const { values } = parse({ args: argv, strict: true, options: { identity: { type: 'string' } } });
  const identity = await loadIdentity((values.identity as string | undefined) ?? process.env.BURROWSER_IDENTITY);
  const gateway = new GatewayClient(identity.url);
  const session = new AgentSession(identity, gateway);
  const { profiles } = await gateway.json<{ profiles: Array<{ id: string; name: string; state: string }> }>('GET', '/v1/profiles', { headers: await session.headers() });
  console.log(`"${identity.displayName}" (agent ${identity.agentId}) is authenticated to ${identity.url}`);
  console.log(profiles.length ? `Profiles:\n${profiles.map(profile => `  ${profile.id}  ${profile.name}  ${profile.state}`).join('\n')}` : 'No profiles yet.');
}
