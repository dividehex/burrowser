# Burrowser crawl test (OpenCode)

A long-running end-to-end test of Burrowser driven by OpenCode agents. An orchestrator loads the
`burrowser-crawl-test` skill and works through `sites.txt` (1000 HTTPS sites), calling one dedicated
`burrowser-crawler` subagent per site. Each subagent crawls about five pages through its Burrowser profile
and returns the pages it fetched with a one-line summary each. Along the way it exercises tab handling,
`browser_shutdown` and restart, idle reclaim, viewport resizes, the passkey tool, screenshots, console and
network inspection, and known-bad sites, and everything wrong in Burrowser itself is collected into a report.

```
.opencode/skills/burrowser-crawl-test/SKILL.md   the orchestrator's procedure (loaded by the skill tool)
.opencode/agents/crawl-orchestrator.md            primary agent: loads the skill, no browser tools
.opencode/agents/burrowser-crawler.md             subagent: only Burrowser tools, one site per call
opencode.json                                     the `burrowser` MCP server (identity `crawler`)
sites.txt, sites.meta.txt, canaries.txt           the 1000 sites, where they came from, the 10 known-bad ones
scripts/                                          next-site, record, report, preflight, generate-sites
results/                                          created by a run (git-ignored)
```

## Set up

1. A running Burrowser gateway, and a dedicated identity named `crawler` (its profile is created on first use):

   ```sh
   ./src/cli/main.ts admin invite | ./src/cli/main.ts enroll --name crawler
   ```

2. Environment, then start OpenCode from **this directory**:

   ```sh
   export BURROWSER_URL=http://localhost:8080
   export BURROWSER_CLI=/path/to/burrowser/src/cli/main.ts
   cd examples/opencode-crawl-test
   scripts/preflight.sh          # checks all of the above
   ```

## Run

**Recommended: `scripts/run.sh`.** The loop, timing, idle-reclaim waits and retries are plain bash, and each
site gets its own short orchestrator session (fresh context) that loads the skill and calls the crawler
subagent once. It works with small models, survives any failure, and resumes where it left off:

```sh
scripts/run.sh
```

Alternatively let one orchestrator session loop over all sites itself (`opencode --agent crawl-orchestrator`,
then say "start"; or `opencode run --agent crawl-orchestrator "Load the burrowser-crawl-test skill and run the test."`).
That needs a model that keeps calling tools instead of ending its turn: `gpt-oss-20b` stopped after its first
tool call in testing, which is why `run.sh` exists. Under `nohup`, cron or CI, give `opencode run` a
`</dev/null` stdin (as `run.sh` does): it waits for piped stdin to reach EOF and otherwise hangs at startup.

To run a slice, export `START_AT` and `MAX_SITES` first (for example `START_AT=20 MAX_SITES=25`). Because
state is on disk (`results/returns/N.txt` means site N is done), starting again continues at the first site
without a result.

Worker Pods only reach TCP 443, so the list is HTTPS-only. A full run takes many hours; the idle-reclaim probe
alone waits 16 minutes three times.

Expect real findings. A smoke run of sites 20-25 and 50 found that heavy sites push a worker Pod past its
1 GiB memory limit: the kubelet OOM-killed Chromium renderers (partial pages, failed launches) and once the
whole container.

## Results

- `results/returns/N.txt`: what the subagent returned for site N (the page list and one-line summaries).
- `results/sites/N.json`: its full log (pages, scenario outcomes, tool usage, faults).
- `results/progress.tsv` and `results/REPORT.md`: one row per site, and the report (rebuilt every 25 sites and at the end).

A *Burrowser fault* is an error from the tool layer (for example "Target page, context or browser has been
closed"), as opposed to a website being down or blocking bots. Those are the point of the test.

## Regenerating the list

`scripts/generate-sites.sh` rebuilds `sites.txt` from the current Tranco ranking (https://tranco-list.eu;
Le Pochat et al., NDSS 2019) and takes 15-20 minutes. The crawler follows normal browsing conduct: read-only,
same-site links, about five page loads per site, no logins or form submissions, and it never bypasses a
CAPTCHA or certificate warning. It does not consult `robots.txt`.
