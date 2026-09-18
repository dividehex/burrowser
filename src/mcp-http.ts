import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport, type EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { dispatchTool, MCP_TOOLS, type DurableProfileStore, type WorkerPort } from './mcp.ts';
import type { Agent } from './identity.ts';
import type { Profile, ProfileStore } from './profiles.ts';

type RequestLike = { method?: string; url?: string; headers: Record<string, string | string[] | undefined> };
type ResponseLike = { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void };
export type McpSession = { agentId: string; transport: StreamableHTTPServerTransport };
export type McpHttpOptions = { store: ProfileStore | DurableProfileStore; agent: Agent; worker?: WorkerPort; workerForProfile?: (profile: Profile) => Promise<WorkerPort>; sessions: Map<string, McpSession>; allowedOrigins?: readonly string[] };

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

async function profileForTool(store: ProfileStore | DurableProfileStore, agentId: string, profileId: string): Promise<Profile> {
  const profile = 'listProfiles' in store
    ? (await store.listProfiles(agentId)).find(candidate => candidate.id === profileId)
    : store.profiles.get(profileId);
  if (!profile || profile.agentId !== agentId) throw new Error('profile not found');
  return profile;
}

const LEASE_ARGS = { profile_id: z.string(), client_id: z.string(), fencing_generation: z.number() };
const NEEDS_WORKER = new Set(['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_auth_status', 'browser_passkey_enrollment_request', 'browser_passkey_status']);
const TOOL_SCHEMAS: Record<string, z.ZodRawShape> = {
  browser_profiles_list: {},
  browser_profiles_create: { name: z.string() },
  browser_profile_open: { profile_id: z.string(), client_id: z.string() },
  browser_profile_release: LEASE_ARGS,
  browser_navigate: { ...LEASE_ARGS, url: z.string(), previous_url: z.string().optional() },
  browser_snapshot: LEASE_ARGS,
  browser_click: { ...LEASE_ARGS, selector: z.string() },
  browser_type: { ...LEASE_ARGS, selector: z.string(), text: z.string() },
  browser_auth_status: LEASE_ARGS,
  browser_passkey_enrollment_request: { ...LEASE_ARGS, rp_id: z.string() },
  browser_passkey_status: LEASE_ARGS,
};

function createSessionServer(options: McpHttpOptions): McpServer {
  const server = new McpServer({ name: 'burrowser', version: '0.1.0' }, { capabilities: { tools: {} } });
  for (const name of MCP_TOOLS) {
    server.registerTool(name, { description: `Burrowser ${name}`, inputSchema: TOOL_SCHEMAS[name] }, async (args: any) => {
      try {
        const needsWorker = NEEDS_WORKER.has(name);
        const worker = options.worker ?? (needsWorker && args.profile_id && options.workerForProfile ? await options.workerForProfile(await profileForTool(options.store, options.agent.id, args.profile_id)) : undefined);
        const result = await dispatchTool(options.store, options.agent, worker, name, args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'tool failed' }] };
      }
    });
  }
  return server;
}

function originAllowed(req: RequestLike, allowedOrigins: readonly string[] | undefined) {
  const origin = req.headers.origin;
  return typeof origin !== 'string' ? true : (allowedOrigins ?? []).includes(origin);
}

function write(res: ResponseLike, status: number, body: unknown) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body));
}

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

  const server = createSessionServer(options);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore: new BoundedEventStore(),
    onsessioninitialized: sid => { options.sessions.set(sid, { agentId: options.agent.id, transport }); },
  });
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) options.sessions.delete(sid);
  };
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
