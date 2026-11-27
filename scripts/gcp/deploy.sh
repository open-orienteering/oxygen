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
# --set-env-vars / --set-secrets REPLACE the whole environment, so the script
# aborts (before migrating) when the live revision has a variable it is not
# about to set, unless --drop-unlisted. Add your own variables with EXTRA_ENV
# in env.sh. See docs/ops/deploy-gcp-cloud-run.md and docs/releases/README.md.
#
# OXYGEN_GCP_ENV overrides the env file (default ./env.sh); used by the tests.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--from-source | --migrate-only] [--drop-unlisted] [tag]

  tag            GHCR tag (v1.2.3, edge, sha-<commit>), digest, or full image ref.
                 Default: \$DEPLOY_TAG from env.sh, otherwise stable.
  --from-source  Build this working tree with Cloud Build and deploy :latest
                 from Artifact Registry instead of GHCR.
  --migrate-only Apply Prisma migrations without changing the Cloud Run service.
  --drop-unlisted Deploy even though the live service has environment variables
                 this script does not set (they are removed). Without it the
                 script lists them and stops; add them to EXTRA_ENV in env.sh.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

source "${OXYGEN_GCP_ENV:-./env.sh}"
# The Geotorget secret's name (env.sh.example); an older env.sh without it gets the default.
DEM_SECRET="${DEM_SECRET:-oxygen-geotorget-credentials}"
# Node-to-node sync secret (SYNC_SHARED_SECRET on the cloud); provision.sh creates it.
SYNC_SECRET="${SYNC_SECRET:-oxygen-sync-secret}"

REPO_ROOT="$(git -C ../.. rev-parse --show-toplevel)"
GHCR_IMAGE="${GHCR_IMAGE:-ghcr.io/open-orienteering/oxygen}"
export GHCR_IMAGE

FROM_SOURCE=0
MIGRATE_ONLY=0
DROP_UNLISTED=0
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
    --drop-unlisted)
      DROP_UNLISTED=1
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

# A gcloud call that fails is an error, never "absent": a transient failure
# must not read as a first deploy (min-instances=0 would end event mode).
gcloud_fail() {
  echo "!! $1 failed; nothing was deployed or migrated:" >&2
  sed 's/^/   /' "$2" >&2
  rm -f "$2"
  exit 1
}

service_exists() {
  local out err
  err="$(mktemp)"
  out="$(gcloud run services list --project="$PROJECT_ID" --region="$REGION" \
    --filter="metadata.name=$SERVICE" --format='value(metadata.name)' 2>"$err")" ||
    gcloud_fail "gcloud run services list" "$err"
  rm -f "$err"
  [[ -n "$out" ]]
}

secret_exists() {
  local name="$1" out err
  err="$(mktemp)"
  out="$(gcloud secrets list --project="$PROJECT_ID" \
    --filter="name~/secrets/${name}$" --format='value(name)' 2>"$err")" ||
    gcloud_fail "gcloud secrets list (${name})" "$err"
  rm -f "$err"
  [[ -n "$out" ]]
}

