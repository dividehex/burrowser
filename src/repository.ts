import type { Agent } from './identity.ts';
import type { Lease, Profile } from './profiles.ts';
import type { AdminRuntime } from './admin-runtimes.ts';

export type QueryResult<Row = Record<string, unknown>> = { rows: Row[]; rowCount?: number };
export type DbClient = {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
  release(): void;
};
export type DbPool = { connect(): Promise<DbClient> };

type InvitationRow = { id: string; expires_at: Date | string; consumed_at: Date | string | null };
type AgentRow = { id: string; display_name: string; public_key: Buffer | string; revoked_at: Date | string | null };
type ProfileRow = { id: string; agent_id: string; name: string; pvc_name: string; state: string; created_at: Date | string; last_used_at: Date | string };
type LeaseRow = { profile_id: string; owner_client_id: string; fencing_generation: number | string; expires_at: Date | string };

const timestamp = (value: Date | string) => value instanceof Date ? value.getTime() : Date.parse(value);
const publicKey = (value: Buffer | string) => Buffer.isBuffer(value) ? value.toString('base64url') : Buffer.from(value, 'binary').toString('base64url');
const agentFromRow = (row: AgentRow): Agent => ({ id: row.id, displayName: row.display_name, publicKey: publicKey(row.public_key), ...(row.revoked_at ? { revokedAt: timestamp(row.revoked_at) } : {}) });
const profileFromRow = (row: ProfileRow): Profile => ({ id: row.id, agentId: row.agent_id, name: row.name, pvcName: row.pvc_name, state: row.state, createdAt: timestamp(row.created_at), lastUsedAt: timestamp(row.last_used_at) });
const leaseFromRow = (row: LeaseRow): Lease => ({ profileId: row.profile_id, ownerClientId: row.owner_client_id, fencingGeneration: Number(row.fencing_generation), expiresAt: timestamp(row.expires_at) });

export type NewAgent = { id: string; displayName: string; publicKey: string };
export type NewProfile = { id: string; agentId: string; name: string; pvcName: string; state: string; createdAt: Date | number; lastUsedAt: Date | number };

export class PostgresRepository {
  private readonly pool: DbPool;

  constructor(pool: DbPool) {
    this.pool = pool;
  }

