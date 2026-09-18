import test from 'node:test';
import assert from 'node:assert/strict';

test('the gateway passes the worker\'s own failure reason to the agent, first line only and bounded', async () => {
  const { HttpWorkerClient } = await import('../src/worker-client.ts');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: `page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/\nCall log:\n  - navigating ${'x'.repeat(500)}` }), { status: 400 })) as typeof fetch;
    await assert.rejects(() => new HttpWorkerClient('p', 'credential').navigate('https://nope.invalid/'), (error: Error) => {
      assert.match(error.message, /^worker request failed with HTTP 400: page\.goto: net::ERR_NAME_NOT_RESOLVED/);
      assert.ok(!error.message.includes('Call log'), 'later lines (browser internals) are not passed on');
      return true;
    });
    globalThis.fetch = (async () => new Response('not json', { status: 502 })) as typeof fetch;
    await assert.rejects(() => new HttpWorkerClient('p', 'credential').snapshot(), /^Error: worker request failed with HTTP 502$/);
  } finally { globalThis.fetch = realFetch; }
});
