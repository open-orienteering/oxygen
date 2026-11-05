#!/usr/bin/env bash
# Run a small Node script against the club's Cloud SQL database as a one-off
# Cloud Run job (no psql access from outside; the password lives only in the
# `oxygen-database-url` secret). The script gets DATABASE_URL and the `pg`
# client of the image; it is passed base64-encoded because `--args` splits on
# commas. Used for the slice E preflight (docs/release-slice-e.md) and for
# instance flags (docs/map-pipeline-switch.md §1).
#
# Usage:
#   ./db-job.sh <script.js> [--tag v0.5.0] [--env KEY=VALUE]...
#   ./db-job.sh jobs/map-survey.js                 # read-only survey
set -euo pipefail
SELF="$(readlink -f "$0")"
cd "$(dirname "$SELF")"
source ./env.sh

REPO_ROOT="$(git -C ../.. rev-parse --show-toplevel)"
GHCR_IMAGE="${GHCR_IMAGE:-ghcr.io/open-orienteering/oxygen}"
export GHCR_IMAGE

SCRIPT="$1"; shift
TAG="${DEPLOY_TAG:-stable}"
ENVS="DATABASE_POOL_MAX=1"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --env) ENVS="${ENVS},$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

IMAGE_REF="$(node "$REPO_ROOT/scripts/ghcr-ref.mjs" resolve "$TAG")"
NAME="$(basename "$SCRIPT" .js)"
JOB="${SERVICE}-db-${NAME}"
B64="$(base64 -w0 "$SCRIPT")"

echo "── ${JOB} with ${IMAGE_REF}"
gcloud run jobs deploy "$JOB" --project="$PROJECT_ID" --region="$REGION" --image="$IMAGE_REF" \
  --service-account="oxygen-run@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-cloudsql-instances="$SQL_CONNECTION" \
  --set-secrets="DATABASE_URL=oxygen-database-url:latest" \
  --set-env-vars="$ENVS" \
  --memory=1Gi --cpu=1 --max-retries=0 --task-timeout=900 \
  --command=sh --args=-c,"cd /app/packages/api && echo ${B64} | base64 -d > /tmp/job.js && node /tmp/job.js" --quiet
set +e
EXEC="$(gcloud run jobs execute "$JOB" --project="$PROJECT_ID" --region="$REGION" --wait --format='value(metadata.name)')"
STATUS=$?
set -e
# This execution's lines only (a job name is reused by every run).
gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=${JOB} AND labels.\"run.googleapis.com/execution_name\"=${EXEC}" \
  --project="$PROJECT_ID" --limit=200 --order=asc --freshness=20m --format='value(textPayload)' | sed '/^$/d'
exit $STATUS
