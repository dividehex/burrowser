# Burrowser

A self-hosted, Kubernetes-native browser service that gives AI agents their
own isolated, persistent Chromium profiles — complete with real WebAuthn
passkeys — over MCP.

[![CI](https://github.com/dividehex/burrowser/actions/workflows/ci.yml/badge.svg)](https://github.com/dividehex/burrowser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![The Burrowser admin dashboard after signing in, showing the live-runtimes tile grid](docs/assets/admin-dashboard.png)
*The admin dashboard (`GET /admin`) — a real, authenticated screenshot
from a running instance, with four real agents each running their own
profile: `research-bot`, `docs-bot`, `qa-bot`, and `support-bot`, each
navigated to a different real page. Every tile shows a live thumbnail
polled from that profile's actual worker Pod and a click-through noVNC
view; a tile disappears once its profile stops.*

**[Quick start](#quick-start) · [Architecture](docs/repository-structure.md) · [Threat model](docs/threat-model.md) · [Milestone status](docs/implementation-plan.md)**

## Why this exists

MCP clients that need a real browser usually get one shared, ephemeral
Chromium instance with no persistent identity. Burrowser instead gives
each authenticated agent its own named, **persistent** browser profiles:
cookies, local storage, and a real virtual WebAuthn authenticator all
survive pod restarts and node reboots, because they live on a dedicated
per-profile PVC rather than in the pod itself. Every profile runs in its
own hardened, non-root, network-isolated Pod — agents never receive cluster
credentials, pod IPs, or a raw CDP endpoint, only a narrow MCP tool surface
gated by server-verified identity.

## Features

- **Per-agent identity, no shared credentials.** Admin-issued single-use
  enrollment invitations; agents authenticate with an Ed25519 keypair, never
  a long-lived bearer token.
- **Named, persistent profiles.** `browser_profiles_create` /
  `browser_profiles_list` / `browser_profile_open` / `browser_profile_release`
  — each profile is its own Pod + Service + PVC, reconciled from durable
  PostgreSQL state, not an in-memory map.
- **Real WebAuthn passkeys.** A supervised enrollment ceremony
  (`browser_passkey_enrollment_request` / `browser_passkey_status`) drives
  Playwright's virtual-authenticator API; credentials are stored
  AES-256-GCM-encrypted on the profile's own PVC and survive Pod recreation.
- **Exclusive, fenced control leases.** Exactly one caller controls a
  profile at a time; a second caller gets a documented 409, never a silent
  takeover.
- **Hardened workers.** Non-root, read-only rootfs, dropped capabilities,
  `automountServiceAccountToken: false`, Localhost seccomp profile,
  default-deny `NetworkPolicy` — no worker ever holds a Kubernetes API
  token.
- **SSRF-resistant navigation.** `browser_navigate` URLs are checked against
  an allowlist policy before the worker ever sees them.
- **Live-view admin dashboard.** A tile grid (`GET /admin`) backed by an SSE
  runtime-event stream shows every active profile as it reconciles, with
  click-through, single-use-ticket-gated noVNC sessions and polled
  thumbnails — capped and visibility-gated, not a persistent stream per
  tile.
- **Node-loss and stuck-reconciliation recovery**, per-client rate limiting,
  and PostgreSQL backup/restore tooling (`docs/runbooks/`).

See `docs/implementation-plan.md` for what's built and live-verified versus
what's still open.

## Usage

```
$ curl -s -X POST https://gateway.internal/v1/profiles \
    -H "Authorization: Bearer $AGENT_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"name":"research"}'

{"id":"…","name":"research","state":"ABSENT","pvcName":"bw-…"}
```
*(illustrative — real IDs are UUIDs) An authenticated agent creating a
named, persistent browser profile via the REST API (the same operation is
also exposed as the `browser_profiles_create` MCP tool). The controller
then provisions a dedicated Pod/PVC/Service for it in Kubernetes and
reconciles it through to `READY` — that's the profile that would show up
as a tile in the screenshot above.*

## Quick start

Requires Node.js >=22 (developed against Node 26).

```sh
npm install
npm test
BURROWSER_ADMIN_BOOTSTRAP=change-me BURROWSER_TOKEN_KEY=$(openssl rand -hex 32) npm start
```

That starts the gateway in-memory only (no `DATABASE_URL` /
`KUBERNETES_SERVICE_HOST` set) — useful for iterating against the HTTP/MCP
surface without a cluster. `GET /health` should return `200`.

### Real deployment

This assumes you already have a Kubernetes (or K3s) cluster and a
PostgreSQL server — Burrowser doesn't provision either for you, and
**no official container images are published.** Build both images from
source (`Dockerfile`, `worker/Dockerfile`) and push them to a registry your
cluster can pull from: your own private registry, or a simple `registry:2`
you run alongside the cluster (see the header of
`scripts/build-and-deploy-local.sh` for a from-scratch K3s + local-registry
example). That script builds both images, pushes them, and rolls the Helm
release to the resulting digests in one step:

```sh
./scripts/build-and-deploy-local.sh
```

The chart is under `charts/burrowser/`; see `values.yaml` for the
knobs (`image.repository`, `workerImage.repository`, `postgres.secretName`,
etc.) — `image.digest`/`workerImage.digest` are required unless
`pullPolicy: Never`, so a bad or missing build fails the Helm render
instead of silently deploying a stale image.

## Architecture

A single-replica gateway/controller owns PostgreSQL and a narrowly scoped
Kubernetes ServiceAccount; it's the only component that talks to worker
Pods or the Kubernetes API. It reconciles durable profile state against
observed Kubernetes resources on a timer, not per-request. See
[`docs/repository-structure.md`](docs/repository-structure.md) for the full
file-by-file layout and the design choices behind it, and
[`docs/architecture/`](docs/architecture) for the ADRs.

## Security

Agents are treated as untrusted input and never receive cluster or worker
credentials; the gateway is the sole authorization point for every HTTP
request, MCP call, and WebSocket upgrade. See
[`docs/threat-model.md`](docs/threat-model.md) for the full asset/trust-boundary
breakdown and mitigation table. No OpenBao integration or password/TOTP
automation is included — passkeys are the only supported credential type.

## Documentation

- [`docs/implementation-plan.md`](docs/implementation-plan.md) — milestone status
- [`docs/threat-model.md`](docs/threat-model.md) — assets, trust boundaries, mitigations
- [`docs/repository-structure.md`](docs/repository-structure.md) — code layout and design choices
- [`docs/architecture/`](docs/architecture) — ADRs
- [`docs/runbooks/postgres-backup-restore.md`](docs/runbooks/postgres-backup-restore.md) — operating the database

## Contributing

Issues and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for local setup, how this project likes
changes proposed, and what CI checks. Please report security
vulnerabilities privately per [SECURITY.md](SECURITY.md) rather than as a
public issue. Participation is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
