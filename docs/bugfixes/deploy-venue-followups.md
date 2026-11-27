# Deploy and venue setup: follow-ups

Left open by [deploy-venue-setup.md](deploy-venue-setup.md).

- **Cloud Run startup probe on `/ready`.** The service still uses Cloud Run's default TCP startup probe.
  Pointing an HTTP startup probe at `/ready` would hold traffic until the database answers and the migrations
  are applied; not done because `deploy.sh` has no probe flags yet and a probe failing on a slow Cloud SQL
  wake-up needs a generous budget.
- **Confirm the non-root migrate job and service at the first real deploy.** The cloud container used for
  this change had no Docker daemon and no `gcloud`: `USER node` was proven only by reading the code (nothing
  writes under `/app`) and by the CI `image` job, which boots the image as that user. The first
  `./deploy.sh` after this change should be watched: the `oxygen-migrate` job's log and the service's first
  revision.
- **A `migrate` service in the dev compose files.** `docker-compose.yml` and `docker-compose.host-db.yml`
  were left alone (the developer runs `pnpm db:migrate`); their runbook-less users can still start an
  unmigrated stack. `/ready` reports it.
- **CI smoke of the venue compose.** CI boots `docker-compose.release.yml` only. The venue stack
  (`migrate`, healthcheck, `web` waiting for `api`, the key mount) is covered by `docker compose config` tests,
  not by a run.
- **Edge rollback and tag cleanup.** `edge` only moves forward. A bad `main` commit that passed the smoke
  stays `edge` until the next good one; there is no rollback command, and old `verified-sha-...` and `sha-...`
  tags accumulate in GHCR with no retention policy.
- **No image `HEALTHCHECK`.** Compose files define their own and Cloud Run ignores it; a plain `docker run`
  has none.
- **AGENTS.md §6 step 5 (Docker rebuild) was not run** in the cloud container (no Docker daemon). The CI
  `image` job (build, non-root check, `demo.sh` boot on `/ready`) is the proof.
