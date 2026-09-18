import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

type Session = { transport: StreamableHTTPServerTransport; server: Server };

/** More than this and the oldest session is closed; a healthy gateway holds one at a time. */
export const MAX_MCP_SESSIONS = 8;

const notFound = (res: any) => { res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'session not found' } })); };
const badRequest = (res: any) => { res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'no valid session ID provided' } })); };

/**
 * Serves MCP over Streamable HTTP. Each new session gets its own server from `createServer` (for
 * Burrowser: Playwright MCP bound to the profile's one persistent browser context), so this is a thin
 * session table and nothing more: the tools, their schemas and their results are Playwright's own.
 */
export function createMcpEndpoint(createServer: () => Promise<Server>) {
  const sessions = new Map<string, Session>();

  return async function handleMcp(req: any, res: any): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId);
      if (!session) return notFound(res);
      return session.transport.handleRequest(req, res);
    }
    if (req.method !== 'POST') return badRequest(res);

    while (sessions.size >= MAX_MCP_SESSIONS) {
      const [oldestId, oldest] = sessions.entries().next().value as [string, Session];
      sessions.delete(oldestId);
      await oldest.transport.close().catch(() => {});
    }
    const server = await createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => { sessions.set(id, { transport, server }); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
