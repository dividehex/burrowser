# Agent Browser — original design specification

> **Status note (added 2026-09-18, retroactively):** This is the original
> design document this project was built from — kept for historical
> record and design rationale, not as a live status page. It's referenced
> by specific line number from a few places in the code (search the repo
> for this file's old name/path if a reference looks stale) as the
> justification for particular decisions, which is why it's kept rather
> than deleted.
>
> **For current implementation status, see
> [`docs/implementation-plan.md`](../implementation-plan.md) — that file
> is authoritative, this one is not.** The text below is preserved as
> originally written (down to referring to itself as a "Codex" handoff,
> the tool it was originally written for) and is **known to no longer
> match reality** in these specific ways:
>
> - **No TLS.** The Mission section below calls for exposing the gateway
>   "with authenticated TLS." That was never built — the gateway is plain
>   `node:http`. This is a real, currently open gap, not an oversight in
>   this note.
> - **The enrollment CLI was built, with a different shape.** "Agent
>   enrollment and authentication" below describes an `agent-browser enroll
>   --url ... --invitation ...` CLI. It now exists as `burrowser enroll`
>   (`src/cli/`): the invitation is a single `<id>.<secret>` token printed by
>   `burrowser admin invite` and is read from a file, piped stdin or a
>   hidden prompt, never argv. The "local MCP stdio adapter" sketched there
>   is `burrowser mcp`. Neither existed when this document was written.
> - **Admin profile deletion was built.** "Administrative APIs" below
>   specifies `DELETE /admin/profiles/{id}` with audited two-phase deletion;
>   it now exists (with a mandatory `?confirm=<id>`), alongside
>   `GET /admin/agents`, `GET /admin/profiles` and `DELETE /admin/agents/{id}`
>   (not in the original list). `POST /v1/profiles/{id}/heartbeat` was
>   never built: instead a lease lasts two minutes and every successful
>   worker-touching MCP call slides it forward.
> - **"Restricted MCP" was reversed.** "Restricted MCP and browser controls"
>   below prescribes a small custom tool set with no evaluate, no file access
>   and a URL policy. Burrowser now exposes Playwright MCP's own tools,
>   unmodified, on the profile's browser, with an operator-configurable
>   exclude list and the agent-side classifier as the boundary between an
>   agent and its tools; see
>   [ADR-0003](adr-0003-expose-playwright-mcp-unmodified.md). The lease/fencing
>   arguments on every tool call are gone too: the gateway holds the lease
>   for the MCP session.
> - **Repository structure differs.** "Repository suggested structure"
>   below sketches a Go-style `cmd/`/`internal/` layout. The actual
>   layout is a flat `src/`/`worker/src/` TypeScript tree — see
>   [`docs/repository-structure.md`](../repository-structure.md) and
>   [ADR-0001](adr-0001-controller-stack.md) for why and what changed.
> - **Language choice was resolved.** "Language choice: Go controller ...
>   OR TypeScript controller ... is acceptable; choose one" below was
>   resolved in favor of TypeScript for both the controller and the
>   worker (see ADR-0001).
>
> Everything else — the mission, trust boundaries, data model, milestone
> list, non-goals (no OpenBao, no password/TOTP automation) — was built
> essentially as specified and remains accurate; see
> `docs/implementation-plan.md` for the live-verified detail behind each
> milestone.

Status: approved architecture, implementation not yet built or tested. Date: 2026-09-17.

## Mission and fixed product decisions

Build a self-hosted, Kubernetes-native, multi-tenant browser service for remote MCP clients (OpenCode CLI initially, Kubernetes-based agents later). An administrator issues a one-time enrollment token; the agent redeems it for an identity credential. Each authenticated agent can dynamically create multiple named persistent profiles. Each active profile runs in a dedicated, ephemeral Kubernetes browser pod with Chromium, restricted Playwright capabilities, and a virtual WebAuthn authenticator. Profiles and virtual passkeys survive pod deletion and host reboot. Enforce one active browser controller per profile, with concurrency across different profiles. Reclaim idle pods after 15 minutes without an active lease; only administrators may delete persistent profiles. Use K3s Local Path storage initially. Expose the gateway on local desktop/private LAN only, with authenticated TLS. Provide an administrator dashboard showing live, read-only noVNC tiles for all running sessions; clicking a tile opens a full noVNC view in a new browser tab. Deliver a usable Codex CLI handoff, documentation and automated tests. No manual per-agent pod or deployment YAML edits.

Non-goals for MVP: centralized OpenBao, password/TOTP automation, importing existing private passkeys, CAPTCHA bypass, multi-node volume migration, generic unrestricted browser MCP, exposing pod services to the public internet, arbitrary Kubernetes workload creation, automatic deletion of old profiles.

## Architecture and trust boundaries

1. A gateway/controller Deployment (replicas=1 for MVP) exposes authenticated HTTPS REST, MCP Streamable HTTP, and an admin dashboard. It owns the control database and a narrowly scoped Kubernetes service account. It authenticates and authorizes every request and every WebSocket upgrade. Agents never receive cluster credentials, pod IPs, raw CDP endpoints or Kubernetes Service URLs.
2. PostgreSQL stores agents, hashed enrollment tokens, public-key identity records, hashed/identified access/refresh grants, profiles, PVC name, runtime state, leases, audit events and revocation state. It never stores passkey private keys or website session cookies. An existing PostgreSQL server may be configured, but migrations and isolated database ownership must be provided.
3. One dynamically created Pod + ClusterIP Service per active *named profile*, not per TCP connection. Pod mounts exactly its owner's dedicated Local Path PVC. The browser worker runs Chromium, Playwright Node/TypeScript, Xvfb/window manager (where needed), x11vnc or equivalent, and websockify. A separate noVNC frontend library is hosted by the dashboard. No browser worker has Kubernetes API credentials (`automountServiceAccountToken: false`). No worker port is published outside the cluster.
4. Worker exposes only a private authenticated RPC protocol for controller operations, plus an internal WebSocket-to-VNC endpoint. Prefer a short-lived per-runtime service credential delivered via a non-agent-readable Kubernetes Secret (or a scoped projected token if using workload identity), and verify controller-to-worker connections. The browser worker does not accept agent identity claims as authority. Agent never reaches the worker directly.
5. Separate admin login (bootstrap offline, then session cookie with Secure, HttpOnly, SameSite and CSRF protections) from agent enrollment. Administrator can list/watch all profiles and delete them. Agent may list/create/start/stop its own named profiles, but may not delete any profile.
6. Shared LLM inference is outside the browser trust domain. When later running agents as pods, use distinct workload identities and network policy; do not let their ServiceAccounts have browser pod or PVC CRUD.

## Agent enrollment and authentication

- Admin creates an enrollment invitation scoped to a single future agent identity, with expiry and single-use semantics. Generate >=256 bits cryptographically random. Store only a keyed hash/hashed verifier, not plaintext. Display once; rate-limit redemption; transactionally consume, including simultaneous redemption races.
- Recommended durable identity: generate an Ed25519 agent keypair locally at enrollment; submit public key to controller with proof of possession and invitation. Return immutable agent UUID and credential metadata. Keep private key in local user-owned restricted file or OS key store. Verify signed nonce on future authentication; exchange it for short-lived audience-bound access token (e.g. 10-15 min), rotate revocable refresh grants if provided. Avoid permanent bearer credentials in opencode.json, logs or URL query strings.
- Enrollment CLI `agent-browser enroll --url https://... --invitation ... --name social` should accept invitation securely without writing it to shell history (prompt or stdin), and output restricted local identity files/config. Never confuse human display names with identity UUIDs. A local MCP stdio adapter can authenticate on behalf of OpenCode and forward Streamable HTTP requests, avoiding reliance on the exact OpenCode version's custom OAuth support. Alternative standards-compliant OAuth can be added later.
- Server authenticates *every* HTTP request, MCP request, and WebSocket upgrade. Bind all profile authorization to server-verified agent UUID. Reject spoofed `agent_id` or arbitrary profile owner fields. Apply TLS validation, audience, expiry, revocation and Origin/Host checks. Document LAN TLS certificate provisioning.
- Admin login is separate; admin-only read-only views may observe any active profile. Audit all control actions without recording auth headers or browser input.

## Persistent data model

Agents(id UUID, display_name, public_key, status, created_at, revoked_at); enrollment_invitations(id, verifier_hash, expires_at, consumed_at, assigned_agent_id); profiles(id UUID, agent_id FK, name unique per agent, state, pvc_name unique, created_at, last_used_at, deleted_at); browser_runtimes(profile_id unique, generation, pod_uid, service_name, node_name, phase, started_at, heartbeat_at, idle_deadline); control_leases(profile_id unique, owner_client_id, fencing_generation, expires_at); audit_events(id, actor_type, actor_id, action, profile_id, timestamp, outcome). Define DB constraints/indexes and migrations. Do not put secrets into audit rows.

PVC paths: `/profile/chromium/` (persistent Chromium user data); `/profile/authenticator/credentials.enc` (encrypted and authenticated WebAuthn records); `/profile/authenticator/manifest.json` (nonsecret version/checksum metadata); `/profile/recovery/` (optional protected snapshots). Explicitly test encryption-key availability after restart: encryption key must live *outside* the same PVC, not embedded beside ciphertext. Protect backups and securely rotate keys. Never create a second live writer for a profile. Profile name is display metadata, not a filesystem path; derive PVC names from immutable UUIDs.

Local Path PV is node-local. Set pod scheduling from PV node affinity and report `node_unavailable` rather than silently moving the profile. Use a dedicated StorageClass/PVC policy; pod deletion must never delete PVC. Use `ReadWriteOnce` plus DB lease with fencing generation and pod UID checks, not `ReadWriteOncePod` with Local Path (RWOP requires CSI). Avoid PVC ownerReferences tied to pods; verify StorageClass/PV reclaim behavior and only delete volume explicitly through audited admin action. Do not use namespace-wide cleanup that deletes PVCs. Backup profile and key material together under administrator control; document limitations of node-local storage.

## Controller lifecycle and correctness

`ABSENT -> PROVISIONING -> STARTING -> READY -> IDLE -> DRAINING -> STOPPED` plus `FAILED`, `DELETING` states. The controller reconciles DB desired state against observed Kubernetes pods, PVCs and Services on startup and periodically. Use unique generation/fencing tokens so stale pods cannot accept requests after replacement. Idempotently ensure a PVC and worker pod/service exist; watch for readiness rather than treating Kubernetes API creation as ready. Handle provisioning timeouts and cleanup partial resources without deleting PVC. Run one controller replica in MVP, use DB transaction/advisory lock plus unique profile runtime row for duplicate request races. Do not rely on in-memory mappings for identity or ownership.

At most one ACTIVE **agent controller lease** per profile. Separate optional dashboard read-only VNC connections do not own that control lease. Two different profiles of same agent can run concurrently. A second client attempting to control the same profile gets a documented 409/busy response with nonsecret lease metadata; no silent takeover. Keepalive/renew lease while in use. If the owning connection vanishes, require a grace period/lease expiry and safely fence the old client before permitting new owner.

Idle timer: 15 minutes after the last valid agent control lease ends (and no active work is pending). Dashboard viewers do not keep pod alive. At timeout, mark DRAINING, reject new control calls, flush virtual credentials, await durable fsync/atomic rename, cleanly close Playwright/Chromium, then delete Pod and Service, keeping PVC and registry entry. A reconnect racing with draining either cancels shutdown before the irreversible boundary or waits for next generation. Never kill pod on a single transient network disconnect. Crash recovery resumes from PVC and encrypted authenticator snapshot; no passkey loss after successful enrollment transaction.

## Browser worker and passkeys

Use TypeScript, Playwright package and bundled compatible Chromium pinned to tested versions/digests. Run browser non-root with Chromium sandbox configured/tested under K3s; don't use `--no-sandbox`, privileged pods, host IPC or mount docker/containerd sockets as a production shortcut. Validate required seccomp/user namespace permissions, rootless desktop/vnc processes and resource requests. Allocate sufficient `/dev/shm` using bounded `emptyDir` memory if appropriate. Deny Kubernetes API credentials; use default-deny NetworkPolicies with tested CNI enforcement, allow gateway/necessary external HTTPS/DNS and block metadata/cluster-admin endpoints. An unrestricted browser can still make outbound network requests: document exact egress guarantees and limits.

Use one persistent Chromium context for the profile and one virtual WebAuthn authenticator per context. Before login/registration, restore saved credentials with `context.credentials.create(rpId, {id,userHandle,privateKey,publicKey})` for each approved record, then call `context.credentials.install()` before any page accesses WebAuthn. During administrator-supervised enrollment, install an empty authenticator *before* starting the website registration ceremony; website must actually complete registration, then inspect `context.credentials.get()` in trusted worker and persist newly registered credentials immediately with atomic encrypted write/verified readback, before reporting success. Capture modifications on credential updates, on idle shutdown and on orderly stop. Do not assume Chromium profile alone persists virtual credentials. The virtual authenticator is a software testing feature; do not assert real hardware user presence/verification or universal compatibility with real social sites. Begin end-to-end testing with a controlled WebAuthn test website, then test actual sites explicitly.

Passkey records include rpId, credentialId, userHandle, publicKey, privateKey and required authenticator metadata. Authenticate all records on load, reject malformed/mismatched relying parties, version persisted format; no secret field in MCP response, logs, screenshots or dashboard payload. Password/TOTP automation out of MVP; interactive initial enrollment is the only supported enrollment method. Session cookies/site data live inside the persistent Chromium profile and must be protected as credentials. Do not enable Playwright raw storageState export in agent tooling.

## Restricted MCP and browser controls

Expose a stable gateway `/mcp` endpoint plus a local stdio bridge compatible with initial OpenCode CLI. Tool set for MVP: `browser_profiles_list`, `browser_profiles_create`, `browser_profile_open`, `browser_profile_release`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_auth_status`, `browser_passkey_enrollment_request` (admin-supervised), `browser_passkey_status` (metadata only). No agent `delete` tool. Browser profile selection uses opaque UUID chosen from caller-owned profiles and checked per request. A profile-open call obtains exclusive control lease; other calls require current lease/generation. Never expose raw Playwright JS/code execution, `browser_evaluate`, CDP, raw browser network/socket, cookie/storage export, passkey private-key reads, arbitrary filesystem access or user-selected persistent profile paths. Restrict text entry and snapshots during sensitive WebAuthn/login operations. Verify browser methods cannot be repurposed to read privileged local URLs or files. Implement URL normalization, scheme/origin restrictions, local/IP SSRF constraints, redirect checks and download/upload restrictions. Note that browser capabilities are inherently powerful: forbid claims of perfect data-exfiltration prevention without robust egress controls and tests.

Prefer gateway implement MCP protocol directly rather than forwarding trusted pod MCP endpoints to arbitrary clients. Document protocol version compatibility and Origin validation. Avoid using transport MCP session IDs as identity.

## Live dashboard and noVNC

Authenticated admin UI at `/admin`, responsive tile grid with agent display name, profile name, pod phase, node, viewer count, last activity and image/live preview. Render one read-only noVNC `RFB` instance per visible tile, with `viewOnly=true`, `scaleViewport=true`, and appropriate resizing. Only start streams for visible tiles (IntersectionObserver) and cap concurrent streams; optional thumbnails/snapshot polling at high counts. Clicking tile opens `/admin/profiles/:id/view` in new tab, a full-size read-only noVNC client. Never use iframes pointing to unrestricted worker URL. Admin-initiated keyboard/mouse control, if implemented later, requires separate approval and an exclusive human control lease coordinated with the agent; read-only remains default.

Worker runs Xvfb + lightweight window manager + Chromium headed in virtual display, x11vnc bound to localhost/pod interface only, websockify internal. Gateway checks logged-in admin and `view:profile` authorization on every WebSocket handshake, then proxies to the specific worker Service determined from registry, not from a client-supplied hostname/port. Browser displays private account data: enforce admin authentication, secure cookies, HTTPS/WSS, short connection lifetimes, origin and CSRF checks, backpressure and connection quotas, no caching/screenshots by default. Restrict VNC input at BOTH frontend and server gateway: never trust the frontend `viewOnly` bit alone. VNC authentication via gateway/worker as required, and never publish per-worker VNC NodePorts/Ingresses.

Dashboard receives runtime status via an authenticated Server-Sent Events or WebSocket event stream. A new pod appears as a tile automatically; stopped pods disappear from LIVE view but profile persists in profile-management view. The dashboard reconnects without creating a new pod merely to show an offline profile. Dashboard viewers do not refresh the agent's 15-minute idle deadline.

## Kubernetes packaging

Ship Helm chart for controller/api/UI, PostgreSQL connection Secret, namespace, PodSecurity, RBAC, Service, Ingress/private LAN TLS, config, quotas, network policies and worker pod templates. Only trusted controller service account can create/watch/get/delete pods and Services and create/get PVCs in the dedicated namespace; do not grant cluster-admin, arbitrary PV or secret read privileges if avoidable. Prefer pre-created dedicated worker ServiceAccount with `automountServiceAccountToken: false`. Use fixed image, securityContext and volume spec assembled server-side from immutable templates; never accept a PodSpec/image/hostPath from agent input. Kubernetes RBAC permission to create Pods is powerful; combine with admission policy and fixed templates. Workers are not owner of PVCs. Pod security use highest compatible setting; document any necessary exception.

Pin images by digest for release, dependency lockfiles, signed/verified supply chain where practical. Add readiness/liveness/startup probes, CPU/RAM/pids limits, bounded logs, shutdown grace period and graceful PID 1. Provide local single-node k3s install instructions, private LAN DNS/TLS instructions, backup/restore and migration limitations. Never claim CNI NetworkPolicy enforcement without testing actual k3s network stack.

## Administrative APIs (proposed; document OpenAPI)

`POST /admin/enrollments` issue single-use invite; `GET /admin/agents`; `POST /admin/agents/{id}/revoke`; `GET /admin/profiles`; `DELETE /admin/profiles/{id}` requires explicit admin confirmation, active lease termination, pod shutdown and audited two-phase deletion; `GET /admin/runtimes`; `GET /admin/runtimes/events`; `GET /admin/profiles/{id}/view`; `GET /admin/profiles/{id}/vnc` WebSocket authenticated and read-only.

`POST /v1/identity/enroll` invitation+public key proof; `POST /v1/identity/token` signed challenge -> short-lived access; `GET /v1/profiles` caller-owned; `POST /v1/profiles` caller-owned named profile; `POST /v1/profiles/{id}/acquire` exclusive lease; `POST /v1/profiles/{id}/heartbeat`; `POST /v1/profiles/{id}/release`; `/mcp` authenticated Streamable HTTP. Agent has NO persistent profile DELETE endpoint.

Specify idempotency keys, pagination, standardized errors (401 unauthenticated, 403 forbidden, 404 ownership-safe not found, 409 busy/conflict, 429 rate limit, 503 pending/unavailable), retry-after and provisioning status. No token, passkey material or cookie in query parameters.

## Repository suggested structure

`cmd/gateway/`, `cmd/enroll-cli/`, `cmd/mcp-bridge/`, `worker/src/`, `frontend/src/`, `internal/{identity,authorization,profiles,leases,reconcile,kube,mcp,proxy,audit}/`, `db/migrations/`, `charts/agent-browser/`, `tests/{unit,integration,e2e,security}/`, `docs/{architecture,threat-model,operations,backups,opencode,passkeys}/`, `.github/workflows/`.

Language choice: Go controller (client-go, pgx, net/http WebSocket reverse proxy) OR TypeScript controller (Kubernetes client + PostgreSQL) is acceptable; choose one and document tradeoff. TypeScript is preferred for worker because official Playwright API is directly available. React/Vite or simple TypeScript frontend with noVNC RFB client. Keep infrastructure minimal; do not build a custom Kubernetes Operator/CRD for the initial release unless tests show normal controller + DB insufficient.

## Milestones and acceptance gates

M1 bootstrap: Helm chart, controller, DB migrations, admin login, invite issuance. Test concurrent single-use invite redemption and identity spoofing.
M2 profiles: create/list named profiles, automated Local Path PVC and Pod/Service generation, readiness/provisioning/errors; recover after controller restart. Test no PVC removed by pod shutdown.
M3 isolation: private MCP, exclusive leases, fencing, secure RBAC/NetworkPolicy, concurrent distinct profiles. Test agent A cannot list/control B; second controller on same profile receives busy; injected PodSpec/hostPath rejected; no direct VNC/CDP access.
M4 browser: headed Chromium persistent profile, login via supervised manual enrollment, cookies survive stop/restart/reboot, worker graceful shutdown and crash recovery.
M5 passkeys: virtual credential registered through real WebAuthn ceremony, encrypted immediately and restored on new pod; test malformed record, encryption key loss/recovery, private key absent from MCP/log/trace; acknowledge sites might reject software authenticators.
M6 dashboard: live read-only tile streams and click-through full view; new/stopped pods reflected automatically; unauthorized WebSocket denied; VNC input blocked server-side; 15-minute idle unaffected by viewers.
M7 hardening: tests for lease race/crash/GC, storage node offline, revocation, rate limits, redirects/SSRF, network egress, Kubernetes API deny, browser sandbox, backup/restore, capacity constraints, documentation and CI.

Do not declare any acceptance gate passed without running the actual test and recording evidence. Use disposable test accounts and a controlled local WebAuthn site first. Never test with production social credentials until isolation and recovery are verified.

## Codex operating instructions

1. Inspect repo and actual environment/installed versions before coding; do not assume existing files, Kubernetes version or working noVNC implementation. If running without cluster access, build isolated mocks and clearly distinguish them from cluster end-to-end validation.
2. Create a concise ADR and threat model first, then implement M1 through M7 in small testable commits. Avoid speculative extra services; no OpenBao or password/TOTP feature creep.
3. Keep all secrets out of source, shell history, Docker build layers, pod arguments, logs, screenshots and MCP tool output. Generate install-time credentials through secure provisioning.
4. Default-deny all tools and routes. Add behavior only alongside authorization tests.
5. Produce Docker images, Helm chart, migration commands, CLI examples for OpenCode V1/V2 according to detected version, admin guide and disaster recovery runbook.
6. Report every test actually executed, failures, untested risks, and any differences from the approved design. Never claim secure/production-ready solely because unit tests pass.

## Primary specification references

- Playwright credentials: https://playwright.dev/docs/api/class-credentials
- Playwright browser context storage: https://playwright.dev/docs/api/class-browsercontext
- Playwright Docker security: https://playwright.dev/docs/docker
- K3s storage: https://docs.k3s.io/add-ons/storage
- Kubernetes RWOP CSI limitation: https://kubernetes.io/docs/tasks/administer-cluster/change-pv-access-mode-readwriteoncepod/
- Kubernetes RBAC security: https://kubernetes.io/docs/concepts/security/rbac-good-practices/
- MCP HTTP transport: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx
- OpenCode MCP V2: https://opencode.ai/v2/docs/mcp-servers
- noVNC: https://github.com/novnc/noVNC
- websockify: https://github.com/novnc/websockify
