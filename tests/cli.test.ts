import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseInvitationToken } from '../src/cli/enroll.ts';
import { identityPath, listIdentities, loadIdentity, newKeyPair, saveIdentity, type Identity } from '../src/cli/identity-store.ts';
import { resolveId, table } from '../src/cli/admin.ts';
import { createGateway, makeState } from '../src/server.ts';

const CLI = new URL('../src/cli/main.ts', import.meta.url).pathname;
const NODE_ARGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI];

type Run = { code: number | null; stdout: string; stderr: string };
function run(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NODE_ARGS, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

const identityFixture = (name: string): Identity => ({ version: 1, url: 'http://127.0.0.1:1', agentId: 'a1', displayName: name, ...newKeyPair() });

test('identity files are owner-only, never silently replaced, and selected unambiguously', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'burrowser-id-'));
  try {
    const path = await saveIdentity(identityFixture('research bot'), { dir });
    assert.equal(path, identityPath('research bot', dir));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    await assert.rejects(() => saveIdentity(identityFixture('research bot'), { dir }), /already exists/);
    await saveIdentity(identityFixture('research bot'), { dir, force: true });

    assert.equal((await loadIdentity(undefined, dir)).displayName, 'research bot', 'the only identity is used when none is named');
    await saveIdentity(identityFixture('second'), { dir });
    await assert.rejects(() => loadIdentity(undefined, dir), /several identities/);
    assert.deepEqual(await listIdentities(dir), ['research-bot', 'second']);
    await assert.rejects(() => loadIdentity('missing', dir), /no identity named/);
    await assert.rejects(() => saveIdentity(identityFixture('..'), { dir }), /cannot be used/);
    await writeFile(join(dir, 'broken.json'), '{"version":1}');
    await assert.rejects(() => loadIdentity('broken', dir), /incomplete/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invitation tokens, id prefixes and tables parse and format as documented', () => {
  const id = 'a'.repeat(32); const secret = 'B'.repeat(43);
  assert.deepEqual(parseInvitationToken(`${id}.${secret}`), { id, invitation: secret });
  for (const bad of ['', 'nodot', `${id}.short`, `xyz.${secret}`]) assert.throws(() => parseInvitationToken(bad), /malformed/);

  const items = [{ id: 'abcd1111' }, { id: 'abcd2222' }, { id: 'ffff0000' }];
  assert.equal(resolveId(items, 'ffff', 'agent').id, 'ffff0000');
  assert.equal(resolveId(items, 'abcd1111', 'agent').id, 'abcd1111');
  assert.throws(() => resolveId(items, 'abcd', 'agent'), /matches 2/);
  assert.throws(() => resolveId(items, 'ab', 'agent'), /no agent matches/);
  assert.throws(() => resolveId(items, undefined, 'agent'), /which agent/);
  assert.equal(table(['ID', 'NAME'], [['1', 'long name'], ['22', 'x']]), 'ID  NAME\n1   long name\n22  x');
});

