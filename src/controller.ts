import type { Lease, Profile, ProfileStore } from './profiles.ts';
import { deleteProfileResources, reclaimIdleProfiles, reclaimStuckProfiles, reconcileProfile, type KubernetesPort } from './reconcile.ts';
import type { WorkerSecretMaterial } from './kube.ts';

export type ControllerStateSource = {
  listProfiles(): Promise<Profile[]>;
  listLeases(): Promise<Lease[]>;
  updateProfileState?(profileId: string, state: string): Promise<void>;
  finalizeProfileDeletion?(profileId: string): Promise<void>;
};
export type WorkerSecretProvider = { get(profile: Profile): Promise<WorkerSecretMaterial>; ensure?(profile: Profile): Promise<WorkerSecretMaterial> };
export type ControllerOptions = { state: ControllerStateSource; secrets: WorkerSecretProvider; kube: KubernetesPort; workerImage: string; intervalMs?: number; stuckMs?: number; onError?: (error: unknown) => void };

export class ProfileController {
  private readonly options: ControllerOptions;
  private readonly stuckSince = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(options: ControllerOptions) {
    this.options = options;
  }

  async reconcileOnce(now = Date.now()) {
    const profiles = await this.options.state.listProfiles();
    const leases = await this.options.state.listLeases();
    const store: ProfileStore = { profiles: new Map(profiles.map(profile => [profile.id, profile])), leases: new Map(leases.map(lease => [lease.profileId, lease])) };
    let reconciled = 0;
    for (const profile of profiles) {
      if (profile.state === 'DELETING') {
        if (await deleteProfileResources(profile, this.options.kube)) await this.options.state.finalizeProfileDeletion?.(profile.id);
        continue;
      }
      if (profile.state === 'STOPPED') continue;
      const workerSecret = this.options.secrets.ensure ? await this.options.secrets.ensure(profile) : await this.options.secrets.get(profile);
      await reconcileProfile(profile, this.options.kube, this.options.workerImage, workerSecret);
      await this.options.state.updateProfileState?.(profile.id, profile.state);
      reconciled++;
    }
    const idleReclaimed = await reclaimIdleProfiles(store, this.options.kube, now);
    const stuckReclaimed = await reclaimStuckProfiles(store, this.options.kube, this.stuckSince, now, this.options.stuckMs);
    for (const profile of profiles) {
      if (profile.state === 'STOPPED' || profile.state === 'FAILED') await this.options.state.updateProfileState?.(profile.id, profile.state);
    }
    return { reconciled, reclaimed: idleReclaimed + stuckReclaimed };
  }

  start() {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? 5_000;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.reconcileOnce().catch(error => {
        if (this.options.onError) this.options.onError(error);
        else console.error(`controller reconciliation failed; will retry: ${error instanceof Error ? error.message : 'unknown error'}`);
      }).finally(() => { this.running = false; });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
