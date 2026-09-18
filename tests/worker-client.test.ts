import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpWorkerClient, workerMcpUrl } from '../src/worker-client.ts';

test('the worker\'s MCP endpoint and RPC endpoint live on the profile\'s own Service', () => {
  assert.equal(workerMcpUrl('abc', 'burrowser').href, 'http://bw-abc.burrowser.svc:8080/mcp');
});

test('the gateway passes the worker\'s own failure reason to the caller, first line only and bounded', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: `context launch failed: no display\nCall log:\n  - launching ${'x'.repeat(500)}` }), { status: 400 })) as typeof fetch;
    await assert.rejects(() => new HttpWorkerClient('p', 'credential').passkeyList(), (error: Error) => {
      assert.match(error.message, /^worker request failed with HTTP 400: context launch failed: no display$/);
      return true;
    });
    globalThis.fetch = (async () => new Response('not json', { status: 502 })) as typeof fetch;
    await assert.rejects(() => new HttpWorkerClient('p', 'credential').thumbnail(), /^Error: worker request failed with HTTP 502$/);
  } finally { globalThis.fetch = realFetch; }
});
