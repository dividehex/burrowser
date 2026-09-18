import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parse } from './args.ts';
import { AgentSession, GatewayClient, warnIfInsecure } from './gateway.ts';
import { loadIdentity, type Identity } from './identity-store.ts';

const TOOL_CALL_TIMEOUT_MS = 120_000;

/**
 * Connects to the gateway's Streamable HTTP MCP endpoint as the given agent. Every request carries
 * freshly-checked credentials, so a long-running bridge outlives the 15-minute access token.
 */
async function connectUpstream(identity: Identity, session: AgentSession) {
  const authedFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(await session.headers())) headers.set(name, value);
    return fetch(input, { ...init, headers });
  };
  const client = new Client({ name: 'burrowser-bridge', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', identity.url), { fetch: authedFetch }));
  return client;
}

/**
 * A stdio MCP server that forwards tools/list and tools/call to the gateway, authenticating as the
 * chosen identity. MCP clients (Claude Code, OpenCode, ...) launch this as a subprocess, so they
 * never see the agent's key or have to manage short-lived tokens.
 */
export async function mcpCommand(argv: string[]) {
  const { values } = parse({ args: argv, strict: true, options: { identity: { type: 'string' } } });
  const identity = await loadIdentity((values.identity as string | undefined) ?? process.env.BURROWSER_IDENTITY);
  warnIfInsecure(identity.url, 'MCP traffic and credentials are sent');
  const session = new AgentSession(identity, new GatewayClient(identity.url));
  let upstream = await connectUpstream(identity, session);

  // Gateway MCP sessions live in the controller's memory; if it restarted, open a fresh one and retry once.
  const withUpstream = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
    try { return await work(upstream); }
    catch (error) {
      if ((error as { code?: number }).code !== 404) throw error;
      await upstream.close().catch(() => {});
      upstream = await connectUpstream(identity, session);
      return work(upstream);
    }
  };

  const server = new Server({ name: 'burrowser', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: upstream.getInstructions() });
  server.setRequestHandler(ListToolsRequestSchema, () => withUpstream(client => client.listTools()));
  server.setRequestHandler(CallToolRequestSchema, request => withUpstream(client => client.callTool(request.params, undefined, { timeout: TOOL_CALL_TIMEOUT_MS })) as Promise<any>);
  server.onclose = () => { upstream.close().catch(() => {}).finally(() => process.exit(0)); };
  await server.connect(new StdioServerTransport());
  console.error(`burrowser MCP bridge ready as "${identity.displayName}" -> ${identity.url}`);
}
