#!/usr/bin/env bash
# One-time provisioning of the GCP resources Oxygen needs:
# Artifact Registry, Cloud SQL (Postgres, smallest tier, automated
# backups), the DATABASE_URL secret, and the Cloud Run runtime service
# account. Idempotent where practical — safe to re-run after a partial
# failure. See docs/ops/deploy-gcp-cloud-run.md.
set -euo pipefail
cd "$(dirname "$0")"
source "${OXYGEN_GCP_ENV:-./env.sh}"

gcloud config set project "$PROJECT_ID"

echo "── Enabling APIs…"
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  iap.googleapis.com

echo "── Artifact Registry repo…"
gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$AR_REPO" \
    --location="$REGION" --repository-format=docker \
    --description="Oxygen images"

echo "── Cloud SQL instance (db-f1-micro, 10 GB SSD, automated backups, point-in-time recovery)…"
if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_18 \
    --edition=enterprise \
    --tier=db-f1-micro \
    --region="$REGION" \
    --storage-type=SSD \
    --storage-size=10GB \
    --storage-auto-increase \
    --backup \
    --backup-start-time=03:00 \
    --retained-backups-count=7 \
    --enable-point-in-time-recovery \
    --retained-transaction-log-days=7
fi

echo "── Database + user…"
gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1 ||
  gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"

if ! gcloud sql users list --instance="$SQL_INSTANCE" --format="value(name)" | grep -qx "$DB_USER"; then
  DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
  gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD"
  echo "── Storing DATABASE_URL in Secret Manager…"
  DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost/${DB_NAME}?host=/cloudsql/${SQL_CONNECTION}&schema=oxygen"
  printf '%s' "$DATABASE_URL" | gcloud secrets create oxygen-database-url --data-file=- 2>/dev/null ||
    printf '%s' "$DATABASE_URL" | gcloud secrets versions add oxygen-database-url --data-file=-
else
  echo "   user '$DB_USER' already exists — skipping password/secret creation."
  echo "   (To rotate: gcloud sql users set-password, then add a new secret version.)"
fi

echo "── Runtime service account…"
RUNTIME_SA="oxygen-run@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create oxygen-run --display-name="Oxygen Cloud Run runtime"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/cloudsql.client" --condition=None >/dev/null
gcloud secrets add-iam-policy-binding oxygen-database-url \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/secretmanager.secretAccessor" >/dev/null

# Venue-box sync (docs/ops/deploy-gcp-cloud-run.md "Venue-box sync through IAP"):
# the shared secret both nodes must hold (SYNC_SHARED_SECRET). Created once with
# a random value, never overwritten; deploy.sh binds it to the service when it exists.
SYNC_SECRET="${SYNC_SECRET:-oxygen-sync-secret}"
# A failing list is an error, not "absent": a blind create would then add a
# second version and change a secret the venue boxes already use.
sync_listing="$(gcloud secrets list --filter="name~/secrets/${SYNC_SECRET}$" --format='value(name)')" || {
  echo "!! gcloud secrets list failed; the sync secret was not touched." >&2
  exit 1
}
if [[ -z "$sync_listing" ]]; then
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create "$SYNC_SECRET" --data-file=- >/dev/null
  echo "── Created secret ${SYNC_SECRET} (random value)."
fi
gcloud secrets add-iam-policy-binding "$SYNC_SECRET" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/secretmanager.secretAccessor" >/dev/null
echo "── ${SYNC_SECRET}: the runtime account may read it. Re-run ./deploy.sh to bind it."
echo "   Venue boxes need the same value as SYNC_SHARED_SECRET in .env.venue:"
echo "     gcloud secrets versions access latest --secret=${SYNC_SECRET}"

# Height data (docs/ops/deploy-gcp-cloud-run.md "Height data"): the Geotorget secret is
# created by the operator with their own credential, never by this script; once it
# exists the runtime account may read it. Re-run this script after creating it.
DEM_SECRET="${DEM_SECRET:-oxygen-geotorget-credentials}"
dem_listing="$(gcloud secrets list --filter="name~/secrets/${DEM_SECRET}$" --format='value(name)')" || {
  echo "!! gcloud secrets list failed; ${DEM_SECRET} was not checked." >&2
  exit 1
}
if [[ -n "$dem_listing" ]]; then
  gcloud secrets add-iam-policy-binding "$DEM_SECRET" \
    --member="serviceAccount:${RUNTIME_SA}" --role="roles/secretmanager.secretAccessor" >/dev/null
  echo "── ${DEM_SECRET}: the runtime account may read it."
else
  echo "── No ${DEM_SECRET} secret: DEM fetch stays off. To enable Lantmäteriet's height"
  echo "   model, create it yourself (see docs/ops/deploy-gcp-cloud-run.md \"Height data\"),"
  echo "   then re-run ./provision.sh and ./deploy.sh."
fi

echo
echo "Provisioning done. Next: ./deploy.sh edge  (or a vX.Y.Z tag), then enable IAP"
echo "(see docs/ops/deploy-gcp-cloud-run.md §IAP)."
