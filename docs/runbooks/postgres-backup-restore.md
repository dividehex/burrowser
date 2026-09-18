# PostgreSQL backup and restore

## Scope

This runbook covers the `burrowser` PostgreSQL database only: agent
identities, profiles, enrollment invitations, and control leases (the
durable state described in `db/migrations/001_initial.sql`).

It deliberately does **not** cover per-profile worker PVC data (the
Chromium profile directory and the encrypted virtual-credential file each
worker mounts). That data is treated as disposable session state by
design: a profile's PVC can always be recreated by opening a new profile,
the encrypted credential store already persists atomically on its own
(`worker/src/persistence.ts`), and there is no CSI snapshot capability on
the `burrowser-local-path` StorageClass in this single-node cluster to
back it up cheaply. If that changes (e.g. a CSI driver with snapshot
support is added), this runbook should be extended to cover volume
snapshots as well.

## Prerequisites

- `docker` access to the external PostgreSQL container that hosts the
  `burrowser` database.
- `.burrowser-postgres.env` present and readable (holds the isolated
  `burrowser` role's own credentials; no admin/superuser access is
  needed for either backup or restore).

## Backup

```sh
./scripts/backup-postgres.sh
```

Writes a timestamped custom-format `pg_dump` to `./backups/` (gitignored)
and verifies it with `pg_restore --list` before reporting success. Set
`BURROWSER_BACKUP_DIR` to write elsewhere (e.g. a mounted network
share) and `BURROWSER_POSTGRES_CONTAINER` if the container isn't named
`ai-postgres`.

Recommended cadence: daily, plus one before any risky operation (a schema
migration, a Helm upgrade that changes `postgres.enabled`, or manual data
surgery). Retain at least the last 7 daily backups; there is currently no
automated pruning, so old backups under `./backups/` should be deleted
manually or by an external retention job.

## Restore

**Restoring overwrites live data.** Take a fresh backup first if there is
any live data worth keeping.

```sh
./scripts/restore-postgres.sh ./backups/burrowser-<timestamp>.dump
```

The script requires typing the database name to confirm before it does
anything destructive. It restores with `pg_restore --clean --if-exists
--no-owner`, which drops and recreates the app role's own tables in place
— it never drops the database or role, so only the app role's own
credentials are needed (no admin/superuser access, unlike a `DROP
DATABASE`-based approach).

After restoring, restart the controller (`kubectl rollout restart
deployment/burrowser-controller -n burrowser`) so its in-process
reconciliation state is rebuilt from the restored rows, and confirm
`/health` returns 200.

## Verifying a backup without touching live data

To prove a specific backup file actually restores correctly, restore it
into a disposable, throwaway PostgreSQL container rather than the live
database:

```sh
docker run -d --name pg-restore-check -e POSTGRES_PASSWORD=test postgres:17
docker cp ./backups/burrowser-<timestamp>.dump pg-restore-check:/tmp/check.dump
docker exec pg-restore-check createdb -U postgres burrowser_check
docker exec pg-restore-check pg_restore -U postgres -d burrowser_check --no-owner /tmp/check.dump
docker exec pg-restore-check psql -U postgres -d burrowser_check -c \
  "SELECT 'agents', count(*) FROM agents UNION ALL SELECT 'profiles', count(*) FROM profiles;"
docker rm -f pg-restore-check
```

This was done for the first backup taken under this runbook
(`burrowser-20260918T014315Z.dump`): the restore completed without
error and table row counts matched the live database at backup time.

## What this does not protect against

- Point-in-time recovery: only whatever was captured at the last backup
  is recoverable; there is no WAL archiving configured.
- Corruption or data loss in the Compose Postgres container's own
  underlying volume between backups.
- Loss of `.burrowser-postgres.env` itself, which holds the
  connection credentials these scripts depend on. Keep a copy somewhere
  safe outside this checkout (it is gitignored and 0600 for a reason —
  don't commit it).
