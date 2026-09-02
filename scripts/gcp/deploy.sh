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

if [[ -z "${OXYGEN_ADMIN_EMAILS:-}" ]]; then
  echo "!! OXYGEN_ADMIN_EMAILS is unset in env.sh — with AUTH_MODE=proxy nobody" >&2
  echo "   will be able to open /admin/users. See env.sh.example." >&2
fi

echo "── Deploying to Cloud Run…"
gcloud run deploy "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="${IMAGE}:latest" \
  --service-account="oxygen-run@${PROJECT_ID}.iam.gserviceaccount.com" \
  --add-cloudsql-instances="$SQL_CONNECTION" \
  --set-secrets="DATABASE_URL=oxygen-database-url:latest" \
  --set-env-vars="^;^NODE_OPTIONS=--max-old-space-size=3328;DATABASE_POOL_MAX=10;AUTH_MODE=proxy;AUTH_HEADER=x-goog-authenticated-user-email;AUTH_AUTO_PROVISION=member;OXYGEN_ADMIN_EMAILS=${OXYGEN_ADMIN_EMAILS:-}" \
  --memory=4Gi \
  --cpu=1 \
  --timeout=300 \
  --max-instances=2 \
  --min-instances=0 \
  --cpu-throttling \
  --no-allow-unauthenticated

# The ^;^ prefix picks ';' as the env-var separator. The default ',' would
# split a multi-admin OXYGEN_ADMIN_EMAILS list, and '@' splits inside every
# email address; ';' is legal in neither an address nor any value below.
#
# Why these limits (see docs/deploy-gcp-cloud-run.md §Sizing):
#  - 4 GiB: the tile renderer itself now needs only a few hundred MB (it
#    rasterises a window per block of tiles, not the whole map), but
#    parsing a large club OCAD into an SVG DOM still spikes. The
#    MAP_RASTER_* caps that used to be needed here are gone with the
#    whole-map raster they bounded.
#  - max-instances=2 + DATABASE_POOL_MAX=10: the ceiling here is Cloud
#    SQL connections, not the code. A db-f1-micro allows 25 and reserves
#    3 for superuser, so two instances at 10 each leaves room for the
#    migration job. The background jobs that genuinely need one runner
#    (LiveResults push, ROC polling, journal shipping) elect a leader
#    through oxygen.instance_lease, so extra instances only serve
#    requests. To scale further, raise the Cloud SQL tier first —
#    db-g1-small allows 50 — then raise both numbers together.

echo
echo "Deployed. If this is the first deploy:"
echo "  1. Run ./migrate.sh to apply the Prisma migrations."
echo "  2. Enable IAP + grant users access (docs/deploy-gcp-cloud-run.md §IAP)."
