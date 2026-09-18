import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { createPublicKey, verify } from 'node:crypto';
import { issueAccessToken, issueInvitation, invitationVerifierHash, redeemInvitation, createEnrolledAgent, verifyEnrollmentProof, verifyAccessToken, verifyAccessTokenClaims, revokeAgent, issueChallengeFor, peekChallenge, type Store, type ChallengeStore } from './identity.ts';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { issueViewTicket, consumeViewTicket, type ViewTicketStore } from './view-tickets.ts';
import { acceptWebSocket, bridgeWebSocketToTcp } from './ws-bridge.ts';
import { serveViewPage, serveNovncAsset, serveAdminDashboardPage } from './static-assets.ts';
import { postgresRuntimeSource, inMemoryRuntimeSource, liveRuntimes, writeSnapshot, pollRuntimes, type AdminRuntime } from './admin-runtimes.ts';
import { acquireLease, createProfile, ownedProfile, releaseLease, type ProfileStore } from './profiles.ts';
import { handleMcpHttp, type McpSession } from './mcp-http.ts';
import { AdminAuth } from './admin-auth.ts';
import type { PostgresRepository } from './repository.ts';
import { createPostgresRepository } from './postgres.ts';
import { createPostgresKubernetesController } from './controller-factory.ts';
import { inClusterKubernetesOptions, KubernetesApiClient } from './kubernetes.ts';
import { postgresMcpStore } from './mcp.ts';
import type { WorkerPort } from './mcp.ts';
import type { Profile } from './profiles.ts';
import { KubernetesWorkerSecretProvider } from './worker-secrets.ts';
import { HttpWorkerClient } from './worker-client.ts';

