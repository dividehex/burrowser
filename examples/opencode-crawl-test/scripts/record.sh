#!/bin/bash
# Records a subagent's reply for site N and appends a line to results/progress.tsv.
# Usage: scripts/record.sh N START_EPOCH END_EPOCH REPLY_FILE
set -euo pipefail
cd "$(dirname "$0")/.."
n=$1; start=$2; end=$3; reply=$4
mkdir -p results/returns
# The task tool wraps a subagent's reply in <task...> tags and a code fence; keep only the reply itself.
sed -E '/^<\/?task(_result)?[ >]/d; /^<\/?task_result>$/d; /^```[a-z]*$/d' "$reply" > "results/returns/$n.txt"
f="results/returns/$n.txt"

url=$(sed -n "${n}p" sites.txt)
status=$(sed -n 's/^STATUS: *//p' "$f" | head -1 | awk '{print $1}')
pages=$(sed -n 's/^PAGES: *//p' "$f" | head -1 | awk '{print $1}')
faults=$(sed -n 's/^FAULTS: *//p' "$f" | head -1)
case "$status" in ok|partial|failed|skipped) ;; *) status=malformed ;; esac
case "$pages" in ''|*[!0-9]*) pages=0 ;; esac
case "${faults:-none}" in none|None|NONE|'-') fault=0 ;; *) fault=1 ;; esac

[ -f results/progress.tsv ] || printf 'n\turl\tstatus\tpages\tburrowser_fault\tseconds\n' > results/progress.tsv
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$url" "$status" "$pages" "$fault" "$((end - start))" >> results/progress.tsv
echo "site $n $url: $status, $pages pages, burrowser_fault=$fault, $((end - start))s"
