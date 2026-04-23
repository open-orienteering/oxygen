#!/usr/bin/env bash
# Load the committed Demo Competition showcase fixture into a MySQL server.
#
# Works against either a Dockerized MySQL (USE_DOCKER=1, typically the one in
# docker-compose.yml) or a native MySQL running on the host. The fixture itself
# is docs/screenshots/fixtures/showcase.sql — a portable, anonymized dump
# derived from Vinterserien data (see scripts/anonymize-vinterserien.ts).
#
# Usage:
#   # Dockerized MySQL (Cloud Shell demo, local docker compose)
#   USE_DOCKER=1 bash scripts/load-showcase.sh
#
#   # Native MySQL on host (typical dev setup)
#   bash scripts/load-showcase.sh
#
#   # Load into a custom database name (e.g. for parallel experiments)
#   DB_NAME=demo2 bash scripts/load-showcase.sh
#
#   # Drop and recreate the target DB if it already exists
#   FORCE=1 bash scripts/load-showcase.sh
#
# Environment variables:
#   DB_NAME         Target competition database (default: demo_competition)
#   MYSQL_HOST      MySQL host             (default: localhost)
#   MYSQL_PORT      MySQL port             (default: 3306)
#   MYSQL_USER      MySQL user             (default: root)
#   MYSQL_PASSWORD  MySQL password         (default: empty)
#   USE_DOCKER      If 1, use `docker compose exec mysql ...` instead of a
#                   native `mysql` client. Host/port are ignored in that mode.
#   FORCE           If 1, DROP DATABASE $DB_NAME before creating it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE="$REPO_ROOT/docs/screenshots/fixtures/showcase.sql"

if [[ ! -f "$FIXTURE" ]]; then
  echo "Fixture not found: $FIXTURE" >&2
  echo "Regenerate it with:  pnpm tsx scripts/anonymize-vinterserien.ts" >&2
  exit 1
fi

DB_NAME="${DB_NAME:-demo_competition}"
MYSQL_HOST="${MYSQL_HOST:-localhost}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"
USE_DOCKER="${USE_DOCKER:-0}"
FORCE="${FORCE:-0}"

# Anything that ran showcase.sql into a DB other than demo_competition needs
# the oEvent.NameId inside the fixture rewritten so the backend can find it.
# A simple sed on the piped SQL does the trick without touching the committed
# fixture.
prepare_sql() {
  if [[ "$DB_NAME" == "demo_competition" ]]; then
    cat "$FIXTURE"
  else
    sed "s/'demo_competition'/'${DB_NAME}'/g" "$FIXTURE"
  fi
}

# Build the argv used to invoke the `mysql` CLI, plus a friendly label.
if [[ "$USE_DOCKER" == "1" ]]; then
  MYSQL_DESC="docker compose exec mysql (user=$MYSQL_USER)"
  mysql_cmd() {
    if [[ -n "$MYSQL_PASSWORD" ]]; then
      docker compose exec -T mysql mysql -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$@"
    else
      docker compose exec -T mysql mysql -u "$MYSQL_USER" "$@"
    fi
  }
else
  MYSQL_DESC="$MYSQL_USER@$MYSQL_HOST:$MYSQL_PORT (native)"
  mysql_cmd() {
    if [[ -n "$MYSQL_PASSWORD" ]]; then
      mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$@"
    else
      mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" "$@"
    fi
  }
fi

echo "Target MySQL : $MYSQL_DESC"
echo "Target DB    : $DB_NAME"
echo "Fixture      : $FIXTURE"
echo

# ── 1. Create target + MeOSMain (drop if FORCE=1) ──────────────────────────
if [[ "$FORCE" == "1" ]]; then
  echo "FORCE=1 — dropping existing $DB_NAME if present…"
  mysql_cmd -e "DROP DATABASE IF EXISTS \`${DB_NAME}\`;"
fi

echo "Ensuring databases exist…"
mysql_cmd -e "
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS MeOSMain CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
"

