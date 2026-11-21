#!/usr/bin/env bash
# One-time provisioning of the GCP resources Oxygen needs:
# Artifact Registry, Cloud SQL (Postgres, smallest tier, automated
# backups), the DATABASE_URL secret, and the Cloud Run runtime service
# account. Idempotent where practical — safe to re-run after a partial
# failure. See docs/ops/deploy-gcp-cloud-run.md.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

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

echo "── Cloud SQL instance (db-f1-micro, 10 GB SSD, automated backups)…"
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
    --retained-backups-count=7
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

# Height data (docs/ops/deploy-gcp-cloud-run.md "Height data"): the Geotorget secret is
# created by the operator with their own credential, never by this script; once it
# exists the runtime account may read it. Re-run this script after creating it.
DEM_SECRET="${DEM_SECRET:-oxygen-geotorget-credentials}"
if gcloud secrets describe "$DEM_SECRET" >/dev/null 2>&1; then
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
