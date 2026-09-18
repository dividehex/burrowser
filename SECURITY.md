# Security Policy

Agent Browser is self-hosted software that provisions and controls
per-agent Kubernetes browser workloads with real credentials (agent
identity keys, WebAuthn passkeys, admin sessions). See
[`docs/threat-model.md`](docs/threat-model.md) for the assets, trust
boundaries, and mitigations this project already accounts for — please
check there first, since a report may already describe a documented,
accepted residual risk rather than a new issue.

## Supported versions

This project doesn't have tagged releases yet; security fixes are applied
to `main`. Once releases exist, this section will be updated to state
which lines receive fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Email **jake@dpks.com** with a description of the issue, the affected
component (gateway, worker, Helm chart, etc.), and steps to reproduce.
Encrypt sensitive details if you'd prefer not to send them in plaintext
email.

Once this repository is public, GitHub's private vulnerability reporting
(Security tab → **Report a vulnerability**) will be enabled and preferred
over email — it keeps the report and any discussion scoped to this repo
with commit/PR linking. Until then, email is the reporting channel.

Please include:

- A clear description of the vulnerability and its impact.
- Steps to reproduce, or a minimal proof of concept.
- The affected file(s)/component(s) and, if known, the commit or version.

## What to expect

This is a solo-maintained project without a formal SLA. You should expect
an acknowledgment and an honest assessment of severity and next steps, and
credit in the fix's commit/changelog unless you'd prefer otherwise. Please
give a reasonable amount of time to investigate and ship a fix before any
public disclosure.
