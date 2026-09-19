#!/bin/bash
# Builds results/REPORT.md from results/progress.tsv and the per-site logs in results/sites/*.json.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f results/progress.tsv ] || { echo "no results yet" >&2; exit 1; }
out=results/REPORT.md

valid=()
for f in results/sites/*.json; do [ -e "$f" ] && jq -e . "$f" >/dev/null 2>&1 && valid+=("$f"); done
if [ "${#valid[@]}" -gt 0 ]; then logs=$(jq -s '.' "${valid[@]}"); else logs='[]'; fi

{
echo "# Burrowser crawl test report"
echo; echo "Generated $(date -u +%FT%TZ). Source: \`$(head -1 sites.meta.txt 2>/dev/null || echo unknown)\`"
echo; echo "## Overview"; echo
awk -F'\t' 'NR>1 { total++; st[$3]++; pages+=$4; faults+=$5; secs+=$6; if ($6>max) max=$6 }
  END { printf "- Sites recorded: %d\n- Pages fetched (as returned): %d\n- Sites reporting a Burrowser fault: %d\n- Time in subagent calls: %d s (mean %.1f s, max %d s)\n", total, pages, faults, secs, (total ? secs/total : 0), max
        printf "- By status:"; for (s in st) printf " %s=%d", s, st[s]; printf "\n" }' results/progress.tsv
echo "- Detailed logs present for $(echo "$logs" | jq length) of $(($(wc -l < results/progress.tsv) - 1)) sites"

echo; echo "## Burrowser faults (errors from the tool layer, not the website)"; echo
echo "$logs" | jq -r '[.[] | .n as $n | (.burrowser_faults // [])[] | "- site \($n): `\(.tool // "?")`: \(.error // "?")"] | if length == 0 then ["_none logged_"] else . end | .[]'
awk -F'\t' 'NR>1 && $5==1 {print "- site " $1 " (" $2 ") returned a FAULTS line"}' results/progress.tsv

echo; echo "## Scenario outcomes"; echo
echo "$logs" | jq -r '[.[] | .n as $n | (.scenarios // {}) | to_entries[] | {name: .key, n: $n, ok: (.value.ok // false), detail: (.value.detail // "")}]
  | group_by(.name)[] | "- **\(.[0].name)**: ran \(length), ok \(map(select(.ok)) | length)" + (if (map(select(.ok | not)) | length) > 0 then "; failed: " + (map(select(.ok | not)) | map("site \(.n): \(.detail)") | join(" | ")) else "" end)'

echo; echo "## Website error classes"; echo
echo "$logs" | jq -r '[.[] | (.site_errors // [])[] | .class // "other"] | group_by(.)[] | "- \(.[0]): \(length)"' | sort
echo "$logs" | jq -r '[.[] | (.pages // [])[] | select(.outcome == "error")] | "- pages that failed to load: \(length)"'

echo; echo "## Browser tool usage and page health"; echo
echo "$logs" | jq -r '[.[] | (.telemetry.tools_used // {}) | to_entries[]] | group_by(.key)[] | "- `\(.[0].key)`: \(map(.value) | add)"'
echo "$logs" | jq -r '"- console errors seen: \([.[] | .telemetry.console_errors // 0] | add // 0)", "- failed network requests seen: \([.[] | .telemetry.failed_requests // 0] | add // 0)"'

echo; echo "## Slowest 10 sites"; echo
awk -F'\t' 'NR>1 {print $6 "\t" $1 "\t" $2}' results/progress.tsv | sort -rn | head -10 | awk -F'\t' '{print "- site " $2 " " $3 ": " $1 " s"}'

echo; echo "## Malformed subagent replies"; echo
awk -F'\t' 'NR>1 && $3=="malformed" {print "- site " $1 " " $2}' results/progress.tsv | { grep . || echo "_none_"; }
} > "$out"
echo "wrote $out"
