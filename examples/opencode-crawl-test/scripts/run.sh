#!/bin/bash
# Runs the whole crawl test to completion with one short orchestrator session per site.
# The loop, timing, idle-reclaim waits and retries are plain bash, so the run survives a model that stops early,
# every session starts with a fresh context, and any failure or restart resumes where it left off.
# Usage: scripts/run.sh            Env: START_AT, MAX_SITES (a slice), OPENCODE_AGENT (default crawl-orchestrator),
#                                        SITE_TIMEOUT (seconds per attempt, default 1200), ATTEMPTS (default 2)
set -uo pipefail
cd "$(dirname "$0")/.."
AGENT=${OPENCODE_AGENT:-crawl-orchestrator}
SITE_TIMEOUT=${SITE_TIMEOUT:-1200}
ATTEMPTS=${ATTEMPTS:-2}

scripts/preflight.sh || exit 1
mkdir -p results/returns results/sites

while :; do
  info=$(scripts/next-site.sh) || { echo "next-site.sh failed"; exit 1; }
  [ "$(jq -r .done <<<"$info")" = true ] && break
  n=$(jq -r .n <<<"$info"); url=$(jq -r .url <<<"$info"); total=$(jq -r .total <<<"$info")
  scenarios=$(jq -r '.scenarios | if length == 0 then "none" else join(", ") end' <<<"$info")
  wait_s=$(jq -r .wait_before_seconds <<<"$info")

  if [ "$wait_s" -gt 0 ]; then
    echo "idle-reclaim probe: no browser activity for ${wait_s}s before site $n"
    sleep "$wait_s"
  fi

  start=$(date +%s); rm -f results/tmp-return.txt
  for attempt in $(seq 1 "$ATTEMPTS"); do
    # stdin must be /dev/null: "opencode run" waits for piped stdin to reach EOF, so under nohup, cron or CI it would hang.
    timeout "$SITE_TIMEOUT" opencode run --agent "$AGENT" \
      "Single-site mode. Crawl site $n of $total. URL: $url. Scenarios: $scenarios." < /dev/null >> results/opencode.log 2>&1 || true
    [ -s results/tmp-return.txt ] && break
    echo "site $n: attempt $attempt produced no reply from the crawler"
  done
  end=$(date +%s)

  if [ ! -s results/tmp-return.txt ]; then
    printf 'SITE: %s %s\nSTATUS: failed\nPAGES: 0\nFAULTS: no reply from the crawler after %s attempts (orchestrator session ended without calling it, or it timed out)\nSCENARIOS: none\nNOTES: recorded by scripts/run.sh\n' \
      "$n" "$url" "$ATTEMPTS" > results/tmp-return.txt
  fi
  scripts/record.sh "$n" "$start" "$end" results/tmp-return.txt
  if [ $((n % 25)) -eq 0 ]; then scripts/report.sh >/dev/null && echo "  (report refreshed after site $n)"; fi
done

scripts/report.sh && echo "done: see results/REPORT.md"
