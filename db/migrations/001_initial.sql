CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE agents (id uuid PRIMARY KEY, display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100), public_key bytea NOT NULL, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
CREATE TABLE enrollment_invitations (id uuid PRIMARY KEY, verifier_hash bytea NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz, assigned_agent_id uuid REFERENCES agents(id));
CREATE TABLE profiles (id uuid PRIMARY KEY, agent_id uuid NOT NULL REFERENCES agents(id), name text NOT NULL, state text NOT NULL, pvc_name text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, UNIQUE(agent_id, name));
CREATE TABLE browser_runtimes (profile_id uuid PRIMARY KEY REFERENCES profiles(id), generation bigint NOT NULL, pod_uid text, service_name text NOT NULL, node_name text, phase text NOT NULL, started_at timestamptz, heartbeat_at timestamptz, idle_deadline timestamptz);
CREATE TABLE control_leases (profile_id uuid PRIMARY KEY REFERENCES profiles(id), owner_client_id text NOT NULL, fencing_generation bigint NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE audit_events (id bigserial PRIMARY KEY, actor_type text NOT NULL, actor_id text NOT NULL, action text NOT NULL, profile_id uuid REFERENCES profiles(id), timestamp timestamptz NOT NULL DEFAULT now(), outcome text NOT NULL);
CREATE INDEX profiles_agent_idx ON profiles(agent_id) WHERE deleted_at IS NULL;
CREATE INDEX leases_expiry_idx ON control_leases(expires_at);
