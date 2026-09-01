#!/usr/bin/env bash
# Apply pending Prisma migrations against the Cloud SQL database using a
# Cloud Run job running the same image as the service.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

JOB="${SERVICE}-migrate"

echo "── Creating/updating migration job…"
gcloud run jobs deploy "$JOB" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="${IMAGE}:latest" \
  --service-account="oxygen-run@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-cloudsql-instances="$SQL_CONNECTION" \
  --set-secrets="DATABASE_URL=oxygen-database-url:latest" \
  --memory=1Gi \
  --max-retries=0 \
  --task-timeout=600 \
  --command=sh \
  --args=-c,"cd packages/api && node_modules/.bin/prisma migrate deploy"

echo "── Executing…"
gcloud run jobs execute "$JOB" --project="$PROJECT_ID" --region="$REGION" --wait
