import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { profileLease, waitUntilUsable } from '../src/mcp.ts';
import { connectWorkerMcp, createProxyServer, PASSKEY_TOOLS, SHUTDOWN_TOOL } from '../src/mcp-proxy.ts';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from 'node:net';
import { createGateway, makeState, parseToolList } from '../src/server.ts';
import { FAKE_TOOLS, SCREENSHOT, SNAPSHOT_TEXT, startFakePlaywrightWorker } from './helpers/fake-playwright-worker.ts';

type Call = (path: string, init?: any) => Promise<Response>;
async function enrollAgent(call: Call, displayName: string) {
  const pair: any = generateKeyPairSync('ed25519');
  const invite = await (await call('/admin/enrollments', { method: 'POST', headers: { authorization: 'Bearer admin-secret' } })).json() as any;
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const proof = sign(null, Buffer.from(`${invite.id}:${invite.invitation}`), pair.privateKey).toString('base64url');
  const enrolled = await (await call('/v1/identity/enroll', { method: 'POST', body: JSON.stringify({ id: invite.id, invitation: invite.invitation, displayName, publicKey, proof }) })).json() as any;
  const challenge = (await (await call('/v1/identity/challenge', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id }) })).json() as any).challenge;
  const token = (await (await call('/v1/identity/token', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id, proof: sign(null, Buffer.from(challenge), pair.privateKey).toString('base64url') }) })).json() as any).access_token;
  const headers = { authorization: `Bearer ${token}`, 'x-agent-challenge': challenge };
  const profile = await (await call('/v1/profiles', { method: 'POST', headers, body: JSON.stringify({ name: 'main' }) })).json() as any;
  return { headers, profile };
}

async function setup(options: { excluded?: string; passkeys?: boolean } = {}) {
  const worker = await startFakePlaywrightWorker();
  const state = makeState();
  const passkeyCalls: string[] = [];
  const workerPort: any = options.passkeys === false ? undefined : {
    passkeyEnrollBegin: async (rpId: string) => { passkeyCalls.push(`begin:${rpId}`); return { status: 'awaiting_ceremony', rpId }; },
    passkeyEnrollPoll: async () => ({ status: 'idle' }),
    passkeyList: async () => ({ credentials: [{ id: 'c1', rpId: 'example.com' }] }),
    thumbnail: async () => ({ image: '', contentType: 'image/jpeg' }),
  };
  const server = createGateway(state, 'admin-secret', 'token-secret', undefined, workerPort && (async () => workerPort), undefined, undefined, 2000, async () => worker.target, parseToolList(options.excluded));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call: Call = (path, init: any = {}) => fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const connect = async (agent: { headers: any; profile: any }) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { ...agent.headers, 'x-burrowser-profile': agent.profile.id } } });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(transport);
    return { client, transport };
  };
  return { worker, state, call, base, connect, passkeyCalls, teardown: async () => { server.close(); server.closeAllConnections(); await worker.close(); } };
}

test('a session is the profile\'s Playwright MCP server: tools, arguments and results pass through untouched', async () => {
  const t = await setup();
  try {
    const agent = await enrollAgent(t.call, 'a');
    const { client } = await t.connect(agent);
    const listed = (await client.listTools()).tools;
    for (const fake of FAKE_TOOLS) assert.deepEqual(listed.find(tool => tool.name === fake.name), { ...fake }, `${fake.name} keeps its name, description and schema exactly`);
    assert.deepEqual(listed.filter(tool => !FAKE_TOOLS.some(fake => fake.name === tool.name)).map(tool => tool.name), [...PASSKEY_TOOLS, SHUTDOWN_TOOL].map(tool => tool.name), 'the only additions are Burrowser\'s passkey and shutdown tools');

    const nav: any = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } });
    assert.deepEqual(nav.content, [{ type: 'text', text: '### Page\n- Page URL: https://example.com' }]);
    assert.deepEqual((await client.callTool({ name: 'browser_snapshot', arguments: {} }) as any).content, [{ type: 'text', text: SNAPSHOT_TEXT }]);
    assert.deepEqual((await client.callTool({ name: 'browser_take_screenshot', arguments: {} }) as any).content, [{ type: 'text', text: 'shot' }, SCREENSHOT], 'image content survives byte for byte');
    const failed: any = await client.callTool({ name: 'browser_boom', arguments: {} });
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0].text, 'page.goto: net::ERR_NAME_NOT_RESOLVED', 'the browser\'s own error text reaches the agent');
    assert.deepEqual(t.worker.calls.map(c => c.name), ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot', 'browser_boom']);
    assert.deepEqual(t.worker.calls[0].args, { url: 'https://example.com' }, 'arguments arrive exactly as sent, with no lease or profile fields added');
    await client.close();
  } finally { await t.teardown(); }
});

