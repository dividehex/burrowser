---
name: burrowser-crawl-test
description: Runs the Burrowser end-to-end crawl test. Works through sites.txt (1000 HTTPS sites) one site at a time, calling the burrowser-crawler subagent for each, which visits about five pages through its dedicated Burrowser profile and returns each page fetched with a one-line summary. Deliberately exercises Burrowser (tab churn, close-all-tabs, browser_shutdown and restart, idle reclaim, viewport resizes, passkey status, screenshots, console and network inspection, failing sites) and ends with a report. Load this skill, then the orchestrator starts the test.
license: MIT
compatibility: opencode
metadata:
  project: burrowser
  role: orchestrator
  subagent: burrowser-crawler
---

# Burrowser crawl test (orchestrator)

**Once this skill is loaded, start the test.** Your next action is a tool call: run `scripts/preflight.sh` with the bash tool. Do not ask the user for confirmation, do not summarise this skill back to them, and do not write a text-only reply such as "the test will now begin". **Every turn you take must end in a tool call until `scripts/next-site.sh` prints `"done":true`** (then write the final message), apart from the reasons listed under "Stop and report".

## Two ways this skill is used

- **Whole run (this session loops).** The user asks you to run the test. Follow "Procedure" below, looping over all sites yourself.
- **Single-site mode.** The user message starts with `Single-site mode.` and names one site, its URL and its scenarios (this is how `scripts/run.sh` drives a run, one short session per site, with the loop, timing and idle waits done in bash). Then do **only** this, in order, and nothing else:
  1. Call the `task` tool with subagent `burrowser-crawler` and the message from step (d) below, filled in from the user message.
  2. Write the subagent's reply **verbatim** to `results/tmp-return.txt` with the write tool.
  3. Reply with the single word `done`. Do not run `preflight.sh`, `next-site.sh` or `record.sh`, and do not call the subagent again: the runner records the result.

## What this is

A long, repeatable test of Burrowser (a self-hosted service that gives an AI agent its own persistent browser). You call **one** `burrowser-crawler` subagent at a time, each given **one site** from `sites.txt`. The subagent crawls up to five pages of that site through its Burrowser profile and returns the page list with a one-sentence summary per page. Along the way it runs scheduled scenarios that stress Burrowser's browser lifecycle. Every result is recorded on disk and a report is built at the end.

You are the orchestrator. You have **no browser tools, on purpose**: never fetch or browse a page yourself. The subagent's only way to reach the web is Burrowser, so every page load tests it.

## Rules

1. **State lives on disk, not in your memory.** Site `N` is finished once `results/returns/N.txt` exists. Always get the next site from `scripts/next-site.sh`; never work out the next number yourself. If your context is ever compacted or the run is restarted, run `scripts/next-site.sh` and carry on: nothing is lost or repeated.
2. **One subagent call at a time.** Never start a second `task` call before the previous one has returned.
3. **Never skip a site**, and never re-run a finished one. A failed site is a valid result: record it and move on.
4. **Stay terse.** After each site print one line (the output of `scripts/record.sh`). Do not repeat the page list or summaries back to the user; they are already in `results/`.
5. The subagent decides how to crawl. You never tell it to bypass a block, sign in, submit a form, or click through a certificate warning.

## Procedure

### 1. Preflight

Run `scripts/preflight.sh`. If any line says `FAIL`, stop and show the user exactly what to fix (the script prints the fix beside each failure). Do not start the test until it passes.

### 2. The loop

Repeat until step (a) says `done`:

**(a)** Run `scripts/next-site.sh`. It prints one JSON line, either `{"done":true,...}` (go to step 3) or

```json
{"done":false,"n":12,"url":"https://example.org/","total":1000,"scenarios":["tab-churn","resize"],"wait_before_seconds":0}
```

**(b) Idle-reclaim probe.** If `wait_before_seconds` is above 0, this site follows a scheduled idle gap: Burrowser stops a profile that has been unused for 15 minutes, and the browser must come back on its own when the next site starts. Say one line ("idle-reclaim probe: waiting N s"), then wait that long with `sleep` using the bash tool (give the bash call a timeout longer than the sleep; if the tool refuses a long timeout, wait in several `sleep 100` calls). Make **no browser call** during the wait.

**(c)** Note the start time: `date +%s`.