export type AppState = Store & ProfileStore & { challenges: ChallengeStore };
export function makeState(): AppState { return { invitations: new Map(), agents: new Map(), profiles: new Map(), leases: new Map(), challenges: new Map() }; }
const json = (res: any, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
async function body(req: any) { let data = ''; for await (const chunk of req) data += chunk; if (data.length > 64 * 1024) throw new Error('request too large'); return JSON.parse(data || '{}'); }

const RATE_LIMITS: Record<string, { points: number; duration: number }> = {
  '/admin/login': { points: 10, duration: 60 },
  '/v1/identity/enroll': { points: 20, duration: 60 },
  '/v1/identity/challenge': { points: 30, duration: 60 },
  '/v1/identity/token': { points: 30, duration: 60 },
};

export function createGateway(state = makeState(), adminToken = process.env.BURROWSER_ADMIN_BOOTSTRAP, tokenSigningKey = process.env.BURROWSER_TOKEN_KEY ?? 'development-only-change-me', repository?: PostgresRepository, workerForProfile?: (profile: Profile) => Promise<WorkerPort>, viewSecretsForProfile?: (profile: Profile) => Promise<{ vncPassword: string }>, viewTargetForProfile?: (profileId: string) => { host: string; port: number }, runtimeEventIntervalMs = 2000) {
  const mcpSessions = new Map<string, McpSession>();
  const adminAuth = new AdminAuth(adminToken);
  const rateLimiters = new Map(Object.entries(RATE_LIMITS).map(([path, options]) => [path, new RateLimiterMemory(options)]));
  const viewTickets: ViewTicketStore = new Map();
  const namespace = process.env.KUBERNETES_NAMESPACE ?? 'burrowser';
  const dialTarget = viewTargetForProfile ?? (profileId => ({ host: `bw-${profileId}.${namespace}.svc`, port: 5900 }));
  const runtimeSource = repository ? postgresRuntimeSource(repository) : inMemoryRuntimeSource(state);
  const authorizeAdmin = (headers: Record<string, string | string[] | undefined>) => Boolean(adminAuth.authenticate(headers)) || Boolean(adminToken && headers.authorization === `Bearer ${adminToken}`);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'https://gateway.invalid');
      const rateLimiter = rateLimiters.get(url.pathname);
      if (rateLimiter) {
        try { await rateLimiter.consume(req.socket?.remoteAddress ?? 'unknown'); }
        catch { return json(res, 429, { error: 'rate limited' }); }
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/admin') return serveAdminDashboardPage(res);
      if (req.method === 'GET' && url.pathname === '/view') return serveViewPage(res);
      if (req.method === 'GET' && url.pathname.startsWith('/novnc/')) return serveNovncAsset(url.pathname, res);
      if (req.method === 'POST' && url.pathname === '/admin/login') {
        const input = await body(req); const session = adminAuth.login(String(input.bootstrap_token ?? ''));
        res.writeHead(204, { 'set-cookie': adminAuth.cookie(session), 'x-csrf-token': session.csrfToken, 'cache-control': 'no-store' }); res.end(); return;
      }
      if (req.method === 'POST' && url.pathname === '/admin/enrollments') {
        const session = adminAuth.authenticate(req.headers);
        const bootstrap = adminToken && req.headers.authorization === `Bearer ${adminToken}`;
        if (!session && !bootstrap) return json(res, 401, { error: 'unauthenticated' });
        if (session && !bootstrap) adminAuth.requireMutation(req.headers);
        const invitation = issueInvitation(state);
        if (repository) {
          state.invitations.delete(invitation.id);
          await repository.createInvitation(invitation.id, invitationVerifierHash(invitation.invitation), new Date(invitation.expiresAt));
        }
        return json(res, 201, invitation);
      }
      const revokeMatch = req.method === 'POST' && url.pathname.match(/^\/admin\/agents\/([^/]+)\/revoke$/);
      if (revokeMatch) {
        const session = adminAuth.authenticate(req.headers);
        const bootstrap = adminToken && req.headers.authorization === `Bearer ${adminToken}`;
        if (!session && !bootstrap) return json(res, 401, { error: 'unauthenticated' });
        if (session && !bootstrap) adminAuth.requireMutation(req.headers);
        if (repository) await repository.revokeAgent(revokeMatch[1], new Date());
        else revokeAgent(state, revokeMatch[1]);
        res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return;
      }
      if (req.method === 'GET' && url.pathname === '/admin/runtimes') {
        if (!authorizeAdmin(req.headers)) return json(res, 401, { error: 'unauthenticated' });
        return json(res, 200, { runtimes: liveRuntimes(await runtimeSource.listAdminRuntimes()) });
      }
      if (req.method === 'GET' && url.pathname === '/admin/runtimes/events') {
        if (!authorizeAdmin(req.headers)) return json(res, 401, { error: 'unauthenticated' });
        const previous = new Map<string, AdminRuntime>();
        const initial = liveRuntimes(await runtimeSource.listAdminRuntimes());
        for (const runtime of initial) previous.set(runtime.id, runtime);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        writeSnapshot(res, initial);
        const timer = setInterval(() => { pollRuntimes(runtimeSource, previous, res).catch(() => {}); }, runtimeEventIntervalMs);
        timer.unref?.();
        req.on('close', () => clearInterval(timer));
        return;
      }
      const adminViewMatch = req.method === 'POST' && url.pathname.match(/^\/admin\/profiles\/([^/]+)\/view-ticket$/);
      if (adminViewMatch) {
        const session = adminAuth.authenticate(req.headers);
        const bootstrap = adminToken && req.headers.authorization === `Bearer ${adminToken}`;
        if (!session && !bootstrap) return json(res, 401, { error: 'unauthenticated' });
        if (session && !bootstrap) adminAuth.requireMutation(req.headers);
        const profile = repository ? (await repository.listControllerProfiles()).find(candidate => candidate.id === adminViewMatch[1]) : state.profiles.get(adminViewMatch[1]);
        if (!profile) throw new Error('profile not found');
        if (!viewSecretsForProfile) throw new Error('live view unavailable');
        const { vncPassword } = await viewSecretsForProfile(profile);
        const ticket = issueViewTicket(viewTickets, profile.id, `admin:${session?.id ?? 'bootstrap'}`);
        return json(res, 200, { ticket, vnc_password: vncPassword, expires_in: 30 });
      }
      const adminThumbnailMatch = req.method === 'GET' && url.pathname.match(/^\/admin\/profiles\/([^/]+)\/thumbnail$/);
      if (adminThumbnailMatch) {
        if (!authorizeAdmin(req.headers)) return json(res, 401, { error: 'unauthenticated' });
        const profile = repository ? (await repository.listControllerProfiles()).find(candidate => candidate.id === adminThumbnailMatch[1]) : state.profiles.get(adminThumbnailMatch[1]);
        if (!profile) throw new Error('profile not found');
        if (!workerForProfile) throw new Error('live view unavailable');
        const worker = await workerForProfile(profile);
        const { image, contentType } = await worker.thumbnail();
        res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
        res.end(Buffer.from(image, 'base64'));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/identity/enroll') {
        const input = await body(req);
        if (!repository) {
          const agent = redeemInvitation(state, input);
          return json(res, 201, { agent_id: agent.id, display_name: agent.displayName });
        }
        verifyEnrollmentProof(input);
        const agent = createEnrolledAgent(input);
        const persisted = await repository.redeemInvitation(input.id, invitationVerifierHash(input.invitation), new Date(), agent);
        return json(res, 201, { agent_id: persisted.id, display_name: persisted.displayName });
      }
      if (req.method === 'POST' && url.pathname === '/v1/identity/challenge') { const input = await body(req); const challenge = issueChallengeFor(state.challenges, input.agent_id); return json(res, 200, { challenge }); }
      if (req.method === 'POST' && url.pathname === '/v1/identity/token') {
        const input = await body(req); const challenge = peekChallenge(state.challenges, input.agent_id);
        const agent = repository ? await repository.findAgent(input.agent_id) : state.agents.get(input.agent_id); if (!agent) throw new Error('invalid identity');
        const key = createPublicKey({ key: Buffer.from(agent.publicKey, 'base64url'), format: 'der', type: 'spki' });
        if (!verify(null, Buffer.from(challenge), key, Buffer.from(input.proof, 'base64url'))) throw new Error('invalid identity proof');
        const token = issueAccessToken(agent, challenge, tokenSigningKey);
        state.challenges.delete(input.agent_id); return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 900 });
      }
      const auth = req.headers.authorization?.replace(/^Bearer /, '');
      if (!auth) return json(res, 401, { error: 'unauthenticated' });
      const challenge = (req.headers['x-agent-challenge'] as string) ?? '';
      const claims = repository ? verifyAccessTokenClaims(auth, challenge, tokenSigningKey) : undefined;
      const agent = repository ? await repository.findAgent(claims!.sub) : verifyAccessToken(state, auth, challenge, tokenSigningKey);
      if (!agent || agent.revokedAt) throw new Error('invalid token');
      if (url.pathname === '/mcp') {
        return handleMcpHttp(req, res, { store: repository ? postgresMcpStore(repository) : state, agent, sessions: mcpSessions, workerForProfile, allowedOrigins: process.env.BURROWSER_ALLOWED_ORIGIN ? [process.env.BURROWSER_ALLOWED_ORIGIN] : undefined });
      }
      if (req.method === 'GET' && url.pathname === '/v1/profiles') return json(res, 200, { profiles: repository ? await repository.listProfiles(agent.id) : [...state.profiles.values()].filter(p => p.agentId === agent.id) });
      if (req.method === 'POST' && url.pathname === '/v1/profiles') {
        const input = await body(req);
        if (!repository) return json(res, 201, createProfile(state, agent, input.name));
        const profile = createProfile({ profiles: new Map(), leases: new Map() }, agent, input.name);
        return json(res, 201, await repository.createProfile(profile));
      }
      const match = url.pathname.match(/^\/v1\/profiles\/([^/]+)\/(acquire|release)$/);
      if (match) {
        const input = await body(req);
        if (repository) {
          const profile = (await repository.listProfiles(agent.id)).find(candidate => candidate.id === match[1]);
          if (!profile) throw new Error('profile not found');
          if (match[2] === 'acquire') return json(res, 200, await repository.acquireLease(profile.id, agent.id, input.client_id, new Date()));
          await repository.releaseLease(profile.id, input.client_id, input.fencing_generation, new Date()); return json(res, 204, {});
        }
        const profile = ownedProfile(state, agent.id, match[1]);
        if (match[2] === 'acquire') return json(res, 200, acquireLease(state, profile, input.client_id));
        releaseLease(state, profile.id, input.client_id, input.fencing_generation); return json(res, 204, {});
      }
      const viewMatch = req.method === 'POST' && url.pathname.match(/^\/v1\/profiles\/([^/]+)\/view-ticket$/);
      if (viewMatch) {
        const profile = repository ? (await repository.listProfiles(agent.id)).find(candidate => candidate.id === viewMatch[1]) : ownedProfile(state, agent.id, viewMatch[1]);
        if (!profile) throw new Error('profile not found');
        if (!viewSecretsForProfile) throw new Error('live view unavailable');
        const { vncPassword } = await viewSecretsForProfile(profile);
        const ticket = issueViewTicket(viewTickets, profile.id, agent.id);
        return json(res, 200, { ticket, vnc_password: vncPassword, expires_in: 30 });
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) { const message = error instanceof Error ? error.message : 'request failed'; const status = message.includes('busy') ? 409 : message.includes('too many') ? 429 : message.includes('unauthenticated') || message.includes('token') || message.includes('proof') ? 401 : 400; json(res, status, { error: message }); }
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'https://gateway.invalid');
    const match = url.pathname.match(/^\/v1\/profiles\/([^/]+)\/view$/);
    const ticket = url.searchParams.get('ticket');
    if (!match || !ticket || !consumeViewTicket(viewTickets, ticket, match[1])) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const target = netConnect(dialTarget(match[1]));
    target.once('error', () => { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); socket.destroy(); });
    target.once('connect', () => {
      acceptWebSocket(req, socket, head).then(ws => bridgeWebSocketToTcp(ws, target));
    });
  });
  return server;
}