test('the exclude list switches tools off everywhere: not listed, not callable, never reaching the browser', async () => {
  const t = await setup({ excluded: 'browser_evaluate, browser_passkey_status' });
  try {
    const { client } = await t.connect(await enrollAgent(t.call, 'a'));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(!names.includes('browser_evaluate') && !names.includes('browser_passkey_status'));
    assert.ok(names.includes('browser_navigate') && names.includes('browser_passkey_enrollment_request'));
    const refused: any = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => 1' } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /switched off/);
    assert.ok(!t.worker.calls.some(c => c.name === 'browser_evaluate'));
    await client.close();
  } finally { await t.teardown(); }
});

test('with nothing excluded every tool the browser offers is available', async () => {
  const t = await setup();
  try {
    const { client } = await t.connect(await enrollAgent(t.call, 'a'));
    assert.equal(((await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => 1' } })) as any).content[0].text, 'evaluated');
    await client.close();
  } finally { await t.teardown(); }
});

test('passkey tools are answered by the worker\'s RPC, not the browser', async () => {
  const t = await setup();
  try {
    const { client } = await t.connect(await enrollAgent(t.call, 'a'));
    const begun: any = await client.callTool({ name: 'browser_passkey_enrollment_request', arguments: { rp_id: 'webauthn.io' } });
    assert.deepEqual(JSON.parse(begun.content[0].text), { status: 'awaiting_ceremony', rpId: 'webauthn.io' });
    const status: any = await client.callTool({ name: 'browser_passkey_status', arguments: {} });
    assert.deepEqual(JSON.parse(status.content[0].text), { supported: true, credentials: [{ id: 'c1', rpId: 'example.com' }], enrollment: { status: 'idle' } });
    assert.deepEqual(t.passkeyCalls, ['begin:webauthn.io']);
    assert.equal(t.worker.calls.length, 0, 'the browser was never asked');
    await client.close();
  } finally { await t.teardown(); }
});

test('browser_shutdown asks for the profile to be stopped without touching the browser, and can be switched off', async () => {
  const t = await setup();
  try {
    const agent = await enrollAgent(t.call, 'a');
    const { client } = await t.connect(agent);
    t.state.profiles.get(agent.profile.id)!.state = 'READY';
    const result: any = await client.callTool({ name: 'browser_shutdown', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Shutdown requested/);
    assert.equal(t.state.profiles.get(agent.profile.id)!.state, 'STOPPED');
    assert.equal(t.worker.calls.length, 0, 'the browser was never asked');
    await client.close();
  } finally { await t.teardown(); }

  const off = await setup({ excluded: 'browser_shutdown' });
  try {
    const { client } = await off.connect(await enrollAgent(off.call, 'b'));
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'browser_shutdown'), false);
    const refused: any = await client.callTool({ name: 'browser_shutdown', arguments: {} });
    assert.equal(refused.isError, true);
    await client.close();
  } finally { await off.teardown(); }
});

test('a session must name one of the caller\'s own profiles, and only the caller may continue it', async () => {
  const t = await setup();
  try {
    const alice = await enrollAgent(t.call, 'alice'); const bob = await enrollAgent(t.call, 'bob');
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };
    const start = (headers: Record<string, string>) => t.call('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) });
    assert.equal((await start(alice.headers)).status, 400, 'no profile header');
    assert.equal((await start({ ...alice.headers, 'x-burrowser-profile': bob.profile.id })).status, 404, 'someone else\'s profile looks like it does not exist');
    assert.equal((await start({ ...alice.headers, 'x-burrowser-profile': 'nope' })).status, 404);
    assert.equal((await t.call('/mcp', { method: 'POST', headers: { ...alice.headers, origin: 'https://evil.example', 'x-burrowser-profile': alice.profile.id, accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) })).status, 403, 'browser-origin requests are refused');

    const { client, transport } = await t.connect(alice);
    const hijack = await t.call('/mcp', { method: 'POST', headers: { ...bob.headers, 'mcp-session-id': transport.sessionId!, accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    assert.equal(hijack.status, 400, 'bob cannot use alice\'s session');
    await client.close();
  } finally { await t.teardown(); }
});

test('a session holds the profile for its lifetime: a second one is told it is busy until the first ends', async () => {
  const t = await setup();
  try {
    const agent = await enrollAgent(t.call, 'a');
    const first = await t.connect(agent);
    assert.equal(t.state.leases.size, 1, 'the lease is taken when the session starts');
    await assert.rejects(() => t.connect(agent), (error: any) => { assert.equal(error.code, 409); assert.match(error.message, /busy/); return true; });
    assert.equal(t.state.leases.size, 1, 'the failed attempt did not disturb the holder');
    await first.transport.terminateSession(); await first.client.close();
    assert.equal(t.state.leases.size, 0, 'ending the session releases the lease at once');
    const second = await t.connect(agent);
    await second.transport.terminateSession(); await second.client.close();
  } finally { await t.teardown(); }
});

test('if the worker restarts mid-session, the next call quietly opens a new session to it', async () => {
  const t = await setup();
  try {
    const { client } = await t.connect(await enrollAgent(t.call, 'a'));
    await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://a.example' } });
    t.worker.restart();
    const after: any = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://b.example' } });
    assert.match(after.content[0].text, /https:\/\/b\.example/);
    await client.close();
  } finally { await t.teardown(); }
});

test('a gateway with no browser workers says so instead of pretending', async () => {
  const state = makeState();
  const server = createGateway(state, 'admin-secret', 'token-secret');
  await new Promise<void>(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call: Call = (path, init: any = {}) => fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  try {
    const agent = await enrollAgent(call, 'a');
    const res = await call('/mcp', { method: 'POST', headers: { ...agent.headers, 'x-burrowser-profile': agent.profile.id, accept: 'application/json, text/event-stream' }, body: '{}' });
    assert.equal(res.status, 503);
  } finally { server.close(); server.closeAllConnections(); }
});

const profileIn = (state: string) => ({ id: 'p', agentId: 'a', name: 'main', pvcName: 'bw-p', state, createdAt: 0, lastUsedAt: 0 });

test('waitUntilUsable waits for a restarting durable profile, gives up with a reason, and stops at once for one being deleted', async () => {
  const sequence = ['STOPPED', 'ABSENT', 'STARTING', 'READY'];
  let polls = 0;
  const durable: any = { listProfiles: async () => [profileIn(sequence[Math.min(polls++, sequence.length - 1)])] };
  assert.equal((await waitUntilUsable(durable, 'a', profileIn('STOPPED') as any, { timeoutMs: 5000, pollMs: 1 })).state, 'READY');
  assert.equal(polls, 4);

  const stuck: any = { listProfiles: async () => [profileIn('STARTING')] };
  await assert.rejects(() => waitUntilUsable(stuck, 'a', profileIn('STARTING') as any, { timeoutMs: 30, pollMs: 5 }), { status: 503, message: /STARTING and did not become READY/ });
  const deleting: any = { listProfiles: async () => [profileIn('DELETING')] };
  await assert.rejects(() => waitUntilUsable(deleting, 'a', profileIn('READY') as any, { timeoutMs: 5000, pollMs: 1 }), { status: 404 });
  const inMemory: any = { profiles: new Map(), leases: new Map() };
  assert.equal((await waitUntilUsable(inMemory, 'a', profileIn('ABSENT') as any, { timeoutMs: 1, pollMs: 1 })).state, 'ABSENT', 'in-memory profiles have no controller to wait for');
});

test('a session\'s lease is taken through the durable store under its own client id and released with the generation it was given', async () => {
  const seen: string[] = [];
  const durable: any = {
    acquireLease: async (profileId: string, agentId: string, clientId: string) => { seen.push(`acquire:${profileId}:${agentId}:${clientId.startsWith('session-')}`); return { profileId, ownerClientId: clientId, fencingGeneration: 7, expiresAt: 0 }; },
    releaseLease: async (profileId: string, clientId: string, generation: number) => { seen.push(`release:${profileId}:${generation}`); throw new Error('already lapsed'); },
    listProfiles: async () => [],
  };
  const lease = profileLease(durable, { id: 'a' } as any, profileIn('READY') as any, 'session-1');
  await lease.release();
  assert.deepEqual(seen, [], 'nothing to release before anything was held');
  await lease.ensure(); await lease.ensure();
  await lease.release();
  await lease.release();
  assert.deepEqual(seen, ['acquire:p:a:true', 'acquire:p:a:true', 'release:p:7'], 'renewed on each call, released once, and a failed release is not an error');
});

test('a worker whose server is still starting is retried for a bounded time, then reported', async () => {
  const freePort = await new Promise<number>(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as any; probe.close(() => resolve(port)); }); });
  const target = { url: new URL(`http://127.0.0.1:${freePort}/mcp`), credential: 'worker-secret' };

  await assert.rejects(() => connectWorkerMcp(target, { retryMs: 100, pollMs: 20 }), 'nothing is listening and the budget is spent');

  const late = new Promise<Awaited<ReturnType<typeof startFakePlaywrightWorker>>>(resolve => setTimeout(() => startFakePlaywrightWorker(freePort).then(resolve), 400));
  const client = await connectWorkerMcp(target, { retryMs: 10_000, pollMs: 50 });
  assert.equal((await client.listTools()).tools.length, FAKE_TOOLS.length, 'it connected once the worker came up');
  await client.close();
  await (await late).close();

  const wrongCredential = await startFakePlaywrightWorker();
  await assert.rejects(() => connectWorkerMcp({ ...wrongCredential.target, credential: 'nope' }, { retryMs: 5000, pollMs: 20 }), 'a rejected credential is a real failure and is not retried until the budget runs out');
  await wrongCredential.close();
});

test('a worker that is stopped and started again mid-session is waited for, up to the reconnect window', async () => {
  for (const { reconnectRetryMs, backAfterMs, recovers } of [{ reconnectRetryMs: 4000, backAfterMs: 600, recovers: true }, { reconnectRetryMs: 100, backAfterMs: 2500, recovers: false }]) {
    let worker = await startFakePlaywrightWorker();
    const port = Number(worker.target.url.port);
    const { server, close } = await createProxyServer({ target: worker.target, lease: { ensure: async () => {} }, excludedTools: new Set(), reconnectRetryMs });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
    try {
      await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://a.example' } });
      await worker.close();
      const comesBack = new Promise<void>(resolve => setTimeout(async () => { worker = await startFakePlaywrightWorker(port); resolve(); }, backAfterMs));
      const call = client.callTool({ name: 'browser_navigate', arguments: { url: 'https://b.example' } });
      if (recovers) assert.match(((await call) as any).content[0].text, /b\.example/);
      else await assert.rejects(call);
      await comesBack;
    } finally { await client.close(); await close(); await worker.close(); }
  }
});

test('after browser_close the agent carries on in the same session: the worker ends its session and the gateway opens a new one', async () => {
  const t = await setup();
  try {
    const { client } = await t.connect(await enrollAgent(t.call, 'a'));
    const closed: any = await client.callTool({ name: 'browser_close', arguments: {} });
    assert.match(closed.content[0].text, /No open tabs/);
    const after: any = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://after-close.example' } });
    assert.notEqual(after.isError, true);
    assert.match(after.content[0].text, /after-close\.example/);
    await client.close();
  } finally { await t.teardown(); }
});