# ── 2. Make sure MeOSMain has the schema Oxygen expects ────────────────────
# The loader is usable on fresh Cloud Shell boxes where MeOSMain is empty,
# so apply the checked-in schema if (and only if) oEvent doesn't already exist.
HAS_OEVENT="$(mysql_cmd -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='MeOSMain' AND table_name='oEvent';" 2>/dev/null || echo 0)"
if [[ "${HAS_OEVENT//[[:space:]]/}" == "0" ]]; then
  echo "Applying MeOSMain schema (packages/api/prisma/meos-schema.sql)…"
  if [[ "$USE_DOCKER" == "1" ]]; then
    mysql_cmd MeOSMain < "$REPO_ROOT/packages/api/prisma/meos-schema.sql"
  else
    mysql_cmd MeOSMain < "$REPO_ROOT/packages/api/prisma/meos-schema.sql"
  fi
fi

# ── 3. Pipe the fixture into the target DB ─────────────────────────────────
echo "Loading fixture into \`${DB_NAME}\`…"
prepare_sql | mysql_cmd "$DB_NAME"

# ── 4. Register the competition in MeOSMain.oEvent ─────────────────────────
# MeOS requires that MeOSMain.oEvent.Id == <competition_db>.oEvent.Id for a
# given NameId. MeOSMain.oEvent has only a PRIMARY KEY on Id (no UNIQUE on
# NameId), so we can't blindly INSERT … ON DUPLICATE KEY — if a row with the
# same Id but a different NameId already exists (parallel demo DBs), that
# would overwrite the wrong registration. Instead: pick an Id that actually
# fits, then sync the competition DB's oEvent.Id to match.
FIXTURE_EVENT_ID="$(mysql_cmd -N -B -e "SELECT Id FROM \`${DB_NAME}\`.oEvent LIMIT 1;")"
FIXTURE_EVENT_ID="${FIXTURE_EVENT_ID//[[:space:]]/}"
if [[ -z "$FIXTURE_EVENT_ID" ]]; then
  echo "Could not read oEvent.Id from ${DB_NAME}. Fixture load likely failed." >&2
  exit 1
fi

# Existing row for this NameId → reuse its Id (idempotent reloads).
EXISTING_ID="$(mysql_cmd -N -B -e "SELECT Id FROM MeOSMain.oEvent WHERE NameId='${DB_NAME}' LIMIT 1;")"
EXISTING_ID="${EXISTING_ID//[[:space:]]/}"

if [[ -n "$EXISTING_ID" ]]; then
  TARGET_ID="$EXISTING_ID"
  mysql_cmd MeOSMain -e "
    UPDATE oEvent
    SET Name='Demo Competition', Date='2026-03-15', Version=96, Removed=0
    WHERE Id=${TARGET_ID};
  "
else
  FIXTURE_ID_FREE="$(mysql_cmd -N -B -e "SELECT COUNT(*) FROM MeOSMain.oEvent WHERE Id=${FIXTURE_EVENT_ID};")"
  FIXTURE_ID_FREE="${FIXTURE_ID_FREE//[[:space:]]/}"
  if [[ "$FIXTURE_ID_FREE" == "0" ]]; then
    TARGET_ID="$FIXTURE_EVENT_ID"
    mysql_cmd MeOSMain -e "
      INSERT INTO oEvent (Id, Name, Date, NameId, Version, Annotation, Removed)
      VALUES (${TARGET_ID}, 'Demo Competition', '2026-03-15', '${DB_NAME}', 96, '', 0);
    "
  else
    mysql_cmd MeOSMain -e "
      INSERT INTO oEvent (Name, Date, NameId, Version, Annotation, Removed)
      VALUES ('Demo Competition', '2026-03-15', '${DB_NAME}', 96, '', 0);
    "
    TARGET_ID="$(mysql_cmd -N -B -e "SELECT Id FROM MeOSMain.oEvent WHERE NameId='${DB_NAME}' ORDER BY Id DESC LIMIT 1;")"
    TARGET_ID="${TARGET_ID//[[:space:]]/}"
  fi
fi

# Keep the competition DB's oEvent.Id aligned with MeOSMain.oEvent.Id.
if [[ "$TARGET_ID" != "$FIXTURE_EVENT_ID" ]]; then
  mysql_cmd "$DB_NAME" -e "UPDATE oEvent SET Id=${TARGET_ID} WHERE Id=${FIXTURE_EVENT_ID};"
fi

echo "Registered competition in MeOSMain.oEvent (Id=${TARGET_ID}, NameId=${DB_NAME})."

echo
echo "✓ Demo Competition loaded into \`${DB_NAME}\`."
echo "  Open Oxygen and pick 'Demo Competition' in the competition selector."
