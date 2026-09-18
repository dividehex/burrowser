import type { PostgresRepository } from './repository.ts';
import { ProfileController } from './controller.ts';
import { KubernetesWorkerSecretProvider } from './worker-secrets.ts';
import type { KubernetesPort } from './reconcile.ts';

export function createPostgresKubernetesController(repository: Pick<PostgresRepository, 'listControllerProfiles' | 'listControllerLeases'> & Partial<Pick<PostgresRepository, 'updateProfileState'>>, kube: KubernetesPort, workerImage: string, intervalMs?: number) {
  return new ProfileController({
    state: {
      listProfiles: () => repository.listControllerProfiles(),
      listLeases: () => repository.listControllerLeases(),
      updateProfileState: repository.updateProfileState ? (profileId, state) => repository.updateProfileState!(profileId, state) : undefined,
    },
    secrets: new KubernetesWorkerSecretProvider(kube),
    kube,
    workerImage,
    intervalMs,
  });
}
