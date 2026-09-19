import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

type Session = { csrfToken: string; expiresAt: number };
type RequestHeaders = { cookie?: string | string[]; [key: string]: unknown };

const cookieName = '__Host-burrowser_admin';
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (left: string, right: string) => {
  const a = digest(left); const b = digest(right);
  return timingSafeEqual(a, b);
};

/** How long an admin session (and its cookie) lasts. */
export const ADMIN_SESSION_TTL_MS = 24 * 60 * 60_000;

export type AdminSession = { id: string; csrfToken: string; expiresAt: number };

export class AdminAuth {
  private readonly bootstrapToken?: string;
  private readonly ttlMs: number;
  private readonly sessions = new Map<string, Session>();

  constructor(bootstrapToken?: string, ttlMs = ADMIN_SESSION_TTL_MS) {
    this.bootstrapToken = bootstrapToken;
    this.ttlMs = ttlMs;
  }

  login(token: string, now = Date.now()): AdminSession {
    if (!this.bootstrapToken || !equal(token, this.bootstrapToken)) throw new Error('invalid admin credentials');
    const id = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const session = { csrfToken, expiresAt: now + this.ttlMs };
    this.sessions.set(id, session);
    return { id, ...session };
  }

  authenticate(headers: RequestHeaders, now = Date.now()): AdminSession | undefined {
    const cookieHeader = Array.isArray(headers.cookie) ? headers.cookie.join(';') : headers.cookie;
    const match = cookieHeader?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
    const id = match?.slice(cookieName.length + 1);
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= now) { if (session) this.sessions.delete(id); return undefined; }
    return { id, ...session };
  }

  /** Constant-time check of an `Authorization: Bearer <bootstrap token>` header (scripted/CLI admin access). */
  authenticateBootstrap(headers: RequestHeaders): boolean {
    const header = headers.authorization;
    return Boolean(this.bootstrapToken) && typeof header === 'string' && header.startsWith('Bearer ') && equal(header.slice('Bearer '.length), this.bootstrapToken as string);
  }

  requireMutation(headers: RequestHeaders, now = Date.now()): AdminSession {
    const session = this.authenticate(headers, now);
    const csrf = headers['x-csrf-token'];
    if (!session || typeof csrf !== 'string' || !equal(csrf, session.csrfToken)) throw new Error('admin session or CSRF token required');
    return session;
  }

  cookie(session: AdminSession) {
    return `${cookieName}=${session.id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.ttlMs / 1000)}`;
  }

  clearCookie() {
    return `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}
