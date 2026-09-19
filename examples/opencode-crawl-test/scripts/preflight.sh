#!/bin/bash
# Checks everything the crawl test needs before it starts. Exit 1 if anything is missing.
cd "$(dirname "$0")/.."
ok=0
check() { if eval "$2" >/dev/null 2>&1; then echo "PASS  $1"; else echo "FAIL  $1  -> $3"; ok=1; fi; }
check "sites.txt has 1000 lines" '[ "$(grep -c . sites.txt)" -eq 1000 ]' "run scripts/generate-sites.sh"
check "jq and curl are installed" 'command -v jq && command -v curl' "install jq and curl"
check "BURROWSER_URL is set" '[ -n "${BURROWSER_URL:-}" ]' "export BURROWSER_URL=http://localhost:8080"
check "Burrowser gateway answers /health" 'curl -sf --max-time 5 "$BURROWSER_URL/health"' "is the gateway up at \$BURROWSER_URL?"
check "BURROWSER_CLI is an executable" '[ -x "${BURROWSER_CLI:-}" ]' "export BURROWSER_CLI=/path/to/burrowser/src/cli/main.ts"
check "identity 'crawler' is enrolled" '[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/burrowser/identities/crawler.json" ]' "burrowser admin invite | burrowser enroll --name crawler"
mkdir -p results/returns results/sites
exit $ok
