# Contributing to Agent Browser

Thanks for taking the time to contribute. This is a small, actively
developed project — issues and pull requests are both welcome.

## Prerequisites

- Node.js >=22 (developed against Node 26).
- Docker, if you're touching `Dockerfile` or `worker/Dockerfile`.
- Helm, if you're touching `charts/agent-browser/`.
- A Kubernetes/K3s cluster and PostgreSQL server are only needed for
  end-to-end testing against a real deployment — the unit/integration test
  suite runs without either.

## Local setup

```sh
git clone https://github.com/dividehex/agent-browser.git
cd agent-browser
npm install
npm test
```

`npm test` runs the full `node:test` suite (unit tests plus real-listener
HTTP integration tests) for both the gateway (`tests/`) and the worker
(`worker/src/*.test.ts`). This is also exactly what CI runs — if it's green
locally, it'll be green in the PR check.

There's no separate lint/format step configured yet; match the existing
code's style (small, explicitly-injected ports, no framework abstractions
beyond what's already there — see
[`docs/repository-structure.md`](docs/repository-structure.md) for the
design choices behind the current layout before adding a new one).

### If you're changing the Helm chart

```sh
helm lint charts/agent-browser \
  --set image.digest=sha256:0000000000000000000000000000000000000000000000000000000000000000 \
  --set workerImage.digest=sha256:0000000000000000000000000000000000000000000000000000000000000000
```

(The chart requires a digest unless `pullPolicy: Never`; the placeholder
digest above is only for linting/rendering, matching what CI's `helm-lint`
job does.)

### If you're changing either Dockerfile

```sh
docker build -f Dockerfile .
docker build -f worker/Dockerfile worker/
```

CI builds both on every PR (build-only, not pushed — see
[README.md](README.md#real-deployment) for why no images are published).

## Making a change

1. Open an issue first for anything non-trivial (new features, behavior
   changes, anything touching the identity/lease/isolation model) so we can
   agree on the approach before you write code — this project has a real
   [threat model](docs/threat-model.md) and a deliberately narrow trust
   boundary; changes there need more scrutiny than a typical bug fix.
2. Fork the repo and create a branch from `main`.
3. Make focused changes. Add or update tests for new behavior and bug
   fixes — a bug fix should generally come with a regression test.
4. Run `npm test` (and `helm lint` / `docker build` if relevant) before
   opening the PR.
5. Open a pull request against `main` describing what changed and why. CI
   (`.github/workflows/ci.yml`) runs the test suite, both Docker image
   builds, and the Helm chart lint automatically.

## Reporting bugs

Open a [GitHub issue](https://github.com/dividehex/agent-browser/issues)
with steps to reproduce, what you expected, and what actually happened.
Include relevant logs (`kubectl logs -n agent-browser
deployment/agent-browser-controller`) with any credentials or tokens
redacted.

## Reporting security issues

Do **not** open a public issue for a security vulnerability — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree your contributions are licensed under this
project's [MIT License](LICENSE).
