import { CliError } from './cli-error.ts';
import { signWith, type Identity } from './identity-store.ts';

type Fetch = typeof fetch;
const REQUEST_TIMEOUT_MS = 30_000;

export function normalizeGatewayUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CliError(`"${raw}" is not a valid URL; expected something like https://burrowser.example.com`, 2); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CliError(`gateway URL must be http(s), got ${url.protocol}`, 2);
  return url.origin;
}

/** The gateway has no TLS of its own; say so when secrets would cross a network in the clear. */
export function warnIfInsecure(baseUrl: string, what: string, warn: (message: string) => void = message => console.error(message)) {
  const { protocol, hostname } = new URL(baseUrl);
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (protocol === 'http:' && !loopback) warn(`warning: ${what} over plain HTTP to ${hostname}; anyone on the network path can read it. Put the gateway behind TLS.`);
}

export class GatewayClient {
  readonly baseUrl: string;
  private readonly fetchImpl: Fetch;

  constructor(baseUrl: string, fetchImpl: Fetch = fetch) {
    this.baseUrl = normalizeGatewayUrl(baseUrl);
    this.fetchImpl = fetchImpl;
  }

  /** Returns the parsed JSON body, or undefined for 204. Non-2xx becomes a CliError carrying the gateway's own message. */
  async json<T = any>(method: string, path: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CliError(`cannot reach ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    if (!response.ok) throw new CliError(`${method} ${path} failed (${response.status}): ${parsed?.error ?? (text || response.statusText)}`);
    return parsed as T;
  }
}

export type AgentAuthHeaders = { authorization: string; 'x-agent-challenge': string };
const REFRESH_MARGIN_MS = 60_000;

/** Proves possession of an identity's key to the gateway and keeps a short-lived access token fresh. */
export class AgentSession {
  private readonly identity: Identity;
  private readonly gateway: GatewayClient;
  private current?: { headers: AgentAuthHeaders; expiresAt: number };
  private refreshing?: Promise<AgentAuthHeaders>;

  constructor(identity: Identity, gateway = new GatewayClient(identity.url)) {
    this.identity = identity;
    this.gateway = gateway;
  }

  async headers(now = Date.now()): Promise<AgentAuthHeaders> {
    if (this.current && this.current.expiresAt - now > REFRESH_MARGIN_MS) return this.current.headers;
    this.refreshing ??= this.refresh(now).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refresh(now: number): Promise<AgentAuthHeaders> {
    // The gateway keeps one outstanding challenge per agent, so two processes refreshing at once can
    // invalidate each other; one retry after a short pause resolves that.
    for (let attempt = 0; ; attempt++) {
      try {
        const { challenge } = await this.gateway.json<{ challenge: string }>('POST', '/v1/identity/challenge', { body: { agent_id: this.identity.agentId } });
        const token = await this.gateway.json<{ access_token: string; expires_in: number }>('POST', '/v1/identity/token', { body: { agent_id: this.identity.agentId, proof: signWith(this.identity, challenge) } });
        const headers = { authorization: `Bearer ${token.access_token}`, 'x-agent-challenge': challenge };
        this.current = { headers, expiresAt: now + token.expires_in * 1000 };
        return headers;
      } catch (error) {
        if (attempt >= 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
      }
    }
  }
}
