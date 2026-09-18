#!/usr/bin/env bash
# Dumps the agent_browser database (identities, profiles, invitations,
# leases) to a timestamped custom-format pg_dump file. Does not back up
# per-profile worker PVC data (Chromium profile directories, encrypted
# credential files); see docs/runbooks/postgres-backup-restore.md for why.
set -euo pipefail
cd "$(dirname "$0")/.."

POSTGRES_CONTAINER="${AGENT_BROWSER_POSTGRES_CONTAINER:-ai-postgres}"
BACKUP_DIR="${AGENT_BROWSER_BACKUP_DIR:-./backups}"

set -a
source .agent-browser-postgres.env
set +a

mkdir -p "$BACKUP_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
filename="agent_browser-$timestamp.dump"
out="$BACKUP_DIR/$filename"

docker exec -e PGPASSWORD="$AGENT_BROWSER_DB_PASSWORD" "$POSTGRES_CONTAINER" \
  pg_dump -U "$AGENT_BROWSER_DB_USER" -d "$AGENT_BROWSER_DB_NAME" -F custom -f "/tmp/$filename"
docker cp "$POSTGRES_CONTAINER:/tmp/$filename" "$out"
docker exec "$POSTGRES_CONTAINER" rm -f "/tmp/$filename"

test -s "$out"
docker exec -i "$POSTGRES_CONTAINER" pg_restore --list < "$out" > /dev/null
echo "backup verified and written to $out ($(du -h "$out" | cut -f1))"
