# Deploying Oxygen to GCP (Cloud Run + Cloud SQL + IAP)

Production deployment for a club: a single IAP-protected Cloud Run service
(API + web bundle in one container) backed by Cloud SQL Postgres. The
container is the public GHCR image `ghcr.io/open-orienteering/oxygen`
(see [releases-and-images.md](releases-and-images.md)). GitHub Actions
never authenticates to the club project — an operator with `gcloud`
runs `scripts/gcp/deploy.sh` locally. Access is restricted to allowlisted
Google accounts via Identity-Aware Proxy — free when enabled directly on
Cloud Run, no load balancer needed.

```
allowlisted user ──Google sign-in──▶ IAP ──▶ Cloud Run "oxygen"        Eventor / ROC /
                                             (cloud image target)  ──▶ LiveResults /
venue box ──SA ID token + secret──▶ IAP ──▶  2 vCPU / 4 GiB            Sheets (outbound)
                                                │ /cloudsql unix socket
                                                ▼
                                             Cloud SQL Postgres
                                             db-f1-micro, 10 GB SSD
```

Two operating modes, flipped with one command:


| Mode           | Command                     | Billing                        | Timers (LiveResults/ROC) | Cost       |
| -------------- | --------------------------- | ------------------------------ | ------------------------ | ---------- |
| Idle (default) | `scripts/gcp/idle-mode.sh`  | Request-based, scales to zero  | Dormant                  | ~$0        |
| Event          | `scripts/gcp/event-mode.sh` | Instance-based, min 1 instance | Running                  | ~$3.70/day |


Map-making and admin work function fully in idle mode — the container cold
starts in a few seconds on the first request and stays warm for 15 minutes
after the last one. Only the background timers need event mode.

## Expected monthly cost (Tier-1 region, Aug 2026 prices)


| Item                                           | Cost            |
| ---------------------------------------------- | --------------- |
| Cloud SQL db-f1-micro + 10 GB SSD + backups    | ~$10–12         |
| Cloud Run, idle mode                           | ~$0 (free tier) |
| Cloud Run, event mode                          | ~$3.70/day      |
| IAP                                            | $0              |
| Artifact Registry + egress                     | ~$1             |
| **Typical month with one competition weekend** | **~$13–18**     |


Cloud SQL has no free tier and is the cost floor. Optional lever: stop the
instance between events (`gcloud sql instances patch $SQL_INSTANCE --activation-policy=NEVER`, start with `=ALWAYS`) to drop to ~$2/month
storage-only — but then nothing works until you start it again (1–2 min).

## Prerequisites

- A GCP project with billing enabled, `gcloud` CLI authenticated
(`gcloud auth login`) — new billing accounts get $300 in credits.
- Repo checked out locally for the `scripts/gcp/` helpers (`env.sh` is
  gitignored). Default deploys **pull a published GHCR tag**; they do not
  build from the working tree.
- Node.js on the operator machine (`deploy.sh` resolves image refs with
  `scripts/ghcr-ref.mjs`).

## First-time setup

```bash
cd scripts/gcp
cp env.sh.example env.sh   # fill in PROJECT_ID + REGION; env.sh is gitignored
./provision.sh             # APIs, Artifact Registry, Cloud SQL, secret, runtime SA
./deploy.sh edge           # pull GHCR, migrate, Cloud Run (use a vX.Y.Z tag once released)
```

`deploy.sh` applies Prisma migrations and then rolls out Cloud Run in one
go. `./migrate.sh` is a thin wrapper (`deploy.sh --migrate-only`). Pass a
tag (`v1.2.3`, `edge`, `sha-<full-commit>`) or set `DEPLOY_TAG` in `env.sh`
(default `stable`). `./deploy.sh --from-source` is the old Cloud Build →
Artifact Registry path, for an unreleased local tree only.

`provision.sh` generates the DB password and stores the full `DATABASE_URL`
(unix-socket form, `?host=/cloudsql/…&schema=oxygen`) in Secret Manager;
the service reads it via `--set-secrets`, so no credentials live in the
service config or in git.

### Enable IAP (one-time)

```bash
source scripts/gcp/env.sh
gcloud beta run services update "$SERVICE" --region="$REGION" --iap
```

