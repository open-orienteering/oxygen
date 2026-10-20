#!/usr/bin/env bash
# Run the map-document backfill (docs/map-storage.md §6.7) against the club's
# Cloud SQL database as a Cloud Run job, using the same image selection as
# deploy.sh so the CLI, the Prisma client and the schema are the ones the
# service runs. Nothing here touches the service itself.
#
# Usage:
#   ./backfill.sh --dry-run                 # plan only: lists rows a run would touch
#   ./backfill.sh                           # run with the DEPLOY_TAG image (env.sh), else :stable
#   ./backfill.sh --tag edge --dry-run      # pick the image explicitly
#   ./backfill.sh --event <nameId>          # club rows + that event's rows only
#   ./backfill.sh --limit 5                 # at most n maps this run
#
# Re-runnable by construction: a run only revisits rows still missing a
# document. Exit 1 if any map failed (the gate for slice A is zero failures).
# See docs/release-slice-a.md.
set -euo pipefail
SELF="$(readlink -f "$0")"
cd "$(dirname "$SELF")"
source ./env.sh

REPO_ROOT="$(git -C ../.. rev-parse --show-toplevel)"
GHCR_IMAGE="${GHCR_IMAGE:-ghcr.io/open-orienteering/oxygen}"
export GHCR_IMAGE

TAG="${DEPLOY_TAG:-stable}"
CLI_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,17p' "$SELF" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      CLI_ARGS+=("$1")
      shift
      ;;
  esac
done

IMAGE_REF="$(node "$REPO_ROOT/scripts/ghcr-ref.mjs" resolve "$TAG")"
JOB="${SERVICE}-map-backfill"

# The CLI takes its flags as plain argv; pass them through unchanged.
CLI="node packages/api/dist/cli/map-backfill.js"
if [[ ${#CLI_ARGS[@]} -gt 0 ]]; then
  CLI="$CLI $(printf '%q ' "${CLI_ARGS[@]}")"
fi

echo "── Backfill job ${JOB} with ${IMAGE_REF}"
echo "   command: ${CLI}"
# Club-full peaks at ~360 MB RSS for the thumbnail alone; one map at a time.
# The club's Cloud SQL tier allows 25 connections: the service holds up to
# 8 per instance (two instances), so this job gets a pool of 2.
gcloud run jobs deploy "$JOB" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE_REF" \
  --service-account="oxygen-run@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-cloudsql-instances="$SQL_CONNECTION" \
  --set-secrets="DATABASE_URL=oxygen-database-url:latest" \
  --set-env-vars="DATABASE_POOL_MAX=2,NODE_OPTIONS=--max-old-space-size=1536" \
  --memory=2Gi \
  --cpu=2 \
  --max-retries=0 \
  --task-timeout=3600 \
  --command=sh \
  --args=-c,"cd /app && ${CLI}" \
  --quiet

echo "── Executing…"
set +e
gcloud run jobs execute "$JOB" --project="$PROJECT_ID" --region="$REGION" --wait
STATUS=$?
set -e

echo "── Job log (last 200 lines):"
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=${JOB}" \
  --project="$PROJECT_ID" --limit=200 --order=asc \
  --format='value(textPayload)' --freshness=2h | sed '/^$/d' | tail -200

if [[ $STATUS -ne 0 ]]; then
  echo "!! Backfill finished with failures (exit ${STATUS}). Re-run after fixing; only rows still missing a document are revisited." >&2
  exit "$STATUS"
fi
echo "Backfill finished with zero failures."