**(d)** Call the `task` tool with subagent `burrowser-crawler` and exactly this message (fill in the values; write `none` if the scenario list is empty):

```
Crawl site <n> of <total>.
URL: <url>
Scenarios: <comma-separated scenarios, or none>
```

**(e)** Note the end time: `date +%s`. Write the subagent's reply **verbatim, with nothing added or removed**, to `results/tmp-return.txt` using the write tool, then run

```
scripts/record.sh <n> <start> <end> results/tmp-return.txt
```

Print its one-line output and nothing else. If the `task` call itself fails or returns nothing, write a reply that reads

```
SITE: <n> <url>
STATUS: failed
PAGES: 0
FAULTS: subagent call failed: <the error text>
SCENARIOS: none
NOTES: the orchestrator could not get a reply from the crawler
```

and record that, so the site is not lost and the fault is counted.

**(f)** Every 25 sites, run `scripts/report.sh` (it rebuilds `results/REPORT.md`) and say in one line how many sites are done and how many reported Burrowser faults.

### 3. Finish

When `scripts/next-site.sh` says `done`: run `scripts/report.sh`, read `results/REPORT.md`, and give the user a short final message: sites done, pages fetched, counts by status, every Burrowser fault (site and exact error text, at most ten, then "and N more"), any scenario that failed, and the path `results/REPORT.md`. The per-page log and summaries are in `results/returns/` (as returned) and `results/sites/` (full JSON per site).

### Stop and report

Stop the loop early, and tell the user what happened, only if:

- preflight fails, or
- five sites in a row report a Burrowser fault or fail with STATUS `failed` (Burrowser or the gateway may be down: run `scripts/preflight.sh` again and include its output), or
- the `task` tool is unavailable or denies the `burrowser-crawler` subagent.

The user can resume at any time by loading this skill again.

## The scenario schedule (computed by `scripts/next-site.sh`)

For site number `n`, the script adds these scenarios. They are here so you know what the subagent is doing; you do not compute them.

| Scenario | When | What it exercises in Burrowser |
|---|---|---|
| (always) | every site | navigation, snapshots, waits, one screenshot, console messages, network requests, and a persistent profile that accumulates cookies across all 1000 sites |
| `tab-churn` | `n % 5 == 0` | opening several tabs, switching between them, closing extras |
| `resize` | `n % 7 == 0` | viewport changes and reloading at a mobile size |
| `passkey-status` | `n % 10 == 0` | the Burrowser-specific passkey tool and the worker RPC behind it |
| `close-all-tabs` | `n % 25 == 0` | closing every tab, including the last (Burrowser must keep one blank tab and the browser usable) |
| `shutdown` | `n % 20 == 0` | `browser_shutdown`: clean stop, then the next site restarts the worker on its own |
| idle gap | before site `n` when `(n-1) % 250 == 0` | the controller's 15-minute idle reclaim and the automatic restart afterwards |

Fixed canary sites are at lines 50, 150, ... 950 of `sites.txt` (bad TLS certificates, a host that does not exist, a 404, a 503, a slow response, a long redirect chain, JavaScript dialogs, a file download). They exist to exercise failure handling; expect them to fail, and expect the subagent to record the failure and carry on.

## What the subagent returns (for reference)

```
SITE: 12 https://example.org/
STATUS: ok | partial | failed | skipped
PAGES: 3
1. https://example.org/ | one-sentence summary
2. https://example.org/about | one-sentence summary
FAULTS: none | exact error text(s) of Burrowser faults
SCENARIOS: tab-churn ok; resize ok
NOTES: one line
```

`scripts/record.sh` reads the `STATUS:`, `PAGES:` and `FAULTS:` lines. A `FAULTS:` value other than `none` means a Burrowser fault (an error from the tool layer, such as "Target page, context or browser has been closed"), which is the most important thing this test looks for. A website that is simply down or blocks bots is *not* a fault.

## Environment

The user starts OpenCode from this directory with `BURROWSER_CLI` (path to the Burrowser CLI, `src/cli/main.ts`), `BURROWSER_URL` (the gateway, for example `http://localhost:8080`) and an enrolled Burrowser identity named `crawler`. `scripts/preflight.sh` checks all of it. To run a slice instead of everything, the user can export `START_AT` and `MAX_SITES` before starting; `scripts/next-site.sh` honours them.
