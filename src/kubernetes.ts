import { KubeConfig, CoreV1Api, ApiException } from '@kubernetes/client-node';
import type { KubernetesPort, ObservedPod } from './reconcile.ts';

export type KubernetesClientOptions = { api: CoreV1Api; namespace: string };

export function inClusterKubernetesOptions(): KubernetesClientOptions {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromCluster();
  const namespace = kubeConfig.getContextObject(kubeConfig.getCurrentContext())?.namespace;
  if (!namespace) throw new Error('unable to determine namespace from the in-cluster service account');
  return { api: kubeConfig.makeApiClient(CoreV1Api), namespace };
}

type ResourceKind = 'pvc' | 'pod' | 'service' | 'secret';
const READ_METHOD = { pvc: 'readNamespacedPersistentVolumeClaim', pod: 'readNamespacedPod', service: 'readNamespacedService', secret: 'readNamespacedSecret' } as const;
const CREATE_METHOD = { pvc: 'createNamespacedPersistentVolumeClaim', pod: 'createNamespacedPod', service: 'createNamespacedService', secret: 'createNamespacedSecret' } as const;
const DELETE_METHOD = { pvc: 'deleteNamespacedPersistentVolumeClaim', pod: 'deleteNamespacedPod', service: 'deleteNamespacedService', secret: 'deleteNamespacedSecret' } as const;

export class KubernetesApiClient implements KubernetesPort {
  private readonly api: CoreV1Api;
  private readonly namespace: string;

  constructor(options: KubernetesClientOptions) {
    this.api = options.api;
    this.namespace = options.namespace;
  }

  async get(kind: ResourceKind, name: string): Promise<unknown | undefined> {
    try {
      return await (this.api[READ_METHOD[kind]] as (params: { name: string; namespace: string }) => Promise<unknown>)({ name, namespace: this.namespace });
    } catch (error) {
      if (error instanceof ApiException && error.code === 404) return undefined;
      throw this.wrap(error, `get ${kind}/${name}`);
    }
  }

  async apply(kind: ResourceKind, name: string, resource: unknown): Promise<void> {
    try {
      await (this.api[CREATE_METHOD[kind]] as (params: { namespace: string; body: unknown }) => Promise<unknown>)({ namespace: this.namespace, body: resource });
    } catch (error) {
      if (error instanceof ApiException && error.code === 409) return;
      throw this.wrap(error, `create ${kind}/${name}`);
    }
  }

  async delete(kind: 'pod' | 'service' | 'secret', name: string): Promise<void> {
    try {
      await (this.api[DELETE_METHOD[kind]] as (params: { name: string; namespace: string }) => Promise<unknown>)({ name, namespace: this.namespace });
    } catch (error) {
      if (error instanceof ApiException && error.code === 404) return;
      throw this.wrap(error, `delete ${kind}/${name}`);
    }
  }

  async podStatus(name: string): Promise<ObservedPod | undefined> {
    const pod = await this.get('pod', name) as { status?: { phase?: string; conditions?: Array<{ type?: string; status?: string }> } } | undefined;
    if (!pod?.status) return undefined;
    const phase = pod.status.phase;
    const normalizedPhase: ObservedPod['phase'] = phase === 'Pending' || phase === 'Running' || phase === 'Failed' ? phase : 'Unknown';
    return { phase: normalizedPhase, ready: pod.status.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True') ?? false };
  }

  private wrap(error: unknown, action: string): Error {
    if (error instanceof ApiException) return new Error(`Kubernetes ${action} failed with HTTP ${error.code}: ${JSON.stringify(error.body).slice(0, 500)}`);
    return new Error(`Kubernetes ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
