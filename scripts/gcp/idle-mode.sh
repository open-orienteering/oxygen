#!/usr/bin/env bash
# Idle mode (default): scale to zero between competitions. The app wakes
# on demand (a few seconds cold start) for map-making and admin work at
# effectively zero cost, but background timers (LiveResults push, ROC
# polling) do NOT run — switch to ./event-mode.sh for competitions.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

gcloud run services update "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --min-instances=0 \
  --cpu-throttling

echo "Idle mode ON — scales to zero when unused."
