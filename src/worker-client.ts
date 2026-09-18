import type { WorkerPort } from './mcp.ts';

const workerHost = (profileId: string, namespace: string) => `bw-${profileId}.${namespace}.svc:8080`;

/** Where a profile's worker serves Playwright MCP inside the cluster. */
export const workerMcpUrl = (profileId: string, namespace = process.env.KUBERNETES_NAMESPACE ?? 'burrowser') => new URL(`http://${workerHost(profileId, namespace)}/mcp`);

/** The worker's JSON RPC: the few things MCP has no equivalent for (passkey enrollment, dashboard thumbnails). */
export class HttpWorkerClient implements WorkerPort {
  private readonly endpoint: string;
  private readonly credential: string;

  constructor(profileId: string, credential: string, namespace = process.env.KUBERNETES_NAMESPACE ?? 'burrowser') {
    this.endpoint = `http://${workerHost(profileId, namespace)}/rpc`;
    this.credential = credential;
  }

  passkeyEnrollBegin(rpId: string) { return this.call('passkeyEnrollBegin', { rpId }); }
  passkeyEnrollPoll() { return this.call('passkeyEnrollPoll', {}); }
  passkeyList() { return this.call('passkeyList', {}) as Promise<{ credentials: unknown[] }>; }
  thumbnail() { return this.call('thumbnail', {}) as Promise<{ image: string; contentType: string }>; }

  private async call(method: string, input: Record<string, unknown>) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, ...input }),
    });
    const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
    // The worker's message is what tells a caller *why*; keep only its first line.
    const reason = typeof body?.error === 'string' ? `: ${body.error.split('\n')[0].slice(0, 300)}` : '';
    if (!response.ok) throw new Error(`worker request failed with HTTP ${response.status}${reason}`);
    return body;
  }
}
