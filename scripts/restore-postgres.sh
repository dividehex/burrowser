#!/usr/bin/env bash
# Restores a pg_dump custom-format backup IN PLACE into the live
# agent_browser database, using only the app role's own privileges
# (pg_restore --clean --if-exists drops and recreates the role's own
# objects; it never touches the database or role itself, so no admin
# credentials are needed). DESTRUCTIVE to current data - see
# docs/runbooks/postgres-backup-restore.md before running this for real.
set -euo pipefail
cd "$(dirname "$0")/.."

DUMP_FILE="${1:?usage: restore-postgres.sh <dump-file>}"
POSTGRES_CONTAINER="${AGENT_BROWSER_POSTGRES_CONTAINER:-ai-postgres}"

set -a
source .agent-browser-postgres.env
set +a

test -f "$DUMP_FILE"

echo "This will DROP AND RESTORE every table in database '$AGENT_BROWSER_DB_NAME' from:"
echo "  $DUMP_FILE"
read -r -p "Type the database name to confirm: " confirm
[ "$confirm" = "$AGENT_BROWSER_DB_NAME" ] || { echo "Aborted: confirmation did not match."; exit 1; }

filename="restore-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker cp "$DUMP_FILE" "$POSTGRES_CONTAINER:/tmp/$filename"
docker exec -e PGPASSWORD="$AGENT_BROWSER_DB_PASSWORD" "$POSTGRES_CONTAINER" \
  pg_restore -U "$AGENT_BROWSER_DB_USER" -d "$AGENT_BROWSER_DB_NAME" --clean --if-exists --no-owner "/tmp/$filename"
docker exec "$POSTGRES_CONTAINER" rm -f "/tmp/$filename"
echo "restored $DUMP_FILE into database $AGENT_BROWSER_DB_NAME"
