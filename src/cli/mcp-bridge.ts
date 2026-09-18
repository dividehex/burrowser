import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parse } from './args.ts';
import { AgentSession, GatewayClient, warnIfInsecure } from './gateway.ts';
import { loadIdentity } from './identity-store.ts';

const TOOL_CALL_TIMEOUT_MS = 300_000;
/** Starting a session may wait for a stopped profile's browser to come back (about a minute at worst). */
const CONNECT_TIMEOUT_MS = 180_000;
const PROFILE_HEADER = 'x-burrowser-profile';

/**
 * A stdio MCP server that IS the chosen profile's Playwright MCP server: tools/list and tools/call are forwarded
 * to the gateway unchanged. It authenticates as the chosen identity (refreshing short-lived tokens per request),
 * creates the profile on first use, and leaves everything else - leases, waiting for the browser to start - to the
 * gateway, so an MCP client (Claude Code, OpenCode, ...) sees exactly the tools Playwright offers and nothing else.
 */
export async function mcpCommand(argv: string[]) {
  const { values } = parse({ args: argv, strict: true, options: { identity: { type: 'string' }, profile: { type: 'string' } } });
  const identity = await loadIdentity((values.identity as string | undefined) ?? process.env.BURROWSER_IDENTITY);
  const profileName = (values.profile as string | undefined) ?? identity.displayName;
  warnIfInsecure(identity.url, 'MCP traffic and credentials are sent');
  const gateway = new GatewayClient(identity.url);
  const session = new AgentSession(identity, gateway);

  const findOrCreateProfile = async (): Promise<string> => {
    const headers = await session.headers();
    const { profiles } = await gateway.json<{ profiles: Array<{ id: string; name: string }> }>('GET', '/v1/profiles', { headers });
    const existing = profiles.find(profile => profile.name === profileName);
    if (existing) return existing.id;
    console.error(`burrowser: creating profile "${profileName}"`);
    return (await gateway.json<{ id: string }>('POST', '/v1/profiles', { headers, body: { name: profileName } })).id;
  };

  type Upstream = { client: Client; transport: StreamableHTTPClientTransport };
  const connectUpstream = async (): Promise<Upstream> => {
    const profileId = await findOrCreateProfile();
    const authedFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(await session.headers())) headers.set(name, value);
      headers.set(PROFILE_HEADER, profileId);
      return fetch(input, { ...init, headers });
    };
    const client = new Client({ name: 'burrowser-bridge', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', identity.url), { fetch: authedFetch });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return { client, transport };
  };
  /** Ends the gateway session, which releases the profile's lease immediately rather than when it lapses. */
  const closeUpstream = async (upstream: Upstream | undefined) => {
    await upstream?.transport.terminateSession().catch(() => {});
    await upstream?.client.close().catch(() => {});
  };

  // Connect on first use rather than at startup, so the MCP client's own startup timeout is never spent
  // waiting for a cold browser.
  let upstream: Promise<Upstream> | undefined;
  const getUpstream = () => upstream ??= connectUpstream().catch(error => { upstream = undefined; throw error; });
  // Gateway MCP sessions live in the controller's memory; if it restarted, open a fresh one and retry once.
  const withUpstream = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
    try { return await work((await getUpstream()).client); }
    catch (error) {
      if ((error as { code?: number }).code !== 404) throw error;
      const stale = await upstream; upstream = undefined;
      await closeUpstream(stale);
      return work((await getUpstream()).client);
    }
  };

  const server = new Server({ name: 'burrowser', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, request => withUpstream(client => client.listTools(request.params)));
  server.setRequestHandler(CallToolRequestSchema, request => withUpstream(client => client.callTool(request.params, undefined, { timeout: TOOL_CALL_TIMEOUT_MS })) as Promise<any>);
  const shutdown = () => { Promise.resolve(upstream).then(closeUpstream).catch(() => {}).finally(() => process.exit(0)); };
  server.onclose = shutdown;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, shutdown);
  await server.connect(new StdioServerTransport());
  console.error(`burrowser MCP bridge ready as "${identity.displayName}", profile "${profileName}" -> ${identity.url}`);
}
