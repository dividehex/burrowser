#!/bin/bash
# Prints the next unprocessed site as one JSON line, or {"done":true,...} when there is none.
# All state is on disk: site N is done once results/returns/N.txt exists, so a restarted run resumes by itself.
# Optional env: START_AT (first site to consider, default 1), MAX_SITES (last site to run, default all).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p results/returns results/sites

total=$(grep -c . sites.txt)
last=${MAX_SITES:-$total}; [ "$last" -gt "$total" ] && last=$total
n=${START_AT:-1}
while [ "$n" -le "$last" ] && [ -f "results/returns/$n.txt" ]; do n=$((n + 1)); done
if [ "$n" -gt "$last" ]; then jq -nc --argjson total "$total" --argjson last "$last" '{done: true, total: $total, last: $last}'; exit 0; fi

url=$(sed -n "${n}p" sites.txt)
scenarios=()
if [ $((n % 5)) -eq 0 ]; then scenarios+=(tab-churn); fi
if [ $((n % 7)) -eq 0 ]; then scenarios+=(resize); fi
if [ $((n % 10)) -eq 0 ]; then scenarios+=(passkey-status); fi
if [ $((n % 25)) -eq 0 ]; then scenarios+=(close-all-tabs); fi
if [ $((n % 20)) -eq 0 ]; then scenarios+=(shutdown); fi   # always last: nothing may use the browser after it
wait_before=0
if [ "$n" -gt 1 ] && [ $(((n - 1) % 250)) -eq 0 ] && [ -f "results/returns/$((n - 1)).txt" ]; then wait_before=960; fi   # idle-reclaim probe: the controller stops a profile after 15 idle minutes

scenario_json=$(printf '%s\n' "${scenarios[@]:-}" | jq -R . | jq -sc 'map(select(length > 0))')
jq -nc --argjson n "$n" --arg url "$url" --argjson total "$total" --argjson scenarios "$scenario_json" --argjson wait "$wait_before" \
  '{done: false, n: $n, url: $url, total: $total, scenarios: $scenarios, wait_before_seconds: $wait}'
