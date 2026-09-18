import { acquireLease, releaseLease, type Lease, type Profile, type ProfileStore } from './profiles.ts';
import type { Agent } from './identity.ts';
import { HttpError } from './errors.ts';
import type { PostgresRepository } from './repository.ts';

/** What the gateway needs from a profile's worker besides the Playwright MCP tools themselves. */
export type WorkerPort = {
  passkeyEnrollBegin(rpId: string): Promise<unknown>;
  passkeyEnrollPoll(): Promise<unknown>;
  passkeyList(): Promise<{ credentials: unknown[] }>;
  /** Admin-dashboard-only: a periodic visual thumbnail, never exposed to agents - see
   * docs/architecture/original-spec.md line 106's "optional thumbnails/snapshot polling". */
  thumbnail(): Promise<{ image: string; contentType: string }>;
};

export type DurableProfileStore = {
  listProfiles(agentId: string): Promise<Profile[]>;
  acquireLease(profileId: string, agentId: string, clientId: string, now: Date): Promise<Lease>;
  releaseLease(profileId: string, clientId: string, generation: number, now: Date): Promise<void>;
};

export function postgresMcpStore(repository: Pick<PostgresRepository, 'listProfiles' | 'acquireLease' | 'releaseLease'>): DurableProfileStore {
  return repository;
}

/** States in which a profile's browser can be driven. */
export const USABLE_STATES = new Set(['READY', 'IDLE']);

const isDurable = (store: ProfileStore | DurableProfileStore): store is DurableProfileStore => 'listProfiles' in store;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function findOwnedProfile(store: ProfileStore | DurableProfileStore, agentId: string, profileId: string): Promise<Profile | undefined> {
  if (isDurable(store)) return (await store.listProfiles(agentId)).find(candidate => candidate.id === profileId);
  const profile = store.profiles.get(profileId);
  return profile && profile.agentId === agentId ? profile : undefined;
}

/**
 * A session's hold on a profile. `ensure` is called on every proxied call: it takes the lease the first
 * time, renews it afterwards (so a busy agent never loses it), and takes it back if it lapsed while the
 * agent was thinking, unless someone else has taken it meanwhile, in which case it fails with "busy".
 */
export function profileLease(store: ProfileStore | DurableProfileStore, agent: Agent, profile: Profile, clientId: string) {
  let held: Lease | undefined;
  return {
    async ensure(): Promise<void> {
      held = isDurable(store) ? await store.acquireLease(profile.id, agent.id, clientId, new Date()) : acquireLease(store, profile, clientId);
    },
    async release(): Promise<void> {
      if (!held) return;
      const generation = held.fencingGeneration;
      held = undefined;
      try {
        if (isDurable(store)) await store.releaseLease(profile.id, clientId, generation, new Date());
        else releaseLease(store, profile.id, clientId, generation);
      } catch { /* already expired or taken over: nothing left to release */ }
    },
  };
}

/**
 * Waits for a durable profile's browser to be ready (a stopped profile restarts when its lease is taken, which
 * takes a few seconds). In-memory profiles have no controller behind them, so they are usable as they stand.
 */
export async function waitUntilUsable(store: ProfileStore | DurableProfileStore, agentId: string, profile: Profile, options: { timeoutMs: number; pollMs: number }): Promise<Profile> {
  if (!isDurable(store)) return profile;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const current = (await store.listProfiles(agentId)).find(candidate => candidate.id === profile.id);
    if (!current || current.state === 'DELETING') throw new HttpError(404, 'profile not found');
    if (USABLE_STATES.has(current.state)) return current;
    if (Date.now() >= deadline) throw new HttpError(503, `the profile is ${current.state} and did not become READY within ${Math.round(options.timeoutMs / 1000)}s`);
    await sleep(options.pollMs);
  }
}
