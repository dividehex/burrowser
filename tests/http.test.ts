import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createGateway, makeState } from '../src/server.ts';

test('HTTP gateway authenticates admin and agent enrollment', { skip: 'sandbox does not permit local TCP listeners; run outside sandbox' }, async () => {
  const state = makeState(); const pair: any = generateKeyPairSync('ed25519'); const server = createGateway(state, 'admin-secret', 'token-secret'); await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port; const call = (path: string, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  assert.equal((await call('/admin/enrollments', { method: 'POST' })).status, 401);
  const invite = await (await call('/admin/enrollments', { method: 'POST', headers: { authorization: 'Bearer admin-secret' } })).json() as any;
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'); const proof = sign(null, Buffer.from(`${invite.id}:${invite.invitation}`), pair.privateKey).toString('base64url');
  const enrolled = await (await call('/v1/identity/enroll', { method: 'POST', body: JSON.stringify({ id: invite.id, invitation: invite.invitation, displayName: 'agent', publicKey, proof }) })).json() as any;
  assert.equal((await call('/v1/profiles', { headers: { authorization: 'Bearer malformed' } })).status, 401); assert.ok(enrolled.agent_id);
  assert.equal((await call(`/admin/agents/${enrolled.agent_id}/revoke`, { method: 'POST' })).status, 401);
  assert.equal((await call(`/admin/agents/${enrolled.agent_id}/revoke`, { method: 'POST', headers: { authorization: 'Bearer admin-secret' } })).status, 204);
  assert.equal((await call(`/admin/agents/missing/revoke`, { method: 'POST', headers: { authorization: 'Bearer admin-secret' } })).status, 400);
  server.close();
});

test('the live-view page and noVNC assets are served statically', async () => {
  const server = createGateway(makeState(), 'admin-secret', 'token-secret'); await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const page = await fetch(`http://127.0.0.1:${port}/view`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /RFB/);
  const rfb = await fetch(`http://127.0.0.1:${port}/novnc/core/rfb.js`);
  assert.equal(rfb.status, 200);
  assert.match(rfb.headers.get('content-type') ?? '', /javascript/);
  server.close();
});

test('live-view ticket flow bridges an authenticated WebSocket to the worker VNC port', async () => {
  const fakeVnc = createTcpServer(socket => {
    socket.write('RFB 003.008\n');
    socket.on('data', chunk => socket.write(chunk));
  });
  await new Promise<void>(resolve => fakeVnc.listen(0, resolve));
  const vncPort = (fakeVnc.address() as any).port;

  const workerForProfile = undefined;
  const viewSecretsForProfile = async () => ({ vncPassword: 'test-vnc-password' });
  const viewTargetForProfile = () => ({ host: '127.0.0.1', port: vncPort });
  const server = createGateway(makeState(), 'admin-secret', 'token-secret', undefined, workerForProfile, viewSecretsForProfile, viewTargetForProfile);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const call = (path: string, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

  const pair: any = generateKeyPairSync('ed25519');
  const login = await (await call('/admin/login', { method: 'POST', body: JSON.stringify({ bootstrap_token: 'admin-secret' }) }));
  const csrf = login.headers.get('x-csrf-token'); const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const invite = await (await call('/admin/enrollments', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf! } })).json() as any;
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const enrollProof = sign(null, Buffer.from(`${invite.id}:${invite.invitation}`), pair.privateKey).toString('base64url');
  const enrolled = await (await call('/v1/identity/enroll', { method: 'POST', body: JSON.stringify({ id: invite.id, invitation: invite.invitation, displayName: 'viewer', publicKey, proof: enrollProof }) })).json() as any;
  const challengeResp = await (await call('/v1/identity/challenge', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id }) })).json() as any;
  const authProof = sign(null, Buffer.from(challengeResp.challenge), pair.privateKey).toString('base64url');
  const tokenResp = await (await call('/v1/identity/token', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id, proof: authProof }) })).json() as any;
  const authHeaders = { authorization: `Bearer ${tokenResp.access_token}`, 'x-agent-challenge': challengeResp.challenge };
  const profile = await (await call('/v1/profiles', { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'view-test' }) })).json() as any;

  const ticketResp = await (await call(`/v1/profiles/${profile.id}/view-ticket`, { method: 'POST', headers: authHeaders })).json() as any;
  assert.equal(ticketResp.vnc_password, 'test-vnc-password');

  const received = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/profiles/${profile.id}/view?ticket=${ticketResp.ticket}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(new TextEncoder().encode('echo-me'));
    ws.onmessage = event => { resolve(Buffer.from(event.data as ArrayBuffer).toString()); ws.close(); };
    ws.onerror = () => reject(new Error('websocket error'));
  });
  assert.equal(received, 'RFB 003.008\n', 'the tunnel carries bytes straight from the worker VNC port');

  const reuseRejected = await new Promise<boolean>(resolve => {
    const reuse = new WebSocket(`ws://127.0.0.1:${port}/v1/profiles/${profile.id}/view?ticket=${ticketResp.ticket}`);
    reuse.onopen = () => resolve(false);
    reuse.onerror = () => resolve(true);
  });
  assert.equal(reuseRejected, true, 'a ticket cannot be reused');

  server.close(); fakeVnc.close();
});

