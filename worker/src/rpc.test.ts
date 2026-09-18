import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeWorkerRequest, validateRpcMethod } from './rpc.ts';

test('worker RPC requires exact controller credential and allowlisted methods', () => {
  assert.equal(authorizeWorkerRequest({ authorization: 'Bearer controller-secret' }, 'controller-secret'), true);
  assert.equal(authorizeWorkerRequest({ authorization: 'Bearer controller-secret' }, 'wrong'), false);
  assert.equal(validateRpcMethod('passkeyEnrollBegin'), 'passkeyEnrollBegin'); assert.equal(validateRpcMethod('thumbnail'), 'thumbnail');
  // Browser control now lives on /mcp; the old JSON methods are gone rather than kept alongside it.
  for (const gone of ['snapshot', 'navigate', 'click', 'type', 'authStatus', 'evaluate']) assert.throws(() => validateRpcMethod(gone), /not allowed/);
});
