import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { WorkerPort } from './mcp.ts';

/** Where a profile's worker serves Playwright MCP, and the credential the gateway presents to it. */
export type WorkerMcpTarget = { url: URL; credential: string };

const TOOL_CALL_TIMEOUT_MS = 300_000;
/** A worker that was stopped (shutdown, idle reclaim) and is being started again may take a cold start: wait as long as a session start does. */
const RECONNECT_RETRY_MS = 90_000;

/**
 * The only tools Burrowser adds to Playwright's own: registering a passkey with the virtual authenticator is
 * an administrator-supervised ceremony that Playwright MCP has no notion of.
 */
export const PASSKEY_TOOLS: Tool[] = [
  {
    name: 'browser_passkey_enrollment_request',
    description: 'Begin an administrator-supervised passkey registration ceremony for a relying party: call this, then complete the site\'s own "register a passkey" flow in the browser. Poll browser_passkey_status to see whether it completed.',
    inputSchema: { type: 'object', properties: { rp_id: { type: 'string', description: 'The relying-party id (the site\'s registrable domain) the passkey is for.' } }, required: ['rp_id'], additionalProperties: false },
  },
  {
    name: 'browser_passkey_status',
    description: 'Report passkey enrollment progress and the metadata (never the keys) of passkeys stored for this profile.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
const PASSKEY_TOOL_NAMES = new Set(PASSKEY_TOOLS.map(tool => tool.name));

/** Lets an agent that is finished end its own browser: Playwright MCP's browser_close only closes a page. */
export const SHUTDOWN_TOOL: Tool = {
  name: 'browser_shutdown',
  description: 'Shut this profile\'s browser down cleanly when you are completely finished with it. Chromium closes normally and the worker stops within a few seconds; cookies, logins and passkeys are kept, and the browser starts again by itself the next time any browser tool is called (which also cancels a shutdown that has not happened yet). Do not call this between steps of a task.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export type ProxyOptions = {
  target: WorkerMcpTarget;
  worker?: WorkerPort;
  /** Asks for this profile's browser to be shut down; without it browser_shutdown is not offered. */
  shutdown?: () => Promise<void>;
  /** Called before every forwarded call; throws if this session no longer holds the profile. */
  lease: { ensure(): Promise<void> };
  /** Tool names this gateway refuses to offer or run. */
  excludedTools: ReadonlySet<string>;
  /** How long to keep trying to reach a worker that went away mid-session (default 90s). */
  reconnectRetryMs?: number;
};

/** A worker that is still starting refuses connections or is not resolvable yet; anything else is a real failure. */
const workerNotUpYet = (error: unknown) => {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return error instanceof TypeError || ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT'].includes(code ?? '');
};

/**
 * Opens an MCP session to a profile's worker. A worker whose process is still coming up is retried for a bounded
 * time, since "the container started" and "the server is listening" are not the same moment.
 */
export async function connectWorkerMcp(target: WorkerMcpTarget, options: { retryMs?: number; pollMs?: number } = {}): Promise<Client> {
  const deadline = Date.now() + (options.retryMs ?? 30_000);
  for (;;) {
    const client = new Client({ name: 'burrowser-gateway', version: '0.1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(target.url, { requestInit: { headers: { authorization: `Bearer ${target.credential}` } } }), { timeout: 60_000 });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (!workerNotUpYet(error) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 1000));
    }
  }
}

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });
const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/** The worker's MCP session is in its memory: after a worker restart, open a new one and retry once. */
const lostSession = (error: unknown) => (error as { code?: number })?.code === 404 || error instanceof TypeError;

/**
 * An MCP server that is, tool for tool, the profile's Playwright MCP server. `tools/list` and `tools/call`
 * pass through to it with their arguments and results untouched; the only things this layer decides are
 * whether the caller still holds the profile and which tool names are switched off.
 */
export async function createProxyServer(options: ProxyOptions): Promise<{ server: Server; close(): Promise<void> }> {
  let upstream = await connectWorkerMcp(options.target);
  const withUpstream = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
    try { return await work(upstream); }
    catch (error) {
      if (!lostSession(error)) throw error;
      await upstream.close().catch(() => {});
      upstream = await connectWorkerMcp(options.target, { retryMs: options.reconnectRetryMs ?? RECONNECT_RETRY_MS });
      return work(upstream);
    }
  };

  const server = new Server({ name: 'burrowser', version: '0.1.0' }, { capabilities: { tools: {} }, ...(upstream.getInstructions() ? { instructions: upstream.getInstructions() } : {}) });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await withUpstream(client => client.listTools(cursor ? { cursor } : undefined));
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return { tools: [...tools, ...(options.worker ? PASSKEY_TOOLS : []), ...(options.shutdown ? [SHUTDOWN_TOOL] : [])].filter(tool => !options.excludedTools.has(tool.name)) };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    if (options.excludedTools.has(name)) return failure(`${name} is switched off on this Burrowser gateway`);
    try { await options.lease.ensure(); }
    catch (error) { return failure(error instanceof Error ? error.message : 'the profile is not available'); }

    if (name === SHUTDOWN_TOOL.name && options.shutdown) {
      try { await options.shutdown(); }
      catch (error) { return failure(error instanceof Error ? error.message : 'shutdown request failed'); }
      return { content: [{ type: 'text', text: 'Shutdown requested: the browser will close cleanly and its worker will stop within a few seconds. Your profile is kept; calling any browser tool again starts it.' }] };
    }

    if (PASSKEY_TOOL_NAMES.has(name)) {
      if (!options.worker) return failure('passkey tools are unavailable');
      try {
        if (name === 'browser_passkey_enrollment_request') return json(await options.worker.passkeyEnrollBegin(String((args as { rp_id?: unknown } | undefined)?.rp_id)));
        const [enrollment, { credentials }] = await Promise.all([options.worker.passkeyEnrollPoll(), options.worker.passkeyList()]);
        return json({ supported: true, credentials, enrollment });
      } catch (error) { return failure(error instanceof Error ? error.message : 'passkey request failed'); }
    }
    return await withUpstream(client => client.callTool(request.params, undefined, { timeout: TOOL_CALL_TIMEOUT_MS })) as CallToolResult;
  });

  return { server, close: () => upstream.close().catch(() => {}) };
}
