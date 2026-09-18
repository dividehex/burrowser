import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { authorizeWorkerRequest, validateRpcMethod } from './rpc.ts';
import { persistCredentials, restoreCredentials, type CredentialContext } from './credentials.ts';
import { beginEnrollment, pollEnrollment, type EnrollmentState } from './enrollment.ts';

const credential = process.env.WORKER_CONTROLLER_CREDENTIAL;
if (!credential) throw new Error('WORKER_CONTROLLER_CREDENTIAL is required');
let context: BrowserContext | undefined;
let page: Page | undefined;
let enrollment: EnrollmentState | undefined;
const credentialPath = '/profile/authenticator/credentials.enc';
const credentialKey = process.env.AGENT_BROWSER_AUTHENTICATOR_KEY ? Buffer.from(process.env.AGENT_BROWSER_AUTHENTICATOR_KEY, 'base64url') : undefined;

async function browserPage() {
  if (!context) {
    mkdirSync('/profile/chromium', { recursive: true });
    mkdirSync('/profile/authenticator', { recursive: true });
    context = await chromium.launchPersistentContext('/profile/chromium', { headless: false, chromiumSandbox: true, args: ['--window-size=1280,900'] });
    await restoreCredentials(context as unknown as CredentialContext, credentialPath, credentialKey);
    page = await context.newPage();
  }
  return page!;
}
async function readBody(req: any) { let value = ''; for await (const chunk of req) value += chunk; if (value.length > 64 * 1024) throw new Error('request too large'); return JSON.parse(value || '{}'); }
const reply = (res: any, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };

export const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/rpc' || !authorizeWorkerRequest(req.headers, credential)) return reply(res, 404, { error: 'not_found' });
    const input = await readBody(req); const method = validateRpcMethod(input.method); const activePage = await browserPage();
    const credentialsApi = (context as unknown as CredentialContext).credentials!;
    if ((method === 'type' || method === 'snapshot') && enrollment && Date.now() < enrollment.expiresAt) return reply(res, 409, { error: 'text entry and snapshots are restricted during passkey enrollment' });
    if (method === 'navigate') { const url = await activePage.goto(input.url, { waitUntil: 'domcontentloaded' }).then(() => activePage.url()); await persistCredentials(context as unknown as CredentialContext, credentialPath, credentialKey); return reply(res, 200, { url }); }
    if (method === 'snapshot') { const text = await activePage.locator('body').innerText({ timeout: 5000 }); await persistCredentials(context as unknown as CredentialContext, credentialPath, credentialKey); return reply(res, 200, { text }); }
    if (method === 'click') { const result = await activePage.locator(String(input.selector)).click(); await persistCredentials(context as unknown as CredentialContext, credentialPath, credentialKey); return reply(res, 200, { ok: true, result }); }
    if (method === 'type') { const result = await activePage.locator(String(input.selector)).fill(String(input.text).slice(0, 10_000)); await persistCredentials(context as unknown as CredentialContext, credentialPath, credentialKey); return reply(res, 200, { ok: true, result }); }
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
      if (result.status === 'completed') await persistCredentials(context as unknown as CredentialContext, credentialPath, credentialKey);
      return reply(res, 200, result);
    }
    if (method === 'passkeyList') {
      const all = await credentialsApi.get();
      return reply(res, 200, { credentials: all.map(({ id, rpId, userHandle }) => ({ id, rpId, userHandle })) });
    }
    if (method === 'thumbnail') {
      const buffer = await activePage.screenshot({ type: 'jpeg', quality: 60 });
      return reply(res, 200, { image: buffer.toString('base64'), contentType: 'image/jpeg' });
    }
    await persistCredentials(context as unknown as CredentialContext, credentialPath, credentialKey);
    return reply(res, 200, { authenticated: false });
  } catch (error) { reply(res, 400, { error: error instanceof Error ? error.message : 'request failed' }); }
});

async function shutdown() {
  server.close();
  let failure: unknown;
  try { if (context) await persistCredentials(context as unknown as CredentialContext, credentialPath, credentialKey); }
  catch (error) { failure = error; console.error('credential persistence failed during shutdown'); }
  finally { if (context) await context.close(); }
  process.exit(failure ? 1 : 0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

if (import.meta.url === `file://${process.argv[1]}`) server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
