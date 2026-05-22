#!/usr/bin/env bash
# Load the committed Demo Competition showcase fixture into PostgreSQL.
#
# Works against either a Dockerized PostgreSQL (USE_DOCKER=1, typically the
# one in docker-compose.yml) or a native PostgreSQL running on the host.
# The fixture itself is docs/screenshots/fixtures/showcase.sql — a portable,
# anonymized dump derived from Vinterserien data
# (see scripts/anonymize-vinterserien.ts).
#
# The fixture is idempotent: it cascade-deletes any existing event whose
# name_id matches before re-inserting, so re-running is safe.
#
# Usage:
#   # Dockerized PostgreSQL (Cloud Shell demo, local `docker compose`)
#   USE_DOCKER=1 bash scripts/load-showcase.sh
#
#   # Native PostgreSQL on the host (typical dev setup)
#   bash scripts/load-showcase.sh
#
# Environment variables:
#   DATABASE_URL    Full connection string. Takes precedence over the
#                   discrete PG_* variables below. Defaults to
#                   postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen
#                   (mirrors packages/api/.env.example).
#   PG_HOST         PostgreSQL host                       (default: localhost)
#   PG_PORT         PostgreSQL port                       (default: 5432)
#   PG_USER         PostgreSQL user                       (default: oxygen)
#   PG_PASSWORD     PostgreSQL password                   (default: oxygen)
#   PG_DATABASE     PostgreSQL database                   (default: oxygen)
#   USE_DOCKER      If 1, exec `psql` inside the
#                   `docker compose` postgres service instead of using a
#                   native client. Host / port from PG_* are ignored.
#   APPLY_SCHEMA    If 1, run `pnpm db:push` first to ensure the oxygen
#                   schema exists in the target DB. Default: 0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE="$REPO_ROOT/docs/screenshots/fixtures/showcase.sql"

if [[ ! -f "$FIXTURE" ]]; then
  echo "Fixture not found: $FIXTURE" >&2
  echo "Regenerate it with:  pnpm tsx scripts/anonymize-vinterserien.ts" >&2
  exit 1
fi

USE_DOCKER="${USE_DOCKER:-0}"
APPLY_SCHEMA="${APPLY_SCHEMA:-0}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-oxygen}"
PG_PASSWORD="${PG_PASSWORD:-oxygen}"
PG_DATABASE="${PG_DATABASE:-oxygen}"
DATABASE_URL="${DATABASE_URL:-postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}?schema=oxygen}"

echo "Loading showcase fixture into PostgreSQL"
echo "  Fixture:  $FIXTURE  ($(du -h "$FIXTURE" | cut -f1))"
if [[ "$USE_DOCKER" == "1" ]]; then
  echo "  Target:   docker compose postgres → $PG_DATABASE"
else
  echo "  Target:   ${DATABASE_URL/:${PG_PASSWORD}@/:***@}"
fi
echo ""

# ─── 1. (Optional) ensure schema is current ────────────────────
if [[ "$APPLY_SCHEMA" == "1" ]]; then
  echo "Applying oxygen schema (pnpm db:push)..."
  ( cd "$REPO_ROOT" && DATABASE_URL="$DATABASE_URL" pnpm --filter @oxygen/api db:push ) >/dev/null
  echo "  Schema applied."
fi

# ─── 2. Verify schema exists ───────────────────────────────────
if [[ "$USE_DOCKER" == "1" ]]; then
  HAS_SCHEMA=$(docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DATABASE" -tAc \
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'oxygen'" 2>/dev/null \
    | tr -d '[:space:]')
else
  HAS_SCHEMA=$(PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -tAc \
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'oxygen'" 2>/dev/null \
    | tr -d '[:space:]' || true)
fi
if [[ "$HAS_SCHEMA" != "1" ]]; then
  echo "ERROR: the 'oxygen' schema doesn't exist in the target database." >&2
  echo "       Run with APPLY_SCHEMA=1, or apply manually:" >&2
  echo "         DATABASE_URL='$DATABASE_URL' pnpm --filter @oxygen/api db:push" >&2
  exit 2
fi

# ─── 3. Load the fixture ───────────────────────────────────────
echo "Loading showcase.sql..."
if [[ "$USE_DOCKER" == "1" ]]; then
  docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DATABASE" \
    -v ON_ERROR_STOP=1 -q < "$FIXTURE"
else
  PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
    -v ON_ERROR_STOP=1 -q -f "$FIXTURE"
fi
echo "  Loaded."

# ─── 4. Smoke check ────────────────────────────────────────────
if [[ "$USE_DOCKER" == "1" ]]; then
  ROW_COUNT=$(docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DATABASE" -tAc \
    "SELECT COUNT(*) FROM oxygen.runners r JOIN oxygen.events e ON e.id = r.event_id WHERE e.name_id = 'demo_competition'" \
    | tr -d '[:space:]')
else
  ROW_COUNT=$(PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -tAc \
    "SELECT COUNT(*) FROM oxygen.runners r JOIN oxygen.events e ON e.id = r.event_id WHERE e.name_id = 'demo_competition'" \
    | tr -d '[:space:]')
fi

echo ""
echo "✓ Demo Competition loaded — $ROW_COUNT runners visible."
echo ""
echo "Next steps:"
echo "  1. Start the app:  pnpm dev"
echo "  2. Open http://localhost:5173 and pick 'Demo Competition'."
