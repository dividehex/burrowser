# ADR-0001: TypeScript gateway/controller with explicit infrastructure ports

Status: Accepted
Date: 2026-09-17

## Context

Burrowser needs an authenticated HTTP/MCP gateway, durable ownership and
lease state, and a Kubernetes reconciler. Browser workers must use TypeScript
because Playwright is a first-class dependency. This checkout contains no
existing runtime or dependency policy, and the development host has Node.js
26 but no Go, Kubernetes client, Helm, or PostgreSQL tooling.

## Decision

Use a TypeScript/Node.js controller. Keep domain logic independent of HTTP,
PostgreSQL, and Kubernetes through small ports. The initial test adapter is an
in-memory store and fake Kubernetes client; production wiring will use pg and
the Kubernetes API. Use Node's built-in HTTP and crypto primitives for the
M1 identity surface to keep the security-critical behavior auditable and the
bootstrap install reproducible.

Identity uses an Ed25519 public key, signed nonce challenge, short-lived
audience-bound access token, and hashed single-use enrollment verifier. No
private keys, cookies, passkeys, or bearer tokens are stored by the server.

## Consequences

The first milestone runs without downloading packages, which is useful for
isolated development. PostgreSQL/Kubernetes integration remains an explicit
adapter milestone and cannot be claimed from unit tests. A real deployment
must supply TLS termination, a PostgreSQL-backed repository, and a scoped
Kubernetes service account before production use.
