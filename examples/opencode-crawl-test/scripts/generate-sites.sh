#!/bin/bash
# Regenerates sites.txt: 1000 HTTPS sites, in ranking order, for the crawl test.
#   - 990 come from the Tranco ranking (https://tranco-list.eu; Le Pochat et al., NDSS 2019): the highest-ranked
#     domains that answer over HTTPS with an HTML page, minus adult sites (a keyword denylist) and infrastructure
#     domains that serve no page (CDNs, APIs, DNS), which the probe drops.
#   - 10 are known-bad "canary" sites from canaries.txt (bad TLS, dead DNS, 404, 503, slow, long redirect chain,
#     dialogs, downloads) placed at lines 50, 150, ... 950, so failure handling is exercised at fixed points.
# Usage: scripts/generate-sites.sh            (downloads the latest list)
#        TRANCO_CSV=/path/top-1m.csv scripts/generate-sites.sh
# Needs curl, unzip, jq, awk, xargs. Takes 15-20 minutes (it probes about 3500 domains, 12 at a time).
# Env: POOL (domains considered, default 3500), PROBE_JOBS (parallel probes, default 12), TRANCO_CSV (local list).
set -euo pipefail
cd "$(dirname "$0")/.."

TOTAL=1000
CANARIES=$(grep -c . canaries.txt)
WANT=$((TOTAL - CANARIES))
POOL=${POOL:-3500}          # how many top-ranked domains to consider
JOBS=${PROBE_JOBS:-12}     # parallel probes: more than this overwhelms many home resolvers (lookups time out)
DENY='porn|xxx|xvideos|xnxx|xhamster|redtube|youporn|chaturbate|stripchat|bongacams|livejasmin|spankbang|eporner|onlyfans|fansly|brazzers|hentai|rule34|cam4|camsoda|motherless|erome|tnaflix|tube8|xtube|beeg|missav|javhd|sex\.com|escort'

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
if [ -z "${TRANCO_CSV:-}" ]; then
  meta=$(curl -sL --max-time 30 https://tranco-list.eu/api/lists/date/latest)
  source_note="Tranco list $(echo "$meta" | jq -r .list_id) created $(echo "$meta" | jq -r .created_on)"
  curl -sL --max-time 300 -o "$work/top-1m.csv.zip" https://tranco-list.eu/top-1m.csv.zip
  unzip -q -o "$work/top-1m.csv.zip" -d "$work"
  TRANCO_CSV="$work/top-1m.csv"
else
  source_note="Tranco list from local file $(basename "$TRANCO_CSV")"
fi

head -"$POOL" "$TRANCO_CSV" | tr -d '\r' | grep -Eiv ",[^,]*($DENY)" > "$work/candidates.csv"

probe() {  # "rank,domain" -> "rank domain" when https://domain/ answers 2xx/3xx (or a bot wall) with HTML
  local rank=${1%%,*} domain=${1#*,} out
  out=$(curl -sL --max-time 8 -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' \
        -o /dev/null -w '%{http_code} %{content_type}' "https://$domain/" 2>/dev/null || true)
  case "$out" in
    2*" text/html"*|3*" text/html"*|401" text/html"*|403" text/html"*|429" text/html"*) echo "$rank $domain" ;;
  esac
}
export -f probe
xargs -P "$JOBS" -I{} bash -c 'probe {}' < "$work/candidates.csv" | sort -n | head -"$WANT" > "$work/ok.txt"
[ "$(wc -l < "$work/ok.txt")" -eq "$WANT" ] || { echo "only $(wc -l < "$work/ok.txt") probed sites passed; raise POOL" >&2; exit 1; }

awk -v cf=canaries.txt 'BEGIN { while ((getline line < cf) > 0) if (line != "") canary[++nc] = line; next_c = 1 }
  { if (next_c <= nc && pos + 1 == 50 + 100 * (next_c - 1)) { print canary[next_c++]; pos++ } print "https://" $2 "/"; pos++ }' "$work/ok.txt" > sites.txt

{
  echo "source: $source_note"
  echo "generated: $(date -u +%FT%TZ)"
  echo "sites: $(wc -l < sites.txt) ($WANT ranked + $CANARIES canaries at lines 50,150,...,950)"
  echo "denylist: adult keyword denylist in scripts/generate-sites.sh; probe: HTTPS answering HTML (2xx/3xx, or 401/403/429 bot wall)"
} > sites.meta.txt
echo "wrote sites.txt ($(wc -l < sites.txt) lines)"; cat sites.meta.txt
