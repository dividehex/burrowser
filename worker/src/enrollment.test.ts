import test from 'node:test';
import assert from 'node:assert/strict';
import { beginEnrollment, pollEnrollment } from './enrollment.ts';

test('beginEnrollment rejects a malformed relying party id', () => {
  assert.throws(() => beginEnrollment('not a host!', [], 0), /relying party/);
});

test('pollEnrollment reports idle when no enrollment is active', () => {
  assert.deepEqual(pollEnrollment(undefined, [], 0), { result: { status: 'idle' }, next: undefined });
});

test('pollEnrollment waits until a credential id not present at baseline appears', () => {
  const state = beginEnrollment('example.com', ['old'], 1000, 60_000);
  const stillWaiting = pollEnrollment(state, ['old'], 1500);
  assert.deepEqual(stillWaiting.result, { status: 'awaiting_ceremony', rpId: 'example.com', expiresAt: 61_000 });
  assert.equal(stillWaiting.next, state);

  const completed = pollEnrollment(state, ['old', 'new-cred'], 1500);
  assert.deepEqual(completed.result, { status: 'completed', rpId: 'example.com', credentialId: 'new-cred' });
  assert.equal(completed.next, undefined);
});

test('pollEnrollment expires the window and clears state without a completion', () => {
  const state = beginEnrollment('example.com', [], 0, 1000);
  const expired = pollEnrollment(state, [], 1000);
  assert.deepEqual(expired.result, { status: 'expired', rpId: 'example.com' });
  assert.equal(expired.next, undefined);
});