test('enroll, whoami, the MCP bridge, and admin list/delete work end to end through the real CLI', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'burrowser-cli-'));
  const server = createGateway(makeState(), 'admin-secret', 'token-secret');
  await new Promise<void>(resolve => server.listen(0, resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const env = { BURROWSER_URL: url, BURROWSER_ADMIN_BOOTSTRAP: 'admin-secret', XDG_CONFIG_HOME: configHome };
  try {
    const invite1 = await run(['admin', 'invite'], env);
    assert.equal(invite1.code, 0, invite1.stderr);
    const token1 = invite1.stdout.trim();
    assert.match(token1, /^[0-9a-f]{32}\.[A-Za-z0-9_-]+$/);
    assert.match(invite1.stderr, /works once/);

    const enrolled = await run(['enroll', '--name', 'tester'], env, token1);
    assert.equal(enrolled.code, 0, enrolled.stderr);
    assert.match(enrolled.stdout, /Enrolled "tester" as agent [0-9a-f]{32}/);
    assert.equal((await stat(identityPath('tester', join(configHome, 'burrowser', 'identities')))).mode & 0o777, 0o600);

    // A name clash must be caught before the single-use invitation is spent.
    const invite2 = (await run(['admin', 'invite'], env)).stdout.trim();
    const clash = await run(['enroll', '--name', 'tester'], env, invite2);
    assert.equal(clash.code, 1);
    assert.match(clash.stderr, /already exists/);
    assert.equal((await run(['enroll', '--name', 'tester-two'], env, invite2)).code, 0, 'the invitation was not consumed by the failed attempt');
    assert.equal((await run(['enroll', '--name', 'replay'], env, invite2)).code, 1, 'but it is single-use once actually redeemed');

    assert.equal((await run(['enroll', '--name', 'x'], env, 'garbage')).code, 2);
    const whoami = await run(['whoami', '--identity', 'tester'], env);
    assert.equal(whoami.code, 0, whoami.stderr);
    assert.match(whoami.stdout, /"tester" \(agent [0-9a-f]{32}\) is authenticated/);
    assert.match(whoami.stdout, /No profiles yet/);

    // The stdio bridge, driven by a real MCP client exactly as Claude Code would drive it.
    const client = new Client({ name: 'cli-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [...NODE_ARGS, 'mcp', '--identity', 'tester'], env: { PATH: process.env.PATH ?? '', ...env }, stderr: 'ignore' });
    await client.connect(transport);
    try {
      assert.match(client.getInstructions() ?? '', /browser_profile_open/);
      const tools = (await client.listTools()).tools;
      assert.ok(tools.some(tool => tool.name === 'browser_navigate'));
      for (const tool of tools) assert.ok(tool.description && !tool.description.startsWith('Burrowser browser_'), `${tool.name} has a real description`);
      const created = await client.callTool({ name: 'browser_profiles_create', arguments: { name: 'demo' } }) as any;
      assert.equal(JSON.parse(created.content[0].text).name, 'demo');
      const listed = await client.callTool({ name: 'browser_profiles_list', arguments: {} }) as any;
      assert.deepEqual(JSON.parse(listed.content[0].text).map((profile: any) => profile.name), ['demo']);
      const refused = await client.callTool({ name: 'browser_navigate', arguments: { profile_id: 'x', client_id: 'c', fencing_generation: 1, url: 'https://example.com' } }) as any;
      assert.equal(refused.isError, true, 'tool errors from the gateway come through as MCP tool errors');
    } finally { await client.close(); }

    const agents = JSON.parse((await run(['admin', 'agents', 'list', '--json'], env)).stdout) as any[];
    const tester = agents.find(agent => agent.displayName === 'tester');
    assert.equal(tester.profileCount, 1);
    const profiles = JSON.parse((await run(['admin', 'profiles', 'list', '--json'], env)).stdout) as any[];
    assert.equal(profiles[0].name, 'demo');
    assert.match((await run(['admin', 'agents', 'list'], env)).stdout, /tester\s+active\s+1/);

    const noConfirm = await run(['admin', 'profiles', 'delete', profiles[0].id.slice(0, 6)], env);
    assert.equal(noConfirm.code, 2, 'without --yes and without a terminal there is no way to confirm');
    assert.match(noConfirm.stderr, /--yes/);
    const blocked = await run(['admin', 'agents', 'delete', tester.id, '--yes'], env);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /still owns 1 profile/);

    const deleted = await run(['admin', 'profiles', 'delete', profiles[0].id.slice(0, 6), '--yes', '--wait'], env);
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.match(deleted.stdout, /Deleted profile "demo"/);
    const gone = await run(['admin', 'agents', 'delete', tester.id.slice(0, 8), '--yes'], env);
    assert.equal(gone.code, 0, gone.stderr);
    assert.equal((await run(['whoami', '--identity', 'tester'], env)).code, 1, 'a deleted agent can no longer authenticate');

    const wrongToken = await run(['admin', 'agents', 'list'], { ...env, BURROWSER_ADMIN_BOOTSTRAP: 'nope' });
    assert.equal(wrongToken.code, 1);
    assert.match(wrongToken.stderr, /401/);
    assert.equal((await run(['admin', 'agents', 'list', '--bogus'], env)).code, 2);
  } finally {
    server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});
