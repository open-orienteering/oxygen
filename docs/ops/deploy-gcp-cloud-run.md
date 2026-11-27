# Deploying Oxygen to GCP (Cloud Run + Cloud SQL + IAP)

Production deployment for a club: a single IAP-protected Cloud Run service
(API + web bundle in one container) backed by Cloud SQL Postgres. The
container is the public GHCR image `ghcr.io/open-orienteering/oxygen`
(see [releases/README.md](../releases/README.md)). GitHub Actions
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
scripts/gcp/deploy.sh edge      # newest main commit that passed the image smoke
scripts/gcp/deploy.sh --drop-unlisted v1.2.3   # also remove live variables deploy.sh does not set
scripts/gcp/deploy.sh --from-source   # Cloud Build this working tree (fallback)
```

Migrations run first against the chosen image, then Cloud Run is updated.
The script records the selected argument as `OXYGEN_DEPLOY_REF`. The UI
footer shows the version baked into the image (`Oxygen v1.2.3`,
`Oxygen v1.2.3-4-gabc1234` for a later `main` commit) and the baked commit;
it adds `Image: edge`, `Image: stable` or the chosen SHA only when the ref is
not that version's own tag, so `./deploy.sh v1.2.3` shows no `Image:` part
([releases/README.md](../releases/README.md#the-footer)).
`--from-source` computes the version locally with `scripts/build-version.mjs`
(Cloud Build's upload has no `.git`) and passes it as `_BUILD_VERSION`.
Idle vs event mode on the live service is **preserved** (a deploy during a
competition will not flip you back to scale-to-zero), and the closing message
prints the mode the deploy used (min-instances, CPU throttling, or "first
deploy"). The script looks the service up with `gcloud run services list`:
a failing gcloud call stops the script with its error before anything is
migrated or deployed, instead of being read as "no service" (which would
deploy with `--min-instances=0` over an event-mode service). Use
`./event-mode.sh` / `./idle-mode.sh` to change that on purpose.

**Every deploy replaces the whole environment** (`--set-env-vars`,
`--set-secrets`). The script therefore compares the live revision's
variables with the ones it is about to set, and when any would disappear it
names them and exits before migrating:

```text
!! The live service oxygen has variables this deploy would REMOVE: PRINT_WORKERS
```

Put your own variables in `EXTRA_ENV` in `env.sh`, `NAME=value` pairs
separated by `;` (values may not contain `;`), for example
`export EXTRA_ENV="PRINT_WORKERS=2;MAP_HEIGHTFIELD_MAX_CELLS=30000000"`
(see the sizing notes). Malformed entries, and names the script manages
itself (`AUTH_MODE`, `MAP_DEM_PROVIDERS`, `SYNC_SHARED_SECRET`, …), are
refused. `--drop-unlisted` deploys anyway and removes what is not listed.
The sync secret (below) and the Geotorget secret are bound automatically when
they exist in Secret Manager. `edge` is the newest `main` commit whose image
passed the smoke test (it can trail `main` while a newer commit is being
built), and `vX.Y.Z` tags are promoted only from such images
([releases/README.md](../releases/README.md#tags)).

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

Before the race, check the event's **zero time** (before the first start)
and **time zone** under Event Info. Cloud Run runs the image with
`TZ=Europe/Stockholm`, but no race time depends on it: "now", has-started and
the station clocks use each event's own time zone.

In event mode the LiveResults pusher and ROC online-punch puller run
continuously, exactly as in the docker-compose deployment. Forgetting
idle-mode costs ~$110/month, so put it in the tear-down checklist.

## Venue-box sync through IAP

IAP protects *all* ingress, including the venue box's journal shipping
(`SYNC_PEER_URL` pointing at the cloud). The venue box authenticates as a
service account; the shipper attaches an OIDC ID token when
`SYNC_GOOGLE_AUDIENCE` is set (see `packages/api/src/sync/googleIdToken.ts`).
`SYNC_SHARED_SECRET` is the app-level credential for both directions: the
box presents it on `events.push` as well as on `events.since`, and the cloud
accepts a push that carries it without a signed-in user (the cloud runs
`AUTH_MODE=proxy`, and the service account need not be an invited member).
A missing or wrong secret now fails the push loudly (`UNAUTHORIZED`, or
`PRECONDITION_FAILED` when the cloud has no `SYNC_SHARED_SECRET` set) and the
shipper logs it every cycle; before, a secret-only push was rejected for lack
of a user while the pull looked healthy. IAP still needs the ID token above.

The secret lives in Secret Manager as `oxygen-sync-secret` (`SYNC_SECRET` in
`env.sh` names another). `./provision.sh` creates it with a random value if
it is missing and lets the runtime account read it; `./deploy.sh` then binds
it as `SYNC_SHARED_SECRET` on every deploy, and warns (without failing) when
it does not exist, because venue-box checkout would then fail with
`PRECONDITION_FAILED`. Read the value for the box's `.env.venue` with
`gcloud secrets versions access latest --secret=oxygen-sync-secret`.

**Upgrading a cloud whose `SYNC_SHARED_SECRET` was set by hand** as a literal
environment variable: `./deploy.sh` aborts ("would REMOVE: SYNC_SHARED_SECRET"),
because `EXTRA_ENV` refuses the managed name, and running `./provision.sh`
first would create a *new* random value that the venue boxes do not hold. Move
the existing value into Secret Manager instead:

```bash
source scripts/gcp/env.sh
# 1. Read the current value from the live revision
gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --format='value(spec.template.spec.containers[0].env.filter(name=SYNC_SHARED_SECRET).extract(value).flatten())'
# 2. Create the secret from it
printf %s "<current value>" | gcloud secrets create oxygen-sync-secret --project="$PROJECT_ID" --data-file=-
# 3. Bind runtime access (never overwrites the secret you just made)
./provision.sh
# 4. Deploy: SYNC_SHARED_SECRET now moves from a literal to the secret, which is not a drop
./deploy.sh
```

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

On the venue box, copy `venue-sa.json` somewhere private (outside the
checkout; `chown 1000` and `chmod 400`, the container runs as uid 1000) and
put these in `.env.venue`; `docker-compose.venue.yml` mounts the key read-only
and sets `GOOGLE_APPLICATION_CREDENTIALS` itself:

```bash
VENUE_SA_KEY=/absolute/path/to/venue-sa.json   # absolute or ./ path
SYNC_GOOGLE_AUDIENCE=<IAP OAuth client id>
SYNC_PEER_URL=https://oxygen-….run.app
SYNC_SHARED_SECRET=…
```

The api logs at start whether IAP auth is on and warns when only one of the
two is set or the key is unreadable. The full box setup is in
[venue-runbook.md](venue-runbook.md#one-time-setup).

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
- **Point-in-time recovery** (DB-35): `provision.sh` creates the instance
with `--enable-point-in-time-recovery --retained-transaction-log-days=7`,
so the database can be restored to any moment of the last seven days, not
only to the last 03:00 backup (a bad write at 14:00 on race day is undone
to 13:59). The transaction logs add some storage cost (a few cents a day
at this size). An instance created before this release does not have it:
turn it on once, **between events, never on race day** (the patch
restarts the instance, a minute or two of downtime):

  ```bash
  gcloud sql instances describe "$SQL_INSTANCE" --format='value(settings.backupConfiguration.pointInTimeRecoveryEnabled)'
  gcloud sql instances patch "$SQL_INSTANCE" --enable-point-in-time-recovery --retained-transaction-log-days=7
  ```

  To recover, clone the instance to the moment before the damage and
  point the service at the clone (or copy the event out of it with the
  per-event backup and restore it into the live database):

  ```bash
  gcloud sql instances clone "$SQL_INSTANCE" "${SQL_INSTANCE}-recovered" --point-in-time='2026-05-01T12:59:00Z'
  ```

- **Per-event backup download** (`GET /api/backup/event`, psql inside the
container through the Cloud SQL socket of the `?host=` parameter in
`DATABASE_URL`) works as documented in `docs/ops/backup-restore.md`: the
image ships `postgresql-client`. A dump that cannot reach the database
answers an error instead of a file.

## Height data (Lantmäteriet)

The 3D terrain (docs/map-terrain.md §7) can anchor a map's contours to a
digital elevation model fetched by the server. **Fetching is off by
default.** Lantmäteriet's height model (CC BY 4.0, "© Lantmäteriet") needs
**one Geotorget account for the instance** (the club's); Copernicus GLO-30
(open, no account) serves where Lantmäteriet has no coverage.

**The normal way is the app: Settings → Height data** (`/settings?tab=terrain`,
an admin tab, map-terrain §7.8). The page explains itself; in short:

1. Create a user on Lantmäteriet's Geotorget
   (<https://geotorget.lantmateriet.se/>) and order the free product
   *Markhöjdmodell Nedladdning* for it. That user name and password are
   the download API's (`api.lantmateriet.se/stac-hojd/v1`).
2. In the tab, enter the user name and password and save. The password is
   stored encrypted in the database (with a key kept in the database
   beside it: it never shows in plaintext in a row, a screen, a log or a
   settings export, but anyone holding the whole database could open it,
   map-terrain §7.0b answer 10), is never shown again, and is sent only to
   Lantmäteriet's hosts. Saving queues every map whose fetch failed on the
   old account — no redeploy.
3. Switch the providers on (Lantmäteriet, GLO-30) and keep the resolution
   at 2 m.
4. Once, run **Test connection** on one club map of ordinary size (a few
   km across, like the corpus's club-2026; the largest maps are over the
   1 m cap and the tab will not offer them). It reads about 100 MB of
   height data for that map in a worker thread, stores and shows only
   aggregates, and changes nothing. If it fails, choose 1 m in the tab
   (the largest club maps then get no DEM until the cap is raised) and
   record the result in docs/map-terrain.md §7.6.

Nothing in the deploy needs to change for this. Each value saved in the
tab wins over its environment variable; a value not saved falls back to
the deploy's (map-terrain §7.0b 6). **The environment remains as the
deploy's default**, for an instance that prefers its secret store:

- Create the secret yourself — the value is typed at the prompt, never
  written to a file or your shell history (finish with Enter, then
  Ctrl-D):

  ```bash
  gcloud secrets create oxygen-geotorget-credentials --data-file=- --project="$PROJECT_ID"
  ```

  The value is `username:password` (surrounding whitespace, such as the
  newline Enter adds, is trimmed when it is read). To rotate later:
  `gcloud secrets versions add oxygen-geotorget-credentials --data-file=-`.
- Let the runtime account read it, and deploy:

  ```bash
  ./provision.sh
  ```

  ```bash
  ./deploy.sh
  ```

  `deploy.sh` finds the secret by name and adds
  `MAP_DEM_LANTMATERIET_AUTH=oxygen-geotorget-credentials:latest` to
  `--set-secrets` and `MAP_DEM_PROVIDERS=lantmateriet,glo30` to the
  environment; without the secret it deploys with no provider in the
  environment (the tab can still switch them on). `DEM_SECRET` in
  `env.sh` names a different secret; `MAP_DEM_PROVIDERS` in `env.sh`
  overrides the providers (`glo30` alone for an instance outside Sweden,
  which needs no secret). The 1 m model is chosen in Settings → Height data
  (stored in the database, so a deploy does not reset it); the variable
  `MAP_DEM_LANTMATERIET_RESOLUTION_M` is only the default before that, and
  would have to go in `EXTRA_ENV` to survive a deploy.
- The tab shows such an account as "From the deploy configuration" with
  its user name. A secret fixed in Secret Manager reaches the instance on
  the next deploy or restart, which queues the maps that failed on it.
- The live check also runs from your own machine with your own
  credential (`read -rs MAP_DEM_LANTMATERIET_AUTH; export
  MAP_DEM_LANTMATERIET_AUTH`, then
  `pnpm --filter @oxygen/api dem:live-check -- --map /path/to/club-map.ocd`);
  it prints aggregates and writes nothing.

The fetch runs in the background after an import and is retried on
failure (docs/map-storage.md §4.7 "The DEM"); the tab lists every club
map's state, with **Retry** for a failed one. A refused credential shows
as `failed: auth`; it is retried after an hour, three times, then left
until a new account is saved in the tab (or, for the environment's, the
next deploy or restart). Memory: one DEM derive adds about 1 GB on the
largest corpus map, the order of the contour derive, and the two never
run at once on an instance (Test connection waits in the same queue).

## Sizing notes

- **Print and import memory.** `maps.pdf` composes in a worker thread
(`course-print.md` §8.2): `PRINT_WORKERS` (default `1`, max `4`) is how
many prints compose at once; each worker holds a decoded map document and
fonts (a Club-full print run peaked at 2.6 GB RSS), so on 2 vCPU / 4 GiB
keep it at 1, or 2 for small maps (set it with `EXTRA_ENV="PRINT_WORKERS=2"` in `env.sh`; a value set only by hand is removed by the next deploy). Workers use no database connection.
The rest of the 4 GiB is headroom for the map import worker (an OCAD
file parsed into a map document); since v0.6.1 (E5) the upload itself
parses nothing — it stores the chunks and starts the job.
- **Height-field memory.** Every import ends by deriving the map's
height field from its contours in a worker thread of its own
(`map-storage.md` §4.7), one at a time per instance: about 0.3 GB
added for a typical club map, 0.84 GB for Club-full, about 1.1 GB at
the 60 M-cell graph budget, which caps it. Beside a 2.6 GB Club-full
print that is about 3.7 GB, under the 4 GiB limit. The typed arrays live
outside the V8 heap, so `--max-old-space-size` does not bound them.
`MAP_HEIGHTFIELD_MAX_CELLS` (default 60 000 000, which refuses nothing)
lowers the cap on a smaller instance (via `EXTRA_ENV` in `env.sh`); a map over it gets no height field
(`over-cap`) and no 3D.
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
`docs/releases/slice-e.md` §2). Until then the v0.5.0 image, which reads
them, falls back to its defaults without them. The September 2026
tile incident and the whole-map raster OOM before it are recorded in
[bugfixes/archive/map-tile-cold-render-cloud-timeouts.md](../bugfixes/archive/map-tile-cold-render-cloud-timeouts.md).
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
  See [bugfixes/cloud-sql-handshake-eof.md](../bugfixes/cloud-sql-handshake-eof.md).

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
  [system/background-jobs-lease.md](../system/background-jobs-lease.md). Extra instances
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
[bugfixes/archive/map-tile-cold-render-cloud-timeouts.md](../bugfixes/archive/map-tile-cold-render-cloud-timeouts.md));
since then the likely culprits are importing an unusually large OCAD
file or several large prints at once, so raise `--memory` or keep
`PRINT_WORKERS` at 1.
- **Map never loads.** The viewer reads the event's pinned map document
(`/api/map-documents/:hash`); a map whose import has not pinned one
shows the import state instead (`map-storage.md` §4.6). Check the
import job (`mapImport.latestForEvent`) before the instance; re-upload
the map, or import it again with `pnpm map:rematch --event <name_id>`
(`scripts/gcp/backfill.sh --rematch` on Cloud Run).

## What this deployment does NOT change

- Source-building docker-compose files (`docker-compose.yml`, `host-db`,
`venue`) are unchanged. Self-hosters who want the published image use
[`docker-compose.release.yml`](../../docker-compose.release.yml) — see
[releases/README.md](../releases/README.md). The `cloud` Docker
target and `WEB_DIST_DIR` static serving are what GHCR and Cloud Run run.
- Spectator results still flow outbound to liveresultat.se — nothing
public is served from the IAP-protected instance.