test('an admin session can open the live view of any profile, not just an agent viewing their own', async () => {
  const fakeVnc = createTcpServer(socket => { socket.write('RFB 003.008\n'); });
  await new Promise<void>(resolve => fakeVnc.listen(0, resolve));
  const vncPort = (fakeVnc.address() as any).port;

  const viewSecretsForProfile = async () => ({ vncPassword: 'admin-path-password' });
  const viewTargetForProfile = () => ({ host: '127.0.0.1', port: vncPort });
  const server = createGateway(makeState(), 'admin-secret', 'token-secret', undefined, undefined, viewSecretsForProfile, viewTargetForProfile);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const call = (path: string, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

  const pair: any = generateKeyPairSync('ed25519');
  const login = await call('/admin/login', { method: 'POST', body: JSON.stringify({ bootstrap_token: 'admin-secret' }) });
  const csrf = login.headers.get('x-csrf-token'); const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const invite = await (await call('/admin/enrollments', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf! } })).json() as any;
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const enrollProof = sign(null, Buffer.from(`${invite.id}:${invite.invitation}`), pair.privateKey).toString('base64url');
  const enrolled = await (await call('/v1/identity/enroll', { method: 'POST', body: JSON.stringify({ id: invite.id, invitation: invite.invitation, displayName: 'someone-else', publicKey, proof: enrollProof }) })).json() as any;
  const challengeResp = await (await call('/v1/identity/challenge', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id }) })).json() as any;
  const authProof = sign(null, Buffer.from(challengeResp.challenge), pair.privateKey).toString('base64url');
  const tokenResp = await (await call('/v1/identity/token', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id, proof: authProof }) })).json() as any;
  const authHeaders = { authorization: `Bearer ${tokenResp.access_token}`, 'x-agent-challenge': challengeResp.challenge };
  const profile = await (await call('/v1/profiles', { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'someone-elses-profile' }) })).json() as any;

  assert.equal((await call(`/admin/profiles/${profile.id}/view-ticket`, { method: 'POST' })).status, 401, 'no admin session at all');
  assert.equal((await call(`/admin/profiles/${profile.id}/view-ticket`, { method: 'POST', headers: authHeaders })).status, 401, 'an agent bearer token is not an admin session');
  assert.equal((await call(`/admin/profiles/${profile.id}/view-ticket`, { method: 'POST', headers: { cookie } })).status, 401, 'admin session without CSRF token is rejected');

  const ticketResp = await (await call(`/admin/profiles/${profile.id}/view-ticket`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf! } })).json() as any;
  assert.equal(ticketResp.vnc_password, 'admin-path-password', 'the admin never had to be the owning agent to get the real VNC password');

  const received = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/profiles/${profile.id}/view?ticket=${ticketResp.ticket}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = event => { resolve(Buffer.from(event.data as ArrayBuffer).toString()); ws.close(); };
    ws.onerror = () => reject(new Error('websocket error'));
  });
  assert.equal(received, 'RFB 003.008\n', 'the admin-minted ticket opens the same real tunnel to the worker');

  assert.equal((await call(`/admin/profiles/missing-profile/view-ticket`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf! } })).status, 400, 'a nonexistent profile id fails closed');

  server.close(); fakeVnc.close();
});

test('the admin dashboard can fetch a live thumbnail for any profile without an agent bearer token', async () => {
  const workerForProfile = async () => ({ thumbnail: async () => ({ image: Buffer.from('fake-jpeg-bytes').toString('base64'), contentType: 'image/jpeg' }) }) as any;
  const server = createGateway(makeState(), 'admin-secret', 'token-secret', undefined, workerForProfile);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const call = (path: string, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

  const pair: any = generateKeyPairSync('ed25519');
  const login = await call('/admin/login', { method: 'POST', body: JSON.stringify({ bootstrap_token: 'admin-secret' }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const csrf = login.headers.get('x-csrf-token');
  const invite = await (await call('/admin/enrollments', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf! } })).json() as any;
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const enrollProof = sign(null, Buffer.from(`${invite.id}:${invite.invitation}`), pair.privateKey).toString('base64url');
  const enrolled = await (await call('/v1/identity/enroll', { method: 'POST', body: JSON.stringify({ id: invite.id, invitation: invite.invitation, displayName: 'thumb-owner', publicKey, proof: enrollProof }) })).json() as any;
  const challengeResp = await (await call('/v1/identity/challenge', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id }) })).json() as any;
  const authProof = sign(null, Buffer.from(challengeResp.challenge), pair.privateKey).toString('base64url');
  const tokenResp = await (await call('/v1/identity/token', { method: 'POST', body: JSON.stringify({ agent_id: enrolled.agent_id, proof: authProof }) })).json() as any;
  const authHeaders = { authorization: `Bearer ${tokenResp.access_token}`, 'x-agent-challenge': challengeResp.challenge };
  const profile = await (await call('/v1/profiles', { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'thumb-test' }) })).json() as any;

  assert.equal((await call(`/admin/profiles/${profile.id}/thumbnail`)).status, 401, 'no admin session at all');
  assert.equal((await call(`/admin/profiles/${profile.id}/thumbnail`, { headers: authHeaders })).status, 401, 'an agent bearer token is not an admin session');

  const thumbnailResp = await call(`/admin/profiles/${profile.id}/thumbnail`, { headers: { cookie } });
  assert.equal(thumbnailResp.status, 200, 'a GET needs no CSRF token, matching the other admin read routes');
  assert.equal(thumbnailResp.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await thumbnailResp.arrayBuffer()).toString(), 'fake-jpeg-bytes');

  server.close();
});

test('unauthenticated identity endpoints are rate limited per client', async () => {
  const server = createGateway(makeState(), 'admin-secret', 'token-secret'); await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port; const call = (path: string, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const attempt = () => call('/v1/identity/challenge', { method: 'POST', body: JSON.stringify({ agent_id: 'x' }) });
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) statuses.push((await attempt()).status);
  assert.equal(statuses.slice(0, 30).every(status => status === 200), true);
  assert.equal(statuses[30], 429);
  server.close();
});
