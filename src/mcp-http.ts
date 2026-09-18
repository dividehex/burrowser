import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport, type EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { findOwnedProfile, profileLease, waitUntilUsable, type DurableProfileStore, type WorkerPort } from './mcp.ts';
import { createProxyServer, type WorkerMcpTarget } from './mcp-proxy.ts';
import type { Agent } from './identity.ts';
import type { Profile, ProfileStore } from './profiles.ts';
import { HttpError } from './errors.ts';

type ResponseLike = { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void };
export type McpSession = { agentId: string; transport: StreamableHTTPServerTransport };
export type McpHttpOptions = {
  store: ProfileStore | DurableProfileStore;
  agent: Agent;
  sessions: Map<string, McpSession>;
  workerForProfile?: (profile: Profile) => Promise<WorkerPort>;
  /** Where the profile's worker serves Playwright MCP. Without it the gateway has no browser to offer. */
  workerMcpForProfile?: (profile: Profile) => Promise<WorkerMcpTarget>;
  excludedTools: ReadonlySet<string>;
  allowedOrigins?: readonly string[];
  /** How long a session start waits for a profile's browser to become ready (default 90s, polling every second). */
  readyTimeoutMs?: number;
  readyPollMs?: number;
};

/** An MCP client says which of its profiles it is driving with this header on its first request. */
export const PROFILE_HEADER = 'x-burrowser-profile';

const jsonHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const jsonRpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } });

/** Bounded per-stream event history for SSE resumption (Last-Event-ID replay), matching this
 * project's existing "keep the last N events" design rather than unbounded retention. */
class BoundedEventStore implements EventStore {
  private readonly streams = new Map<string, Array<{ id: string; message: JSONRPCMessage }>>();
  private counter = 0;

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = `${streamId}:${++this.counter}`;
    const events = this.streams.get(streamId) ?? [];
    events.push({ id: eventId, message });
    if (events.length > 100) events.shift();
    this.streams.set(streamId, events);
    return eventId;
  }

  async replayEventsAfter(lastEventId: string, { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }): Promise<string> {
    const [streamId] = lastEventId.split(':');
    const events = this.streams.get(streamId) ?? [];
    const index = events.findIndex(event => event.id === lastEventId);
    for (const event of events.slice(index + 1)) await send(event.id, event.message);
    return streamId;
  }
}

function originAllowed(req: { headers: Record<string, string | string[] | undefined> }, allowedOrigins: readonly string[] | undefined) {
  const origin = req.headers.origin;
  return typeof origin !== 'string' ? true : (allowedOrigins ?? []).includes(origin);
}

function write(res: ResponseLike, status: number, body: unknown) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body));
}

/** Maps a failure while starting a session to the status an MCP client can act on. */
function startFailure(error: unknown) {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  const message = error instanceof Error ? error.message : 'could not start the browser session';
  return { status: message.includes('busy') ? 409 : message.includes('not found') ? 404 : 502, message };
}

/**
 * Starts (or continues) an MCP session that IS the profile's Playwright MCP server, seen through the gateway:
 * the caller is authenticated by the layer above, this takes the profile's lease for the life of the session,
 * waits for its browser, and then proxies (see mcp-proxy.ts).
 */
export async function handleMcpHttp(req: any, res: any, options: McpHttpOptions): Promise<void> {
  if (!originAllowed(req, options.allowedOrigins)) return write(res, 403, { error: 'origin not allowed' });

  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId === 'string') {
    const session = options.sessions.get(sessionId);
    if (!session) return write(res, 404, jsonRpcError(null, -32001, 'session not found'));
    if (session.agentId !== options.agent.id) return write(res, 400, jsonRpcError(null, -32600, 'MCP session identity mismatch'));
    await session.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== 'POST') return write(res, 400, jsonRpcError(null, -32600, 'no valid session ID provided'));
  const profileId = req.headers[PROFILE_HEADER];
  if (typeof profileId !== 'string' || !profileId) return write(res, 400, jsonRpcError(null, -32600, `the ${PROFILE_HEADER} header is required: it names the profile this session drives`));
  if (!options.workerMcpForProfile) return write(res, 503, jsonRpcError(null, -32000, 'this gateway has no browser workers to offer'));

  const profile = await findOwnedProfile(options.store, options.agent.id, profileId);
  if (!profile) return write(res, 404, jsonRpcError(null, -32000, 'profile not found'));

  const lease = profileLease(options.store, options.agent, profile, `session-${randomUUID()}`);
  let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([lease.release(), proxy?.close()]);
  };

  try {
    await lease.ensure();
    const ready = await waitUntilUsable(options.store, options.agent.id, profile, { timeoutMs: options.readyTimeoutMs ?? 90_000, pollMs: options.readyPollMs ?? 1000 });
    proxy = await createProxyServer({
      target: await options.workerMcpForProfile(ready),
      worker: options.workerForProfile ? await options.workerForProfile(ready) : undefined,
      lease,
      excludedTools: options.excludedTools,
    });
  } catch (error) {
    await cleanup();
    const { status, message } = startFailure(error);
    return write(res, status, jsonRpcError(null, -32000, message));
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore: new BoundedEventStore(),
    onsessioninitialized: sid => { options.sessions.set(sid, { agentId: options.agent.id, transport }); },
  });
  transport.onclose = () => {
    if (transport.sessionId) options.sessions.delete(transport.sessionId);
    void cleanup();
  };
  await proxy.server.connect(transport);
  await transport.handleRequest(req, res);
  if (!transport.sessionId) await cleanup();   // the first request wasn't a valid initialize: nothing to keep
}
