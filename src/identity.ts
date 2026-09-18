import { createHash, createHmac, createPublicKey, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';

export type Agent = { id: string; displayName: string; publicKey: string; revokedAt?: number };
export type Invitation = { id: string; verifierHash: string; expiresAt: number; consumedBy?: string };
export type Store = { invitations: Map<string, Invitation>; agents: Map<string, Agent> };

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');
const unb64 = (value: string) => Buffer.from(value, 'base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function invitationVerifierHash(invitation: string) { return hash(invitation); }

export function verifyEnrollmentProof(input: { id: string; invitation: string; publicKey: string; proof: string }) {
  const key = createPublicKey({ key: Buffer.from(input.publicKey, 'base64url'), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(`${input.id}:${input.invitation}`), key, unb64(input.proof))) throw new Error('invalid enrollment proof');
}

export function createEnrolledAgent(input: { displayName: string; publicKey: string }): Agent {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 100) throw new Error('invalid display name');
  return { id: randomBytes(16).toString('hex'), displayName, publicKey: input.publicKey };
}

export function issueInvitation(store: Store, now = Date.now(), ttlMs = 15 * 60_000) {
  const invitation = randomBytes(32).toString('base64url');
  const id = randomBytes(16).toString('hex');
  store.invitations.set(id, { id, verifierHash: invitationVerifierHash(invitation), expiresAt: now + ttlMs });
  return { id, invitation, expiresAt: now + ttlMs };
}

export function redeemInvitation(store: Store, input: { id: string; invitation: string; displayName: string; publicKey: string; proof: string }, now = Date.now()): Agent {
  const record = store.invitations.get(input.id);
  if (!record || record.consumedBy || record.expiresAt <= now || hash(input.invitation) !== record.verifierHash) throw new Error('invalid or consumed invitation');
  verifyEnrollmentProof(input);
  const agent = createEnrolledAgent(input);
  record.consumedBy = agent.id;
  store.agents.set(agent.id, agent);
  return agent;
}

export function revokeAgent(store: Store, agentId: string, now = Date.now()) {
  const agent = store.agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  agent.revokedAt = now;
}

export function issueChallenge() { return randomBytes(32).toString('base64url'); }

export type ChallengeStore = Map<string, { value: string; expiresAt: number }>;

export function issueChallengeFor(store: ChallengeStore, agentId: string, now = Date.now(), ttlMs = 60_000, maxOutstanding = 10_000): string {
  for (const [key, record] of store) if (record.expiresAt <= now) store.delete(key);
  if (store.size >= maxOutstanding) throw new Error('too many outstanding challenges');
  const value = issueChallenge();
  store.set(agentId, { value, expiresAt: now + ttlMs });
  return value;
}

export function peekChallenge(store: ChallengeStore, agentId: string, now = Date.now()): string {
  const record = store.get(agentId);
  if (!record || record.expiresAt <= now) throw new Error('challenge required');
  return record.value;
}

export function issueAccessToken(agent: Agent, challenge: string, signingKey: string, now = Date.now(), ttlMs = 15 * 60_000) {
  const header = b64(JSON.stringify({ alg: 'EdDSA', typ: 'ABAT', aud: 'agent-browser' }));
  const payload = b64(JSON.stringify({ sub: agent.id, aud: 'agent-browser', iat: now, exp: now + ttlMs, challenge }));
  const body = `${header}.${payload}`;
  return `${body}.${b64(createHmac('sha256', signingKey).update(body).digest())}`;
}

export function verifyAccessToken(store: Store, token: string, challenge: string, signingKey: string, now = Date.now()): Agent {
  const claims = verifyAccessTokenClaims(token, challenge, signingKey, now);
  const agent = store.agents.get(claims.sub);
  if (!agent || agent.revokedAt) throw new Error('invalid token');
  return agent;
}

export function verifyAccessTokenClaims(token: string, challenge: string, signingKey: string, now = Date.now()) {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new Error('invalid token');
  const claims = JSON.parse(unb64(payload).toString());
  if (claims.aud !== 'agent-browser' || claims.challenge !== challenge || claims.exp <= now) throw new Error('invalid token');
  const expected = createHmac('sha256', signingKey).update(`${header}.${payload}`).digest();
  if (expected.length !== unb64(signature).length || !timingSafeEqual(expected, unb64(signature))) throw new Error('invalid token');
  return claims as { sub: string; aud: string; iat: number; exp: number; challenge: string };
}
