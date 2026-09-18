import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeWorkerRequest, validateRpcMethod } from './rpc.ts';

test('worker RPC requires exact controller credential and allowlisted methods', () => {
  assert.equal(authorizeWorkerRequest({ authorization: 'Bearer controller-secret' }, 'controller-secret'), true);
  assert.equal(authorizeWorkerRequest({ authorization: 'Bearer controller-secret' }, 'wrong'), false);
  assert.equal(validateRpcMethod('snapshot'), 'snapshot'); assert.equal(validateRpcMethod('passkeyEnrollBegin'), 'passkeyEnrollBegin'); assert.equal(validateRpcMethod('thumbnail'), 'thumbnail'); assert.throws(() => validateRpcMethod('evaluate'));
});
