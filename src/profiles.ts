import { randomUUID } from 'node:crypto';
import type { Agent } from './identity.ts';

export type Profile = { id: string; agentId: string; name: string; pvcName: string; state: string; createdAt: number; lastUsedAt: number };
export type Lease = { profileId: string; ownerClientId: string; fencingGeneration: number; expiresAt: number };
export type ProfileStore = { profiles: Map<string, Profile>; leases: Map<string, Lease> };

export function createProfile(store: ProfileStore, agent: Agent, name: string, now = Date.now()) {
  const clean = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}$/.test(clean)) throw new Error('invalid profile name');
  if ([...store.profiles.values()].some(p => p.agentId === agent.id && p.name === clean)) throw new Error('profile name already exists');
  const id = randomUUID();
  const profile = { id, agentId: agent.id, name: clean, pvcName: `bw-${id}`, state: 'ABSENT', createdAt: now, lastUsedAt: now };
  store.profiles.set(id, profile);
  return profile;
}

export function ownedProfile(store: ProfileStore, agentId: string, id: string) {
  const profile = store.profiles.get(id);
  if (!profile || profile.agentId !== agentId) throw new Error('profile not found');
  return profile;
}

/** Long enough to span an LLM agent's think time between tool calls; every successful call slides it forward. */
export const LEASE_TTL_MS = 120_000;
export const LEASE_EXPIRED_MESSAGE = 'lease required or expired: call browser_profile_open again to obtain a fresh fencing_generation';

export function acquireLease(store: ProfileStore, profile: Profile, clientId: string, now = Date.now(), ttlMs = LEASE_TTL_MS) {
  const current = store.leases.get(profile.id);
  if (current && current.expiresAt > now && current.ownerClientId !== clientId) throw new Error('profile busy');
  const lease = { profileId: profile.id, ownerClientId: clientId, fencingGeneration: (current?.fencingGeneration ?? 0) + 1, expiresAt: now + ttlMs };
  store.leases.set(profile.id, lease); profile.lastUsedAt = now;
  return lease;
}

export function requireLease(store: ProfileStore, profileId: string, clientId: string, generation: number, now = Date.now()) {
  const lease = store.leases.get(profileId);
  if (!lease || lease.ownerClientId !== clientId || lease.fencingGeneration !== generation || lease.expiresAt <= now) throw new Error(LEASE_EXPIRED_MESSAGE);
  return lease;
}

export function releaseLease(store: ProfileStore, profileId: string, clientId: string, generation: number, now = Date.now()) {
  requireLease(store, profileId, clientId, generation, now);
  store.leases.delete(profileId);
}
