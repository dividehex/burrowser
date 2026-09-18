# Agent Browser threat model

## Assets

- Agent identities, enrollment invitations, access grants, profile ownership.
- Persistent Chromium cookies/session data and encrypted virtual passkeys.
- Kubernetes resources and the administrator's live browser view.

## Trust boundaries

1. The agent/MCP client is untrusted input and never receives cluster or worker
   credentials.
2. The gateway is the only component allowed to authorize profile operations
   and contact worker pods.
3. Workers are isolated per profile and have no Kubernetes API token.
4. PostgreSQL is durable control state; PVC contents are sensitive browser data.
5. The live-view dashboard is gated by the same agent authentication as
   everything else (a short-lived view ticket minted via an authenticated
   HTTP call), not a separate admin trust domain — there is no
   admin-specific dashboard yet, only the admin bootstrap/session auth in
   `src/admin-auth.ts` used for invitation issuance and agent revocation.

## Main threats and controls

| Threat | Control | Validation status |
| --- | --- | --- |
| Invitation theft/replay/race | 256-bit random verifier, keyed hash, expiry, transactional consume | Unit-tested; live-verified against PostgreSQL |
| Agent identity spoofing | Ed25519 challenge proof; server derives agent UUID | Unit-tested; live-verified |
| Compromised/leaked agent identity | Admin-triggered revocation (`POST /admin/agents/:id/revoke`); every authenticated request re-checks `revokedAt` | Unit-tested; live-verified: a valid unexpired token is rejected on the request immediately after revocation |
| Cross-tenant profile access | Ownership checks on every request; durable lease checks use the repository, not an in-memory map | Unit-tested; live-verified |
| Lease split-brain | Durable exclusive lease and fencing generation | Unit-tested in-memory and against PostgreSQL; live-verified via real MCP client sessions |
| Unauthenticated identity-endpoint DoS | Bounded/expiring challenge store (was previously unbounded) plus per-client-IP rate limiting on `/admin/login`, `/v1/identity/enroll`, `/v1/identity/challenge`, `/v1/identity/token` | Unit-tested; live-verified (flooded the live controller, got 429s after the configured limit) |
| Worker escape / API abuse | Fixed server-side manifests, no worker SA token, default-deny NetworkPolicy, Localhost seccomp, read-only rootfs, no `--no-sandbox` | Manifest tests, live K3s runtime validation, and CNI-enforced NetworkPolicy all passed |
| Node loss / stuck reconciliation | A profile stuck in `STARTING` past a grace period is reset (Pod/Service deleted, PVC preserved) and gets a fresh scheduling attempt on the next cycle | Unit/controller-tested; a true live node-loss simulation was not attempted (single-node cluster) |
| SSRF/local file access | URL policy rejects non-HTTP(S), loopback, private/link-local targets | Unit-tested conservatively |
| Secret disclosure | No secrets in audit data or API responses; encrypted passkey file design; per-profile worker credentials (RPC bearer, authenticator key, VNC password) delivered only via a Kubernetes Secret the controller creates, never in Pod args | Worker persistence, Secret delivery, and durable controller key management (`KubernetesWorkerSecretProvider`) are all live-verified |
| Live-view dashboard abuse | `x11vnc -viewonly` (read-only at the VNC server), a single-use/short-TTL/profile-bound view ticket (agent bearer tokens can't be sent on a browser WebSocket handshake, so a ticket is minted via an authenticated HTTP call instead), and a per-profile VNC password known only to the worker and the authenticated ticket-issuing gateway | Unit-tested (ticket single-use/expiry/binding); live-verified with a real RFB/DES handshake through the tunnel against the real worker |
| Database backup/restore gaps | `pg_dump`/`pg_restore`-based backup and in-place restore, documented in `docs/runbooks/postgres-backup-restore.md` | Live-verified: backup taken, restored into a disposable throwaway database, row counts matched |

Residual risk: an authorized browser can exfiltrate data over allowed egress.
The MVP does not claim perfect exfiltration prevention. Local Path storage is
node-local and requires operator backups (see the Postgres backup runbook for
control-plane state; per-profile browser PVC data is intentionally out of
scope for backup, being disposable session state); multi-node migration is
out of scope. The live-view dashboard has no server-side rate limit on
view-ticket issuance beyond the general per-request lease/ownership check,
and its WebSocket bridge (`src/ws-bridge.ts`) is a blind byte pipe with no
awareness of the VNC protocol running over it — correctness there depends on
`x11vnc` and the noVNC client, not on this codebase's own validation. Real
WebAuthn/passkey ceremony support is not implemented; the corresponding MCP
tool remains a stub that always throws.
