#!/usr/bin/env bash
# Deploy a published GHCR image to Cloud Run, then apply Prisma migrations
# with that same image. Club Cloud Run is never updated from GitHub Actions.
#
# Usage:
#   ./deploy.sh                 # DEPLOY_TAG from env.sh, else :stable
#   ./deploy.sh v1.2.3
#   ./deploy.sh edge
#   ./deploy.sh sha-<40-char-commit>
#   ./deploy.sh --from-source   # Cloud Build from this working tree (fallback)
#   ./deploy.sh --migrate-only [tag]
#
# Scaling (idle vs event mode) is preserved from the running service.
# See docs/deploy-gcp-cloud-run.md and docs/releases-and-images.md.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--from-source | --migrate-only] [tag]

  tag            GHCR tag (v1.2.3, edge, sha-<commit>), digest, or full image ref.
                 Default: \$DEPLOY_TAG from env.sh, otherwise stable.
  --from-source  Build this working tree with Cloud Build and deploy :latest
                 from Artifact Registry instead of GHCR.
  --migrate-only Apply Prisma migrations without changing the Cloud Run service.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

source ./env.sh

REPO_ROOT="$(git -C ../.. rev-parse --show-toplevel)"
GHCR_IMAGE="${GHCR_IMAGE:-ghcr.io/open-orienteering/oxygen}"
export GHCR_IMAGE

FROM_SOURCE=0
MIGRATE_ONLY=0
TAG_INPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-source)
      FROM_SOURCE=1
      shift
      ;;
    --migrate-only)
      MIGRATE_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$TAG_INPUT" ]]; then
        echo "Unexpected extra argument: $1" >&2
        usage >&2
        exit 1
      fi
      TAG_INPUT="$1"
      shift
      ;;
  esac
done

if [[ "$FROM_SOURCE" -eq 1 && -n "$TAG_INPUT" ]]; then
  echo "--from-source cannot be combined with an image tag." >&2
  exit 1
fi

resolve_image_ref() {
  node "$REPO_ROOT/scripts/ghcr-ref.mjs" resolve "$1"
}

# Read min-instances / CPU throttling from the live service so a deploy
# during a competition does not flip the club back to idle mode.
read_scaling() {
  local json min throttle
  if ! json="$(gcloud run services describe "$SERVICE" \
    --project="$PROJECT_ID" --region="$REGION" --format=json 2>/dev/null)"; then
    MIN_INSTANCES=0
    CPU_THROTTLING=1
    return
  fi
  min="$(printf '%s' "$json" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const ann = d.spec?.template?.metadata?.annotations || {};
process.stdout.write(String(ann["autoscaling.knative.dev/minScale"] || "0"));
')"
  throttle="$(printf '%s' "$json" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const ann = d.spec?.template?.metadata?.annotations || {};
process.stdout.write(String(ann["run.googleapis.com/cpu-throttling"] || "true"));
')"
  MIN_INSTANCES="${min:-0}"
  if [[ "$throttle" == "false" ]]; then
    CPU_THROTTLING=0
  else
    CPU_THROTTLING=1
  fi
}

run_migrate() {
  local image_ref="$1"
  local job="${SERVICE}-migrate"
  echo "── Applying Prisma migrations with ${image_ref}…"
  gcloud run jobs deploy "$job" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --image="$image_ref" \
    --service-account="oxygen-run@${PROJECT_ID}.iam.gserviceaccount.com" \
    --set-cloudsql-instances="$SQL_CONNECTION" \
    --set-secrets="DATABASE_URL=oxygen-database-url:latest" \
    --memory=1Gi \
    --max-retries=0 \
    --task-timeout=600 \
    --command=sh \
    --args=-c,"cd packages/api && node_modules/.bin/prisma migrate deploy"
  gcloud run jobs execute "$job" --project="$PROJECT_ID" --region="$REGION" --wait
}

run_cloud_run_deploy() {
  local image_ref="$1"
  local cpu_flag="--cpu-throttling"
  if [[ "$CPU_THROTTLING" -eq 0 ]]; then
    cpu_flag="--no-cpu-throttling"
  fi

  if [[ -z "${OXYGEN_ADMIN_EMAILS:-}" ]]; then
    echo "!! OXYGEN_ADMIN_EMAILS is unset in env.sh — with AUTH_MODE=proxy nobody" >&2
    echo "   will be able to open /admin/users. See env.sh.example." >&2
  fi

  echo "── Deploying ${image_ref} to Cloud Run (min-instances=${MIN_INSTANCES}, cpu-throttling=${CPU_THROTTLING})…"
  gcloud run deploy "$SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --image="$image_ref" \
    --service-account="oxygen-run@${PROJECT_ID}.iam.gserviceaccount.com" \
    --add-cloudsql-instances="$SQL_CONNECTION" \
    --set-secrets="DATABASE_URL=oxygen-database-url:latest" \
    --set-env-vars="^;^NODE_OPTIONS=--max-old-space-size=3328;DATABASE_POOL_MAX=8;MAP_RENDER_CONCURRENCY=3;AUTH_MODE=proxy;AUTH_HEADER=x-goog-authenticated-user-email;AUTH_AUTO_PROVISION=member;OXYGEN_ADMIN_EMAILS=${OXYGEN_ADMIN_EMAILS:-};OXYGEN_DEPLOY_REF=${DEPLOY_REF}" \
    --memory=4Gi \
    --cpu=2 \
    --timeout=300 \
    --max-instances=2 \
    --min-instances="$MIN_INSTANCES" \
    "$cpu_flag" \
    --no-allow-unauthenticated

  echo "── Normalising service-level max instances…"
  gcloud run services update "$SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --max=2
}

IMAGE_REF=""
DEPLOY_REF=""
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  BUILD_ID="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)-$(date +%Y%m%d%H%M%S)"
  echo "── Building working tree with Cloud Build (BUILD_ID=${BUILD_ID})…"
  gcloud builds submit "$REPO_ROOT" \
    --project="$PROJECT_ID" \
    --config="$REPO_ROOT/scripts/gcp/cloudbuild.yaml" \
    --substitutions="_IMAGE=${IMAGE},_BUILD_ID=${BUILD_ID}"
  IMAGE_REF="${IMAGE}:latest"
  DEPLOY_REF="source-${BUILD_ID}"
else
  SELECTED="${TAG_INPUT:-${DEPLOY_TAG:-stable}}"
  IMAGE_REF="$(resolve_image_ref "$SELECTED")"
  DEPLOY_REF="$SELECTED"
  echo "── Using published image ${IMAGE_REF}"
fi

run_migrate "$IMAGE_REF"

if [[ "$MIGRATE_ONLY" -eq 1 ]]; then
  echo
  echo "Migrations applied. Cloud Run service was not updated."
  exit 0
fi

read_scaling
run_cloud_run_deploy "$IMAGE_REF"

echo
echo "Deployed ${IMAGE_REF}."
echo "  If this is the first deploy:"
echo "    1. Enable IAP + grant users access (docs/deploy-gcp-cloud-run.md §IAP)."
echo "  Idle vs event mode is unchanged; use ./event-mode.sh / ./idle-mode.sh to switch."
