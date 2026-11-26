#!/bin/sh
# Automatic whole-database backups for a venue box or a self-hosted
# install (docs/ops/backup-restore.md "Automatic backups", DB-36).
#
# Runs in the compose file's `backup` service (the postgres image, so
# pg_dump matches the server). Every BACKUP_INTERVAL_SECONDS it writes
# a custom-format dump of the oxygen schema to BACKUP_DIR, first as
# .partial and renamed when pg_dump succeeded, so a file named *.dump is
# always complete. Keeps the newest BACKUP_KEEP dumps.
#
#   PGHOST, PGUSER, PGPASSWORD, PGDATABASE   the database (libpq variables)
#   BACKUP_DIR               default /backups (bind-mounted from the host)
#   BACKUP_INTERVAL_SECONDS  default 900 (15 minutes)
#   BACKUP_KEEP              default 48 (12 hours at the default interval)
set -u

BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-900}"
KEEP="${BACKUP_KEEP:-48}"

mkdir -p "$BACKUP_DIR"
echo "pg-backup: every ${INTERVAL}s to ${BACKUP_DIR}, keeping ${KEEP}"

while true; do
  stamp="$(date -u +%Y%m%d_%H%M%S)"
  out="${BACKUP_DIR}/oxygen_${stamp}.dump"
  if pg_dump --schema=oxygen --format=custom --file="${out}.partial"; then
    mv "${out}.partial" "${out}"
    echo "pg-backup: wrote ${out} ($(wc -c < "${out}") bytes)"
    # Newest first; drop everything after the first KEEP.
    ls -1t "${BACKUP_DIR}"/oxygen_*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
      rm -f "${old}"
    done
  else
    echo "pg-backup: pg_dump FAILED at ${stamp}" >&2
    rm -f "${out}.partial"
  fi
  sleep "${INTERVAL}"
done
