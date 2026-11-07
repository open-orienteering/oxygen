#!/usr/bin/env bash
# Load the committed Demo Competition showcase fixture into PostgreSQL.
#
# Works against either a Dockerized PostgreSQL (USE_DOCKER=1, typically the
# one in docker-compose.yml) or a native PostgreSQL running on the host.
# The fixture itself is docs/screenshots/fixtures/showcase.sql — a portable,
# anonymized dump derived from Vinterserien data. Its map is the CC0 Puit de
# Laven map with invented point features (puit-de-laven-demo.omap next to
# it; docs/demo.md, "The map"). The SQL names the map only by hash, so the
# load has three steps: insert the map_sources row from the committed .omap,
# run the SQL, then run the map re-match, which imports the document and
# pins it (docs/map-storage.md §6.9) — natively through `pnpm map:rematch`,
# under USE_DOCKER=1 through the API image's own CLI, so the Cloud Shell demo
# needs no Node on the host. It needs the v0.6.1 schema or later.
#
# The fixture is idempotent: it cascade-deletes any existing event whose
# name_id matches before re-inserting, and the map_sources row is
# content-addressed (ON CONFLICT DO NOTHING), so re-running is safe.
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
#                   native client, and the re-match inside the API
#                   service. Host / port from PG_* are ignored.
#   API_SERVICE     The compose service that runs the API image, for the
#                   re-match under USE_DOCKER=1 (default: `oxygen` with
#                   docker-compose.release.yml, else `api`).
#   APPLY_SCHEMA    If 1, run `pnpm db:push` first to ensure the oxygen
#                   schema exists in the target DB. Default: 0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE="$REPO_ROOT/docs/screenshots/fixtures/showcase.sql"
MAP_FILE="$REPO_ROOT/docs/screenshots/fixtures/puit-de-laven-demo.omap"

for f in "$FIXTURE" "$MAP_FILE"; do
  if [[ ! -f "$f" ]]; then
    echo "Fixture not found: $f" >&2
    echo "Regenerate it with:  pnpm tsx scripts/anonymize-vinterserien.ts" >&2
    exit 1
  fi
done

# The map the SQL names must be the committed file.
MAP_HASH=$(grep -m1 '^INSERT INTO map_files ' "$FIXTURE" | grep -oE "'[0-9a-f]{64}', NULL\);$" | cut -c2-65 || true)
if command -v sha256sum >/dev/null 2>&1; then
  FILE_HASH=$(sha256sum "$MAP_FILE" | cut -d' ' -f1)
else
  FILE_HASH=$(shasum -a 256 "$MAP_FILE" | cut -d' ' -f1)
fi
if [[ -z "$MAP_HASH" || "$MAP_HASH" != "$FILE_HASH" ]]; then
  echo "ERROR: showcase.sql names map source '${MAP_HASH:-none}', but $(basename "$MAP_FILE") hashes to $FILE_HASH." >&2
  echo "       Re-pin with:  node scripts/patch-showcase-map.mjs" >&2
  exit 1
fi
MAP_BYTES=$(wc -c < "$MAP_FILE" | tr -d '[:space:]')

USE_DOCKER="${USE_DOCKER:-0}"
if [[ "${COMPOSE_FILE:-}" == *"docker-compose.release.yml"* ]]; then
  API_SERVICE="${API_SERVICE:-oxygen}"
else
  API_SERVICE="${API_SERVICE:-api}"
fi
APPLY_SCHEMA="${APPLY_SCHEMA:-0}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-oxygen}"
PG_PASSWORD="${PG_PASSWORD:-oxygen}"
PG_DATABASE="${PG_DATABASE:-oxygen}"
DATABASE_URL="${DATABASE_URL:-postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}?schema=oxygen}"

echo "Loading showcase fixture into PostgreSQL"
echo "  Fixture:  $FIXTURE  ($(du -h "$FIXTURE" | cut -f1))"
echo "  Map:      $MAP_FILE  ($(du -h "$MAP_FILE" | cut -f1), ${MAP_HASH:0:12})"
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

# ─── 3. Load the map source and the fixture ────────────────────
# The source row first (base64 on psql's stdin, so no file has to reach the
# database container), then the SQL, in one psql session.
showcase_sql() {
  printf "SET search_path = oxygen;\nINSERT INTO map_sources (file_hash, kind, bytes, size_bytes, file_name) VALUES ('%s', 'omap', decode('" "$MAP_HASH"
  base64 < "$MAP_FILE" | tr -d '\n'
  printf "', 'base64'), %s, '%s') ON CONFLICT (file_hash) DO NOTHING;\n" "$MAP_BYTES" "$(basename "$MAP_FILE")"
  cat "$FIXTURE"
}
echo "Loading the map source and showcase.sql..."
if [[ "$USE_DOCKER" == "1" ]]; then
  showcase_sql | docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DATABASE" \
    -v ON_ERROR_STOP=1 -q
else
  showcase_sql | PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
    -v ON_ERROR_STOP=1 -q
fi
echo "  Loaded."

# ─── 4. Import and pin the map (re-match) ──────────────────────
echo "Importing the map (map re-match for demo_competition)..."
if [[ "$USE_DOCKER" == "1" ]]; then
  docker compose exec -T "$API_SERVICE" node packages/api/dist/cli/map-rematch.js --event demo_competition
else
  ( cd "$REPO_ROOT" && DATABASE_URL="$DATABASE_URL" pnpm --silent map:rematch --event demo_competition )
fi

# ─── 5. Smoke check ────────────────────────────────────────────
SMOKE_SQL="SELECT (SELECT COUNT(*) FROM oxygen.runners r WHERE r.event_id = e.id) || ' ' || COALESCE((SELECT m.document_hash FROM oxygen.map_files m WHERE m.event_id = e.id ORDER BY m.uploaded_at DESC LIMIT 1), '-') FROM oxygen.events e WHERE e.name_id = 'demo_competition'"
if [[ "$USE_DOCKER" == "1" ]]; then
  SMOKE=$(docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DATABASE" -tAc "$SMOKE_SQL")
else
  SMOKE=$(PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -tAc "$SMOKE_SQL")
fi
read -r ROW_COUNT DOCUMENT_HASH <<<"$SMOKE"
if [[ -z "${DOCUMENT_HASH:-}" || "$DOCUMENT_HASH" == "-" ]]; then
  echo "ERROR: the demo map was not pinned (map_files.document_hash is NULL); see the re-match output above." >&2
  exit 3
fi

echo ""
echo "✓ Demo Competition loaded — $ROW_COUNT runners visible, map document ${DOCUMENT_HASH:0:12}."
echo ""
if [[ "${COMPOSE_FILE:-}" == *"docker-compose.release.yml"* ]]; then
  echo "The published-image app is ready; pick 'Demo Competition' in the browser."
else
  echo "Next steps:"
  echo "  1. Start the app:  pnpm dev"
  echo "  2. Open http://localhost:5173 and pick 'Demo Competition'."
fi
