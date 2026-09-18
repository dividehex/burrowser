import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { chromium, type BrowserContext } from 'playwright';
import { createConnection } from '@playwright/mcp';
import { authorizeWorkerRequest, validateRpcMethod } from './rpc.ts';
import { persistCredentials, restoreCredentials, type CredentialContext } from './credentials.ts';
import { beginEnrollment, pollEnrollment, type EnrollmentState } from './enrollment.ts';
import { createMcpEndpoint } from './mcp-endpoint.ts';

const credential = process.env.WORKER_CONTROLLER_CREDENTIAL;
if (!credential) throw new Error('WORKER_CONTROLLER_CREDENTIAL is required');
let contextPromise: Promise<BrowserContext> | undefined;
let enrollment: EnrollmentState | undefined;
const credentialPath = '/profile/authenticator/credentials.enc';
const credentialKey = process.env.BURROWSER_AUTHENTICATOR_KEY ? Buffer.from(process.env.BURROWSER_AUTHENTICATOR_KEY, 'base64url') : undefined;
/** Playwright MCP's own tool groups; "core" is what a stock Playwright MCP server offers. */
const mcpCapabilities = (process.env.BURROWSER_MCP_CAPS ?? 'core').split(',').map(value => value.trim()).filter(Boolean);

const credentialsOf = (context: BrowserContext) => context as unknown as CredentialContext;

/** The profile's one persistent browser: launched on first use, and shared by Playwright MCP, the passkey RPCs and the live view. */
function browserContext(): Promise<BrowserContext> {
  contextPromise ??= (async () => {
    mkdirSync('/profile/chromium', { recursive: true });
    mkdirSync('/profile/authenticator', { recursive: true });
    const context = await chromium.launchPersistentContext('/profile/chromium', { headless: false, chromiumSandbox: true, args: ['--window-size=1280,900'] });
    await restoreCredentials(credentialsOf(context), credentialPath, credentialKey);
    await context.newPage();
    return context;
  })().catch(error => { contextPromise = undefined; throw error; });
  return contextPromise;
}

// Passkeys can change whenever a page uses the authenticator, and Playwright MCP drives pages without
// telling us, so save whenever the set has changed (plus at enrollment completion and shutdown).
let lastPersisted = '';
async function persistIfChanged() {
  if (!contextPromise) return;
  const context = await contextPromise;
  const fingerprint = JSON.stringify(await credentialsOf(context).credentials!.get());
  if (fingerprint === lastPersisted) return;
  await persistCredentials(credentialsOf(context), credentialPath, credentialKey);
  lastPersisted = fingerprint;
}
setInterval(() => { persistIfChanged().catch(() => console.error('credential persistence failed; will retry')); }, 15_000).unref();

const mcpEndpoint = createMcpEndpoint(() => createConnection({ capabilities: mcpCapabilities as any, outputDir: '/tmp/mcp-output', outputMaxSize: 64 * 1024 * 1024 }, browserContext));

async function readBody(req: any) { let value = ''; for await (const chunk of req) value += chunk; if (value.length > 64 * 1024) throw new Error('request too large'); return JSON.parse(value || '{}'); }
const reply = (res: any, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };

export const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { status: 'ok' });
    if (!authorizeWorkerRequest(req.headers, credential)) return reply(res, 404, { error: 'not_found' });
    if (req.url === '/mcp') return await mcpEndpoint(req, res);
    if (req.method !== 'POST' || req.url !== '/rpc') return reply(res, 404, { error: 'not_found' });

    const input = await readBody(req); const method = validateRpcMethod(input.method);
    const context = await browserContext(); const credentialsApi = credentialsOf(context).credentials!;
    if (method === 'passkeyEnrollBegin') {
      const rpId = String(input.rpId);
      const existing = (await credentialsApi.get({ rpId })).map(c => c.id);
      enrollment = beginEnrollment(rpId, existing, Date.now());
      return reply(res, 200, { status: 'awaiting_ceremony', rpId: enrollment.rpId, expiresAt: enrollment.expiresAt });
    }
    if (method === 'passkeyEnrollPoll') {
      const current = enrollment ? (await credentialsApi.get({ rpId: enrollment.rpId })).map(c => c.id) : [];
      const { result, next } = pollEnrollment(enrollment, current, Date.now());
      enrollment = next;
      if (result.status === 'completed') await persistIfChanged();
      return reply(res, 200, result);
    }
    if (method === 'passkeyList') {
      const all = await credentialsApi.get();
      return reply(res, 200, { credentials: all.map(({ id, rpId, userHandle }) => ({ id, rpId, userHandle })) });
    }
    // thumbnail: the tab most recently opened, which is the one an agent is working in
    const pages = context.pages().filter(candidate => !candidate.isClosed());
    const page = pages.at(-1) ?? await context.newPage();
    const buffer = await page.screenshot({ type: 'jpeg', quality: 60 });
    return reply(res, 200, { image: buffer.toString('base64'), contentType: 'image/jpeg' });
  } catch (error) { if (!res.headersSent) reply(res, 400, { error: error instanceof Error ? error.message : 'request failed' }); }
});

async function shutdown() {
  server.close();
  let failure: unknown;
  try { if (contextPromise) await persistCredentials(credentialsOf(await contextPromise), credentialPath, credentialKey); }
  catch (error) { failure = error; console.error('credential persistence failed during shutdown'); }
  finally { if (contextPromise) await (await contextPromise).close(); }
  process.exit(failure ? 1 : 0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

if (import.meta.url === `file://${process.argv[1]}`) server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
