import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminAuth, ADMIN_SESSION_TTL_MS } from '../src/admin-auth.ts';

test('admin login issues a secure session cookie and CSRF token', () => {
  const auth = new AdminAuth('bootstrap', 1000); const session = auth.login('bootstrap', 100);
  const headers = { cookie: auth.cookie(session) };
  assert.equal(auth.authenticate(headers, 500)?.id, session.id);
  assert.equal(auth.requireMutation({ ...headers, 'x-csrf-token': session.csrfToken }, 500).id, session.id);
  assert.match(auth.cookie(session), /Secure/); assert.match(auth.cookie(session), /HttpOnly/); assert.match(auth.cookie(session), /SameSite=Strict/);
});

test('admin sessions reject bad credentials, CSRF, and expiry', () => {
  const auth = new AdminAuth('bootstrap', 1000); assert.throws(() => auth.login('wrong'), /invalid admin credentials/);
  const session = auth.login('bootstrap', 100); const headers = { cookie: auth.cookie(session) };
  assert.equal(auth.authenticate(headers, 1099)?.id, session.id);
  assert.equal(auth.authenticate(headers, 1101), undefined);
  assert.throws(() => auth.requireMutation({ ...headers, 'x-csrf-token': 'wrong' }, 100), /CSRF/);
});

test('an admin session lasts 24 hours by default, and its cookie persists for as long', () => {
  assert.equal(ADMIN_SESSION_TTL_MS, 24 * 60 * 60_000);
  const auth = new AdminAuth('bootstrap'); const session = auth.login('bootstrap', 0);
  assert.match(auth.cookie(session), /Max-Age=86400\b/);
  const headers = { cookie: auth.cookie(session) };
  assert.equal(auth.authenticate(headers, ADMIN_SESSION_TTL_MS - 1)?.id, session.id);
  assert.equal(auth.authenticate(headers, ADMIN_SESSION_TTL_MS + 1), undefined);
});