Then grant each person access. IAP is the network allowlist; Oxygen then
auto-creates anyone who gets through as a plain member
(`AUTH_AUTO_PROVISION=member` on `deploy.sh`). Put your own email in
`OXYGEN_ADMIN_EMAILS` in `env.sh` so the first request makes you an
instance admin — from there, **Settings → Users** is where
you promote others. This also covers the case where a `users` row for your
address already exists (for example after restoring a dev dump, below):
the row is promoted and reactivated rather than left as a member.

```bash
gcloud beta iap web add-iam-policy-binding \
  --member="user:someone@gmail.com" \
  --role="roles/iap.httpsResourceAccessor" \
  --resource-type=cloud-run \
  --service="$SERVICE" --region="$REGION"
```

Remove someone with `remove-iam-policy-binding` and the same arguments.
Any Google account works (gmail.com included); users hit a Google sign-in
page and non-allowlisted accounts get a 403 from Google before reaching
the app. Deactivating a user in Oxygen locks them out of the app without
revoking IAP (they still reach the Access denied page until you also
drop the IAP binding).

#### One-time: custom OAuth client (required for projects without an organization)

IAP's default Google-managed OAuth client only exists for projects inside
a Google Cloud organization, and only admits same-org users. A standalone
project (or a gmail.com allowlist) instead 502s with *"Empty Google
Account OAuth client ID(s)/secret(s)"* until you hand IAP a custom client:

1. **Branding** — console → Google Auth Platform → Overview → Get started:
  app name (e.g. "Oxygen"), support email, audience **External**.
2. **Publish or add test users** — on the Audience page, either publish
  the app (IAP only uses basic email/profile scopes, so no Google
   verification is needed) or, while it is in *Testing*, list every
   allowlisted account as a test user (testing mode also expires sign-ins
   after ~7 days — publish to avoid that).
3. **Create the client** — Clients page → Create client → type **Web
  application**. Copy the client secret (shown only at creation). Then
   edit the client and add the authorized redirect URI, substituting the
   new client's own ID:
   `https://iap.googleapis.com/v1/oauth/clientIds/CLIENT_ID:handleRedirect`
4. **Hand it to IAP** at the project level:

```yaml
# iap_settings.yaml (delete after applying — IAP stores a hash)
access_settings:
  oauth_settings:
    client_id: CLIENT_ID
    client_secret: CLIENT_SECRET
```

```bash
gcloud iap settings set iap_settings.yaml --project="$PROJECT_ID"
```

Takes effect in seconds. This client ID is also the `SYNC_GOOGLE_AUDIENCE`
value for venue-box sync (see below).

The service URL is printed by the deploy (`gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)'`).

### Custom domain (e.g. oxygen.skogsluffarna.se)