# Read min-instances / CPU throttling from the live service so a deploy
# during a competition does not flip the club back to idle mode. Keeps the
# service JSON for the dropped-variable check.
SERVICE_JSON=""
SERVICE_PRESENT=0
read_scaling() {
  local err min throttle
  MIN_INSTANCES=0
  CPU_THROTTLING=1
  if ! service_exists; then
    return # first deploy
  fi
  SERVICE_PRESENT=1
  err="$(mktemp)"
  SERVICE_JSON="$(gcloud run services describe "$SERVICE" \
    --project="$PROJECT_ID" --region="$REGION" --format=json 2>"$err")" ||
    gcloud_fail "gcloud run services describe" "$err"
  rm -f "$err"
  min="$(printf '%s' "$SERVICE_JSON" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const ann = d.spec?.template?.metadata?.annotations || {};
process.stdout.write(String(ann["autoscaling.knative.dev/minScale"] || "0"));
')"
  throttle="$(printf '%s' "$SERVICE_JSON" | node -e '
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

# Variables this script sets itself; EXTRA_ENV may not override them.
MANAGED_ENV_NAMES="NODE_OPTIONS DATABASE_POOL_MAX MAP_RENDER_CONCURRENCY AUTH_MODE AUTH_HEADER AUTH_AUTO_PROVISION OXYGEN_ADMIN_EMAILS OXYGEN_DEPLOY_REF MAP_DEM_PROVIDERS DATABASE_URL MAP_DEM_LANTMATERIET_AUTH SYNC_SHARED_SECRET"

ENV_PAIRS=()      # NAME=value, everything but OXYGEN_DEPLOY_REF
SECRET_PAIRS=()   # NAME=secret:latest
SYNC_ON=0
DEM_ON=0

# Work out what this deploy will set (env + secrets), before anything is
# changed: the DEM and sync secrets are looked up, EXTRA_ENV is validated.
prepare_config() {
  if [[ -z "${OXYGEN_ADMIN_EMAILS:-}" ]]; then
    echo "!! OXYGEN_ADMIN_EMAILS is unset in env.sh — with AUTH_MODE=proxy nobody" >&2
    echo "   will be able to open /admin/users. See env.sh.example." >&2
  fi

  SECRET_PAIRS=("DATABASE_URL=oxygen-database-url:latest")
  ENV_PAIRS=(
    "NODE_OPTIONS=--max-old-space-size=3328"
    "DATABASE_POOL_MAX=8"
    "MAP_RENDER_CONCURRENCY=3"
    "AUTH_MODE=proxy"
    "AUTH_HEADER=x-goog-authenticated-user-email"
    "AUTH_AUTO_PROVISION=member"
    "OXYGEN_ADMIN_EMAILS=${OXYGEN_ADMIN_EMAILS:-}"
  )

  # Height data (docs/ops/deploy-gcp-cloud-run.md "Height data"; docs/map-terrain.md §7):
  # the deploy's defaults. Settings → Height data in the app (§7.8) overrides each of
  # them. The instance's one Geotorget account, referenced by secret name only: with
  # the secret the environment turns on Lantmäteriet's model and GLO-30 where it has
  # none; without it no provider is in the environment, unless env.sh sets
  # MAP_DEM_PROVIDERS (e.g. glo30).
  local dem_providers="${MAP_DEM_PROVIDERS:-}"
  if secret_exists "$DEM_SECRET"; then
    SECRET_PAIRS+=("MAP_DEM_LANTMATERIET_AUTH=${DEM_SECRET}:latest")
    dem_providers="${dem_providers:-lantmateriet,glo30}"
  elif [[ "$dem_providers" == *lantmateriet* ]]; then
    echo "!! MAP_DEM_PROVIDERS names lantmateriet but the secret ${DEM_SECRET} does not exist;" >&2
    echo "   Lantmäteriet stays off. See docs/ops/deploy-gcp-cloud-run.md \"Height data\"." >&2
  fi
  if [[ -n "$dem_providers" ]]; then
    ENV_PAIRS+=("MAP_DEM_PROVIDERS=${dem_providers}")
    echo "── DEM providers: ${dem_providers}"
  else
    echo "── DEM fetch off (no ${DEM_SECRET} secret, MAP_DEM_PROVIDERS unset)"
  fi

  # Venue-box sync (docs/ops/venue-runbook.md): checkout and the journal pull
  # need SYNC_SHARED_SECRET on the cloud node.
  if secret_exists "$SYNC_SECRET"; then
    SECRET_PAIRS+=("SYNC_SHARED_SECRET=${SYNC_SECRET}:latest")
    SYNC_ON=1
    echo "── Venue sync on (secret ${SYNC_SECRET})"
  else
    echo "!! No ${SYNC_SECRET} secret: venue-box sync is OFF on this deploy (checkout to a" >&2
    echo "   venue box will fail). Run ./provision.sh to create it." >&2
  fi

  # EXTRA_ENV="NAME=value;NAME2=value2" (env.sh): tuning variables that the
  # replace semantics of --set-env-vars would otherwise remove.
  local entry name
  local -a extra=()
  if [[ -n "${EXTRA_ENV:-}" ]]; then
    IFS=';' read -r -a extra <<<"$EXTRA_ENV"
  fi
  for entry in "${extra[@]+"${extra[@]}"}"; do
    [[ -z "$entry" ]] && continue
    if [[ ! "$entry" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      echo "!! EXTRA_ENV entry '${entry}' is not NAME=value (entries are separated by ';', values may not contain ';')." >&2
      exit 1
    fi
    name="${BASH_REMATCH[1]}"
    if [[ " $MANAGED_ENV_NAMES " == *" $name "* ]]; then
      echo "!! EXTRA_ENV may not set ${name}: deploy.sh manages it (see env.sh.example)." >&2
      exit 1
    fi
    ENV_PAIRS+=("$entry")
  done
}

# --set-env-vars / --set-secrets replace everything: stop (before migrating)
# when the live revision has variables this deploy would remove.
check_dropped_vars() {
  [[ "$SERVICE_PRESENT" -eq 1 ]] || return 0
  local names=("OXYGEN_DEPLOY_REF") pair dropped
  for pair in "${ENV_PAIRS[@]}" "${SECRET_PAIRS[@]}"; do
    names+=("${pair%%=*}")
  done
  dropped="$(printf '%s' "$SERVICE_JSON" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const set = new Set(process.argv.slice(1));
const live = (d.spec?.template?.spec?.containers?.[0]?.env || []).map((e) => e.name);
process.stdout.write(live.filter((n) => !set.has(n)).join(" "));
' "${names[@]}")"
  [[ -z "$dropped" ]] && return 0
  if [[ "$DROP_UNLISTED" -eq 1 ]]; then
    echo "!! --drop-unlisted: removing live variables not set by this deploy: ${dropped}" >&2
    return 0
  fi
  echo "!! The live service ${SERVICE} has variables this deploy would REMOVE: ${dropped}" >&2
  echo "   Add them to EXTRA_ENV in env.sh (NAME=value;NAME2=value2) or, for a secret, create it" >&2
  echo "   as documented, then deploy again; or pass --drop-unlisted to remove them on purpose." >&2
  echo "   Nothing was migrated or deployed." >&2
  exit 1
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

  local secrets env_vars pair
  secrets="$(IFS=,; printf '%s' "${SECRET_PAIRS[*]}")"
  env_vars="^;^"
  for pair in "${ENV_PAIRS[@]}" "OXYGEN_DEPLOY_REF=${DEPLOY_REF}"; do
    env_vars+="${pair};"
  done
  env_vars="${env_vars%;}"

  echo "── Deploying ${image_ref} to Cloud Run (min-instances=${MIN_INSTANCES}, cpu-throttling=${CPU_THROTTLING})…"
  gcloud run deploy "$SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --image="$image_ref" \
    --service-account="oxygen-run@${PROJECT_ID}.iam.gserviceaccount.com" \
    --add-cloudsql-instances="$SQL_CONNECTION" \
    --set-secrets="$secrets" \
    --set-env-vars="$env_vars" \
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

# Everything that can fail on a read (live mode, secrets, env diff) is done
# before the first thing that changes (build, migrate, deploy).
if [[ "$MIGRATE_ONLY" -eq 0 ]]; then
  read_scaling
  prepare_config
  check_dropped_vars
fi

IMAGE_REF=""
DEPLOY_REF=""
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  BUILD_ID="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)-$(date +%Y%m%d%H%M%S)"
  # Cloud Build's upload has no .git, so the version is computed here.
  BUILD_VERSION="$(node "$REPO_ROOT/scripts/build-version.mjs")"
  echo "── Building working tree with Cloud Build (BUILD_ID=${BUILD_ID}, version ${BUILD_VERSION})…"
  gcloud builds submit "$REPO_ROOT" \
    --project="$PROJECT_ID" \
    --config="$REPO_ROOT/scripts/gcp/cloudbuild.yaml" \
    --substitutions="_IMAGE=${IMAGE},_BUILD_ID=${BUILD_ID},_BUILD_VERSION=${BUILD_VERSION}"
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

run_cloud_run_deploy "$IMAGE_REF"

echo
echo "Deployed ${IMAGE_REF}."
if [[ "$SERVICE_PRESENT" -eq 1 ]]; then
  if [[ "$MIN_INSTANCES" -gt 0 && "$CPU_THROTTLING" -eq 0 ]]; then
    MODE_NAME="event mode"
  else
    MODE_NAME="idle mode"
  fi
  echo "  Mode kept from the running service: ${MODE_NAME} (min-instances=${MIN_INSTANCES}, cpu-throttling=${CPU_THROTTLING})."
else
  echo "  First deploy: idle mode (min-instances=0, cpu-throttling=1)."
  echo "    1. Enable IAP + grant users access (docs/ops/deploy-gcp-cloud-run.md §IAP)."
fi
echo "  Use ./event-mode.sh / ./idle-mode.sh to switch."
