#!/bin/sh
# Automatic whole-database backups for a venue box or a self-hosted
# install (docs/ops/backup-restore.md "Automatic backups", DB-36).
#
# Runs in the compose file's `backup` service (the postgres image, so
# pg_dump matches the server). Every BACKUP_INTERVAL_SECONDS it writes
# a custom-format dump of the oxygen schema to BACKUP_DIR, first as
# .partial and renamed when pg_dump succeeded, so a file named *.dump is
# always complete. Keeps the newest BACKUP_KEEP dumps. Before a dump it
# wants twice the last dump's size free: it deletes the oldest dumps
# (never the newest two) until there is, and skips the round only if
# that is not enough, so the backups never fill the database's disk.
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

free_kb() { df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 }'; }

while true; do
  # A dump cut off by a container stop leaves a .partial behind.
  find "$BACKUP_DIR" -maxdepth 1 -name 'oxygen_*.dump.partial' -type f -delete
  last="$(ls -1t "$BACKUP_DIR"/oxygen_*.dump 2>/dev/null | head -n 1)"
  need_kb=0
  if [ -n "$last" ]; then need_kb=$(( $(wc -c < "$last") * 2 / 1024 )); fi
  # Make room from the oldest dumps, keeping the newest two.
  while free="$(free_kb)" && [ -n "$free" ] && [ "$free" -lt "$need_kb" ]; do
    oldest="$(ls -1t "$BACKUP_DIR"/oxygen_*.dump 2>/dev/null | tail -n +3 | tail -n 1)"
    [ -n "$oldest" ] || break
    echo "pg-backup: low on space (${free} KiB free, need ${need_kb}): deleting ${oldest}"
    rm -f "$oldest"
  done
  free="$(free_kb)"
  stamp="$(date -u +%Y%m%d_%H%M%S)"
  out="${BACKUP_DIR}/oxygen_${stamp}.dump"
  # An unknown free space (df failed) does not stop the backups.
  if [ -n "$free" ] && [ "$free" -lt "$need_kb" ]; then
    echo "pg-backup: SKIPPED at ${stamp}: ${free} KiB free in ${BACKUP_DIR}, need ${need_kb}" >&2
  elif pg_dump --schema=oxygen --format=custom --file="${out}.partial"; then
    mv "${out}.partial" "${out}"
    echo "pg-backup: wrote ${out} ($(wc -c < "${out}") bytes)"
    # Newest first; drop everything after the first KEEP.
    ls -1t "$BACKUP_DIR"/oxygen_*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
      rm -f "$old"
    done
  else
    echo "pg-backup: pg_dump FAILED at ${stamp}" >&2
    rm -f "${out}.partial"
  fi
  sleep "$INTERVAL"
done
