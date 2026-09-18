import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpEndpoint } from '../../worker/src/mcp-endpoint.ts';
import { authorizeWorkerRequest } from '../../worker/src/rpc.ts';

export const WORKER_CREDENTIAL = 'worker-secret';

/** Tool definitions shaped like Playwright MCP's, so tests can check they pass through untouched. */
export const FAKE_TOOLS = [
  { name: 'browser_navigate', description: 'Navigate to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to navigate to' } }, required: ['url'], additionalProperties: false } },
  { name: 'browser_snapshot', description: 'Capture accessibility snapshot of the current page', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'browser_take_screenshot', description: 'Take a screenshot', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'browser_evaluate', description: 'Evaluate JavaScript', inputSchema: { type: 'object', properties: { function: { type: 'string' } }, required: ['function'] } },
  { name: 'browser_boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
];
export const SNAPSHOT_TEXT = '### Snapshot\n```yaml\n- link "Learn more" [ref=e6]\n```';
export const SCREENSHOT = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' } as const;

/** A stand-in for a profile's worker: serves an MCP server on /mcp behind the same bearer check the real one uses. */
export async function startFakePlaywrightWorker(port = 0) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const build = async () => {
    const server = new Server({ name: 'fake-playwright', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FAKE_TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args } = request.params;
      calls.push({ name, args });
      if (name === 'browser_navigate') return { content: [{ type: 'text', text: `### Page\n- Page URL: ${(args as any).url}` }] };
      if (name === 'browser_snapshot') return { content: [{ type: 'text', text: SNAPSHOT_TEXT }] };
      if (name === 'browser_take_screenshot') return { content: [{ type: 'text', text: 'shot' }, SCREENSHOT] };
      if (name === 'browser_evaluate') return { content: [{ type: 'text', text: 'evaluated' }] };
      return { isError: true, content: [{ type: 'text', text: 'page.goto: net::ERR_NAME_NOT_RESOLVED' }] };
    });
    return server;
  };
  let endpoint = createMcpEndpoint(build);
  const http = createServer((req, res) => {
    if (req.url !== '/mcp' || !authorizeWorkerRequest(req.headers, WORKER_CREDENTIAL)) { res.writeHead(404); res.end(); return; }
    endpoint(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => http.listen(port, '127.0.0.1', resolve));
  return {
    target: { url: new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp`), credential: WORKER_CREDENTIAL },
    calls,
    /** Forget every session, as a restarted worker would. */
    restart() { endpoint = createMcpEndpoint(build); },
    close: () => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }),
  };
}
