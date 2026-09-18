import { acquireLease, createProfile, LEASE_EXPIRED_MESSAGE, LEASE_TTL_MS, ownedProfile, releaseLease, requireLease, type ProfileStore } from './profiles.ts';
import { validateBrowserUrl } from './url-policy.ts';
import type { Agent } from './identity.ts';
import type { PostgresRepository } from './repository.ts';

export const MCP_TOOLS = ['browser_profiles_list', 'browser_profiles_create', 'browser_profile_open', 'browser_profile_release', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_auth_status', 'browser_passkey_enrollment_request', 'browser_passkey_status'] as const;
export type WorkerPort = {
  navigate(url: string): Promise<unknown>;
  snapshot(): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  type(selector: string, text: string): Promise<unknown>;
  authStatus(): Promise<unknown>;
  passkeyEnrollBegin(rpId: string): Promise<unknown>;
  passkeyEnrollPoll(): Promise<unknown>;
  passkeyList(): Promise<{ credentials: unknown[] }>;
  /** Admin-dashboard-only: a periodic visual thumbnail, never exposed as an MCP tool - see
   * docs/architecture/original-spec.md line 106's "optional thumbnails/snapshot polling". */
  thumbnail(): Promise<{ image: string; contentType: string }>;
};
export type DurableProfileStore = {
  listProfiles(agentId: string): Promise<import('./profiles.ts').Profile[]>;
  createProfile(profile: import('./profiles.ts').Profile): Promise<import('./profiles.ts').Profile>;
  acquireLease(profileId: string, agentId: string, clientId: string, now: Date): Promise<import('./profiles.ts').Lease>;
  releaseLease(profileId: string, clientId: string, generation: number, now: Date): Promise<void>;
  getLease(profileId: string): Promise<import('./profiles.ts').Lease | undefined>;
  renewLease?(profileId: string, clientId: string, generation: number, now: Date): Promise<void>;
};

export function postgresMcpStore(repository: Pick<PostgresRepository, 'listProfiles' | 'createProfile' | 'acquireLease' | 'releaseLease' | 'getLease'>): DurableProfileStore {
  return repository;
}

export async function dispatchTool(store: ProfileStore | DurableProfileStore, agent: Agent, worker: WorkerPort | undefined, name: string, args: any, now = Date.now()) {
  if (!(MCP_TOOLS as readonly string[]).includes(name)) throw new Error('tool not found');
  const durable = 'listProfiles' in store;
  if (name === 'browser_profiles_list') {
    const profiles = durable ? await store.listProfiles(agent.id) : [...store.profiles.values()].filter(p => p.agentId === agent.id);
    return profiles.map(({ id, name, state, createdAt, lastUsedAt }) => ({ id, name, state, createdAt, lastUsedAt }));
  }
  if (name === 'browser_profiles_create') {
    if (!durable) return createProfile(store, agent, args.name, now);
    const profile = createProfile({ profiles: new Map(), leases: new Map() }, agent, args.name, now);
    return store.createProfile(profile);
  }
  const profile = durable
    ? (await store.listProfiles(agent.id)).find(candidate => candidate.id === args.profile_id)
    : ownedProfile(store, agent.id, args.profile_id);
  if (!profile) throw new Error('profile not found');
  if (name === 'browser_profile_open') return durable
    ? store.acquireLease(profile.id, agent.id, args.client_id, new Date(now))
    : acquireLease(store, profile, args.client_id, now);
  if (name === 'browser_profile_release') {
    if (durable) await store.releaseLease(profile.id, args.client_id, args.fencing_generation, new Date(now));
    else releaseLease(store, profile.id, args.client_id, args.fencing_generation, now);
    return { released: true };
  }
  if (!worker) throw new Error('browser unavailable');
  if (durable) {
    const lease = await store.getLease(profile.id);
    if (!lease || lease.ownerClientId !== args.client_id || lease.fencingGeneration !== args.fencing_generation || lease.expiresAt <= now) throw new Error(LEASE_EXPIRED_MESSAGE);
    await store.renewLease?.(profile.id, args.client_id, args.fencing_generation, new Date(now));
  } else {
    const lease = requireLease(store, profile.id, args.client_id, args.fencing_generation, now);
    lease.expiresAt = now + LEASE_TTL_MS;
    profile.lastUsedAt = now;
  }
  if (name === 'browser_navigate') return worker.navigate(validateBrowserUrl(args.url, args.previous_url));
  if (name === 'browser_snapshot') return worker.snapshot();
  if (name === 'browser_click') return worker.click(String(args.selector));
  if (name === 'browser_type') { if (String(args.text).length > 10_000) throw new Error('text too long'); return worker.type(String(args.selector), String(args.text)); }
  if (name === 'browser_auth_status') return worker.authStatus();
  if (name === 'browser_passkey_status') {
    const [enrollment, { credentials }] = await Promise.all([worker.passkeyEnrollPoll(), worker.passkeyList()]);
    return { supported: true, credentials, enrollment };
  }
  if (name === 'browser_passkey_enrollment_request') return worker.passkeyEnrollBegin(String(args.rp_id));
  throw new Error('tool not found');
}
