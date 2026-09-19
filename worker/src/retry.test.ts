import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetries } from './retry.ts';

test('withRetries returns the first success and retries transient failures', async () => {
  let calls = 0;
  const result = await withRetries(async () => { if (++calls < 3) throw new Error('not yet'); return 'ok'; }, { attempts: 4, delayMs: 0 });
  assert.equal(result, 'ok'); assert.equal(calls, 3);
});

test('withRetries gives up after the attempts and throws the last error', async () => {
  let calls = 0;
  await assert.rejects(withRetries(async () => { throw new Error(`failure ${++calls}`); }, { attempts: 3, delayMs: 0 }), /failure 3/);
  assert.equal(calls, 3);
});
