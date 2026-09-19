import type { Profile } from './profiles.ts';

export type WorkerSecretMaterial = { controllerCredential: string; authenticatorKey: string; vncPassword: string };
export function workerSecretName(profile: Profile) { return `bw-${profile.id}-worker-auth`; }

export function workerSecretResource(profile: Profile, material: WorkerSecretMaterial) {
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name: workerSecretName(profile), labels: { 'burrowser/profile-id': profile.id } }, type: 'Opaque', stringData: { WORKER_CONTROLLER_CREDENTIAL: material.controllerCredential, BURROWSER_AUTHENTICATOR_KEY: material.authenticatorKey, BURROWSER_VNC_PASSWORD: material.vncPassword } };
}

/** Time a stopping worker gets to persist its passkeys and close Chromium normally before the kubelet kills it (Kubernetes's default is 30). */
export const WORKER_TERMINATION_GRACE_SECONDS = 45;

/**
 * Memory limit for a worker Pod (Chromium plus /dev/shm, which counts against it). Heavy sites exceed the old 1Gi
 * and get renderers, then the whole container, OOM-killed. Set with the chart value worker.memoryLimit.
 */
export const DEFAULT_WORKER_MEMORY_LIMIT = '3Gi';
const WORKER_MEMORY_REQUEST_MI = 512;
export function workerMemoryLimit(env: Record<string, string | undefined> = process.env) {
  const value = env.BURROWSER_WORKER_MEMORY_LIMIT || DEFAULT_WORKER_MEMORY_LIMIT;
  const match = /^([1-9]\d*)(Mi|Gi)$/.exec(value);
  if (!match) throw new Error(`BURROWSER_WORKER_MEMORY_LIMIT must be a whole number of Mi or Gi (for example 3Gi), got "${value}"`);
  if (Number(match[1]) * (match[2] === 'Gi' ? 1024 : 1) < WORKER_MEMORY_REQUEST_MI) throw new Error(`BURROWSER_WORKER_MEMORY_LIMIT must be at least the ${WORKER_MEMORY_REQUEST_MI}Mi request`);
  return value;
}

export function workerResources(profile: Profile, image = 'ghcr.io/burrowser/worker@sha256:REPLACE') {
  const pinned = /^[a-z0-9][\w.-]*(?::[0-9]+)?(?:\/[\w./-]+)+(?::[\w.-]+)?@sha256:[a-f0-9]{64}$/.test(image);
  const localDevelopment = process.env.BURROWSER_WORKER_IMAGE_PULL_POLICY === 'Never' && /^docker\.io\/library\/[\w.-]+:[\w.-]+$/.test(image);
  if (!pinned && !localDevelopment) throw new Error('worker image must be registry-qualified and pinned by digest');
  const labels = { 'app.kubernetes.io/name': 'burrowser-worker', 'burrowser/profile-id': profile.id };
  const imagePullPolicy = process.env.BURROWSER_WORKER_IMAGE_PULL_POLICY ?? 'IfNotPresent';
  return {
    pvc: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: profile.pvcName, labels }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'burrowser-local-path', resources: { requests: { storage: '10Gi' } } } },
    service: { apiVersion: 'v1', kind: 'Service', metadata: { name: `bw-${profile.id}`, labels }, spec: { type: 'ClusterIP', selector: labels, ports: [{ name: 'rpc', port: 8080 }, { name: 'vnc', port: 5900 }] } },
    pod: { apiVersion: 'v1', kind: 'Pod', metadata: { name: `bw-${profile.id}`, labels }, spec: { terminationGracePeriodSeconds: WORKER_TERMINATION_GRACE_SECONDS, automountServiceAccountToken: false, serviceAccountName: 'burrowser-worker', securityContext: { seccompProfile: { type: 'Localhost', localhostProfile: 'burrowser/chromium.json' } }, containers: [{ name: 'worker', image, imagePullPolicy, ports: [{ containerPort: 8080 }, { containerPort: 5900 }], readinessProbe: { httpGet: { path: '/health', port: 8080 }, initialDelaySeconds: 1, periodSeconds: 2, failureThreshold: 30 }, resources: { requests: { cpu: '250m', memory: `${WORKER_MEMORY_REQUEST_MI}Mi` }, limits: { cpu: '1', memory: workerMemoryLimit() } }, env: [{ name: 'WORKER_CONTROLLER_CREDENTIAL', valueFrom: { secretKeyRef: { name: workerSecretName(profile), key: 'WORKER_CONTROLLER_CREDENTIAL' } } }, { name: 'BURROWSER_AUTHENTICATOR_KEY', valueFrom: { secretKeyRef: { name: workerSecretName(profile), key: 'BURROWSER_AUTHENTICATOR_KEY' } } }, { name: 'BURROWSER_VNC_PASSWORD', valueFrom: { secretKeyRef: { name: workerSecretName(profile), key: 'BURROWSER_VNC_PASSWORD' } } }, ...(process.env.BURROWSER_MCP_CAPS ? [{ name: 'BURROWSER_MCP_CAPS', value: process.env.BURROWSER_MCP_CAPS }] : [])], securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } }, volumeMounts: [{ name: 'profile', mountPath: '/profile' }, { name: 'tmp', mountPath: '/tmp' }, { name: 'shm', mountPath: '/dev/shm' }, { name: 'home', mountPath: '/home/browser' }] }], volumes: [{ name: 'profile', persistentVolumeClaim: { claimName: profile.pvcName } }, { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } }, { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } }, { name: 'home', emptyDir: { sizeLimit: '256Mi' } }] } }
  };
}
