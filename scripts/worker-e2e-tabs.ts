#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
// Talks to a worker's /mcp endpoint (see worker-e2e.sh): opens extra tabs, closes every tab, and checks the
// browser is left with exactly one usable blank tab and no errors. Exits 1 if any round is not clean.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [port, credential, roundsArg = '6'] = process.argv.slice(2);
if (!port || !credential) { console.error('usage: worker-e2e-tabs.ts PORT CREDENTIAL [ROUNDS]'); process.exit(2); }
const url = new URL(`http://127.0.0.1:${port}/mcp`);

async function session<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'worker-e2e', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${credential}` } } }));
  try { return await work(client); } finally { await client.close().catch(() => {}); }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = ((result.content ?? []) as Array<{ text?: string }>).map(part => part.text ?? '').join('\n');
    return { error: result.isError ? text.split('\n').find(line => /error/i.test(line)) ?? 'tool error' : undefined, text };
  } catch (error) { return { error: `threw: ${error instanceof Error ? error.message : error}`, text: '' }; }
}
const tabs = (text: string) => text.split('\n').filter(line => /^- \d+:/.test(line));

let failures = 0;
for (let round = 1; round <= Number(roundsArg); round++) {
  const closed = await session(async client => {
    await call(client, 'browser_tabs', { action: 'list' });
    await call(client, 'browser_tabs', { action: 'new' });
    await call(client, 'browser_tabs', { action: 'new' });
    const before = tabs((await call(client, 'browser_tabs', { action: 'list' })).text).length;
    let closeError: string | undefined;
    for (let index = before - 1; index >= 0; index--) closeError ??= (await call(client, 'browser_tabs', { action: 'close', index })).error;
    const after = await call(client, 'browser_tabs', { action: 'list' });
    return { before, closeError, afterError: after.error, afterTabs: tabs(after.text).length };
  });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const settled = await session(async client => {
    const listed = await call(client, 'browser_tabs', { action: 'list' });
    const navigated = await call(client, 'browser_navigate', { url: 'about:blank' });
    return { error: listed.error ?? navigated.error, tabs: tabs(listed.text).length };
  });
  const problems = [
    closed.closeError && `closing: ${closed.closeError}`,
    closed.afterError && `call right after closing: ${closed.afterError}`,
    closed.afterTabs !== 1 && `${closed.afterTabs} tabs right after closing all (want 1)`,
    settled.error && `browser unusable afterwards: ${settled.error}`,
    settled.tabs !== 1 && `${settled.tabs} tabs later (want 1)`,
  ].filter(Boolean);
  if (problems.length) failures++;
  console.log(`  round ${round}: ${closed.before} tabs closed -> ${problems.length ? `FAIL (${problems.join('; ')})` : 'one blank tab, no errors'}`);
}
process.exit(failures ? 1 : 0);
