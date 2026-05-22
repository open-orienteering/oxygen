#!/usr/bin/env bash
# Sets up and starts Oxygen with demo data, suitable for Google Cloud Shell
# or any local sandbox where you want a one-command "see it running".
#
# Steps:
#   1. Start the PostgreSQL container (postgres:18-alpine).
#   2. Apply the latest oxygen schema with `pnpm db:push`.
#   3. Load the committed Demo Competition showcase fixture.
#   4. Build and start the API + web containers.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ─── 1. Start PostgreSQL ─────────────────────────────────────────────────────
echo "Starting PostgreSQL..."
docker compose up -d postgres

echo "Waiting for PostgreSQL to accept connections..."
until docker compose exec -T postgres pg_isready -U oxygen -d oxygen >/dev/null 2>&1; do
  sleep 1
done
echo "  PostgreSQL is ready."

# Pick a DATABASE_URL that targets the docker postgres from the host.
# The container exposes 5432 → 5432.
export DATABASE_URL="postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen"

# ─── 2. Apply oxygen schema ──────────────────────────────────────────────────
echo "Applying oxygen schema..."
pnpm --filter @oxygen/api db:push >/dev/null
echo "  Schema applied."

# ─── 3. Load Demo Competition showcase ───────────────────────────────────────
echo "Loading Demo Competition showcase..."
bash scripts/load-showcase.sh
echo "  Loaded."

# ─── 4. Start API and web ────────────────────────────────────────────────────
echo "Building and starting Oxygen (first run takes ~1 min)..."
docker compose up -d --build api web

echo ""
echo "✓ Oxygen is running with the Demo Competition."
echo "  Open Web Preview on port 8080 to access the app."
echo "  Or, locally: http://localhost:8080"
