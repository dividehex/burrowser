# ADR-0002: Prefer established third-party libraries over hand-rolled protocol/crypto code

Status: Accepted
Date: 2026-09-18

## Context

ADR-0001 recorded that the M1 identity slice used Node's built-in HTTP and
crypto primitives directly, with no other dependencies, so that early
security-critical behavior stayed auditable and the bootstrap install stayed
reproducible without network access. That was correct for that specific
slice (Ed25519, HMAC, and hashing via `node:crypto` are the *correct* way to
use cryptographic primitives, not something to avoid), but it was later
misread as a general "minimize dependencies" project policy. On that
mistaken basis, subsequent work hand-rolled RFC6455 WebSocket server framing
from scratch and began hand-writing a DES cipher in JavaScript (VNC's
password-authentication scheme has no Web Crypto equivalent) for a
browser-side VNC client.

## Decision

There is no minimal-dependency policy. Prefer well-established, actively
maintained third-party libraries over hand-rolled reimplementations of
solved problems (wire protocols, ciphers, transports, rate limiters,
generated API clients, migration runners), including in a codebase that
currently has few dependencies. A low dependency count observed at a point
in time is not evidence of a rule against adding more.

This does not mean maximizing dependencies indiscriminately — using
`node:crypto`'s primitives directly for the identity/token scheme (Ed25519,
HMAC-SHA256, AES-256-GCM) remains correct, since that *is* the established,
audited way to use those primitives in Node; the problem was reimplementing
protocol/algorithm *logic* (frame parsing, permutation networks, REST
clients, migration bookkeeping) that a maintained library already solves
correctly and keeps solving as specs evolve.

As of this ADR, the following hand-rolled code was replaced:

| Concern | Hand-rolled | Replaced with |
| --- | --- | --- |
| WebSocket server framing | Manual RFC6455 accept-key/frame codec | `ws` |
| Browser-side VNC (RFB/DES) client | Unfinished, hand-written | `@novnc/novnc`'s `RFB` class |
| Per-client rate limiting | Manual sliding-window Map | `rate-limiter-flexible` |
| Kubernetes API client | Manual REST calls over `node:https` | `@kubernetes/client-node` |
| MCP Streamable HTTP transport | Manual JSON-RPC/SSE/session handling | `@modelcontextprotocol/sdk` |
| SQL migration runner | Manual transaction/tracking-table logic | `postgres-migrations` |

In each case the existing internal interface boundary (e.g. `KubernetesPort`
in `src/reconcile.ts`) was preserved so the swap stayed low-risk: the
business logic and its tests did not need to change, only the concrete
transport/protocol implementation underneath.

## Consequences

`npm install` is now required before running or building anything (see
README); the controller image is correspondingly larger. Library-specific
storage-policy adapters remain necessary and are not "hand-rolled code" in
the sense this ADR is about — e.g. `BoundedEventStore` in `src/mcp-http.ts`
implements the MCP SDK's own `EventStore` interface, and
`viewSecretsForProfile`/`workerForProfile` implement the SDK's/this
codebase's own dependency-injection seams. Adopting `postgres-migrations`
required a one-time manual reconciliation of the live database's migration
history because it tracks applied migrations in a different table than the
hand-rolled runner it replaced; this was a one-time transition cost, not an
ongoing one.