Cloud Run domain mapping is free (no load balancer) but only available in
[certain regions](https://cloud.google.com/run/docs/locations#domains) —
`europe-north1` yes, `europe-north2` no. It is formally in preview with a
latency caveat; acceptable for a club admin app, and IAP covers the mapped
domain like any other ingress path.

1. **Verify domain ownership** for the Google account running gcloud:
  `gcloud domains verify skogsluffarna.se` opens Search Console, which  asks for a TXT record on the zone apex. Add it wherever the club's DNS  records are managed (the same place the Workspace MX records live).
2. **Create the mapping**:

```bash
gcloud beta run domain-mappings create \
  --service="$SERVICE" --region="$REGION" \
  --domain=oxygen.skogsluffarna.se
```

1. **Add the CNAME** it prints: `oxygen` → `ghs.googlehosted.com.`
2. Wait for the Google-managed TLS certificate (usually ~15 min, up to
  24 h). Check with `gcloud beta run domain-mappings describe  --domain=oxygen.skogsluffarna.se --region="$REGION"`.

## Deploying updates

```bash
scripts/gcp/deploy.sh           # GHCR :stable (or DEPLOY_TAG in env.sh)
scripts/gcp/deploy.sh v1.2.3    # a GitHub Release
scripts/gcp/deploy.sh edge      # latest verified main
scripts/gcp/deploy.sh --from-source   # Cloud Build this working tree (fallback)
```

Migrations run first against the chosen image, then Cloud Run is updated.
The script records the selected argument as `OXYGEN_DEPLOY_REF`, so the UI
footer shows `Image: edge`, `Image: v1.2.3`, or the chosen SHA alongside
the baked commit identity.
Idle vs event mode on the live service is **preserved** (a deploy during a
competition will not flip you back to scale-to-zero). Use
`./event-mode.sh` / `./idle-mode.sh` to change that on purpose.

Cloud Run keeps the previous revision; roll back by deploying an older
tag (`./deploy.sh v1.2.2` or `sha-…`) or with
`gcloud run services update-traffic`.

The database is reachable only from Cloud Run. For a one-off query (a
release preflight, an instance flag in `oxygen.settings`), run a small Node
script as a job with the service's secret and the image's `pg` client:

```bash
scripts/gcp/db-job.sh scripts/gcp/jobs/map-survey.js --tag v0.5.0
scripts/gcp/db-job.sh my-script.js --env KEY=VALUE   # extra env for the script
```

It prints the script's output from this execution's log. Scripts in
`scripts/gcp/jobs/` are read-only unless they say otherwise.

## Competition runbook

```bash
scripts/gcp/event-mode.sh   # the day before: always-on, timers running
# … run the competition …
scripts/gcp/idle-mode.sh    # after prize-giving: back to scale-to-zero
```

In event mode the LiveResults pusher and ROC online-punch puller run
continuously, exactly as in the docker-compose deployment. Forgetting
idle-mode costs ~$110/month, so put it in the tear-down checklist.

## Venue-box sync through IAP

IAP protects *all* ingress, including the venue box's journal shipping
(`SYNC_PEER_URL` pointing at the cloud). The venue box authenticates as a
service account; the shipper attaches an OIDC ID token when
`SYNC_GOOGLE_AUDIENCE` is set (see `packages/api/src/sync/googleIdToken.ts`).
The existing `SYNC_SHARED_SECRET` still applies as the app-level check.

One-time setup:

```bash
source scripts/gcp/env.sh

# 1. Service account for the venue box + key file
gcloud iam service-accounts create oxygen-venue --display-name="Oxygen venue box"
gcloud iam service-accounts keys create venue-sa.json \
  --iam-account="oxygen-venue@${PROJECT_ID}.iam.gserviceaccount.com"

# 2. Allow it through IAP (same binding as human users)
gcloud beta iap web add-iam-policy-binding \
  --member="serviceAccount:oxygen-venue@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iap.httpsResourceAccessor" \
  --resource-type=cloud-run \
  --service="$SERVICE" --region="$REGION"

# 3. Find the IAP OAuth client id (the token audience)
gcloud iap settings get --resource-type=cloud-run \
  --service="$SERVICE" --region="$REGION" --project="$PROJECT_ID"
```

On the venue box, copy `venue-sa.json` somewhere private and add to the
API container's environment (alongside the existing sync vars):

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/venue-sa.json
SYNC_GOOGLE_AUDIENCE=<IAP OAuth client id>
SYNC_PEER_URL=https://oxygen-….run.app
SYNC_SHARED_SECRET=…
```

With `SYNC_GOOGLE_AUDIENCE` unset, behavior is exactly as before (LAN /
non-IAP deployments are unaffected).

## Syncing a local database to the cloud

To replace the cloud database contents with a local dev database (one-way,
destructive on the cloud side), tunnel with the Cloud SQL Auth Proxy and
use `pg_dump`/`pg_restore`. Client tools must match the server major
version — easiest is the `postgres:18-alpine` image with host networking:

```bash
# 1. Proxy (download from github.com/GoogleCloudPlatform/cloud-sql-proxy).
#    --token works around ADC files with insufficient scopes.
cloud-sql-proxy "$SQL_CONNECTION" --port 5434 --token "$(gcloud auth print-access-token)" &

# 2. Dump the local dev DB (oxygen schema only)
docker run --rm --network=host -v /tmp:/dump postgres:18-alpine \
  pg_dump "postgresql://oxygen:oxygen@localhost:5432/oxygen" \
  -n oxygen -Fc --no-owner --no-privileges -f /dump/oxygen-dev.dump

# 3. Drop + restore on the cloud side (password: see the
#    oxygen-database-url secret)
docker run --rm --network=host -e PGPASSWORD="$DB_PASSWORD" -v /tmp:/dump \
  postgres:18-alpine sh -c '
    psql -h 127.0.0.1 -p 5434 -U oxygen -d oxygen -c "DROP SCHEMA IF EXISTS oxygen CASCADE" &&
    pg_restore -h 127.0.0.1 -p 5434 -U oxygen -d oxygen --no-owner --no-privileges /dump/oxygen-dev.dump'
```

The dump includes `_prisma_migrations`, so the cloud DB inherits the dev
migration history — run `./migrate.sh` afterwards to confirm deploys still
apply cleanly.

## Backups and restore

- **Cloud SQL automated backups**: enabled by `provision.sh` (daily 03:00
UTC, 7 retained). Restore via `gcloud sql backups list/restore`.
- **Per-event backup download** (`GET /api/backup/event`, `pg_dump` inside
the container) works as documented in `docs/backup-restore.md` — the
image ships `postgresql-client`.

## Sizing notes

- **Print and import memory.** `maps.pdf` composes in a worker thread
(`course-print.md` §8.2): `PRINT_WORKERS` (default `1`, max `4`) is how
many prints compose at once; each worker holds a decoded map document and
fonts (a Club-full print run peaked at 2.6 GB RSS), so on 2 vCPU / 4 GiB
keep it at 1, or 2 for small maps. Workers use no database connection.
The rest of the 4 GiB is headroom for the map import worker (an OCAD
file parsed into a map document); since v0.6.1 (E5) the upload itself
parses nothing — it stores the chunks and starts the job.
- **The render gate.** Each print also takes a permit of the process's
render gate (`renderGate()` in `packages/api/src/map-render-limits.ts`,
`MAP_RENDER_CONCURRENCY`, default 2, `deploy.sh` sets 3). Since E4a the
viewer draws the map document on the GPU and the server renders no
tiles: the tile renderer and its knobs are gone. `MAP_TILE_BLOCK_TILES`,
`MAP_TILE_SUPERSAMPLE`, `MAP_TILE_PRECACHE`, `MAP_PRECACHE_MIN_ZOOM`,
`MAP_PRECACHE_MAX_ZOOM`, `MAP_PRECACHE_BLOCK_DELAY_MS`,
`MAP_RENDER_MAX_QUEUE`, `MAP_SVG_CACHE_EVENTS`, `MAP_WINDOW_MAX_PIXELS`
(and the older `MAP_RASTER_MAX_PIXELS` / `MAP_RASTER_CACHE_EVENTS`) set
on a revision are ignored; remove them from the revision after v0.6.1
(`gcloud run services update oxygen --remove-env-vars=…`,
`docs/release-slice-e.md` §2). Until then the v0.5.0 image, which reads
them, falls back to its defaults without them. The September 2026
tile incident and the whole-map raster OOM before it are recorded in
[bugfix-map-tile-cold-render-cloud-timeouts.md](bugfix-map-tile-cold-render-cloud-timeouts.md).
- **`--cpu=2` and `MAP_RENDER_CONCURRENCY=3`.** The CPU-bound work the
service does is a map import and a print, both in worker threads; two
vCPUs let them run beside request handling instead of starving it.
The extra CPU is free in idle mode: request-based billing charges per
vCPU-second of *request* time, and club traffic sits far under the
180,000 vCPU-second monthly free tier. Event mode is instance-based and
bills the whole instance lifetime, so the second vCPU costs
$0.000018/vCPU-second there — about $1.55/day. That is the one place
this setting shows up on a bill; flip back to idle mode after the
weekend as usual.
- **`--max-instances=2` and `DATABASE_POOL_MAX=8`.** These two belong
together: the binding constraint on scale-out is Cloud SQL connections,
not the application. A `db-f1-micro` allows 25 and reserves 3 for
superuser use, leaving about 22. Each instance opens up to
`DATABASE_POOL_MAX`, so two instances at 8 use 16 and leave 6 for the
migration job and an interactive `psql`. To scale further, raise the
Cloud SQL tier first (`db-g1-small` allows 50) and then raise both
numbers together — raising `--max-instances` alone exhausts the budget.

  **Budget the connections, and leave headroom.** The rule is
  `max_instances × DATABASE_POOL_MAX + 6 ≤ (max_connections − 3)`. The
  earlier pairing of `2 × 10` satisfied the limit arithmetically (20 of
  22) but had no slack, and a shared-core instance at the edge does not
  fail cleanly: instead of `FATAL: sorry, too many clients already` from
  Postgres, the Cloud SQL connector's TLS handshake is dropped before it
  reaches Postgres. What you see is
  `dial error: handshake failed (connection name = …): EOF` in the Cloud
  Run log and Prisma `P2010 DatabaseNotReachable`, while the instance
  itself looks perfectly healthy (low CPU, no query errors, `RUNNABLE`).
  See [bugfix-cloud-sql-handshake-eof.md](bugfix-cloud-sql-handshake-eof.md).

  **Two different max-instances settings exist.** `--max-instances` is a
  *revision* setting; Cloud Run also stores a *service*-level cap in the
  `run.googleapis.com/maxScale` annotation, which is divided across
  revisions and takes precedence when the two disagree. `gcloud run
  deploy` cannot set it (there is no flag), so a value changed in the
  console persists through every subsequent deploy even though the
  revision still reports the old number. `deploy.sh` therefore follows
  each deploy with `gcloud run services update --max=2`. To inspect both:

  ```bash
  gcloud run services describe oxygen --region=europe-north1 --format=export \
    | grep -E 'maxScale|containerConcurrency'
  # run.googleapis.com/maxScale: '2'        <- service level, wins
  #   autoscaling.knative.dev/maxScale: '2' <- revision level
  ```
  The code side no longer objects. Prints and map documents are
  stateless (any instance can compose any print; documents are
  content-addressed rows), and the background jobs that must not run
  twice elect a single runner
  through the `oxygen.instance_lease` table — see
  [background-jobs-lease.md](background-jobs-lease.md). Extra instances
  therefore only serve requests.
- Cloud SQL `db-f1-micro` (0.6 GB shared core) is enough for club-scale
events. If map blobs push the DB hard, `db-g1-small` (~$26/mo) is the
next step up.

## Troubleshooting

- **"Update available" prompts on every visit.** The web client compares
the version identity from `/api/version`. Cloud Run restarts the process
constantly (scale-to-zero, instance swaps), so process start time alone
false-positives; the identity is therefore the `BUILD_ID` baked into the
image (`OXYGEN_BUILD_ID`). GHCR publishes use the git SHA; `--from-source`
uses SHA + timestamp. If prompts recur without a deploy, check
that the running revision has `OXYGEN_BUILD_ID` set
(`gcloud run services describe "$SERVICE" --region="$REGION" --format=yaml | grep -A1 OXYGEN_BUILD_ID`).
- **Instance restart loop / `Memory limit … exceeded`.** Confirm
with
`gcloud logging read 'resource.labels.service_name="oxygen" severity>=WARNING' --limit=20`.
On revisions before v0.6.0 this was the tile renderer (see
[bugfix-map-tile-cold-render-cloud-timeouts.md](bugfix-map-tile-cold-render-cloud-timeouts.md));
since then the likely culprits are importing an unusually large OCAD
file or several large prints at once, so raise `--memory` or keep
`PRINT_WORKERS` at 1.
- **Map never loads.** The viewer reads the event's pinned map document
(`/api/map-documents/:hash`); a map whose import has not pinned one
shows the import state instead (`map-storage.md` §4.6). Check the
import job (`mapImport.latestForEvent`, or Settings → Maintenance →
**Map documents**) before the instance.

## What this deployment does NOT change

- Source-building docker-compose files (`docker-compose.yml`, `host-db`,
`venue`) are unchanged. Self-hosters who want the published image use
[`docker-compose.release.yml`](../docker-compose.release.yml) — see
[releases-and-images.md](releases-and-images.md). The `cloud` Docker
target and `WEB_DIST_DIR` static serving are what GHCR and Cloud Run run.
- Spectator results still flow outbound to liveresultat.se — nothing
public is served from the IAP-protected instance.