async function startProductionGateway() {
  const database = process.env.DATABASE_URL ? createPostgresRepository() : undefined;
  let workerForProfile: ((profile: Profile) => Promise<WorkerPort>) | undefined;
  let viewSecretsForProfile: ((profile: Profile) => Promise<{ vncPassword: string }>) | undefined;
  let controller: ReturnType<typeof createPostgresKubernetesController> | undefined;
  if (database && process.env.KUBERNETES_SERVICE_HOST) {
    const kube = new KubernetesApiClient(inClusterKubernetesOptions());
    const workerImage = process.env.BURROWSER_WORKER_IMAGE;
    if (!workerImage) throw new Error('BURROWSER_WORKER_IMAGE is required when PostgreSQL is enabled');
    const secrets = new KubernetesWorkerSecretProvider(kube);
    workerForProfile = async profile => new HttpWorkerClient(profile.id, (await secrets.ensure(profile)).controllerCredential);
    viewSecretsForProfile = async profile => secrets.ensure(profile);
    controller = createPostgresKubernetesController(database.repository, kube, workerImage);
  }
  const server = createGateway(makeState(), undefined, undefined, database?.repository, workerForProfile, viewSecretsForProfile);
  server.listen(Number(process.env.PORT ?? 8080));
  if (controller) {
    controller.start();
    server.on('close', () => controller.stop());
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startProductionGateway().catch(error => {
    console.error(error instanceof Error ? error.message : 'gateway startup failed');
    process.exitCode = 1;
  });
}
