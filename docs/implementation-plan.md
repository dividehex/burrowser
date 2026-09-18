# Milestone plan

1. **M1 bootstrap — done, live-verified.** Identity domain, HTTP gateway,
   enrollment/redeem, challenge authentication, admin invitation endpoint,
   migrations, tests.
2. **M2 profiles — done, live-verified.** Named caller-owned profiles,
   PVC/pod/service manifests, lifecycle reconciliation and
   readiness/error states, including node-loss/stuck-reconciliation
   recovery beyond the original scope.
3. **M3 isolation — done, live-verified.** Restricted MCP, exclusive
   leases/fencing, RBAC and network policy, SSRF controls, cross-tenant
   and direct-worker security tests.
4. **M4 browser — done, live-verified.** Non-root headed Chromium worker,
   persistent context and graceful/crash recovery.
5. **M5 passkeys — done, live-verified.** Supervised WebAuthn ceremony
   built on Playwright's real `context.credentials` virtual-authenticator
   API (`v1.61+`): the worker exposes `passkeyEnrollBegin`/
   `passkeyEnrollPoll`/`passkeyList` RPC methods (`worker/src/main.ts`,
   `worker/src/enrollment.ts`), the gateway wires
   `browser_passkey_enrollment_request`/`browser_passkey_status` through
   to them (`src/mcp.ts`, `src/mcp-http.ts`), and `browser_type`/
   `browser_snapshot` are rejected on the worker while an enrollment
   window is open. Live-verified against the real cluster with a real MCP
   client driving a real worker through an actual registration ceremony
   on webauthn.io (a public WebAuthn test/demo site): filled the
   username, opened an enrollment window, confirmed `browser_type`/
   `browser_snapshot` were rejected with HTTP 409 while it was open,
   clicked Register (triggering the site's real `navigator.credentials.
   create()`, answered by the virtual authenticator), and confirmed
   `browser_passkey_status` reported a single completed credential with
   no `publicKey`/`privateKey` substring anywhere in the MCP response.
   Also deleted the live worker Pod mid-test and confirmed the same
   credential id was restored from the encrypted PVC file in the fresh
   Pod/process, proving crash recovery. Malformed-record and
   encryption-key-mismatch rejection were already covered by
   `worker/src/persistence.test.ts` and re-confirmed as still passing.
   Disposable resources were cleaned up afterward.
6. **M6 dashboard — done, live-verified.** Authenticated live read-only
   noVNC proxy: done (x11vnc, ticket-gated authenticated WebSocket<->TCP
   bridge, a real `@novnc/novnc`-based browser viewer page). The live
   *event stream* is also done: `GET /admin/runtimes` (snapshot) and
   `GET /admin/runtimes/events` (admin-session-gated Server-Sent Events)
   report profile/pod runtime status - not per-action browser events -
   per the original spec's line 110 (`docs/architecture/original-spec.md`), backed by a
   minimal `/admin` tile-grid page (`src/admin-dashboard.html`). Live
   tiles only show `STARTING`/`READY`/`IDLE` profiles; a state leaving
   that set is pushed as a `removed` event, so a stopped pod disappears
   from the live view while the profile itself still exists for
   management. Live-verified against the real cluster: a real profile
   provisioned through the real controller was watched reaching `READY`
   over the real SSE stream, then disappearing from it once stopped.
   Click-through is also done: each tile has a "View" button that mints
   an admin-authorized ticket (`POST /admin/profiles/:id/view-ticket`,
   admin-session+CSRF or bootstrap-token gated, looks the profile up
   without tenant filtering) and opens `/view` in a new tab with that
   ticket, reusing the same single-use ticket store and WebSocket<->TCP
   bridge the agent-facing flow already used - `view.html` now accepts
   either `#token=&challenge=` (agent mints its own ticket) or
   `#ticket=&vnc_password=` (already minted, e.g. by the dashboard).
   Live-verified against the real cluster: an admin session with no
   relationship to a profile (created and owned by a different, ordinary
   enrolled agent) opened a real VNC tunnel to it and read a real RFB
   banner from the real worker; confirmed the *owning agent's own* bearer
   token is rejected on the admin route, proving it's genuinely a
   separate authorization path, not a fallback. Per-tile embedded live
   video preview (as opposed to a text/status tile plus a click-through
   button) is still not built, which the spec itself treats as optional
   ("thumbnails/snapshot polling at high counts").

   **Follow-up requested by Jake — done.** Tiles now show live updates as
   a browser session is actually used: each tile has an `<img>` fed by a
   new admin-only worker RPC method, `thumbnail` (`worker/src/main.ts`,
   `worker/src/rpc.ts`), which takes a real `page.screenshot()` (JPEG,
   quality 60) - separate from the agent-facing `snapshot` method
   (text-only, MCP-exposed) so there is no overlap between what an agent
   can pull and what only the trusted admin dashboard can. Exposed via
   `GET /admin/profiles/:id/thumbnail` (`src/server.ts`, admin-session or
   bootstrap-token gated, no CSRF needed since it's a read). The
   dashboard (`src/admin-dashboard.html`) polls this every 3s per tile,
   but only for tiles actually on screen (`IntersectionObserver`, per the
   spec's own line 60 guidance) and capped at 4 concurrent in-flight
   requests dashboard-wide - matching "only start streams for visible
   tiles ... and cap concurrent streams; optional thumbnails/snapshot
   polling at high counts" precisely rather than building the heavier,
   spec-optional per-tile live noVNC feed. Live-verified against the real
   cluster: navigated a real profile to two different real pages and
   confirmed the fetched JPEG bytes actually changed between them (not a
   cached or static image).
7. **M7 hardening — done.** Done
   and live-verified: rate limits, agent revocation, GC races/node loss,
   backup/restore, and now capacity: the worker Pod spec (`src/kube.ts`)
   gained CPU/memory requests+limits (250m/512Mi request, 1 CPU/1Gi
   limit) - closing a real gap where the controller Deployment had
   resource limits but every worker Pod did not, contradicting the
   original spec's line 116 ("CPU/RAM/pids limits"). ("pids limits" specifically is
   a kubelet/container-runtime setting, not something expressible in a
   Pod manifest this app controls, so it's out of scope here - noted,
   not silently dropped.) New tests (`tests/capacity.test.ts`) prove the
   controller reconciles 250 fake profiles in one tick without error or
   runaway latency, that many concurrent real HTTP profile-creates never
   collide or lose one, and that concurrent lease-acquisition attempts on
   one profile from many different clients always produce exactly one
   winner. Live-verified against the real cluster: 3 real profiles
   created concurrently all reached `READY`, each with the new resource
   limits actually present on the deployed Pod (`kubectl get pod -o
   jsonpath='{.spec.containers[0].resources}'`).

   Both decisions this used to call blocked are now made: CI is a GitHub
   Actions workflow (`.github/workflows/ci.yml` — unit/integration tests,
   both Docker images build-validated, Helm chart lint/render) that runs
   on every push and PR to `main`. No image registry is published for this
   project — deliberately: operators are expected to already have a
   Kubernetes/K3s cluster and PostgreSQL server, and are assumed capable of
   running or pointing at their own private registry (a K3s cluster's own
   built-in one, or otherwise) rather than depending on the maintainer to
   cut releases and host images. `scripts/build-and-deploy-local.sh`
   automates the build-and-push-to-your-own-registry path end to end.

No OpenBao or password/TOTP automation is planned for the initial release.
