#!/usr/bin/env bash
# Sets up and starts Oxygen with demo data, suitable for Google Cloud Shell
# or any local sandbox where you want a one-command "see it running".
#
# Uses the published GHCR image, so the host only needs Docker + Compose:
# no Node.js, pnpm, dependency install, or source build is required.
#
# Override OXYGEN_IMAGE to test a release or immutable SHA image.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Use the release topology (published cloud image + PostgreSQL). COMPOSE_FILE
# also makes load-showcase.sh exec psql in this stack.
export COMPOSE_FILE="$REPO_ROOT/docker-compose.release.yml"
export OXYGEN_IMAGE="${OXYGEN_IMAGE:-ghcr.io/open-orienteering/oxygen:edge}"
export OXYGEN_PORT="${OXYGEN_PORT:-8080}"
export OXYGEN_PULL_POLICY="${OXYGEN_PULL_POLICY:-always}"

# ─── 1. Pull and start the published app ─────────────────────────────────────
echo "Starting Oxygen from $OXYGEN_IMAGE..."
if [[ "$OXYGEN_PULL_POLICY" != "never" ]]; then
  docker compose pull
fi
docker compose up -d --wait oxygen
echo "  Published image is healthy."

# ─── 2. Load Demo Competition showcase ───────────────────────────────────────
echo "Loading Demo Competition showcase..."
USE_DOCKER=1 bash scripts/load-showcase.sh
echo "  Loaded."

# ─── 3. Verify the running image over HTTP ───────────────────────────────────
BASE_URL="http://127.0.0.1:$OXYGEN_PORT"
HEALTH_RESPONSE="$(curl --fail --silent --show-error "$BASE_URL/health")"
INDEX_RESPONSE="$(curl --fail --silent --show-error "$BASE_URL/")"
grep -q '"status":"ok"' <<<"$HEALTH_RESPONSE"
grep -q '<div id="root">' <<<"$INDEX_RESPONSE"

echo ""
echo "✓ Oxygen is running with the Demo Competition."
echo "  Image: $OXYGEN_IMAGE"
echo "  Open Web Preview on port $OXYGEN_PORT to access the app."
echo "  Or, locally: http://localhost:$OXYGEN_PORT"
