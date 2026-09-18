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

const PROFILE_ID = z.string().describe('The id of one of your profiles (from browser_profiles_list).');
const CLIENT_ID = z.string().describe('A stable identifier you choose for yourself (for example "claude"). Use the same value for every call on a profile.');
const LEASE_ARGS = {
  profile_id: PROFILE_ID,
  client_id: CLIENT_ID,
  fencing_generation: z.number().describe('The fencingGeneration returned by your most recent browser_profile_open call.'),
};
const NEEDS_WORKER = new Set(['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_auth_status', 'browser_passkey_enrollment_request', 'browser_passkey_status']);
const TOOL_SCHEMAS: Record<string, z.ZodRawShape> = {
  browser_profiles_list: {},
  browser_profiles_create: { name: z.string().describe('A name for the new profile: letters, digits, spaces, "_" or "-", up to 63 characters.') },
  browser_profile_open: { profile_id: PROFILE_ID, client_id: CLIENT_ID },
  browser_profile_release: LEASE_ARGS,
  browser_navigate: { ...LEASE_ARGS, url: z.string().describe('An absolute http(s) URL. Private, loopback and cluster-internal addresses are refused.'), previous_url: z.string().optional().describe('Optional base URL used to resolve a relative url.') },
  browser_snapshot: LEASE_ARGS,
  browser_click: { ...LEASE_ARGS, selector: z.string().describe('A CSS selector for the element to click.') },
  browser_type: { ...LEASE_ARGS, selector: z.string().describe('A CSS selector for the input to type into.'), text: z.string().describe('The text to type (at most 10,000 characters).') },
  browser_auth_status: LEASE_ARGS,
  browser_passkey_enrollment_request: { ...LEASE_ARGS, rp_id: z.string().describe('The relying-party id (the site\'s registrable domain) the passkey is for.') },
  browser_passkey_status: LEASE_ARGS,
};
const TOOL_DESCRIPTIONS: Record<string, string> = {
  browser_profiles_list: 'List your browser profiles with their id, name and state. A profile must be READY before any browser tool works on it; a newly created profile takes roughly 20-60 seconds to get there (ABSENT, then STARTING, then READY).',
  browser_profiles_create: 'Create a new named, persistent browser profile that only you can use. Its browser starts automatically; poll browser_profiles_list until its state is READY.',
  browser_profile_open: 'Take exclusive control of a profile. Returns a lease with a fencingGeneration that every other browser tool needs, together with your client_id. Call it again with the same client_id to renew the lease or to recover after a "lease required or expired" error; the generation changes each time, so always use the latest one. Fails with "profile busy" if another client holds the profile.',
  browser_profile_release: 'Give up control of a profile when you are finished, so others can use it. The browser itself keeps running until it has been idle for a while.',
  browser_navigate: 'Load a URL in the profile\'s browser and return the final url (after redirects), the HTTP status, and the page title. Follow it with browser_snapshot to read the page. Each successful browser call keeps your lease alive.',
  browser_snapshot: 'Read the page currently shown in the profile\'s browser: its url, title, heading outline (a list of {level, text} for every h1-h6, in document order) and its visible text. Long pages are cut (about 20,000 characters of text, 100 headings); textTruncated and headingsTruncated say when that happened.',
  browser_click: 'Click the element matching a CSS selector on the current page.',
  browser_type: 'Type text into the element matching a CSS selector on the current page.',
  browser_auth_status: 'Report the profile\'s sign-in and passkey status without exposing any credential material.',
  browser_passkey_enrollment_request: 'Begin an administrator-supervised passkey registration ceremony for a relying party. While it is open, browser_type and browser_snapshot are refused.',
  browser_passkey_status: 'Report passkey enrollment progress and the metadata (never the keys) of passkeys stored for this profile.',
};
const SERVER_INSTRUCTIONS = 'Burrowser gives you your own persistent web browser. Typical flow: browser_profiles_list (create one with browser_profiles_create if you have none), wait until the profile is READY, browser_profile_open to get a fencingGeneration, then browser_navigate / browser_snapshot / browser_click / browser_type passing profile_id, client_id and that fencing_generation. If a call fails with "lease required or expired", call browser_profile_open again. Call browser_profile_release when you are done.';

function createSessionServer(options: McpHttpOptions): McpServer {
  const server = new McpServer({ name: 'burrowser', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  for (const name of MCP_TOOLS) {
    server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: TOOL_SCHEMAS[name] }, async (args: any) => {
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
