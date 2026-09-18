import test from 'node:test';
import assert from 'node:assert/strict';
import { issueViewTicket, consumeViewTicket, type ViewTicketStore } from '../src/view-tickets.ts';

test('view tickets are single-use, expiring, and bound to their profile', () => {
  const store: ViewTicketStore = new Map();
  const ticket = issueViewTicket(store, 'p', 'a', 0, 1000);
  assert.equal(consumeViewTicket(store, ticket, 'other-profile', 500), false, 'wrong profile is rejected');
  assert.equal(consumeViewTicket(store, ticket, 'p', 500), true);
  assert.equal(consumeViewTicket(store, ticket, 'p', 500), false, 'a ticket cannot be reused');
});

test('an expired ticket is rejected', () => {
  const store: ViewTicketStore = new Map();
  const ticket = issueViewTicket(store, 'p', 'a', 0, 1000);
  assert.equal(consumeViewTicket(store, ticket, 'p', 1500), false);
});

test('an unknown ticket is rejected', () => {
  const store: ViewTicketStore = new Map();
  assert.equal(consumeViewTicket(store, 'no-such-ticket', 'p', 0), false);
});
