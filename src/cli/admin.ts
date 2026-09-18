import { parse, requireUrl } from './args.ts';
import { CliError, usageError } from './cli-error.ts';
import { GatewayClient, warnIfInsecure } from './gateway.ts';
import { confirmDestructive, readSecret } from './input.ts';

type AgentRow = { id: string; displayName: string; status: string; createdAt?: number; profileCount: number };
type ProfileRow = { id: string; name: string; state: string; agentId: string; agentDisplayName: string; lastUsedAt: number };

const iso = (ms?: number) => ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : '-';

export function table(header: string[], rows: string[][]): string {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

/** Accepts a full id or any unique prefix of at least four characters, as git does. */
export function resolveId<T extends { id: string }>(items: T[], input: string | undefined, label: string): T {
  if (!input) throw usageError(`which ${label}? pass its id (see "burrowser admin ${label}s list")`);
  const exact = items.find(item => item.id === input);
  if (exact) return exact;
  const matches = input.length >= 4 ? items.filter(item => item.id.startsWith(input)) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new CliError(`"${input}" matches ${matches.length} ${label}s; use more characters`);
  throw new CliError(`no ${label} matches "${input}"`);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function adminCommand(argv: string[]) {
  const { values, positionals } = parse({
    args: argv, strict: true, allowPositionals: true,
    options: { url: { type: 'string' }, 'admin-token-file': { type: 'string' }, 'admin-token-stdin': { type: 'boolean' }, json: { type: 'boolean' }, yes: { type: 'boolean' }, wait: { type: 'boolean' }, timeout: { type: 'string' } },
  });
  const [group, action, target] = positionals;
  if (!group) throw usageError('admin needs a subcommand: invite, agents, or profiles');

  const gateway = new GatewayClient(requireUrl(values.url));
  const token = await readSecret({ file: values['admin-token-file'] as string | undefined, env: 'BURROWSER_ADMIN_BOOTSTRAP', label: 'admin bootstrap token', stdin: Boolean(values['admin-token-stdin']) });
  warnIfInsecure(gateway.baseUrl, 'the admin token is sent');
  const headers = { authorization: `Bearer ${token}` };
  const listAgents = async () => (await gateway.json<{ agents: AgentRow[] }>('GET', '/admin/agents', { headers })).agents;
  const listProfiles = async () => (await gateway.json<{ profiles: ProfileRow[] }>('GET', '/admin/profiles', { headers })).profiles;

  if (group === 'invite' && !action) {
    const invite = await gateway.json<{ id: string; invitation: string; expiresAt: number }>('POST', '/admin/enrollments', { headers });
    if (values.json) console.log(JSON.stringify(invite));
    else { console.log(`${invite.id}.${invite.invitation}`); console.error(`Invitation expires ${iso(invite.expiresAt)} UTC and works once. Hand it to "burrowser enroll".`); }
    return;
  }

  if (group === 'agents') {
    if (action === 'list') {
      const agents = await listAgents();
      console.log(values.json ? JSON.stringify(agents) : agents.length ? table(['ID', 'NAME', 'STATUS', 'PROFILES', 'CREATED'], agents.map(agent => [agent.id, agent.displayName, agent.status, String(agent.profileCount), iso(agent.createdAt)])) : 'No agents.');
      return;
    }
    if (action === 'revoke' || action === 'delete') {
      const agent = resolveId(await listAgents(), target, 'agent');
      if (action === 'revoke') {
        await gateway.json('POST', `/admin/agents/${agent.id}/revoke`, { headers });
        console.log(`Revoked agent "${agent.displayName}" (${agent.id}); it can no longer authenticate.`);
        return;
      }
      await confirmDestructive(`delete agent "${agent.displayName}" (${agent.id})`, agent.id, { yes: Boolean(values.yes) });
      await gateway.json('DELETE', `/admin/agents/${agent.id}?confirm=${agent.id}`, { headers });
      console.log(`Deleted agent "${agent.displayName}" (${agent.id}).`);
      return;
    }
  }

  if (group === 'profiles') {
    if (action === 'list') {
      const profiles = await listProfiles();
      console.log(values.json ? JSON.stringify(profiles) : profiles.length ? table(['ID', 'NAME', 'STATE', 'AGENT', 'LAST USED'], profiles.map(profile => [profile.id, profile.name, profile.state, profile.agentDisplayName, iso(profile.lastUsedAt)])) : 'No profiles.');
      return;
    }
    if (action === 'delete') {
      const profile = resolveId(await listProfiles(), target, 'profile');
      await confirmDestructive(`delete profile "${profile.name}" (${profile.id}) owned by "${profile.agentDisplayName}", including its browser storage and passkeys`, profile.id, { yes: Boolean(values.yes) });
      await gateway.json('DELETE', `/admin/profiles/${profile.id}?confirm=${profile.id}`, { headers });
      if (!values.wait) { console.log(`Deletion of profile "${profile.name}" (${profile.id}) requested; the controller is removing its resources. Add --wait to block until it is gone.`); return; }
      const deadline = Date.now() + Number(values.timeout ?? 120) * 1000;
      console.error('Waiting for the cluster resources to be removed...');
      while (Date.now() < deadline) {
        if (!(await listProfiles()).some(candidate => candidate.id === profile.id)) { console.log(`Deleted profile "${profile.name}" (${profile.id}).`); return; }
        await sleep(2000);
      }
      throw new CliError(`profile ${profile.id} is still being deleted after ${values.timeout ?? 120}s; the controller keeps working on it in the background`);
    }
  }

  throw usageError(`unknown admin command "${[group, action].filter(Boolean).join(' ')}"`);
}
