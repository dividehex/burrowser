import type { Profile } from './profiles.ts';

export type WorkerSecretMaterial = { controllerCredential: string; authenticatorKey: string; vncPassword: string };
export function workerSecretName(profile: Profile) { return `bw-${profile.id}-worker-auth`; }

export function workerSecretResource(profile: Profile, material: WorkerSecretMaterial) {
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name: workerSecretName(profile), labels: { 'burrowser/profile-id': profile.id } }, type: 'Opaque', stringData: { WORKER_CONTROLLER_CREDENTIAL: material.controllerCredential, BURROWSER_AUTHENTICATOR_KEY: material.authenticatorKey, BURROWSER_VNC_PASSWORD: material.vncPassword } };
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
    pod: { apiVersion: 'v1', kind: 'Pod', metadata: { name: `bw-${profile.id}`, labels }, spec: { automountServiceAccountToken: false, serviceAccountName: 'burrowser-worker', securityContext: { seccompProfile: { type: 'Localhost', localhostProfile: 'burrowser/chromium.json' } }, containers: [{ name: 'worker', image, imagePullPolicy, ports: [{ containerPort: 8080 }, { containerPort: 5900 }], resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1', memory: '1Gi' } }, env: [{ name: 'WORKER_CONTROLLER_CREDENTIAL', valueFrom: { secretKeyRef: { name: workerSecretName(profile), key: 'WORKER_CONTROLLER_CREDENTIAL' } } }, { name: 'BURROWSER_AUTHENTICATOR_KEY', valueFrom: { secretKeyRef: { name: workerSecretName(profile), key: 'BURROWSER_AUTHENTICATOR_KEY' } } }, { name: 'BURROWSER_VNC_PASSWORD', valueFrom: { secretKeyRef: { name: workerSecretName(profile), key: 'BURROWSER_VNC_PASSWORD' } } }], securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } }, volumeMounts: [{ name: 'profile', mountPath: '/profile' }, { name: 'tmp', mountPath: '/tmp' }, { name: 'shm', mountPath: '/dev/shm' }, { name: 'home', mountPath: '/home/browser' }] }], volumes: [{ name: 'profile', persistentVolumeClaim: { claimName: profile.pvcName } }, { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } }, { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } }, { name: 'home', emptyDir: { sizeLimit: '256Mi' } }] } }
  };
}
