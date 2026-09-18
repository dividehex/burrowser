import { randomBytes } from 'node:crypto';

export type ViewTicket = { profileId: string; agentId: string; expiresAt: number };
export type ViewTicketStore = Map<string, ViewTicket>;

/** Single-use, short-lived tickets that gate the live-view WebSocket bridge. A browser
 * WebSocket handshake cannot carry the usual Authorization/X-Agent-Challenge headers, so
 * an authenticated HTTP call mints one of these first and the client passes it as a query
 * parameter on the upgrade request instead of a long-lived bearer token. */
export function issueViewTicket(store: ViewTicketStore, profileId: string, agentId: string, now = Date.now(), ttlMs = 30_000): string {
  for (const [key, record] of store) if (record.expiresAt <= now) store.delete(key);
  const ticket = randomBytes(24).toString('base64url');
  store.set(ticket, { profileId, agentId, expiresAt: now + ttlMs });
  return ticket;
}

export function consumeViewTicket(store: ViewTicketStore, ticket: string, profileId: string, now = Date.now()): boolean {
  const record = store.get(ticket);
  if (!record || record.expiresAt <= now) { store.delete(ticket); return false; }
  if (record.profileId !== profileId) return false;
  store.delete(ticket);
  return true;
}
