#!/usr/bin/env bash
# Competition mode: keep one instance always on with CPU always allocated
# (instance-based billing) so the background timers (LiveResults push, ROC
# punch polling) run continuously. Costs ~$2/day — run ./idle-mode.sh after
# the event.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

gcloud run services update "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --min-instances=1 \
  --no-cpu-throttling

echo "Event mode ON — instance always running, timers active."
