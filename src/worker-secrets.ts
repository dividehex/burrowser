import { randomBytes } from 'node:crypto';
import type { Profile } from './profiles.ts';
import { workerSecretName, workerSecretResource, type WorkerSecretMaterial } from './kube.ts';
import type { KubernetesPort } from './reconcile.ts';

type Secret = { data?: Record<string, string>; stringData?: Record<string, string> };

function value(secret: Secret, key: string) {
  const encoded = secret.data?.[key];
  if (encoded !== undefined) return Buffer.from(encoded, 'base64').toString('utf8');
  return secret.stringData?.[key];
}

export class KubernetesWorkerSecretProvider {
  private readonly kube: KubernetesPort;

  constructor(kube: KubernetesPort) {
    this.kube = kube;
  }

  async ensure(profile: Profile): Promise<WorkerSecretMaterial> {
    const existing = await this.kube.get('secret', workerSecretName(profile));
    if (existing) return this.read(profile, existing as Secret);
    const material = { controllerCredential: randomBytes(32).toString('base64url'), authenticatorKey: randomBytes(32).toString('base64url'), vncPassword: randomBytes(32).toString('base64url') };
    await this.kube.apply('secret', workerSecretName(profile), workerSecretResource(profile, material));
    return material;
  }

  async get(profile: Profile): Promise<WorkerSecretMaterial> {
    const secret = await this.kube.get('secret', workerSecretName(profile)) as Secret | undefined;
    if (!secret) throw new Error(`worker Secret missing for profile ${profile.id}`);
    return this.read(profile, secret);
  }

  private read(profile: Profile, secret: Secret): WorkerSecretMaterial {
    const controllerCredential = value(secret, 'WORKER_CONTROLLER_CREDENTIAL');
    const authenticatorKey = value(secret, 'AGENT_BROWSER_AUTHENTICATOR_KEY');
    const vncPassword = value(secret, 'AGENT_BROWSER_VNC_PASSWORD');
    if (!controllerCredential || !authenticatorKey || !vncPassword || Buffer.from(authenticatorKey, 'base64url').length !== 32) throw new Error(`worker Secret malformed for profile ${profile.id}`);
    return { controllerCredential, authenticatorKey, vncPassword };
  }
}
