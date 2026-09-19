# Repository structure

The original plan (see ADR-0001) sketched a Go-style `cmd/`/`internal/`
layout. The implementation instead uses a flat `src/` Node/TypeScript tree
with small, explicitly-injected ports (`KubernetesPort`, `WorkerPort`,
`ProfileStore`/`DurableProfileStore`) rather than a deep package hierarchy.
This file replaces that earlier sketch with the actual layout.

```text
src/                          controller/gateway (Node, run with --experimental-strip-types)
  server.ts                     HTTP gateway: admin/identity/profile routes, MCP + live-view
                                 wiring, WebSocket upgrade handling, production entrypoint
  identity.ts                   invitations, Ed25519 enrollment/challenge/token, revocation
  admin-auth.ts                 admin session cookies + CSRF
  profiles.ts                   in-memory profile/lease domain logic (dev-mode store)
  repository.ts                 PostgresRepository: durable profiles/leases/agents/invitations
  postgres.ts                   pg.Pool factory (requires DATABASE_URL)
  migrate.ts / migrate-cli.ts    thin wrapper around postgres-migrations + its CLI entrypoint
  reconcile.ts                  pure reconciliation functions: create/stop/idle-GC/stuck-GC
  controller.ts                 ProfileController: polls state, calls reconcile.ts, runs on a timer
  controller-factory.ts         wires PostgresRepository + KubernetesApiClient + secrets into one
  kubernetes.ts                 KubernetesApiClient (KubernetesPort impl, @kubernetes/client-node)
  kube.ts                       fixed worker Pod/Service/PVC/Secret manifest generation
  worker-secrets.ts             per-profile worker credential Secret provider (get/ensure)
  worker-client.ts              HttpWorkerClient (passkey + thumbnail RPC) and workerMcpUrl
  mcp.ts                        session lease (profileLease), readiness wait, WorkerPort/DurableProfileStore types
  mcp-http.ts                   MCP Streamable HTTP endpoint: x-burrowser-profile header -> lease + wait for browser + proxy
  mcp-proxy.ts                  the MCP proxy: tools/list + tools/call pass through to the worker's Playwright MCP
                                 untouched (exclude list, passkey and shutdown tools, bounded connect retry)
  view-tickets.ts               single-use tickets gating the live-view WebSocket upgrade
  ws-bridge.ts                  ws-based WebSocket<->TCP bridge to a worker's VNC port
  static-assets.ts              serves src/view.html and @novnc/novnc's ES modules
  view.html                     the live-view browser page (noVNC RFB client)
  errors.ts                     HttpError: an error carrying the HTTP status the gateway answers with

  cli/                          the `burrowser` command line (package.json "bin"; `npm run cli -- ...`)
    main.ts                       entry point: command dispatch, help, one-line error reporting
    enroll.ts                     `enroll` (redeem an invitation, save an identity) and `whoami`
    admin.ts                      `admin invite | agents list/revoke/delete | profiles list/delete`
    mcp-bridge.ts                 `mcp`: stdio MCP server that forwards to the gateway as an agent
    gateway.ts                    GatewayClient (JSON over fetch) + AgentSession (challenge/token refresh)
    identity-store.ts             owner-only identity files (Ed25519 key) under ~/.config/burrowser
    input.ts                      secrets from file/env/stdin/hidden prompt (never argv); delete confirmation
    args.ts, cli-error.ts         strict option parsing and user-facing error type

worker/                       hardened per-profile Playwright container (separate image)
  src/main.ts                    owns the persistent browser context; serves Playwright MCP on /mcp and passkey/thumbnail RPC on /rpc
  src/rpc.ts                     worker-side auth + allowlisted RPC methods (passkeys, thumbnail)
  src/persistence.ts              encrypted (AES-256-GCM) virtual-authenticator credential store
  src/mcp-endpoint.ts             Streamable HTTP session table around Playwright MCP's createConnection
  entrypoint.sh                  starts Xvfb, x11vnc (read-only), then the RPC server
  Dockerfile                     non-root, read-only-rootfs image; installs the Chromium that the pinned @playwright/mcp + Playwright pair needs

db/migrations/                 plain numbered .sql files, run via postgres-migrations
charts/burrowser/          Helm chart: Deployment, Service, RBAC, NetworkPolicy, StorageClass
scripts/                       build-and-deploy-local.sh, backup/restore-postgres.sh,
                                provision-postgres.ts, install-chromium-seccomp.sh,
                                worker-e2e.sh (+ worker-e2e-tabs.ts): real-Chromium checks of a worker image
tests/                         node:test unit + real-listener integration tests (tests/helpers/ has a fake Playwright
                                worker), plus tests/k8s/
                                (disposable smoke-test manifests, not run by `npm test`)
examples/opencode-crawl-test/  an OpenCode skill + subagent that crawls 1000 sites through a Burrowser profile (a long-running e2e test)
docs/                          architecture ADRs and the original spec, threat model, runbooks
```

## Notable design choices worth knowing before editing

- **Ports stay small and interface-shaped**, not because of a dependency
  policy (see ADR-0002) but so a concrete implementation can be swapped
  without touching the business logic or its tests. `KubernetesApiClient`
  implements `KubernetesPort` from `reconcile.ts`; swapping its internals
  to `@kubernetes/client-node` required no changes to `reconcile.ts`,
  `controller.ts`, or their tests.
- **Durable vs. in-memory stores share call sites.** The MCP session helpers
  in `mcp.ts` and the HTTP routes in `server.ts` branch on `'listProfiles' in store` to decide
  whether they're talking to the in-memory dev store or
  `PostgresRepository`; there is no separate durable-only code path to keep
  in sync.
- **The controller reconciles from durable state on a timer**
  (`ProfileController.reconcileOnce`, `src/controller.ts`), not from
  individual API calls — creating a profile row is necessary but not
  sufficient; the next reconcile tick (default every 5s) is what actually
  provisions Kubernetes resources.
- **Profile deletion is two-phase, and only an administrator can start it.**
  `DELETE /admin/profiles/:id` (`PostgresRepository.requestProfileDeletion`)
  marks the profile `DELETING` and ends its lease in one transaction; the
  controller (`deleteProfileResources` in `reconcile.ts`, driven from
  `ProfileController.reconcileOnce`) then removes the Pod, Service, worker
  Secret and PVC, and calls `finalizeProfileDeletion` only once Kubernetes
  reports all four gone. The PVC is otherwise never deleted by the
  controller. `audit_events` rows are written at each step and, since
  migration `002`, are not tied to the profile row by a foreign key so they
  outlive it.
- **A lease is a session's hold on a profile.** `handleMcpHttp` takes it when
  an MCP session starts (`profileLease` in `mcp.ts`, which also restarts a
  stopped profile), the proxy renews it before every forwarded call, and
  ending the session releases it. It lasts `LEASE_TTL_MS` (two minutes), so a
  vanished client frees the profile shortly; agents never see it.