  private async transaction<T>(work: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original database error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async redeemInvitation(invitationId: string, verifierHash: string, now: Date, agent: NewAgent): Promise<Agent>;
  async redeemInvitation(invitationId: string, now: Date, agent: NewAgent): Promise<Agent>;
  async redeemInvitation(invitationId: string, verifierHashOrNow: string | Date, nowOrAgent: Date | NewAgent, maybeAgent?: NewAgent): Promise<Agent> {
    const verifierHash = typeof verifierHashOrNow === 'string' ? verifierHashOrNow : undefined;
    const now = typeof verifierHashOrNow === 'string' ? nowOrAgent as Date : verifierHashOrNow;
    const agent = typeof verifierHashOrNow === 'string' ? maybeAgent as NewAgent : nowOrAgent as NewAgent;
    return this.transaction(async client => {
      const invitationQuery = verifierHash
        ? ['SELECT id, expires_at, consumed_at FROM enrollment_invitations WHERE id = $1 AND verifier_hash = $2 FOR UPDATE', [invitationId, Buffer.from(verifierHash, 'hex')] as readonly unknown[]]
        : ['SELECT id, expires_at, consumed_at FROM enrollment_invitations WHERE id = $1 FOR UPDATE', [invitationId] as readonly unknown[]];
      const invitation = (await client.query<InvitationRow>(invitationQuery[0] as string, invitationQuery[1])).rows[0];
      if (!invitation || invitation.consumed_at || timestamp(invitation.expires_at) <= now.getTime()) throw new Error('invalid or consumed invitation');

      const row = (await client.query<AgentRow>(
        'INSERT INTO agents (id, display_name, public_key) VALUES ($1, $2, $3) RETURNING id, display_name, public_key, revoked_at',
        [agent.id, agent.displayName, Buffer.from(agent.publicKey, 'base64url')],
      )).rows[0];
      await client.query(
        'UPDATE enrollment_invitations SET consumed_at = $2, assigned_agent_id = $3 WHERE id = $1',
        [invitationId, now, agent.id],
      );
      if (!row) throw new Error('agent creation failed');
      return agentFromRow(row);
    });
  }

  async createInvitation(id: string, verifierHash: string, expiresAt: Date): Promise<void> {
    await this.poolQuery(
      'INSERT INTO enrollment_invitations (id, verifier_hash, expires_at) VALUES ($1, $2, $3)',
      [id, Buffer.from(verifierHash, 'hex'), expiresAt],
    );
  }

  async findAgent(id: string): Promise<Agent | undefined> {
    const row = (await this.poolQuery<AgentRow>(
      'SELECT id, display_name, public_key, revoked_at FROM agents WHERE id = $1', [id],
    )).rows[0];
    return row ? agentFromRow(row) : undefined;
  }

  async revokeAgent(agentId: string, now: Date): Promise<void> {
    const result = await this.poolQuery('UPDATE agents SET revoked_at = $2 WHERE id = $1', [agentId, now]);
    if (!result.rowCount) throw new Error('agent not found');
  }

  async createProfile(profile: NewProfile): Promise<Profile> {
    const row = (await this.poolQuery<ProfileRow>(
      'INSERT INTO profiles (id, agent_id, name, pvc_name, state, created_at, last_used_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, agent_id, name, pvc_name, state, created_at, last_used_at',
      [profile.id, profile.agentId, profile.name, profile.pvcName, profile.state, new Date(profile.createdAt), new Date(profile.lastUsedAt)],
    )).rows[0];
    if (!row) throw new Error('profile creation failed');
    return profileFromRow(row);
  }

  async listProfiles(agentId: string): Promise<Profile[]> {
    const result = await this.poolQuery<ProfileRow>(
      'SELECT id, agent_id, name, pvc_name, state, created_at, last_used_at FROM profiles WHERE agent_id = $1 AND deleted_at IS NULL ORDER BY created_at, id', [agentId],
    );
    return result.rows.map(profileFromRow);
  }

  async listControllerProfiles(): Promise<Profile[]> {
    const result = await this.poolQuery<ProfileRow>(
      'SELECT id, agent_id, name, pvc_name, state, created_at, last_used_at FROM profiles WHERE deleted_at IS NULL ORDER BY created_at, id',
    );
    return result.rows.map(profileFromRow);
  }

  async listAdminRuntimes(): Promise<AdminRuntime[]> {
    const result = await this.poolQuery<ProfileRow & { agent_display_name: string }>(
      `SELECT p.id, p.agent_id, p.name, p.pvc_name, p.state, p.created_at, p.last_used_at, a.display_name AS agent_display_name
       FROM profiles p JOIN agents a ON a.id = p.agent_id
       WHERE p.deleted_at IS NULL ORDER BY p.created_at, p.id`,
    );
    return result.rows.map(row => ({ id: row.id, name: row.name, state: row.state, agentId: row.agent_id, agentDisplayName: row.agent_display_name, createdAt: timestamp(row.created_at), lastUsedAt: timestamp(row.last_used_at) }));
  }

  async updateProfileState(profileId: string, state: string): Promise<void> {
    await this.poolQuery('UPDATE profiles SET state = $2 WHERE id = $1 AND deleted_at IS NULL', [profileId, state]);
  }

  async listControllerLeases(): Promise<Lease[]> {
    const result = await this.poolQuery<LeaseRow>(
      'SELECT profile_id, owner_client_id, fencing_generation, expires_at FROM control_leases ORDER BY profile_id',
    );
    return result.rows.map(leaseFromRow);
  }

  async acquireLease(profileId: string, agentId: string, clientId: string, now: Date, ttlMs = 30_000): Promise<Lease> {
    return this.transaction(async client => {
      const profile = (await client.query<{ id: string }>(
        'SELECT id FROM profiles WHERE id = $1 AND agent_id = $2 AND deleted_at IS NULL FOR UPDATE', [profileId, agentId],
      )).rows[0];
      if (!profile) throw new Error('profile not found');
      const current = (await client.query<LeaseRow>(
        'SELECT profile_id, owner_client_id, fencing_generation, expires_at FROM control_leases WHERE profile_id = $1 FOR UPDATE', [profileId],
      )).rows[0];
      if (current && timestamp(current.expires_at) > now.getTime() && current.owner_client_id !== clientId) throw new Error('profile busy');
      const generation = Number(current?.fencing_generation ?? 0) + 1;
      const expiresAt = new Date(now.getTime() + ttlMs);
      const row = (await client.query<LeaseRow>(
        'INSERT INTO control_leases (profile_id, owner_client_id, fencing_generation, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (profile_id) DO UPDATE SET owner_client_id = EXCLUDED.owner_client_id, fencing_generation = EXCLUDED.fencing_generation, expires_at = EXCLUDED.expires_at RETURNING profile_id, owner_client_id, fencing_generation, expires_at',
        [profileId, clientId, generation, expiresAt],
      )).rows[0];
      await client.query('UPDATE profiles SET last_used_at = $2 WHERE id = $1', [profileId, now]);
      if (!row) throw new Error('lease acquisition failed');
      return leaseFromRow(row);
    });
  }

  async getLease(profileId: string): Promise<Lease | undefined> {
    const row = (await this.poolQuery<LeaseRow>(
      'SELECT profile_id, owner_client_id, fencing_generation, expires_at FROM control_leases WHERE profile_id = $1', [profileId],
    )).rows[0];
    return row ? leaseFromRow(row) : undefined;
  }

  async releaseLease(profileId: string, clientId: string, generation: number, now: Date): Promise<void> {
    await this.transaction(async client => {
      const current = (await client.query<LeaseRow>(
        'SELECT profile_id, owner_client_id, fencing_generation, expires_at FROM control_leases WHERE profile_id = $1 FOR UPDATE', [profileId],
      )).rows[0];
      if (!current || current.owner_client_id !== clientId || Number(current.fencing_generation) !== generation || timestamp(current.expires_at) <= now.getTime()) throw new Error('lease required or expired');
      await client.query('DELETE FROM control_leases WHERE profile_id = $1', [profileId]);
    });
  }

  private async poolQuery<Row>(text: string, values: readonly unknown[] = []) {
    const client = await this.pool.connect();
    try { return await client.query<Row>(text, values); }
    finally { client.release(); }
  }
}
