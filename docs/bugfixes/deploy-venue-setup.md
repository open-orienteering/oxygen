# Deploy and venue setup: dropped variables, IAP wiring, unmigrated boxes, unverified images

Fix package 18 of the code review (BLD-02, BLD-03, BLD-05, BLD-06, BLD-07, BLD-09, DB-32, DB-33).
Open follow-ups: [deploy-venue-followups.md](deploy-venue-followups.md).

## What happened

- **BLD-02.** `scripts/gcp/deploy.sh` passes `--set-env-vars` and `--set-secrets`, which replace the whole
  Cloud Run environment. `SYNC_SHARED_SECRET` appeared nowhere under `scripts/gcp/`, and tuning variables
  (`PRINT_WORKERS`, `MAP_HEIGHTFIELD_MAX_CELLS`) set by hand disappeared on the next deploy. Venue checkout
  then failed with `PRECONDITION_FAILED`, in the worst case mid-event.
- **BLD-07.** `read_scaling` treated any failing `gcloud run services describe` as "first deploy" and
  deployed with `--min-instances=0 --cpu-throttling`, switching an event-mode service to idle mode, while the
  closing message said the mode was unchanged. The DEM secret check had the same silent fallback.
- **BLD-03.** `docker-compose.venue.yml` named neither `SYNC_GOOGLE_AUDIENCE` nor
  `GOOGLE_APPLICATION_CREDENTIALS` and mounted no key, so a box could not authenticate to a cloud behind
  IAP (every deploy made by `deploy.sh` is).
- **DB-32.** The venue stack had no migrate step (the runbook's `exec api pnpm ...` cannot work: `pnpm` is not
  in the runtime image) and nothing noticed an unmigrated database.
- **BLD-09.** Containers ran as root, and `/health` answered ok with Postgres down, which node discovery
  trusted when choosing between box and cloud.
- **BLD-05 / BLD-06.** No check before merge booted the production image, publish moved `:edge` before
  its own smoke test, `release.yml` promoted any `sha-...` image, and on `main` `cancel-in-progress`
  cancelled the previous merge's publish.
- **DB-33.** `docker-compose.release.yml` pulled `stable` on every `up` and migrated without a dump.

## Fix

- **deploy.sh** (`scripts/gcp/deploy.sh`; tests `scripts/__tests__/gcp-deploy.test.mjs` with a stub `gcloud`):
  existence is asked with `gcloud run services list` / `gcloud secrets list`; a failing call prints its
  error and exits 1 before anything is migrated or deployed. The live scaling is read before the migrate
  job and the closing message prints the mode used. `SYNC_SECRET` (`oxygen-sync-secret`) is bound as
  `SYNC_SHARED_SECRET` when it exists (warning when not); `provision.sh` creates it (random value) and grants
  the runtime account access. `EXTRA_ENV` in `env.sh` carries `NAME=value;...` pairs (malformed entries and
  script-managed names are refused). The live revision's variable names are compared with what the deploy
  sets; the script lists the ones it would remove and aborts before migrating unless `--drop-unlisted`.
  `OXYGEN_GCP_ENV` selects the env file (tests).
- **Venue compose**: `SYNC_GOOGLE_AUDIENCE`, `GOOGLE_APPLICATION_CREDENTIALS` (set only with `VENUE_SA_KEY`)
  and a read-only key mount; the api logs at start (`describeSyncAuth`) whether IAP auth is on and warns about
  a half configuration or an unreadable key. A `migrate` service (same build as the api, `restart: "no"`)
  runs first; the api depends on it with `service_completed_successfully`. The runbook's `exec` step is gone
  and it has an "Upgrading the box" section.
- **`/ready`** (`packages/api/src/ready.ts`): `SELECT 1` raced against 2 s, then every directory of
  `prisma/migrations` must be a finished, not rolled-back row of `oxygen._prisma_migrations` (read once from
  the path beside `src/` or `dist/`, which is `packages/api/prisma/migrations` in the image too; a full match
  is cached). 200 `{status:"ok"}` or 503 `{status:"unavailable", reason, pending}`, `Cache-Control: no-store`,
  no auth (a plain route like `/health`, which stays cheap). Node discovery probes `/ready` and falls back to
  `/health` on 404 or a non-JSON body (older boxes). The venue api has a healthcheck on it and `web` waits
  for it; the release compose and `scripts/demo.sh` use it too.
- **Non-root**: `USER node` in the `api` stage (the `cloud` target inherits it). Nothing writes under `/app`
  (scratch files go to `os.tmpdir()`), `prisma migrate deploy` needs no writable tree, and the Cloud Run
  migrate job runs the same image. No image `HEALTHCHECK`.
- **Workflows**: `ci.yml` groups pushes per commit (`cancel-in-progress` stays for pull requests) and its
  `image` job runs `scripts/demo.sh` on the loaded image (own project, port 18080, pull policy `never`,
  `down -v` in an `always()` step) and asserts the image user is not root. `publish.yml` pushes `sha-...` only,
  and after the smoke writes `verified-sha-...`, then moves `edge` only when `scripts/edge-guard.mjs` says the
  commit is an ancestor of `origin/main` with no code change since. `release.yml` promotes `verified-sha-...`.
- **Release compose**: `pull_policy` defaults to `missing` (`OXYGEN_PULL_POLICY=always` restores the old
  behaviour; `demo.sh` keeps `always`). The header leads with a pinned `vX.Y.Z`; the upgrade is `pull`, a
  `pre-upgrade_*` dump outside the rotation, `up -d` ([backup-restore.md](../ops/backup-restore.md#before-an-upgrade)).

## Tests

`scripts/__tests__/gcp-deploy.test.mjs`, `venue-compose.test.mjs` (also the Dockerfile's `USER node`),
`release-compose.test.mjs`, `workflows.test.mjs`, `edge-guard.test.mjs`; `packages/api/src/__tests__/ready.test.ts`,
`sync-auth-describe.test.ts`, `integration/ready.test.ts` (503 after deleting one `_prisma_migrations` row);
`packages/web/src/lib/__tests__/node-discovery.test.ts`.
