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
credentials, pod IPs, or a raw CDP endpoint. What they *do* get is a genuine
browser: the tools are [Playwright MCP](https://github.com/microsoft/playwright-mcp)'s
own, unwrapped, running on that persistent profile.

## Features

- **Per-agent identity, no shared credentials.** Admin-issued single-use
  enrollment invitations; agents authenticate with an Ed25519 keypair, never
  a long-lived bearer token.
- **A `burrowser` CLI.** `enroll` saves an owner-only identity, `mcp` runs a
  stdio MCP bridge that any MCP client (Claude Code, OpenCode, ...) can
  launch — it holds the key and refreshes short-lived tokens so the client
  never has to — and `admin` covers invitations plus listing and deleting
  agents and profiles. Secrets are never taken from argv.
- **Playwright MCP, unmodified.** An agent sees exactly the tools, schemas,
  descriptions and results a stock Playwright MCP server gives it —
  accessibility snapshots with element refs, click/type/fill by ref, key
  presses, tabs, dialogs, screenshots, evaluate — because it *is* Playwright
  MCP, served from inside the profile's Pod and proxied through the gateway.
  Burrowser adds only two passkey tools, and lets an operator switch
  individual tools off (`mcp.excludeTools` in the chart).
- **Named, persistent profiles.** Each profile is its own Pod + Service +
  PVC, reconciled from durable PostgreSQL state, not an in-memory map. A
  profile reclaimed for idleness restarts, with its storage, the next time an
  agent connects to it.
- **Real WebAuthn passkeys.** A supervised enrollment ceremony
  (`browser_passkey_enrollment_request` / `browser_passkey_status`) drives
  Playwright's virtual-authenticator API; credentials are stored
  AES-256-GCM-encrypted on the profile's own PVC and survive Pod recreation.
- **Exclusive control.** Exactly one MCP session drives a profile at a time;
  a second gets a 409, never a silent takeover. The gateway holds the lease
  for the life of the session, so agents never see it.
- **Hardened workers.** Non-root, read-only rootfs, dropped capabilities,
  `automountServiceAccountToken: false`, Localhost seccomp profile,
  default-deny `NetworkPolicy` — no worker ever holds a Kubernetes API
  token.
- **Live-view admin dashboard.** A tile grid (`GET /admin`) backed by an SSE
  runtime-event stream shows every active profile as it reconciles, with
  click-through, single-use-ticket-gated noVNC sessions and polled
  thumbnails — capped and visibility-gated, not a persistent stream per
  tile.
- **Audited admin deletion.** Deleting a profile is two-phase: the gateway
  marks it `DELETING` and ends its lease, then the controller removes the
  Pod, Service, worker Secret and PVC and drops the row only once Kubernetes
  confirms they're gone. The audit trail outlives the profile.
- **Node-loss and stuck-reconciliation recovery**, per-client rate limiting,
  and PostgreSQL backup/restore tooling (`docs/runbooks/`).

See `docs/implementation-plan.md` for what's built and live-verified versus
what's still open.

## Usage

Everything below is the `burrowser` CLI (`npm install`, then `npm link` to put
it on your `PATH`, or run `./src/cli/main.ts` / `npm run cli --` from the
checkout). The gateway address comes from `--url` or `BURROWSER_URL`; admin
commands read the bootstrap token from `BURROWSER_ADMIN_BOOTSTRAP`,
`--admin-token-file`, or `--admin-token-stdin` — never from a command-line
argument.

**Give an agent an identity.** An admin mints a single-use invitation and the
agent redeems it; piping keeps it out of your shell history:

```sh
$ burrowser admin invite | burrowser enroll --name research-bot
Enrolled "research-bot" as agent 4b2ce5a9-e2f4-c661-3ad5-bc3ebeb1b4b2
Identity saved to ~/.config/burrowser/identities/research-bot.json (owner-only; it holds this agent's private key)

$ burrowser whoami --identity research-bot
"research-bot" (agent 4b2ce5a9-...) is authenticated to http://localhost:8080
No profiles yet.
```

**Point an MCP client at it.** `burrowser mcp` is a stdio MCP server that *is*
your profile's Playwright MCP server, seen through the gateway:

```sh
claude mcp add burrowser -- burrowser mcp --identity research-bot
```

The profile defaults to the identity's name (`--profile NAME` picks another)
and is created on first use; a cold start takes about fifteen seconds. The
agent then has Playwright MCP's own tools — `browser_navigate`,
`browser_snapshot` (an accessibility tree with `[ref=…]` handles),
`browser_click`, `browser_type`, `browser_tabs`, `browser_take_screenshot` and
the rest — with nothing about profiles or leases to manage, plus
`browser_passkey_enrollment_request` / `browser_passkey_status` for the
supervised passkey ceremony. To switch tools off, set `mcp.excludeTools`
(comma-separated names) in the chart; `mcp.capabilities` chooses which of
Playwright MCP's tool groups exist (`core` by default).

**Administer.** IDs may be any unique prefix of four or more characters, and
`list` commands take `--json` for scripting:

```sh
burrowser admin agents list
burrowser admin profiles list
burrowser admin profiles delete bfc37f5c --yes --wait   # tears down the Pod, PVC and Secret, audited
burrowser admin agents delete 4b2ce5a9 --yes            # refused while the agent still owns profiles
```

Without `--yes`, deletes ask you to type the target's id back. Run
`burrowser --help` for the full list.

<details>
<summary>The same operations over raw HTTP</summary>

```
$ curl -s -X POST https://gateway.internal/v1/profiles \
    -H "Authorization: Bearer $AGENT_TOKEN" -H "x-agent-challenge: $CHALLENGE" \
    -H 'Content-Type: application/json' -d '{"name":"research"}'

{"id":"…","name":"research","state":"ABSENT","pvcName":"bw-…"}
```
*(illustrative — real IDs are UUIDs.)* Access tokens are short-lived and bound
to a signed challenge, which is exactly what the CLI's `AgentSession` handles
for you (`src/cli/gateway.ts`).
</details>

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
The gateway speaks plain HTTP, so terminate TLS in front of it; the CLI
warns before sending credentials over plain HTTP to a non-loopback address.

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
