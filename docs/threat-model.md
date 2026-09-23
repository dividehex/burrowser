# Burrowser threat model

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
   `src/admin-auth.ts` used for invitation issuance, agent revocation, and
   the admin list/delete operations below.

## Trust model for agents

Agents get [Playwright MCP](https://github.com/microsoft/playwright-mcp)'s own tools,
unmodified (ADR-0003). Playwright MCP is not a security boundary and neither is
Burrowser: the boundary between an AI agent and its tools is the agent's own
approval/classifier layer, which sees every tool call. Burrowser deliberately does
not add URL policies, per-tool argument checks or ceremony-time restrictions on top.
What it does control is *which* agent may drive *which* profile, *one session at a
time*, in a browser that is isolated from the cluster and from every other profile.
An operator can switch individual tools off with `mcp.excludeTools`.

## Main threats and controls

| Threat | Control | Validation status |
| --- | --- | --- |
| Invitation theft/replay/race | 256-bit random verifier, keyed hash, expiry, transactional consume | Unit-tested; live-verified against PostgreSQL |
| Agent identity spoofing | Ed25519 challenge proof; server derives agent UUID | Unit-tested; live-verified |
| Compromised/leaked agent identity | Admin-triggered revocation (`POST /admin/agents/:id/revoke`); every authenticated request re-checks `revokedAt` | Unit-tested; live-verified: a valid unexpired token is rejected on the request immediately after revocation |
| Destructive admin actions (profile/agent deletion) | Admin-only (bootstrap bearer or session+CSRF; an agent's own token is rejected); the request must repeat the target's id as `?confirm=`; profile deletion is two-phase — the request only marks the profile `DELETING` and ends its lease, and the controller then removes the Pod, Service, worker Secret and PVC and hard-deletes the row only once Kubernetes confirms all four are gone; a stale reconcile pass cannot overwrite `DELETING`, and a `DELETING` profile cannot be leased; an agent that still owns profiles cannot be deleted; each step writes an `audit_events` row (actor, action, target) that outlives the profile | Unit-tested (repository SQL flow, controller teardown gating, HTTP authorization/confirmation); live-verified against the real cluster |
| Bootstrap-token guessing via timing | The admin bootstrap bearer token is compared in constant time (`AdminAuth.authenticateBootstrap`) | Unit-tested |
| Agent private key theft from a client machine | The CLI writes an identity file owner-only (`0600`, in a `0700` directory) and never takes secrets from argv; MCP clients launch `burrowser mcp` as a subprocess and only ever see short-lived tokens, not the key | Unit/e2e-tested (file modes, invitation never consumed if the identity cannot be saved) |
| Cross-tenant profile access | Ownership checked when a session starts (a profile that is not yours looks like it does not exist) and on every request; durable lease checks use the repository, not an in-memory map; an MCP session can only be continued by the agent that started it | Unit-tested; live-verified |
| Lease split-brain | Durable exclusive lease with a fencing generation; the gateway takes it when an MCP session starts, renews it on every call and releases it when the session ends, so a second session is refused with 409 | Unit-tested in-memory and against PostgreSQL; live-verified via real MCP client sessions |
| Unauthenticated identity-endpoint DoS | Bounded/expiring challenge store (was previously unbounded) plus per-client-IP rate limiting on `/admin/login`, `/v1/identity/enroll`, `/v1/identity/challenge`, `/v1/identity/token` | Unit-tested; live-verified (flooded the live controller, got 429s after the configured limit) |
| Worker escape / API abuse | Fixed server-side manifests, no worker SA token, default-deny NetworkPolicy, Localhost seccomp, read-only rootfs, no `--no-sandbox` | Manifest tests, live K3s runtime validation, and CNI-enforced NetworkPolicy all passed |
| Node loss / stuck reconciliation | A profile stuck in `STARTING` past a grace period is reset (Pod/Service deleted, PVC preserved) and gets a fresh scheduling attempt on the next cycle | Unit/controller-tested; a true live node-loss simulation was not attempted (single-node cluster) |
| What an agent can do inside its browser | By design, everything Playwright MCP can: evaluate JavaScript, upload files (which can read the worker's filesystem, including the profile's storage), reach any web host the Pod's egress rule allows (TCP 80 and 443 to public addresses only - `worker.egressExcept` carves out private, carrier-grade NAT and link-local ranges, so not the LAN, node, cluster or metadata endpoints; DNS to kube-dns), read cookies and storage if those tool groups are enabled. Containment is the browser's Pod (non-root, read-only rootfs, no Kubernetes credentials, default-deny ingress, seccomp) and the agent-side classifier; `mcp.capabilities` picks which Playwright MCP tool groups exist and `mcp.excludeTools` switches off individual tools | Live-verified: a real MCP client drove a real profile through Playwright's own tools, including a real WebAuthn registration |
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
`x11vnc` and the noVNC client, not on this codebase's own validation. The gateway
speaks plain HTTP and has no TLS of its own: admin and agent credentials are
protected in transit only if the operator terminates TLS in front of it (and
the CLI warns when it is about to send secrets over plain HTTP to a
non-loopback address). A control lease lasts two minutes and is renewed on every
proxied call, so a vanished client keeps a profile locked for up to that
long. The worker's Playwright MCP endpoint is protected by the same
per-runtime bearer credential as its RPC, reachable only from the controller.
