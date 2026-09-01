#!/usr/bin/env bash
# Build the `cloud` image with Cloud Build and deploy it to Cloud Run.
# Deploys in idle mode (scale-to-zero, request-based billing); run
# ./event-mode.sh before a competition. See docs/deploy-gcp-cloud-run.md.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

REPO_ROOT="$(git -C ../.. rev-parse --show-toplevel)"

# Version identity reported by /api/version — the web client shows its
# "update available" prompt when this changes, so it must be unique per
# build but stable across container restarts.
BUILD_ID="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)-$(date +%Y%m%d%H%M%S)"

echo "── Building image with Cloud Build (BUILD_ID=${BUILD_ID})…"
gcloud builds submit "$REPO_ROOT" \
  --project="$PROJECT_ID" \
  --config="$REPO_ROOT/scripts/gcp/cloudbuild.yaml" \
  --substitutions="_IMAGE=${IMAGE},_BUILD_ID=${BUILD_ID}"

echo "── Deploying to Cloud Run…"
gcloud run deploy "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="${IMAGE}:latest" \
  --service-account="oxygen-run@${PROJECT_ID}.iam.gserviceaccount.com" \
  --add-cloudsql-instances="$SQL_CONNECTION" \
  --set-secrets="DATABASE_URL=oxygen-database-url:latest" \
  --set-env-vars="NODE_OPTIONS=--max-old-space-size=3328,MAP_RASTER_MAX_PIXELS=200000000,MAP_RASTER_CACHE_EVENTS=1" \
  --memory=4Gi \
  --cpu=1 \
  --timeout=300 \
  --max-instances=1 \
  --min-instances=0 \
  --cpu-throttling \
  --no-allow-unauthenticated

# Why these limits (see docs/deploy-gcp-cloud-run.md §Sizing):
#  - MAP_RASTER_MAX_PIXELS=200M: map rasterisation peaks at ~2× 4 bytes/px;
#    the 800M-px default OOM-killed the 4 GiB container (signal 9 loops).
#  - MAP_RASTER_CACHE_EVENTS=1: each cached event bitmap holds up to 800 MB.
#  - max-instances=1: the app keeps per-process state (map bitmap cache,
#    tile pre-cache progress); a second instance doubles memory pressure
#    and made /api/version flip-flop between instances.

echo
echo "Deployed. If this is the first deploy:"
echo "  1. Run ./migrate.sh to apply the Prisma migrations."
echo "  2. Enable IAP + grant users access (docs/deploy-gcp-cloud-run.md §IAP)."
