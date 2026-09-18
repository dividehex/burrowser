import { workerResources, workerSecretName, workerSecretResource, type WorkerSecretMaterial } from './kube.ts';
import type { Profile, ProfileStore } from './profiles.ts';

export type ObservedPod = { phase: 'Pending' | 'Running' | 'Failed' | 'Unknown'; ready: boolean; uid?: string };
export type KubernetesPort = {
  get(kind: 'pvc' | 'pod' | 'service' | 'secret', name: string): Promise<unknown | undefined>;
  apply(kind: 'pvc' | 'pod' | 'service' | 'secret', name: string, resource: unknown): Promise<void>;
  delete(kind: 'pod' | 'service' | 'secret' | 'pvc', name: string): Promise<void>;
  podStatus(name: string): Promise<ObservedPod | undefined>;
};

/** Reconcile one profile. PVC is deliberately never deleted here; only deleteProfileResources removes one. */
export async function reconcileProfile(profile: Profile, kube: KubernetesPort, image: string, workerSecret?: WorkerSecretMaterial) {
  const resources = workerResources(profile, image);
  try {
    if (workerSecret && !await kube.get('secret', workerSecretName(profile))) await kube.apply('secret', workerSecretName(profile), workerSecretResource(profile, workerSecret));
    if (!await kube.get('pvc', profile.pvcName)) await kube.apply('pvc', profile.pvcName, resources.pvc);
    if (!await kube.get('service', resources.service.metadata.name)) await kube.apply('service', resources.service.metadata.name, resources.service);
    if (!await kube.get('pod', resources.pod.metadata.name)) {
      await kube.apply('pod', resources.pod.metadata.name, resources.pod);
      profile.state = 'STARTING';
      return profile.state;
    }
    const status = await kube.podStatus(resources.pod.metadata.name);
    if (!status) { profile.state = 'STARTING'; return profile.state; }
    if (status.phase === 'Failed') { profile.state = 'FAILED'; return profile.state; }
    profile.state = status.phase === 'Running' && status.ready ? 'READY' : 'STARTING';
    return profile.state;
  } catch (error) {
    profile.state = 'FAILED';
    throw error;
  }
}

export async function stopProfile(profile: Profile, kube: KubernetesPort, finalState = 'STOPPED') {
  const podName = `bw-${profile.id}`;
  await kube.delete('pod', podName);
  await kube.delete('service', podName);
  profile.state = finalState;
}

/**
 * Tear down everything a profile owns, including its PVC and worker Secret. Only reachable for a
 * profile an administrator has explicitly marked DELETING. Deletes are idempotent and Kubernetes
 * finishes them asynchronously (a PVC stays Terminating until its Pod is gone), so this returns
 * true only once every resource is actually absent; the controller calls it again next tick otherwise.
 */
export async function deleteProfileResources(profile: Profile, kube: KubernetesPort): Promise<boolean> {
  const podName = `bw-${profile.id}`;
  const secretName = workerSecretName(profile);
  await kube.delete('pod', podName);
  await kube.delete('service', podName);
  await kube.delete('secret', secretName);
  await kube.delete('pvc', profile.pvcName);
  const remaining = await Promise.all([kube.get('pod', podName), kube.get('service', podName), kube.get('secret', secretName), kube.get('pvc', profile.pvcName)]);
  return remaining.every(resource => resource === undefined);
}

/**
 * A profile stuck in STARTING (e.g. its Pod is wedged on a lost/unreachable
 * node and never reports Ready) is reset to FAILED after stuckMs so its
 * Pod/Service are freed and the next reconcile cycle gets a fresh
 * scheduling attempt, rather than leaking resources on a dead node forever.
 * FAILED is deliberately not skipped by the controller's reconcile loop, so
 * this is a bounded automatic retry, not a terminal state.
 */
export async function reclaimStuckProfiles(store: ProfileStore, kube: KubernetesPort, stuckSince: Map<string, number>, now = Date.now(), stuckMs = 5 * 60_000) {
  let reclaimed = 0;
  const currentIds = new Set(store.profiles.keys());
  for (const id of stuckSince.keys()) if (!currentIds.has(id)) stuckSince.delete(id);
  for (const profile of store.profiles.values()) {
    if (profile.state !== 'STARTING') { stuckSince.delete(profile.id); continue; }
    const since = stuckSince.get(profile.id) ?? now;
    stuckSince.set(profile.id, since);
    if (now - since < stuckMs) continue;
    await stopProfile(profile, kube, 'FAILED');
    stuckSince.delete(profile.id);
    reclaimed++;
  }
  return reclaimed;
}

export async function reclaimIdleProfiles(store: ProfileStore, kube: KubernetesPort, now = Date.now(), idleMs = 15 * 60_000) {
  let reclaimed = 0;
  for (const profile of store.profiles.values()) {
    if (!['READY', 'IDLE'].includes(profile.state) || now - profile.lastUsedAt < idleMs) continue;
    const lease = store.leases.get(profile.id);
    if (lease && lease.expiresAt > now) continue;
    profile.state = 'DRAINING';
    await stopProfile(profile, kube);
    reclaimed++;
  }
  return reclaimed;
}
