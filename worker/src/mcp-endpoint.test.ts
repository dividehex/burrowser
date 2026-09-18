import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpEndpoint, MAX_MCP_SESSIONS } from './mcp-endpoint.ts';

/** Stands in for Playwright MCP: any MCP server will do, since the endpoint only manages sessions. */
async function echoServer() {
  const server = new Server({ name: 'fake-playwright', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'browser_navigate', description: 'go', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: `at ${(request.params.arguments as any).url}` }] }));
  return server;
}

async function listening(handler: (req: any, res: any) => Promise<void>) {
  const http = createServer((req, res) => { handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return { http, url: new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp`) };
}

test('each MCP client gets its own session on the served server, and its calls reach that server unchanged', async () => {
  let created = 0;
  const { http, url } = await listening(createMcpEndpoint(async () => { created++; return echoServer(); }));
  try {
    const a = new Client({ name: 'a', version: '1' }); const b = new Client({ name: 'b', version: '1' });
    await a.connect(new StreamableHTTPClientTransport(url)); await b.connect(new StreamableHTTPClientTransport(url));
    assert.equal(created, 2);
    assert.deepEqual((await a.listTools()).tools.map(tool => tool.name), ['browser_navigate']);
    const result: any = await b.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com/' } });
    assert.equal(result.content[0].text, 'at https://example.com/');
    await a.close(); await b.close();
  } finally { http.close(); }
});

test('an unknown session id is a 404 and a sessionless non-POST is a 400', async () => {
  const { http, url } = await listening(createMcpEndpoint(async () => echoServer()));
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'mcp-session-id': 'nope', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })).status, 404);
    assert.equal((await fetch(url, { method: 'GET' })).status, 400);
  } finally { http.close(); }
});

test('the oldest session is closed once too many are open', async () => {
  const { http, url } = await listening(createMcpEndpoint(async () => echoServer()));
  const clients: Client[] = [];
  try {
    for (let i = 0; i < MAX_MCP_SESSIONS + 1; i++) { const client = new Client({ name: `c${i}`, version: '1' }); await client.connect(new StreamableHTTPClientTransport(url)); clients.push(client); }
    await assert.rejects(() => clients[0].listTools(), 'the first session was evicted to make room');
    assert.equal((await clients.at(-1)!.listTools()).tools.length, 1, 'the newest session is fine');
  } finally { await Promise.all(clients.map(client => client.close().catch(() => {}))); http.close(); }
});
