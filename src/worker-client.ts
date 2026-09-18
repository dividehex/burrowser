import type { WorkerPort } from './mcp.ts';

export class HttpWorkerClient implements WorkerPort {
  private readonly endpoint: string;
  private readonly credential: string;

  constructor(profileId: string, credential: string, namespace = process.env.KUBERNETES_NAMESPACE ?? 'agent-browser') {
    this.endpoint = `http://ab-${profileId}.${namespace}.svc:8080/rpc`;
    this.credential = credential;
  }

  navigate(url: string) { return this.call('navigate', { url }); }
  snapshot() { return this.call('snapshot', {}); }
  click(selector: string) { return this.call('click', { selector }); }
  type(selector: string, text: string) { return this.call('type', { selector, text }); }
  authStatus() { return this.call('authStatus', {}); }
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
    const body = await response.json() as unknown;
    if (!response.ok) throw new Error(`worker request failed with HTTP ${response.status}`);
    return body;
  }
}
