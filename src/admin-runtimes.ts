import type { Store } from './identity.ts';
import type { ProfileStore } from './profiles.ts';

export type AdminRuntime = { id: string; name: string; state: string; agentId: string; agentDisplayName: string; createdAt: number; lastUsedAt: number };
export type RuntimeSource = { listAdminRuntimes(): Promise<AdminRuntime[]> };
export type RuntimeDiff = { updated: AdminRuntime[]; removed: string[] };
export type SseSink = { write(chunk: string): void };

/** Only these states belong on the live dashboard - a stopped/failed profile still exists for
 * profile management, it just stops appearing here (docs/architecture/original-spec.md line 110). */
export const LIVE_STATES = ['STARTING', 'READY', 'IDLE'] as const;

export function postgresRuntimeSource(repository: { listAdminRuntimes(): Promise<AdminRuntime[]> }): RuntimeSource {
  return repository;
}

export function inMemoryRuntimeSource(state: Store & ProfileStore): RuntimeSource {
  return {
    async listAdminRuntimes() {
      return [...state.profiles.values()].map(profile => ({
        id: profile.id,
        name: profile.name,
        state: profile.state,
        agentId: profile.agentId,
        agentDisplayName: state.agents.get(profile.agentId)?.displayName ?? 'unknown',
        createdAt: profile.createdAt,
        lastUsedAt: profile.lastUsedAt,
      }));
    },
  };
}

export function liveRuntimes(runtimes: AdminRuntime[]): AdminRuntime[] {
  return runtimes.filter(runtime => (LIVE_STATES as readonly string[]).includes(runtime.state));
}

function sameRuntime(a: AdminRuntime, b: AdminRuntime) {
  return a.name === b.name && a.state === b.state && a.agentDisplayName === b.agentDisplayName && a.lastUsedAt === b.lastUsedAt;
}

export function diffRuntimes(previous: ReadonlyMap<string, AdminRuntime>, current: AdminRuntime[]): RuntimeDiff {
  const currentIds = new Set(current.map(runtime => runtime.id));
  const updated = current.filter(runtime => { const before = previous.get(runtime.id); return !before || !sameRuntime(before, runtime); });
  const removed = [...previous.keys()].filter(id => !currentIds.has(id));
  return { updated, removed };
}

export function writeSnapshot(sink: SseSink, runtimes: AdminRuntime[]) {
  sink.write(`event: snapshot\ndata: ${JSON.stringify(runtimes)}\n\n`);
}

export function writeDiff(sink: SseSink, diff: RuntimeDiff) {
  if (diff.updated.length) sink.write(`event: update\ndata: ${JSON.stringify(diff.updated)}\n\n`);
  for (const id of diff.removed) sink.write(`event: removed\ndata: ${JSON.stringify({ id })}\n\n`);
}

export async function pollRuntimes(source: RuntimeSource, previous: Map<string, AdminRuntime>, sink: SseSink) {
  const current = liveRuntimes(await source.listAdminRuntimes());
  writeDiff(sink, diffRuntimes(previous, current));
  previous.clear();
  for (const runtime of current) previous.set(runtime.id, runtime);
}
