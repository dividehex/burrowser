# ADR-0003: Expose Playwright MCP unmodified

Status: accepted, 2026-09-18.

## Context

The first design gave agents a small, hand-written MCP tool set (`browser_navigate`,
`browser_snapshot`, `browser_click`, `browser_type`, ...) that Burrowser wrapped around
Playwright: every call carried a profile id, a client id and a fencing generation, URLs
were checked against a policy, and `browser_snapshot` returned raw page text. In use it
was a worse browser than the real thing. An agent could read a page but not tell what to
click (no element refs), had no key presses, form helpers, tab handling or dialogs, and
had to juggle lease arguments on every call. A Claude subagent's own feedback ("this task
couldn't be completed with the MCP tools alone") made it concrete.

Burrowser exists to give an agent a genuine browser experience on a persistent, private
profile. A tool that hamstrings the agent has failed at that.

## Decision

The MCP tools an agent sees are [Playwright MCP](https://github.com/microsoft/playwright-mcp)'s
own: same names, descriptions, schemas and results. `@playwright/mcp` runs inside each
worker Pod (`createConnection(config, contextGetter)`, given the worker's own persistent
browser context, so the virtual passkey authenticator, the noVNC live view and the profile
on the PVC are shared with it). The gateway is an authenticating, lease-holding MCP proxy:
`tools/list` and `tools/call` pass through with arguments and results untouched.

Burrowser decides only:

- **Who** may connect (agent identity, and that the profile is theirs).
- **That one session at a time** drives a profile. The gateway takes the lease when the
  session starts, renews it on every call, and releases it when the session ends, so the
  agent never handles leases or fencing.
- **Which tool names are switched off**, from a plain exclude list (`mcp.excludeTools`).
  Nothing is excluded by default.
- **Three additions**: `browser_passkey_enrollment_request` and `browser_passkey_status`,
  because the supervised WebAuthn ceremony has no Playwright MCP equivalent, and
  `browser_shutdown`, because Playwright MCP's `browser_close` only closes a page and an
  agent that is finished has no other way to end its worker. It marks the profile for
  shutdown and the controller stops it through the same path as idle reclaim (SIGTERM,
  which closes Chromium normally). Any later call restarts the profile, and cancels a
  shutdown that has not happened yet.

`burrowser mcp --profile NAME` is the client side: it binds a profile (created on first use),
authenticates, and exposes exactly the proxied tool set over stdio.

## The security boundary

Playwright MCP is not a security boundary, and neither is Burrowser. The boundary between an
AI agent and its tools is the agent's own approval/classifier layer, which sees each tool call.
Burrowser therefore does not try to second-guess Playwright's tools: no URL policy, no
per-tool argument checks, no restriction while a passkey ceremony is open. What Burrowser
provides is *isolation of the browser* (its own hardened Pod and storage per profile, no
Kubernetes credentials in it), *identity and ownership*, and *exclusivity*.

## Consequences

- Agents get everything Playwright MCP offers, including `browser_evaluate` and file upload
  (which reads the worker's filesystem, including the profile's storage). An operator who
  wants any of it off adds its name to `mcp.excludeTools`.
- The gateway's `url-policy.ts` and the worker's hand-written navigate/snapshot/click/type RPC
  were deleted; the worker's `/rpc` keeps only passkey enrollment and dashboard thumbnails.
- Upgrades follow Playwright MCP. Each `@playwright/mcp` release pins an exact Playwright
  build (0.0.81 needs `1.64.0-alpha-2026-09-14`), so `worker/package.json` pins both, the
  worker image installs that build's Chromium (`npx playwright install chromium`), and
  `worker/package-lock.json` keeps them a single deduplicated copy. Bump them together.
- Worker Pods gained a readiness probe on `/health`: with the gateway connecting the moment a
  profile is `READY`, "the container started" is no longer good enough.

## Alternatives considered

- **Keep the wrapper, add the missing tools and an accessibility snapshot.** Rejected: it
  re-creates Playwright MCP by hand, drifts from it, and still presents a different experience.
- **An allowlist of Playwright's tools.** Rejected as the default: the point is the genuine
  experience, and the exclude list gives an operator the same control per deployment.
