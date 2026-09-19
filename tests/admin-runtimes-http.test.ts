import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, makeState } from '../src/server.ts';

function parseSseFrames(raw: string) {
  return raw.split('\n\n').filter(Boolean).map(frame => {
    const [eventLine, dataLine] = frame.split('\n');
    return { event: eventLine.replace('event: ', ''), data: JSON.parse(dataLine.replace('data: ', '')) };
  });
}

/** Wraps a stream reader with at most one outstanding read() at a time, held across calls to
 * `readFor`. A reader only ever has one live read request; racing it against a timeout and,
 * on timeout, starting a *second* read() before the first resolves would strand whichever
 * chunk answers the first one call behind what the caller observes. */
function sseCursor(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = reader.read();
  return {
    async readFor(ms: number) {
      let text = '';
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now())));
        const result = await Promise.race([pending, timeout]);
        if (result === 'timeout') continue;
        if (result.done) break;
        text += decoder.decode(result.value);
        pending = reader.read();
      }
      return text;
    },
  };
}

test('the admin runtime dashboard requires admin auth and streams live-state changes over SSE', async () => {
  const state = makeState();
  const server = createGateway(state, 'admin-secret', 'token-secret', undefined, undefined, undefined, undefined, 50);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const call = (path: string, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

  assert.equal((await call('/admin/runtimes')).status, 401);
  assert.equal((await call('/admin/runtimes/events')).status, 401);
  const page = await (await call('/admin')).text();
  assert.match(page, /<form id="login"[\s\S]*type="submit"/, 'Enter in the token box submits the sign-in form');

  const login = await call('/admin/login', { method: 'POST', body: JSON.stringify({ bootstrap_token: 'admin-secret' }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  const snapshotResp = await call('/admin/runtimes', { headers: { cookie } });
  assert.equal(snapshotResp.status, 200);
  assert.deepEqual((await snapshotResp.json() as any).runtimes, []);
  assert.equal(snapshotResp.headers.get('x-csrf-token'), login.headers.get('x-csrf-token'), 'a resumed session can recover its CSRF token');
  const bearer = await call('/admin/runtimes', { headers: { authorization: 'Bearer admin-secret' } });
  assert.equal(bearer.headers.get('x-csrf-token'), null, 'bootstrap-token access has no session to hand a CSRF token for');

  const controller = new AbortController();
  const streamResp = await fetch(`http://127.0.0.1:${port}/admin/runtimes/events`, { headers: { cookie }, signal: controller.signal });
  assert.equal(streamResp.status, 200);
  assert.match(streamResp.headers.get('content-type') ?? '', /event-stream/);
  const cursor = sseCursor(streamResp.body!.getReader());

  const initial = parseSseFrames(await cursor.readFor(150));
  assert.deepEqual(initial, [{ event: 'snapshot', data: [] }]);

  const profile = { id: 'p1', agentId: 'a1', name: 'Main', pvcName: 'bw-p1', state: 'READY', createdAt: Date.now(), lastUsedAt: Date.now() };
  state.profiles.set(profile.id, profile as any);
  state.agents.set('a1', { id: 'a1', displayName: 'agent-a', publicKey: 'key' });

  const appeared = parseSseFrames(await cursor.readFor(300));
  assert.equal(appeared.length, 1);
  assert.equal(appeared[0].event, 'update');
  assert.equal(appeared[0].data[0].id, 'p1');
  assert.equal(appeared[0].data[0].agentDisplayName, 'agent-a');

  profile.state = 'STOPPED';
  const disappeared = parseSseFrames(await cursor.readFor(300));
  assert.deepEqual(disappeared, [{ event: 'removed', data: { id: 'p1' } }]);

  controller.abort();
  server.close();
});
