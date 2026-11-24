# Area 11: Build, Docker, CI, dependencies, release and deploy, and the test suites

Part of the 2026-11 full review (`docs/reviews/2026-11-full-review.md`). Reviewed on `main` at `df5460c3`. Review only: no code was changed.

**Scope:** the Dockerfile and the five compose files, the nginx configs, the GitHub workflows (CI, audit, docs links, publish, release), the GCP scripts (`scripts/gcp/*`), the release and version scripts, the verify-lock wrapper and its hook, dependency placement and pinning, the runbooks under `docs/ops/` and `docs/releases/`. Then the test suites themselves: the CI and Playwright configuration, E2E global setup, reseed and helpers, the API and shared unit and integration suites, the web unit suite and the 71 E2E specs, in both directions (important behaviour with no test, and tests that cost more than they give).

**Method:** four Fable reviewers read the area in full (build/Docker/deploy; CI and test infrastructure; API and shared tests; web and E2E tests), which gave 61 raw findings. Duplicates of findings already verified in areas 01, 03, 04, 05 and 06 were not re-verified; they are listed in the cross-reference table at the end, and the fact that a second reviewer reached them independently is noted there. The other 46 claims (including C2 and C12, which also match earlier findings) went to 18 fresh Fable verifiers, each given only the locations and the claims, never the reviewer's reasoning, and told to disprove them. High claims got one verifier each; medium and low claims were batched two to seven per verifier and judged one by one. `pnpm install` was not possible in this container (the install needs a lockfile rewrite for the `ocad2geojson` git tarball, which was refused), so no vitest, Playwright, tsc or Docker run was possible. Cheap dependency-free reproductions were run where they settle a question: the Cloud SQL URL parse and a psql connect to a closed port (BLD-01), the verify-lock hook fed 15 sample commands (BLD-28), the integration dev-database guard fed eight URLs (BLD-34), the shard partition over all 71 specs (clean), and the Eventor placement computation (cross-referenced to RES-05).

**Result:** no finding was dropped outright, but several sub-claims were refuted and removed: `runner.bulkUpdate` is tested (`runner-variants.test.ts:144-169`); authorisation is asserted for about 60 procedures, not 4 (the router-wide gap stays, as API-36); a package moved to devDependencies cannot break the image boot (the image ships all of them, BLD-13); the "no init process" part of the container finding (SIGTERM is handled); the `oxygen_e2e_1..4` doc line; the order dependence of `map-vector-layer` and `map-viewer-3d` (they reseed); the "duplicate" registration-dialog/kiosk-readout pair (different flows); and "replaying `runner.updated` re-runs the variant follow-up" (it loses it instead, BLD-21). Overlapping claims were merged: A5 into B1 (BLD-05), A6 with B12 (BLD-06), A15 with B11 (BLD-11), A11 with B8 and A16 (BLD-29), B7 with C14 (BLD-31), B10 with D14 (BLD-32). This leaves 37 findings.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 4 |
| Medium | 24 |
| Low | 9 |

No critical finding is new to this area. The critical defects the test reviewers ran into (the standalone kiosk that queues nothing offline, the USB reader that stores a truncated read with an OK beep, re-reads that overwrite a DQ) were already reported and verified in areas 04 to 06; the cross-reference table lists them with the test that would have caught each.

**Fix first:**
1. **BLD-02:** every `./deploy.sh` wipes `SYNC_SHARED_SECRET` from the Cloud Run service, so venue checkout, journal pull and checkin fail against the cloud after a routine release, and there is no supported way to set it.
2. **BLD-01:** the per-event backup download on Cloud Run connects to TCP `localhost:5432` instead of the Cloud SQL socket, and still returns a 200 `.sql` file that holds only a header and a "BACKUP FAILED" line.
3. **BLD-04:** an outbox drain that spans a competition switch sends the remaining batches with the new competition's header; the server applies them to that event, and the idempotency check then hides them from the right one.
4. **BLD-05:** nothing before merge boots the production image or runs `node dist/index.js`, and publish moves `:edge` before its own smoke test, so a bad build reaches `:edge` (and can be tagged as a release) with every PR check green.
5. **BLD-03:** the venue compose file cannot pass the IAP audience and key that the documented cloud deployment always requires, so the venue runbook followed as written cannot check out.

Quick wins (each S): BLD-08 (`.gitignore` for the secret files the runbooks create), BLD-10 (404 for missing `/assets/*`), BLD-14 (pin a non-UTC time zone in CI), BLD-15 (`failOnFlakyTests` or upload traces of flaky passes), BLD-26 (the start-screen spec asserts nothing).

---

## High

### BLD-01 The per-event backup on Cloud Run cannot reach the database, yet downloads as a 200 file
- **Area / category:** backup on the cloud deployment; functional (silent backup failure).
- **Location:**
  - `packages/api/src/backup.ts:109-121` (`parseDatabaseUrl`), `:239-263` (`spawnPgDump` builds `-h/-p` from it), `:301-308` (failure trailer).
  - `scripts/gcp/provision.sh:51`: `DATABASE_URL="postgresql://USER:PW@localhost/DB?host=/cloudsql/<conn>&schema=oxygen"`.
  - Web download link: `packages/web/src/pages/EventPage.tsx:1592` (legacy alias `/api/backup/competition`, routes at `backup.ts:340-394`).
  - Doc that says it works: `docs/ops/deploy-gcp-cloud-run.md:298-301`.
- **What is wrong:** the app connects through `pg`, which honours the `host=` query parameter (the Cloud SQL unix socket). `backup.ts` re-parses the URL by hand and uses `u.hostname` (`localhost`) and port 5432, so `psql` is started with `-h localhost -p 5432`. The `host` search parameter is never read. Nothing listens on TCP 5432 in a Cloud Run container. The header is written before psql starts, so the browser receives a normal-looking attachment.
- **Scenario:** before a race the organiser presses Download backup on the club's Cloud Run instance. psql exits 2 with "connection refused"; the response is a 200 `.sql` file containing only the comment header and `-- BACKUP FAILED (exit 2): …`. The organiser files it as the event backup.
- **Fix (S, plus M for the visible failure):**
  - In `parseDatabaseUrl`, use `u.searchParams.get("host") ?? u.hostname` for `-h` (psql accepts a socket directory there). Export the function and unit-test it with the `provision.sh` URL shape.
  - Make a failed dump visible: hold the first write until psql produces its first output and answer 502 if it fails before that; destroy the response on a later failure so the browser shows a failed download. This overlaps API-12 and DB-13 (psql errors swallowed); fix together.
- **Verdict:** confirmed. Reproduced the parts that can run here: Node's URL parse of the provision shape gives hostname `localhost`, empty port and the socket only in `searchParams`; psql against a closed port exits 2 with "Connection refused". Not run on Cloud Run; psql 15 (node:24-slim) against a PG 18 server was not checked. Rated high rather than critical: the venue laptop (TCP URL) is unaffected and Cloud SQL's daily backups exist (but see cross-reference DB-35). (reviewer A1)

### BLD-02 `deploy.sh` replaces the whole Cloud Run environment and drops `SYNC_SHARED_SECRET` and the tuning knobs on every deploy
- **Area / category:** cloud deploy; functional / stability.
- **Location:**
  - `scripts/gcp/deploy.sh:174-175`: `--set-secrets=…` and `--set-env-vars="^;^NODE_OPTIONS=…"` with a fixed list; `SYNC_SHARED_SECRET` appears nowhere under `scripts/gcp/` (nor in `env.sh.example`).
  - `packages/api/src/sync/nodeIdentity.ts:45-48` (read only from `process.env`); `packages/api/src/trpc.ts:190-197` (`peerProcedure` refuses when unset); users `routers/events.ts:249` (`events.since`), `routers/lease.ts:88-130` (`acquire`, `release`, `exportSnapshot`, `exportSettings`, `exportBlob`, `exportMapRows`).
  - The repo's own statement of the replace semantics: `docs/releases/slice-e.md:211`. Docs that tell operators to set values the next deploy removes: `docs/releases/slice-e.md:294-295` ("Keep `MAP_RENDER_CONCURRENCY` and `PRINT_WORKERS`"), `docs/ops/deploy-gcp-cloud-run.md:391-394` (`PRINT_WORKERS`), `:405-407` (`MAP_HEIGHTFIELD_MAX_CELLS`), `docs/ops/venue-runbook.md:14-15`.
- **What is wrong:** `--set-env-vars` and `--set-secrets` remove every variable not listed. The venue runbook requires the cloud node to have `SYNC_SHARED_SECRET`, the only way to set it is a manual `gcloud run services update`, and the next `./deploy.sh` silently removes it. `PRINT_WORKERS` and `MAP_HEIGHTFIELD_MAX_CELLS` are env-only and go the same way.
- **Scenario:** the club sets the secret by hand and tests checkout. The week before the event they follow the release runbook (`./deploy.sh v0.9.x`, `docs/releases/runbook.md:58`). At the arena "Check out to this node" fails with `PRECONDITION_FAILED "Node-to-node sync is not configured on this node"`. If the deploy happens during a leased event (the script explicitly supports that, `deploy.sh:88-89`), the journal pull and the final checkin start failing mid-event.
- **Fix (M):**
  - Treat the sync secret like the DEM secret: a Secret Manager secret `oxygen-sync-secret`, bound in `provision.sh` (with `secretAccessor` for the run service account), appended to `--set-secrets` when it exists, with a warning (not a failure) when it does not.
  - An `EXTRA_ENV` passthrough in `env.sh` for `PRINT_WORKERS`, `MAP_HEIGHTFIELD_MAX_CELLS` and similar (values must not contain `;`, the `^;^` delimiter).
  - Make `deploy.sh` diff the live revision's variables (`read_scaling` already fetches the service JSON) against what it is about to set and print every variable it will drop. This is the part that stops the next unlisted variable from vanishing.
  - Fix `env.sh.example`, the deploy doc's "Venue-box sync through IAP" section, the venue runbook and `slice-e.md:294-295`. `MAP_DEM_LANTMATERIET_RESOLUTION_M` has a supported path in Settings, so there only the doc sentence (`deploy-gcp-cloud-run.md:366-369`) is wrong.
- **Verdict:** confirmed from the code and the repo's docs (gcloud's replace semantics are documented behaviour, not executed here). Not traced: what the venue shipper does while pulls fail mid-lease. High, not critical: no data is lost and one command restores it, if someone at the arena has gcloud access and recognises the message. (reviewer A2)

### BLD-03 The venue compose file cannot pass the IAP credentials that the documented cloud deployment requires
- **Area / category:** venue to cloud wiring; functional.
- **Location:**
  - `docker-compose.venue.yml:47-59`: `api.environment` is a fixed map (no `SYNC_GOOGLE_AUDIENCE`, no `GOOGLE_APPLICATION_CREDENTIALS`), no `env_file`, no volume on `api`; header comment `:10-17`.
  - `packages/api/src/sync/googleIdToken.ts:12-18,39-42,63-67` (audience unset means no ID token); used by `sync/shipper.ts:90-95` and `sync/lease.ts:433`.
  - `scripts/gcp/deploy.sh:182` (`--no-allow-unauthenticated`): the cloud is always behind IAP.
  - Docs: `docs/ops/deploy-gcp-cloud-run.md:223-264` ("add to the API container's environment", host path to `venue-sa.json`); `docs/ops/venue-runbook.md:19-27` (`.env.venue` example has neither variable; no mention of IAP at all).
- **What is wrong:** values in `.env.venue` are only used for `${…}` interpolation in the compose file; they never reach the container unless the file names them. The compose file names neither the audience nor the key, and nothing mounts the key file.
- **Scenario:** an operator follows the venue runbook against the club's cloud. Every lease and shipper call gets IAP's sign-in redirect or 401, and checkout fails. Testing the day before finds it at home; not testing finds it at the arena.
- **Fix (S):**
  - In `docker-compose.venue.yml`: `SYNC_GOOGLE_AUDIENCE: "${SYNC_GOOGLE_AUDIENCE:-}"`, `GOOGLE_APPLICATION_CREDENTIALS: "${VENUE_SA_KEY:+/run/secrets/venue-sa.json}"`, and a read-only bind mount `"${VENUE_SA_KEY:-/dev/null}:/run/secrets/venue-sa.json:ro"`. Say that `VENUE_SA_KEY` must be an absolute or `./` path (a bare name becomes a named volume).
  - Add both as optional "cloud behind IAP" lines to the runbook's `.env.venue` block, update the compose header, replace the vague sentence in the deploy doc, cross-link the two docs.
  - Log at startup on a venue node whether IAP auth is on, so a misconfiguration is diagnosable.
- **Verdict:** confirmed from the files; the IAP rejection itself is what the repo's code comments and docs state. One overstatement removed: an untracked compose override file would also work, but nothing documents it. (reviewer A9; verifier raised it from medium to high)

### BLD-04 An outbox drain that spans a competition switch writes the rest of the queue into the other competition
- **Area / category:** station offline queue and multi-competition routing; tests (gap) exposing a functional defect.
- **Location:**
  - `packages/web/src/lib/trpc.ts:22-31,74`: `headers: getCompetitionHeader` is evaluated per HTTP request from `window.location.pathname`.
  - `packages/web/src/lib/offline/sync.ts:14-74`: module-level loop, 50 entries per awaited push; the `competitionId` filter is captured when the drain starts; the `draining` flag makes the new competition's own drain return 0. Nothing aborts the loop on navigation (`useEventQueue.ts:51,75` only suppresses state updates); navigation between events is client-side (`App.tsx:97`).
  - `packages/api/src/routers/events.ts:229-237` and `:88-151`: entries are applied to `ctx.event` (from the header, `packages/api/src/trpc.ts:55-57`); `entry.competitionId` (`:69`) is never compared with it. Idempotency at `:99-106` is `journalEntry.findUnique({ where: { id } })` with no event scope.
  - Tests: no test imports `offline/sync`; `e2e/offline.spec.ts` uses one competition; `events-push.test.ts:49` always sends the matching `competitionId`.
- **What is wrong:** the client routes each batch by the URL at the moment the request is built, not by the entries in it, and the server trusts the header. Once an entry is journaled under the wrong event, re-sending it to the right one answers "synced" without applying it, and the client has already marked it synced and deletes it after 24 h (`sync.ts:46-49`, `cleanupSyncedEvents`).
- **Scenario:** on a two-race day a finish station comes back online with 300 queued entries for race A. While batches 3 to 6 are still to go, the operator opens race B. Those batches go out with `x-competition-id: B`: A's card reads are stored under B, and A's `result.applied` and `finish.recorded` are matched by `(eventId, cardNo)` to B's runners (same people, same cards). A's results for those runners are gone unless the cards are read again.
- **Fix (M):**
  - Client: pass the competition per call (`events.push.mutate(input, { context: { competitionId } })` and a `headers` function that reads the op context, falling back to the URL). When the drain runs without a filter, group pending entries by `competitionId` and push each group under its own header.
  - Server: in the `events.push` handler (not inside `ingestJournalEntries`, which the shipper pull at `sync/shipper.ts:240` also calls), return entries whose `competitionId` differs from `ctx.event.nameId` in `failed`. Scope the idempotency lookup to the event, or report an id found under another event as failed.
  - Tests: a unit test of the drain with an injected client and store (`fake-indexeddb` is not a dependency today; `control-outbox.ts` already uses an injected memory store) that changes `location` between batches and asserts the competition per batch; an integration test in `events-push.test.ts` that a mismatching `competitionId` lands in `failed`.
- **Verdict:** confirmed from code; the navigation-during-drain timing was not reproduced. High rather than critical: the outcome is cross-competition corruption plus lost reads, but it needs a backlog of more than 50 entries and an event switch within the seconds of a multi-batch drain. The server half (no competition check on `events.push`) is part of SYNC-04 and API-02; the client routing is new here. (reviewer D6)

---

## Medium

### BLD-05 Nothing before merge boots the production image, and publish moves `:edge` before its own smoke test
- **Area / category:** CI and release integrity; tests (CI gap) / stability.
- **Location:**
  - `.github/workflows/ci.yml:193-218` (job `image`: builds `cloud`, amd64 only, then runs only `packages/api/scripts/image-smoke.mjs` (sharp/resvg) and `node --version`).
  - `.github/workflows/publish.yml:42-62` (one build step pushes `sha-…` and `edge`), smoke `:63-68` (`scripts/demo.sh`, the first `prisma migrate deploy` and the first `node dist/index.js` anywhere), nothing rolls `edge` back.
  - `.github/workflows/release.yml:49-57`: promotes any `sha-…` manifest that exists to `stable`/`latest`; no check that the smoke passed.
  - Why it matters: `packages/api/tsconfig.json` uses `moduleResolution: bundler`, so tsc accepts imports Node ESM rejects (extensionless paths, an `@oxygen/shared/<subpath>` missing from the hand-written export map at `Dockerfile:51-56`). Every test tier runs the API from source under tsx or vitest (`playwright.config.ts:110`).
  - Docs: `docs/releases/README.md:16` ("Latest verified main"), `README.md:108,125`.
- **What is wrong / scenario:** a PR adds an import that resolves under tsx but not under plain Node, or a migration that works in the test harness fails in the image. Unit, integration, all E2E shards and `image` are green; the PR merges (or is auto-merged by the weekly dependency routine); publish pushes `edge`, then `demo.sh` fails. `scripts/demo.sh:18` and `provision.sh:84` default to `:edge`, and a maintainer who tags without looking at the publish result promotes the build to `stable`.
- **Fix (S–M):**
  - In job `image`: `load: true`, then `OXYGEN_IMAGE=oxygen-smoke:ci OXYGEN_PULL_POLICY=never OXYGEN_PORT=18080 COMPOSE_PROJECT_NAME=oxygen-pr-smoke bash scripts/demo.sh`, with an `if: always()` `docker compose … down -v` using the same project name.
  - In publish: push only `sha-…`, run the smoke, then `docker buildx imagetools create --tag $IMAGE:edge $IMAGE:sha-…` as the last step (combine with the tip-of-main guard in BLD-06).
  - In release: require proof the smoke passed, either a `verified-sha-…` tag written after the smoke or a check-runs query (that needs `checks: read` or `actions: read` added to `release.yml`).
  - Fix the "verified" wording in the release docs.
- **Verdict:** confirmed from the workflows. Medium, not high: the failure is loud and limited to a red main and a broken `:edge`; venue boxes build from the venue compose and production deploys use `vX.Y.Z`. The "moved to devDependencies" sub-scenario is refuted (the image ships all dependencies, BLD-13). (reviewers B1, A5, merged)

### BLD-06 `cancel-in-progress` on `main` cancels the previous merge's CI and publish, so a release commit can end up with no image
- **Area / category:** release process; stability.
- **Location:** `.github/workflows/ci.yml:18-20` (`group: ci-${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: true`), `:236-245` (publish is a job of the same run); `publish.yml:44` (always tags `edge`); `release.yml:49-52`; `docs/releases/runbook.md:40`, `docs/releases/README.md:15,53-54,130`.
- **What is wrong:** on `main` every push shares one group, so the next merge cancels the whole in-flight run of the previous one, publish included. That commit never gets `sha-<commit>`, and if the cancel lands between push and smoke, `edge` points at an unsmoked image (BLD-05). If the later run then fails, there is no completed main result for either commit.
- **Scenario:** realistic, not hypothetical: `git log` shows six PRs merged in 47 seconds on 2026-11-21 (#240 to #245) and #251/#252 three minutes apart; every run but the last of such a burst is cancelled. A release PR merged inside such a burst cannot be tagged: `release.yml` fails with "No GHCR image". Re-running the old run later moves `edge` back to the older commit.
- **Fix (S–M):** `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` alone is not enough, because GitHub keeps only one pending run per group and a third push still drops the second. Use a per-SHA group on push (`group: ci-${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}`), and move `edge` only when the built commit is still the tip of main (`git ls-remote origin main` in the post-smoke retag step of BLD-05). Keep the runbook's recovery note (tag a later commit that still carries the bumped `package.json`).
- **Verdict:** confirmed from the config and the merge history; the cancellation itself is GitHub's documented concurrency behaviour. Docs-only merges start no run (`paths-ignore`) and cancel nothing. (reviewers A6, B12, merged)

### BLD-07 `deploy.sh` silently switches an event-mode service to idle mode when one describe call fails
- **Area / category:** cloud deploy during an event; stability.
- **Location:** `scripts/gcp/deploy.sh:89-96` (`read_scaling`: any non-zero exit of `gcloud run services describe … 2>/dev/null` sets `MIN_INSTANCES=0; CPU_THROTTLING=1`, prints nothing), passed explicitly at `:136-139,167,180-181`; `:226` prints "Idle vs event mode is unchanged" unconditionally; intent stated at `:13,87-88`. Same pattern at `:153` (`gcloud secrets describe "$DEM_SECRET" … >/dev/null 2>&1`).
- **What is wrong:** the fallback meant for "first deploy" also catches a transient API error. The deploy then passes `--min-instances=0 --cpu-throttling`, which overwrites event mode, and the closing message says the mode is unchanged. With CPU throttled outside requests the LiveResults push and the ROC poll stop (`idle-mode.sh:2-5`). The `:153` case drops the DEM secret from the revision the same way (because `--set-secrets` replaces).
- **Scenario:** during an event the operator hot-fixes with `./deploy.sh sha-…` over arena Wi-Fi; the one describe call between two successful gcloud calls times out. Live results and radio punches stop on the cloud, and the script said nothing changed.
- **Fix (S):** keep stderr; treat only NOT_FOUND as first deploy (or test existence with `gcloud run services list --filter="metadata.name=$SERVICE" --format='value(metadata.name)'`), otherwise print the error and `exit 1`. Print the deployed mode at `:226`. Apply the same to the secret check at `:153`.
- **Verdict:** confirmed from the code (no gcloud here). Auth or permission errors would stop the script earlier at `run_migrate` (`:211`), so the realistic trigger is a transient failure. (reviewer A7)

### BLD-08 Secret files the runbooks tell operators to create are not git-ignored
- **Area / category:** secrets handling; security.
- **Location:** `.gitignore:3-7` (ignores `.env`, `.env.local`, `scripts/gcp/env.sh`, `scripts/gcp/iap-settings.yaml`); `docs/ops/venue-runbook.md:21-27,33` and `docker-compose.venue.yml:10,17` (`.env.venue` in the repo root, holds `SYNC_SHARED_SECRET`); `docs/ops/deploy-gcp-cloud-run.md:134-143` (`iap_settings.yaml`, underscore, with the OAuth client secret), `:238-239,253-257` (`venue-sa.json`, a service-account private key, written to the working directory); `scripts/gcp/deploy.sh:198` (`gcloud builds submit "$REPO_ROOT"`; no `.gcloudignore`, so gcloud derives one from `.gitignore`).
- **What is wrong:** `git check-ignore` matches none of `.env.venue`, `venue-sa.json`, `iap_settings.yaml`. The one IAP rule names a file (`iap-settings.yaml`, hyphen) that no doc or script creates.
- **Scenario:** a maintainer creates the IAP file and the key as documented, with the repo as working directory (right after `source scripts/gcp/env.sh`), and later runs `git add -A` for a doc fix: the OAuth client secret or the service-account key goes to the public repository. `deploy.sh --from-source` also uploads them to the Cloud Build source bucket.
- **Fix (S):** add `.env.*` with `!.env.example`-style exceptions, `*-sa.json`, `iap_settings.yaml` and `iap-settings.yaml` to `.gitignore`; use one file name in the doc and the rule; better, have the docs write the key and the IAP file outside the checkout (`~/…` or `mktemp`). Mirroring into `.dockerignore` is hygiene only: the Dockerfile copies only manifests and `packages/*`, so root files never reach an image layer.
- **Verdict:** confirmed (`git check-ignore -v` run). The docs do say "delete after applying" and "copy somewhere private", a mitigation by instruction only. (reviewer A10)

### BLD-09 Containers run as root, and `/health` answers ok with the database down, which node discovery then trusts
- **Area / category:** containers and readiness; security / stability.
- **Location:** `Dockerfile:66-107` (no `USER`, no `HEALTHCHECK`); `packages/api/src/index.ts:101` (`/health` returns a static `{status:"ok"}`); `docker-compose.venue.yml:37-59` (no healthcheck on `api`), `:64-70` (`web` has `depends_on: - api` without a condition); `docker-compose.release.yml:63-72`, `scripts/demo.sh:37-39`, `docs/ops/venue-runbook.md:53` rely on `/health`; `packages/web/src/lib/node-discovery.ts:14-16,112-122` probes `/health` to pick the active node.
- **What is wrong:** the API parses untrusted uploads (OCAD, OMAP, zip, XML) and spawns `psql` as uid 0. More important at an event: node discovery chooses a venue node by its `/health`, which does not touch Postgres.
- **Scenario:** the venue box's Postgres container stops (disk full, OOM) or the box was never migrated (DB-32). `/health` still answers ok, so stations keep preferring the box over the cloud fallback, and every tRPC call fails.
- **Fix (M):** add `/ready` (`SELECT 1` with a short timeout) and keep `/health` cheap (the client probes every 15 s); decide deliberately whether node discovery should use `/ready`; add a healthcheck to the venue `api` and `condition: service_healthy` on `web`; `USER node` in the `api` stage after checking that `prisma migrate deploy` and the Cloud Run job work unprivileged (non-test writes found go only to `os.tmpdir()`).
- **Verdict:** confirmed, with corrections: "no init process" is a non-issue (SIGINT/SIGTERM handled at `index.ts:185-186`) and was removed; "unmigrated" cannot pass at start-up in the release compose (`migrate` must complete first), only on the venue stack. The node-discovery consequence was found by the verifier. The unmigrated-venue part is DB-32's; this row is about the probe. (reviewer A13)

### BLD-10 The cloud image answers a missing `/assets/*` file with `index.html` and status 200
- **Area / category:** static serving on Cloud Run; functional.
- **Location:** `packages/api/src/staticServe.ts:44-51` (not-found handler sends `index.html` for every GET/HEAD outside `/trpc` and `/api`; with `wildcard: false` at `:35` every file not present at start-up falls through); header claim at `:6` that it replicates nginx; contrast `docker/nginx.conf:45-48` (404). PWA: `packages/web/vite.config.ts:47` (`registerType: "prompt"`), `:122-129` (print worker, CacheFirst, `statuses: [200]`, one-year expiry), `:107-116` (fonts and text atlas, same shape). `packages/api/src/__tests__/static-serve.test.ts` has no missing-asset case.
- **Scenario:** after a cloud deploy, a tab still running the previous bundle starts its first PDF export or opens the vector map; the old hashed URL returns HTML with 200, the import fails with a MIME error, and Workbox stores the HTML under that script URL. Printing or map fonts stay broken in that tab until a reload to the new bundle. Venue and compose stacks use nginx and are not affected.
- **Fix (S):** in the handler, 404 when the path starts with `/assets/` or its last segment has a file extension (covers `sw.js`, `manifest.webmanifest`, `workbox-*.js`); add both cases to `static-serve.test.ts`.
- **Verdict:** confirmed from code; raised from low to medium by the verifier because of the Workbox caching. (reviewer A14)

### BLD-11 Every GitHub Action is pinned to a moving major tag, including in the jobs that can push `edge`, `stable` and `latest`
- **Area / category:** supply chain; security.
- **Location:** `.github/workflows/publish.yml:19-24,47`, `release.yml:19,22,23,35,36`, `ci.yml:33-35,114,130,199,201`, `audit-pr.yml:20-22`, `docs-links.yml:21-22`. Third-party actions: `pnpm/action-setup@v6` (6 uses), `docker/setup-qemu-action@v4`, `docker/setup-buildx-action@v4`, `docker/login-action@v4`, `docker/build-push-action@v7`. Unused `id-token: write` and `attestations: write` at `publish.yml:8-10`, `release.yml:9-12`, `ci.yml:241-245` (no attestation step exists). Base images: `Dockerfile:2` (`node:24-slim`), `:110` (`nginx:alpine`, no version), `postgres:18-alpine` in the compose files. No Dependabot or Renovate config in `.github/`.
- **What is wrong:** npm packages have a 7-day hold (`pnpm-workspace.yaml` `minimumReleaseAge: 10080`); Actions have none. A retagged `v7` runs on the next merge with a token that can push `ghcr.io/…:edge`, and in `release.yml` move `stable` and `latest`. `nginx:alpine` takes whatever nginx is current on the day a venue box is rebuilt.
- **Fix (S–M):** pin every `uses:` to a full commit SHA with the version as a trailing comment; add `.github/dependabot.yml` for `github-actions` and `docker` so the pins do not rot; drop the unused permissions or add `actions/attest-build-provenance`; pin `nginx:<minor>-alpine`. Rework `scripts/__tests__/gha-node24-actions.test.mjs:16-25`, which matches `owner/action@vN` strings, to read the version from the comment, and add an assertion that every `uses:` is a 40-hex SHA (local `./` workflows excepted).
- **Verdict:** confirmed. Medium for the action pins in publish and release, low for the base images and permissions. Otherwise clean: triggers are `pull_request` (not `pull_request_target`), top-level `contents: read`, only `GITHUB_TOKEN` used. (reviewers A15, B11, merged)

### BLD-12 Production logs go through `pino-pretty` unconditionally, so Cloud Logging gets unstructured text with no severity
- **Area / category:** logging and dependencies; engineering (diagnosability).
- **Location:** `packages/api/src/index.ts:39-45` (the `pino-pretty` transport is set with no `NODE_ENV` branch; no other branch exists in non-test API source); `packages/api/package.json:52` (`pino-pretty` in `dependencies`); `Dockerfile:102` sets `NODE_ENV=production`. Dependency placement in the same change: `packages/api/package.json:50` (`pdf-lib` in `dependencies`, imported only by seven integration tests and three E2E files through `createRequire`; the product uses `@cantoo/pdf-lib`); root `package.json:46-51` (`i18next`, `qrcode.react`, `react-i18next` duplicate `packages/web`; `svg-control-descriptions` is used only by `scripts/generate-iof-symbol-meta.mjs:16`).
- **What is wrong:** every production log line is prettified in a worker thread and reaches Cloud Logging as a text payload with default severity, so an error during an event cannot be filtered by level or queried by field.
- **Fix (S):** no transport when `NODE_ENV === "production"`, and map pino's `level` to Cloud Logging `severity` via `formatters.level`. Move `pdf-lib` and `svg-control-descriptions` to devDependencies and drop the duplicated root dependencies; keep `pino-pretty` where it is until BLD-13 settles what the image installs.
- **Verdict:** confirmed. The verifier split the logging part out as medium; the placement part alone is low. (reviewer A17)

### BLD-13 The API and cloud images ship the whole workspace install, and the migrate job depends on a devDependency
- **Area / category:** image contents; engineering / performance.
- **Location:** `Dockerfile:26` (`pnpm install --frozen-lockfile`, no `--prod`), `:92` (copies the full `/app/node_modules` into `api`), `:100` (`packages/api/` from `build`, including `node_modules/.bin/prisma`); `packages/api/package.json:61` (`prisma` in devDependencies) versus `docker-compose.release.yml:43` and `scripts/gcp/deploy.sh:130` (run `node_modules/.bin/prisma migrate deploy` in the image); `packages/api/prisma.config.ts` (imports `prisma/config` and `dotenv/config`); `AGENTS.md:115` ("no dev dependencies").
- **What is wrong:** the runtime image contains Playwright, vitest, TypeScript, ESLint, the Vite and Tailwind native binaries and the whole web toolchain. That slows every pull (Cloud Run cold start, a venue box on arena network) and hides a trap: a well-meant switch to a production install breaks `prisma migrate deploy` in the release compose and in `deploy.sh`. The weekly audit (`scripts/audit-prod.mjs:78-80`) skips devDependencies on the premise that they do not ship.
- **Fix (M):** move `prisma` to `dependencies` of `@oxygen/api`; add a `prod-deps` stage (`pnpm install --frozen-lockfile --prod --filter @oxygen/api...`; `pnpm deploy` on pnpm 10 needs `--legacy` or `inject-workspace-packages=true`) that supplies `/app/node_modules` and `packages/{api,shared}/node_modules` without the build stage overwriting them; keep the publish smoke as the guard; correct `AGENTS.md:115`. Do this together with BLD-30 (build once), since both reshape the stage graph.
- **Verdict:** confirmed. Medium as a maintenance trap and wrong doc; the attack-surface part is low (no dev tool is reachable from the running server). (reviewer A12)

### BLD-14 Every suite runs only in UTC, so a local-time versus UTC mix-up cannot fail CI
- **Area / category:** CI configuration; tests.
- **Location:** `playwright.config.ts:68-79` (no `timezoneId`, no `locale`), `:113-136` (API `webServer.env`, no `TZ`); `packages/api/vitest.config.ts:4-8`, `packages/api/vitest.integration.config.ts:4-17`, `packages/shared/vitest.config.ts:4-9`, `packages/web/vite.config.ts:23-39`; `.github/workflows/ci.yml:25-26`. A repo-wide grep for `TZ`, `timezoneId`, `timeZone` and `getTimezoneOffset` finds only `playwright.showcase.config.ts:30`.
- **What is wrong:** timing code reads process-local or browser-local hours (`packages/api/src/timeConvert.ts:45`, `routers/race.ts:83-91`, `routers/event.ts:401`, `routers/runner.ts:355`, `routers/lists.ts:52`, `packages/web/src/pages/FinishStation.tsx:158,223`, `StartScreenPage.tsx:49`, `lib/si-protocol.ts:766,1318`). On `ubuntu-latest` everything is UTC, where local equals UTC. Real deployments are a venue laptop in CET/CEST and a UTC cloud container with browsers in CET.
- **Scenario:** a change swaps `getHours` for `getUTCHours` in a finish-time path; CI is green; at an event in Sweden every manually stamped finish is one or two hours off.
- **Fix (S, M if it surfaces failures):** set `TZ` in the configs themselves so local runs match CI (`process.env.TZ ??= "Europe/Stockholm"` in `playwright.config.ts` plus `timezoneId` in `use`, and `test.env` in the vitest configs). Existing tests that build dates with the local constructor (`packages/api/src/__tests__/timeConvert.test.ts:88-135`, `packages/web/src/lib/__tests__/format.test.ts:17-54`) make the pin effective immediately. Optionally one extra unit pass with `TZ=America/Los_Angeles`, and one E2E smoke with the API in UTC and the browser in Stockholm to mirror the cloud.
- **Verdict:** confirmed (grep). A CI safety-net gap, not a demonstrated bug; developers in Sweden do run locally in CET. The product-side defect (server "time of day" in the process zone) is SI-23 and RES-06. (reviewer B2)

### BLD-15 CI's `retries: 2` turns intermittent failures green with no signal and no trace of the failing attempt
- **Area / category:** CI configuration; tests / stability.
- **Location:** `playwright.config.ts:61` (`retries: process.env.CI ? 2 : 0`), `:74` (`trace: "on-first-retry"`); `.github/workflows/ci.yml:128-136,178-186` (artifacts uploaded only `if: failure()`); `scripts/e2e-sharded.mjs:291-315` (summary lists exit codes only); no `failOnFlakyTests` anywhere; `AGENTS.md:95-100` ("Do not skip, retry-loop, or mark it as known-flaky"); `docs/dev/e2e-sharding.md:75-76`.
- **What is wrong:** a test that fails once and passes on retry exits 0; the `e2e` gate and `publish` are green. The flaky count is in the raw log only. The recorded trace is of the retry (a passing run), and it is not uploaded either.
- **Scenario:** a real race in the readout or kiosk path fails one run in three; every CI run passes on retry, the weekly dependency routine sees "fully green" and auto-merges, and the race ships.
- **Fix (S):** set `failOnFlakyTests: !!process.env.CI`, or, if green-on-retry is kept: `trace: "retain-on-first-failure"`, upload on `${{ !cancelled() }}`, and have `e2e-sharded.mjs` add the flaky count to `GITHUB_STEP_SUMMARY` (from a `json` reporter rather than a regex on list output). Expect hidden flakes to turn red at first; correct the sharding doc.
- **Verdict:** confirmed from the config; that a retried pass exits 0 is Playwright's documented behaviour. "No signal" softened to "only in the raw log". (reviewer B3)

### BLD-16 API tests, all of `e2e/` and the root scripts are never type-checked, and the API has no ESLint
- **Area / category:** CI coverage; tests / engineering.
- **Location:** `packages/api/tsconfig.json:15-16` (`exclude: ["src/**/__tests__"]`), `packages/api/package.json:16,18` (`build: tsc`, `lint: tsc --noEmit`, same project); no `tsconfig` at the root or in `e2e/` (`packages/web/tsconfig.app.json` includes `src`, `tsconfig.node.json` only `vite.config.ts`); only `packages/web/eslint.config.js` exists, and it is not type-aware (no `no-floating-promises`); `ci.yml:50-51`; docs that claim otherwise: `AGENTS.md:29` ("Lint | ESLint"), `docs/dev/lint-policy.md:3`.
- **What is wrong:** 173 API test files (81 integration) and their helpers (including the `document-db-stub.ts` cast `as unknown as PrismaClient`), 71 E2E specs, the E2E helpers and seed builders (which write Prisma rows), both Playwright configs and `scripts/*.ts` are in no tsc project; vitest and tsx strip types. API and shared "lint" repeats the build. Web and shared tests are type-checked.
- **Scenario:** a Prisma model or router context changes; a seed builder or the DB stub keeps the old shape; tsc is green and the drift shows up later as a confusing E2E failure, or not at all. Separately, a floating promise in an API handler passes every check (the missing `unhandledRejection` handler that would turn it into a crash is API-37i and SYNC-39).
- **Fix (M, possibly L for the backlog):** `packages/api/tsconfig.test.json` extending the base with `noEmit`, `include: ["src"]` and an explicit `"exclude": []` (an inherited exclude would otherwise keep tests out), used by API lint; a root `tsconfig.e2e.json` for `e2e/**`, `playwright*.config.ts` and `scripts/**/*.ts`, run after `db:generate` in the `unit` job; typescript-eslint with `no-floating-promises` and `no-misused-promises` for `packages/api`. Fix the two docs.
- **Verdict:** confirmed; the counts are exact. Medium: a missing guard, not a demonstrated defect. (reviewer B4)

### BLD-17 Nothing checks that `schema.prisma` and the migrations agree
- **Area / category:** CI coverage; tests.
- **Location:** `.github/workflows/ci.yml:40-41,68-74` (only `db:generate` and `test:integration`); `packages/api/src/__tests__/helpers/global-setup.ts:45-51`, `e2e/helpers/ensure-e2e-db.ts:47-54` (`prisma migrate deploy` only). No `migrate diff`, `migrate status` or shadow database anywhere. `AGENTS.md:33` lists `pnpm db:push` as a normal command.
- **What is wrong:** the client is generated from `schema.prisma` while every real database is built from 67 migrations. Drift that queries do not trip over (a missing index or unique constraint, an `onDelete`, a default) passes every tier.
- **Scenario:** a developer adds `@@unique([eventId, cardNo])` to the schema, runs `db:push` locally, and writes a migration that adds the column but not the constraint. Tests never insert the duplicate, so they pass; venue and cloud databases accept duplicates.
- **Fix (S–M):** after `migrate deploy` on the fresh CI database, run `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (Prisma 7 removed `--shadow-database-url` from `migrate diff`; the alternative is `shadowDatabaseUrl` in `prisma.config.ts`). The 33 triggers and 36 CHECK constraints in the migrations are not modelled by the diff and should not show up; try it locally before making it blocking.
- **Verdict:** confirmed (the missing guard is proven; whether drift exists today was not checked). The flag correction is from the verifier's knowledge of the Prisma 7 CLI and could not be run. (reviewer B5)

### BLD-18 The `web` (nginx) image and `docker/nginx.conf`, used by the venue stack, are built and validated by nothing
- **Area / category:** CI coverage; tests.
- **Location:** `Dockerfile:110-115` (target `web`, copies `docker/nginx.conf`); `docker-compose.venue.yml:40,67,74`; `ci.yml:200-210` and `publish.yml:50` build `cloud` only; `docker-compose.host-db.yml:37-48` (the manual step-5 stack) mounts `docker/nginx.host-db.conf` instead. No script or test references `docker-compose.venue.yml` or `docker/nginx.conf`.
- **What is wrong / scenario:** today the two nginx files differ only in `listen` and the `proxy_pass` host, so the rules are exercised by hand. A PR that adds a route or an upload size to `nginx.host-db.conf` (the one its author sees working) but not `nginx.conf`, or breaks `nginx.conf`'s syntax, is green everywhere; at the arena the box's offline web fallback fails to start or answers 404/413 for the new route.
- **Fix (S):** a dependency-free `scripts/__tests__` check that the two confs match after normalising `listen` and the upstream host (runs in the existing `test:scripts` step); then in job `image` build `target: web`, `docker run --rm --add-host api:127.0.0.1 … nginx -t`, and `VENUE_NODE_ID=x SYNC_PEER_URL=http://x SYNC_SHARED_SECRET=x docker compose -f docker-compose.venue.yml config -q`.
- **Verdict:** confirmed; low end of medium, since it needs a future one-sided edit, and the box's API on :3001 is still reachable directly. (reviewer B6)

### BLD-19 The only "journal write is atomic with the table write" test cannot fail
- **Area / category:** journal emit tests; tests.
- **Location:** `packages/api/src/__tests__/integration/journal-emit.test.ts:118-129` calls `race.recordFinish({ id: 999999 })`, which throws NOT_FOUND at `packages/api/src/routers/race.ts:337-343`, before the `$transaction` at `:349`. `course.test.ts:110-133` throws inside a transaction but asserts only the table. The invariant is commented at the call sites in `runner.ts`, `cardReadout.ts`, `race.ts`, `drawRouter.ts`; `journalEmit.ts:37-40` warns about passing `ctx.db`.
- **What is wrong:** nothing proves that any write and its journal entry commit or roll back together. Passing `ctx.db` instead of `tx` to `appendJournal` gives a phantom journal entry (shipped to peers) when the table write later fails; moving the call after the transaction loses the entry on a crash. Neither change fails a test.
- **Fix (S for one endpoint, M across the journaled routers):** replace the test with: (a) `journalEntry.create` made to throw once (a `$extends` client in `makeCaller`'s context, or a spy), asserting the table row does not exist; (b) a failure injected after `appendJournal` inside the same transaction (for example `runner.bulkDns` or `draw.execute` failing on the second item), asserting the journal count is unchanged; or a structural guard that the singleton's `journalEntry.create` is never called by a journaled mutation. The reviewer's proposed `linkCardToRunner` unique-violation test cannot fail either (the table write throws before the journal call) and was dropped.
- **Verdict:** confirmed. Medium, not high: the 15 call sites spot-checked all pass `tx`; this is a missing guard on a critical invariant. (reviewer C8)

### BLD-20 `computeStatus` has no direct test: max time, outside-competition, no-timing and the fallback are never asserted
- **Area / category:** readout status; tests.
- **Location:** `packages/shared/src/readout.ts:548-578` (DNF `:552`, `runningTime <= 0` fallback `:558-559`, max time `:564-566`, `FlagOutsideCompetition` `:567-569`, no-timing `:570-574`). No test file in any package references `computeStatus`; OK and MP are reached through `kiosk-finish.test.ts:123,177`, `variant-accept.test.ts:110-140,185`, `runner-variants.test.ts:395-396` and `packages/web/src/lib/__tests__/local-readout.test.ts:74-92`; DNF is executed (`variant-accept.test.ts:220`) but not asserted.
- **Scenario:** someone reorders the override block so no-timing wins over max time, or changes `>` to `>=` on max time; every test passes. The same function serves the offline station readout.
- **Fix (S):** a table test in `packages/shared/src/__tests__/readout.test.ts`: one row per branch plus precedence rows (max time and no-timing together, time exactly at max, MP and max time). Do not add a row for "finish with current status DQ" until the owner decides the behaviour: the function ignores `currentStatus` once a finish exists, which is how a re-read overwrites a DQ (SI-01, RES-01).
- **Verdict:** confirmed. (reviewer C10)

### BLD-21 Journal ingest has no test for a replay after a partial apply, for the variant follow-up, or for a foreign row id
- **Area / category:** journal ingest tests; tests.
- **Location:** `packages/api/src/routers/events.ts:96-148` (apply `:108`, journal insert `:122`, follow-up `:137`, all on the bare client), `:469-488` (`runner.registered` dedupe), `:548-549` (`classChanged`, `courseId` nulled), `:843-915` (`applyReferenceUpsert`: upsert by bare id at `:866,875,898`, unvalidated `fields` spread at `:852`, child rows replaced at `:881-893,904-913`). Nearest tests: `events-push.test.ts:86-101`, `journal-shipping.test.ts:246-257` (replay only after the journal row exists).
- **What is untested (each confirmed from code):**
  1. A replay after apply succeeded but the journal insert failed: a `runner.registered` with no card, no `tempId` and no `seq` creates a second runner (with a `seq` it fails on every retry instead). The current web client always sends `tempId`, so this is peer or legacy payloads.
  2. The variant follow-up is lost, not repeated: if `followUp()` at `:137` throws, or the process dies before it, the retry hits `existing` and reports synced, and the runner keeps `courseId = null` for good. The same happens on a `runner.updated` replay, because `classChanged` is then false. No healing path exists.
  3. An entry for event A carrying a class, course or control id of event B updates B's row and replaces its child rows.
- **Fix (M for tests; code fix M–L):** three integration tests in `events-push.test.ts`: (a) a `db` proxy whose `journalEntry.create` throws once, with a cardless, tempId-less payload, then push again: one runner, and a variant dealt; (b) the follow-up made to throw: a variant is dealt on retry (fails today); (c) two events, `class.upserted` with B's id through A's caller: B unchanged, entry in `failed`. The code fixes are already rows elsewhere: one transaction per entry (API-37r, SYNC-20, DB-15) and the cross-event guard (SYNC-04, DB-04); the lost follow-up is the one consequence not named there, so include it in API-37r's fix.
- **Verdict:** partly. Sub-claims 2 and 3 confirmed; sub-claim 1 confirmed for the duplicate, refuted for "re-runs the follow-up" (it loses it). The verifier notes the station-outbox route to (3) is weak (the drain filters by competition); the realistic route is any signed-in user with a known UUID. (reviewer C11)

### BLD-22 Runner router: no test reads times back, `search` is untested, `statusFilter` is dead, and a taken card gives a raw 500
- **Area / category:** runner router tests; tests.
- **Location:** `packages/api/src/routers/runner.ts:119-134` (`buildRunnerUpdateData`), `:437-455` (create), `:305-309,400-401` (reads), `:350-387` (`statusFilter`, no caller in web, E2E or API), `:146-168` (`assertCardNotTaken`, outside the transaction); `packages/web/src/pages/CardsPage.tsx:398` (uses `search`); `packages/api/src/trpc.ts:92-101` (`errorFormatter` maps only `VersionConflictError`). Nearest tests: `integration/runner.test.ts` (222 lines), `card.test.ts:96-140`.
- **What is untested:**
  1. No test creates or updates a runner with `startTime`/`finishTime` and reads it back through `getById` or `list`, or checks the stored relative column; a swapped `toRelative`/`toAbsolute` in `buildRunnerUpdateData` ships.
  2. `list({ search })` has no test.
  3. Two concurrent `runner.create` with the same new card both pass `assertCardNotTaken`; the second dies on the partial unique index with P2002, which reaches the client as INTERNAL_SERVER_ERROR.
- **Fix (M):** in `runner.test.ts`: (1) create with `startTime: 360_000`, update `finishTime: 396_000`, expect `getById` to return both and the columns to hold 36_000 and 72_000; (2) one `search` test; (3) `Promise.allSettled` of two creates with one card gives exactly one CONFLICT, which needs P2002 mapped to CONFLICT in `runner.create`/`update` (S). Delete `statusFilter` and its input field instead of testing it (S). The `linkCardToRunner` 500 (no pre-check at all) is API-37k; the duplicate `cards` rows from concurrent first reads are DB-34 and SI-36. `bulkUpdate` is tested (`runner-variants.test.ts:144-169`); only its `startTime`/`status`/`clubName` fields are not.
- **Verdict:** partly. Items 1 to 3 confirmed; "bulkUpdate untested" refuted. (reviewer C13)

### BLD-23 Card readout while offline has no client-side test, in the admin shell or at the Finish Station
- **Area / category:** station offline readout tests; tests.
- **Location:** `packages/web/src/context/DeviceManager.tsx:418-427` (queue `card.read`), `:429-441` (skip the server resolve), `:531-601` (local resolution, kiosk broadcast, the `result.applied` emit at `:572-580`, the `pre-start`/`register` fallback); `packages/web/src/pages/FinishStation.tsx:153-200` (`handleOfflineFinish`). No unit test references `DeviceManager` or `FinishStation`; E2E specs that go offline (`offline.spec.ts`, `field-mode.spec.ts`, `course-maps.spec.ts`, `offline-print.preview.spec.ts`) never insert a card, and the reader specs (`webserial.spec.ts`, `kiosk-readout.spec.ts`, `kiosk-smart.spec.ts`) never go offline. `offline.spec.ts:389-396` stops at the offline card lookup and never clicks Finish.
- **What is wrong:** the event-critical client path (readout with the network down) is covered only on the server side (`events-push.test.ts:116,128-216`), by the payload builder test and by the projection test. The dead offline `result.applied` emit (SI-02, SYNC-03) is exactly what such a test would have caught.
- **Fix (M):** one E2E in `offline.spec.ts`: warm the cache on a page that mounts `useStationSync` (for example `/itest/card-readout`), connect the mock reader (`getMockWebSerialScript`, `connectMockSerialReader`), `setOffline(true)`, insert a seeded runner's card; assert the notification from cache, `card.read` (deciseconds) and `result.applied` in IndexedDB, and after `setOffline(false)` that both drain and `runner.getById` shows OK. A second for the Finish Station: click Finish offline, assert a pending `finish.recorded` that drains. The `result.applied` assertion fails until SI-02 is fixed (land together, or mark it `test.fail`). Cheaper complement: extract the block at `:531-601` into a pure function with a unit test.
- **Verdict:** confirmed; "at any level" narrowed to the client path. The duplicate-suppression sub-claim is real but narrow (a failed online store already queues `card.read`). (reviewer D4)

### BLD-24 Offline readout looks up the first cached `runner.list` whatever its input, so a filtered or empty entry hides registered runners
- **Area / category:** station offline readout; functional (with a test gap).
- **Location:** `packages/web/src/lib/offline/local-readout.ts:320-331` (`findCachedQuery`: `getAll().find(q => q.queryKey[0].join(".") === key)`, returns `state.data`), used at `:63,168,299`. Inputs in the client: `undefined` (`hooks/useStationSync.ts:30,59`, `useProjectionSync.ts:18`), `{}` (`pages/RunnerManagement.tsx:44`), `{ search }` (`pages/CardsPage.tsx:397-400`, disabled until two characters are typed). Cache `gcTime` and persister `maxAge` are 24 h (`main.tsx:17,24,82`); `invalidate()` refetches only active observers. The test seeds exactly one entry (`lib/__tests__/local-readout.test.ts:44-49`).
- **What is wrong:** the query cache is iterated in insertion order, so whichever `runner.list` was created first wins. Merely opening a card detail on the Cards page creates `runner.list {search:""}` with `data: undefined`.
- **Scenario:** in the morning the operator opens a card on the Cards page before ever opening a station page. Later the network drops and a finisher's card is read: the lookup finds the empty entry, `computeCardReadout` returns null, and `DeviceManager.tsx:581-601` resolves `action: "register"`; the kiosk shows "Registration in progress" for a registered finisher, and the Finish Station's offline receipt shows running time 0. With the Runners page's `{}` entry first, runners registered after it was fetched are unknown offline. The `card.read` is still queued and the server recomputes on drain; with SI-02 fixed, a `result.applied` from a stale entry would also be pushed.
- **Fix (S):** look up the exact key for input `undefined` (`getQueryData(getQueryKey(trpc.runner.list, undefined, "query"))`), falling back to the newest entry with no `search` in its input; never return an entry whose data is undefined. Unit tests: a `{search}` subset inserted before the full list; an undefined-data entry first; `{}` versus `undefined` picking the newer.
- **Verdict:** confirmed from code and React Query v5 semantics. The same lookup also ignores which competition the cached data belongs to; that is SYNC-19. (reviewer D5)

### BLD-25 A server-answered error on an outbox batch is treated as a network error, so one bad entry blocks the whole queue silently
- **Area / category:** station offline queue; functional (with a test gap).
- **Location:** `packages/web/src/lib/offline/sync.ts:63-67` (any throw `break`s with all 50 entries still pending; `attempts` not incremented; the same oldest 50 are selected again at `:27-28`); `packages/api/src/routers/events.ts:231` (input is `z.object({ events: z.array(eventPayloadSchema) })`, so one bad entry rejects the batch); the module's own promise at `packages/web/src/lib/offline/events.ts:136-142` ("a silently dropped finish is the one unforgivable failure mode"). No unit test imports `offline/sync` or `offline/events`; the sibling `control-outbox.ts` has `isNetworkFailure` (`:180-184`) and a 312-line test. `useEventQueue.ts:99-103` `retryFailed` and `retryAllFailedEvents` are dead (the Retry button calls `retryFailedEvent` directly), and no spec clicks Retry.
- **Scenario:** a cloud-served PWA drains into an older venue box (version skew), or one IndexedDB row is corrupt: one entry fails the zod schema, every push of those 50 is a 400, nothing behind them ever syncs for that competition, and the UI shows only a pending count, never the red "failed" badge.
- **Fix (M):** on a zod `BAD_REQUEST`, bisect or send one by one and mark only the offending entries failed; on "No event selected", 401/403, 5xx and HTML answers keep the entries pending and show a distinct "sync blocked: reason" state (otherwise an expired proxy session would turn the whole queue red); reuse `isNetworkFailure` from `lib/trpc-links.ts:39-44`. Unit tests with an injected store and client: synced/failed bookkeeping, attempts, network error leaves entries pending, bisect on a bad entry, `cleanupSyncedEvents` keeps pending and failed. Remove the dead retry helpers or wire them. E2E: extend `offline.spec.ts:293` to click Retry and assert `attempts: 2`.
- **Verdict:** confirmed. Medium: with matching versions every type the client emits is in the server enum, so the trigger is skew or a corrupt row; when it happens, a station stops syncing without a visible error. This is a different trigger from SYNC-11 (no retry after a failed drain while the browser still reports online). (reviewer D9)

### BLD-26 The start-screen spec asserts nothing when runners exist, and the call-up logic is untestable inside the component
- **Area / category:** start screen tests; tests.
- **Location:** `e2e/start-screen.spec.ts:50-54` (`if (hasNoRunners) { await expect(noRunnersMsg).toBeVisible(); }`: it asserts only what it just counted); `packages/web/src/pages/StartScreenPage.tsx:48-50` (`wallClockToMeos`, browser-local hours), `:135-146` (`startMinuteShown = advanceFloorMinute + 600`, no wrap at 864000), `:149-164` (grouping). Server: `packages/api/src/routers/event.ts:709-758`.
- **What is wrong:** the page's whole job, "the runners starting at HH:MM go forward now", has no assertion anywhere, and its helpers are module-private. A device time zone that differs from the event's, a call-up crossing midnight, or an off-by-one in the shown minute fails no test.
- **Fix (M):** extract `callUpWindow(nowDs, offsetMinutes)` and `groupByMinute(runners)` into `lib/start-screen.ts` with a table test (including 23:58 plus 3 minutes). In the spec, `page.clock.install(...)` at a seeded start minute minus the offset, with `timezoneId` set for the test (the config sets none), and assert a seeded runner is in the current group and the next minute's runner in `upcoming-section`; replace lines 50-54.
- **Verdict:** confirmed (Playwright is 1.65.1, `page.clock` is available). The cancelled and DNS runners shown on this screen are RES-22. (reviewer D10)

### BLD-27 Mutating specs that assert seed state without reseeding, so one transient failure poisons its own retries and later specs
- **Area / category:** E2E isolation; tests.
- **Location:** 33 of 71 specs never call `reseed()` (`grep -LE reseed e2e/*.spec.ts`; many of them are read-only). Concrete cases:
  - `e2e/classes.spec.ts`: no hooks; creates "Test Klass" at `:88`, deletes it in the UI at `:98`; "3 classes" asserted at `:29,69,102,108,121,139,180`. A failure between `:88` and `:98` makes both retries fail at `:69` and the tests at `:105,125,177` fail on their counts.
  - `e2e/competition.spec.ts:147-154`: uploads `e2e/test.ocd` into `itest` and never removes it; `e2e/webserial.spec.ts:345` branches on whether a map is present (its top-level describe at `:52` has no reseed).
  - `e2e/lease.spec.ts`: leaves a punch (card 999111, code 77) and its journal entry.
  - `e2e/reader-bt.spec.ts:80,186`: stores a readout for seeded card 501438 with no hooks; `card_readouts` has no runner relation, so `runner.delete` cleanups cannot remove them.
- **Why it matters:** shards are assigned by weight (`scripts/e2e-weights.mjs:115-126`, `scripts/e2e-sharded.mjs:199-203`), so adding a spec or refreshing a weight changes which files share a database and in which order; the failure appears in an unrelated PR.
- **Fix (S–M):** `test.beforeAll(reseed)` in classes, competition, lease, webserial (top level), reader-bt and kiosk-readout (about 1 to 2 s each; on retry Playwright starts a new worker and re-runs `beforeAll`, so this also covers retries). Check phase2, rental-cards and runners-bulk before adding it there.
- **Verdict:** partly. Confirmed for the cases above; refuted for `map-vector-layer.spec.ts` and `map-viewer-3d.spec.ts` (both reseed first); not proven that `kiosk-readout.spec.ts` stores readouts for seeded cards. Latent order dependence; no flake was observed. (reviewer D12)

### BLD-28 The verify-lock guard has false negatives, fails open, and its lock path depends on `XDG_RUNTIME_DIR`
- **Area / category:** local multi-session verification; engineering / stability (developer tooling).
- **Location:** `scripts/hooks/verify-lock-guard.sh:8` (`|| exit 0` when `jq` is missing or the JSON is unreadable), `:11-13` (any command containing the substring `with-verify-lock` is allowed), `:15` (pattern); `scripts/with-verify-lock.sh:19` (`${OXYGEN_VERIFY_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/oxygen-verify.lock}`). Neither script has a test.
- **What is wrong (reproduced by feeding the hook sample commands):** allowed although they need the lock: `pnpm --filter @oxygen/api test:integration`, `pnpm -w test:e2e`, `pnpm exec playwright  test` (two spaces), `docker build --network host --target api .` (which `.claude/CLAUDE.md` says must run under the lock), `docker compose -f docker-compose.test.yml down -v` and `pnpm test:db:down` (from the main checkout this destroys the :5433 instance every worktree shares), `grep with-verify-lock AGENTS.md; pnpm test:e2e`, and anything when `jq` is absent. Most important: a session with `XDG_RUNTIME_DIR` set (a desktop terminal) and one without (this headless session has it unset) take different lock files and do not exclude each other.
- **Scenario:** a desktop-terminal session and a headless agent session both run `scripts/with-verify-lock.sh pnpm test:e2e`; both print "acquired", one fails with "port already used" or the two interleave migrations and reseeds on `oxygen_e2e*`.
- **Fix (S):** a fixed lock path (`/tmp/oxygen-verify-$(id -u).lock`, still overridable); split the command on `;`, `&&`, `||`, `|` and newlines and exempt a segment only if its first word (after `VAR=…` assignments) ends in `with-verify-lock.sh` (requiring the whole command to start with the wrapper would block documented forms and still pass `wrapper x; pnpm test:e2e`); widen the pattern to `pnpm .*test:(e2e|integration)`, `playwright +test`, `test:db:down`, `docker-compose\.test\.yml.* down` and `docker build`; when `jq` is missing, grep the raw stdin instead of exiting 2 (which would block every Bash call, including installing jq). Add a `node --test` table of the commands above under `scripts/__tests__/`.
- **Verdict:** confirmed; the hook cases were reproduced, the lock-path split is proven from the code and its scenario depends on the session mix. Medium for the lock path, low for the guard gaps (a cooperative guardrail, not a security boundary); no event-day impact. (reviewer B9)

---

## Low

### BLD-29 Docs that describe build, audit and test infrastructure that no longer exists
- **Area / category:** docs; engineering.
- **Location and mismatches (each confirmed):**
  - `AGENTS.md:323,330`: the weekly `.github/workflows/audit-weekly.yml` does not exist; commit `feecdae0` deleted it on purpose ("Dependabot does the same thing"). `scripts/check-doc-links.mjs:64` checks only `docs/…` paths, so the stale reference is not caught. Whether Dependabot alerts are on is a repo setting that cannot be checked from the code; if they are off, this is medium.
  - `AGENTS.md:30,112`: step 5's `docker compose -f docker-compose.host-db.yml up --build -d` fails on this machine's Compose v5.6 (`build.network: host`, `docker-compose.host-db.yml:19,41`); `.claude/CLAUDE.md` has the working replacement, and its own "Rebuild Docker automatically" line repeats the failing command.
  - `AGENTS.md:29` and `docs/dev/lint-policy.md:3`: ESLint "across all three packages" (see BLD-16). `AGENTS.md:297`: "the same `oxygen_e2e` container" (it is `postgres-oxygen-test`).
  - `docs/ops/deploy-gcp-cloud-run.md:416-419` and `docs/releases/slice-e.md:294`: `--remove-env-vars` advice that `deploy.sh` makes moot (BLD-02).
  - `docs/ops/backup-restore.md:122`: the backup is "reachable to anyone who can hit the API" (it requires `event.manage`, `backup.ts:313-336`); `Dockerfile:86` and `backup.ts:4,91` say `pg_dump` (the implementation is `psql \copy`).
  - `packages/api/vitest.config.ts:7` ("live MySQL instance"), `docker-compose.test.yml:2-3` ("per-suite Postgres schemas"), `scripts/audit-prod.mjs:5-8` and `audit-pr.yml:28-31` (the "Node 22 toolchain" rationale; the script is still needed on pnpm 10.34.9), `packages/api/src/worker-bootstrap.ts:6` ("on Node 20").
  - `.github/workflows/docs-links.yml:21-24`: `checkout@v5`, `setup-node@v5` and `node-version: 20` while `.nvmrc` is 24 and the other workflows use `@v7` and `node-version-file`.
- **Fix (S):** rewrite AGENTS.md §14 to name Dependabot as the backstop (matching the deliberate deletion) and confirm the setting is on; move CLAUDE.md's working Docker command into AGENTS.md §6 step 5 and the command table; correct the other lines; bump `docs-links.yml`.
- **Verdict:** confirmed for every listed item; the "1..4 shards" sub-claim was refuted and dropped. (reviewers A11, B8, A16, merged)

### BLD-30 The multi-arch publish runs the whole TypeScript and Vite build twice, once under QEMU
- **Area / category:** CI cost; performance.
- **Location:** `Dockerfile:2,14,29` (no `--platform`, so `deps` and `build` run per target platform); `.github/workflows/publish.yml:16` (`timeout-minutes: 90`), `:22` (`setup-qemu-action`), `:51` (`linux/amd64,linux/arm64`); `packages/web/vite.config.ts:9,151` (each architecture bakes its own `__BUILD_VERSION__` timestamp, shown in `BuildInfoLine.tsx:29`; cosmetic).
- **What is wrong:** `prisma generate`, two `tsc` builds and `vite build` produce platform-independent output but run once per architecture, the arm64 pass emulated. This lengthens the window in which BLD-06 cancels a publish.
- **Fix (M):** a `FROM --platform=$BUILDPLATFORM` stage for the JS build (the Prisma client is generated TypeScript, so it can be generated there); keep only `pnpm install` (sharp, resvg, Prisma engines) per target platform, and take `packages/api/node_modules` from the target-platform stage. Do together with BLD-13.
- **Verdict:** confirmed; that this is why the timeout is 90 minutes is plausible only (no run durations available). (reviewer A18)

### BLD-31 Coverage thresholds are never run in CI, and the API's threshold measures a 12-line re-export
- **Area / category:** coverage configuration; tests.
- **Location:** `packages/api/vitest.config.ts:14-25` (include `draw/algorithms.ts`, `draw/optimizer.ts`, `results.ts`; thresholds 70/90/90/90); `packages/api/src/results.ts:1-12` (only `export { … } from "@oxygen/shared"`); `packages/web/vite.config.ts:23-39` (thresholds on `lib/format.ts`, `lib/si-protocol.ts`); `ci.yml:52` runs `pnpm test`, and `coverage` appears in no workflow, script or hook. The tests of the shared readout and result code (`packages/api/src/__tests__/results.test.ts`, `cardReadout.test.ts`) import through API re-exports, so `pnpm --filter @oxygen/shared test` runs none of them; `packages/shared/src/__tests__/readout.test.ts` (70 lines) covers only `findMatchingVariants`.
- **Fix (S):** move the two test files to `packages/shared/src/__tests__/` importing from `../results.js` and `../readout.js` (check for API-only imports first); drop `results.ts` from the API list; then either run `pnpm --filter @oxygen/api test:coverage && pnpm --filter @oxygen/web test:coverage` in the `unit` job (run it once by hand first; thresholds may already have slipped) or delete the threshold blocks so they do not suggest a guarantee. Fix the MySQL comment.
- **Verdict:** confirmed. The code is tested in CI through the API suite; the cost is misplacement and a threshold that guards nothing. (reviewers B7, C14, merged)

### BLD-32 Dead, misnamed and tautological E2E tests, and two cleanup helpers that disagree
- **Area / category:** E2E suite hygiene; tests.
- **Location and items (each confirmed unless noted):**
  - `e2e/registration-trends.spec.ts:72-88`: `if (await card.isVisible()) {…} else { test.skip(); }`. The card returns `null` until its query resolves (`packages/web/src/pages/CompetitionDashboard.tsx:299-305`) and the check does not wait, so the test likely skips on many runs; the seed always has entry dates (`e2e/seed-builder/build-itest.ts:419`). Replace with `await expect(card).toBeVisible()`.
  - `e2e/eventor.spec.ts:241-264`: a skipped test for a removed feature (also one of the four `force: true`). Delete.
  - `e2e/kiosk-readout.spec.ts:310-319`: a `beforeAll` that clears a symbol no longer in `packages/` and is justified by `reuseExistingServer: true` (now `false`, `playwright.config.ts:112`). Delete. `:429-466` repeats the first half of `:380-427` and admits it cannot observe its own state; the rule is unit-tested in `kiosk-standalone-routing.test.ts:41-54`. Delete.
  - `e2e/auth.spec.ts:12-17` duplicates `e2e/permissions.spec.ts:120-131`. Delete the first.
  - `e2e/offline.spec.ts:178-179,195-196`: click the Dashboard link, then assert the Dashboard link is visible. Assert dashboard content rendered from cache instead.
  - `e2e/phase2.spec.ts:125-193`: two API-only tests; move them to `runner.test.ts`, which asserts only the changed field (`:88-100`), not that other fields survive.
  - `e2e/registration-dialog.spec.ts:509-566`: titled "re-read …" but reads once; not a duplicate of `kiosk-readout.spec.ts:206-296` (the reviewer's claim was refuted) and has admin-side assertions found nowhere else. Rename.
  - `e2e/global-setup.ts:39-64` versus `e2e/helpers/reseed.ts:35-55`: different table lists, different event filters (`oxygen_test_%` only in global setup), `SEED_NAME_IDS` duplicated; `reseed.ts:59-62` runs the seed with `stdio: "ignore"`, so a seed failure surfaces as "Command failed" with no cause.
- **Fix (S):** the deletions and assertions above; one exported cleanup function and one `SEED_NAME_IDS` in `reseed.ts`, with the `settings`-key delete behind a parameter used only by global setup; `stdio: ["ignore", "inherit", "inherit"]`.
- **Verdict:** mostly confirmed; the registration-dialog duplicate and the "most of `trpc-batch-matching.spec.ts` is pure" claim were refuted (only one of its four tests is), and the cleanup divergence causing a real local/CI difference is plausible only. (reviewers B10, D14, merged)

### BLD-33 Weak checks in the card, runner and push integration tests
- **Area / category:** integration tests; tests.
- **Location:** `packages/api/src/__tests__/integration/card.test.ts:237-240` (`updatePunchTime({ time: 600_500 })` checked with `not.toBe(old)`; the stored value must be 276_500 with the default ZeroTime 324000); `events-push.test.ts:124-125` (`finishTime` `toBeGreaterThan(0)`; must be 36_000); `runner.test.ts:69-75` (`cardNo: 0` "no throw", never read back), `:165-180` (card re-use after soft delete, no assertion).
- **What is wrong:** storing the absolute time instead of the relative one, the core ZeroTime risk, passes all three time checks.
- **Fix (S):** `expect(updated?.time).toBe(276_500)`; `expect(runner?.finishTime).toBe(36_000)`; Eve's `cardNo` is null; `findByCard(90000)` returns "Reuser" and exactly one active row holds the card.
- **Verdict:** confirmed (weak rather than unfailable: the runner tests still fail on a throw). (reviewer C15)

### BLD-34 The integration tests' dev-database guard refuses only `localhost` and `127.0.0.1` on port 5432
- **Area / category:** test safety; tests.
- **Location:** `packages/api/src/__tests__/helpers/load-env.ts:29-39` and `helpers/global-setup.ts:25-39` (same check twice, with a dead ternary `"5432" : "5432"`); then `global-setup.ts:48` (`prisma migrate deploy`) and `:73-75` (`DELETE FROM events WHERE name_id LIKE 'oxygen_test_%' OR name_id LIKE 'E2E_%'`).
- **What is wrong (reproduced with a copy of the guard):** `[::1]:5432`, `0.0.0.0:5432`, `host.docker.internal:5432`, `127.1:5432`, `localhost.:5432` and `LOCALHOST:5432` all pass (`postgresql:` is not a special URL scheme, so the host is not lower-cased). Only reachable when someone sets `INTEGRATION_DATABASE_URL` explicitly; the file's own comment records that this foot-gun already wiped dev data once.
- **Fix (S):** one `assertTestDatabaseUrl(url)` in a side-effect-free module imported by both files (global setup cannot import `load-env`), allow-listing database names `/^oxygen_(test|e2e)/`; document that remote or CI databases must follow the naming, or add an explicit opt-out variable; unit-test it.
- **Verdict:** confirmed (reproduced). (reviewer C16)

### BLD-35 `lease.spec.ts` asserts only HTTP 200 for `events.push`, which is returned even when the entry is rejected
- **Area / category:** E2E assertions; tests.
- **Location:** `e2e/lease.spec.ts:74-92` (`expect(push.ok()).toBe(true)`); `packages/api/src/routers/events.ts:228-240` (`{ synced, failed }` with per-entry catch at `:140-147`); `:45-49` ("writable when no lease is active" performs no write); no reseed in the file (see BLD-27).
- **Fix (S):** parse `result.data` and assert `synced` equals `[id]` and `failed` is empty; add the unleased write the second test's title promises; `test.afterAll(reseed)`.
- **Verdict:** confirmed; low because the same behaviour is asserted properly at `packages/api/src/__tests__/integration/lease.test.ts:344-357`. (reviewer D11)

### BLD-36 `clickTab` and `selectCompetition` are copied into 19 and 26 spec files
- **Area / category:** E2E helpers; tests (maintenance).
- **Location:** 20 `if (await mainTab.isVisible())` sites (19 `clickTab` definitions, 18 local plus `e2e/helpers/editor.ts:464-472`, and an inline one at `e2e/map-documents.spec.ts:35`); `selectCompetition` defined 27 times. The tab split comes from `dashboard.data?.contentSignals` (`packages/web/src/pages/CompetitionShell.tsx:222-225`, `packages/web/src/lib/shell-tabs.ts:76-104`).
- **What is wrong:** duplication, plus a latent race: `isVisible()` does not wait, and in an event without runners or results some tabs move between the primary bar and the More menu once the dashboard loads. Today's three exposed calls (`editor-start-finish.spec.ts:49`, `class-presets.spec.ts:79`, `control-series.spec.ts:154`) all wait for a map upload first, so no current call site is likely to flake; a new test that opens Runners, Results, Start List or Course Editor right after creating an empty event would.
- **Fix (M, mechanical):** one `e2e/helpers/nav.ts` with `selectCompetition` and a `clickTab` that accepts either location (try the primary link, else open More and click `mainTab.or(menuLink)`), replacing all copies.
- **Verdict:** partly: duplication confirmed, the flake narrowed to latent. (reviewer D13)

### BLD-37 Fixed sleeps in the E2E suite, two of which buy nothing or are fragile
- **Area / category:** E2E speed and timing; tests.
- **Location:** 44 `waitForTimeout` calls under `e2e/`, 12 of them in `e2e/showcase/*` (not the suite); the 31 literal ones in specs and helpers sum to 21.5 s per call site (more per run, since `helpers/editor.ts:212,265` run many times); `course-editor-legs.spec.ts` has 10 (7.3 s). Specific:
  - `e2e/offline.spec.ts:45` (`waitForTimeout(500)`, "give React Query time to persist"): none of the four callers of `warmStationCache` reloads or reads the persisted cache, so it buys nothing. Drop it.
  - `e2e/registration-dialog.spec.ts:606` (`waitForTimeout(6000)` proving a 4 s watchdog does not fire against a 2 s heartbeat): 2 s of slack per beat, so a stall of over 2 s on a loaded shard fails it. Raise the override to 6 s with an 8 s wait, or poll that "Registration in progress" stays visible.
  - The `course-editor-legs` "nothing written after Escape" waits are negative assertions and acceptable.
- **Context:** by `scripts/e2e-weights.mjs` (total 1444 s), the seven `course-editor*.spec.ts` files are 594 s (41 %); the explicitly weighted registration, kiosk, offline and lease specs together are about 123 s. The suite's time is not where the event-day risk is, and the tests BLD-23, BLD-04 and SI-03 call for would add well under a minute.
- **Verdict:** partly: counts and locations confirmed; the offline sleep confirmed useless; the registration-dialog flake plausible only. (reviewer D15)

---

## Already reported in other areas

These raw findings from this area's reviewers match findings already verified in the area named. They were not re-verified here; a second, independent reviewer reaching each one is itself corroboration. The "test to add" column is this area's contribution: the test that would have caught the defect.

| Raw | Matches | Defect | Test to add with the fix |
|---|---|---|---|
| D1 | SYNC-03, SI-02, SI-03 | Standalone kiosk queues nothing when the node is unreachable; the offline `result.applied` emit is dead code | E2E on `/:nameId/kiosk` with `setOffline(true)` and a card insert, asserting a pending `card.read` and `result.applied` |
| D2 | SI-05, SI-13, SI-31 | USB reader stores a truncated read with the OK beep; CRC and block numbers unchecked; no unit test for `webserial.ts` | `webserial.test.ts` driving `SIReaderConnection` with a fake port (bad CRC, timeout, split frames) |
| D3 | SYNC-11 | Outbox is retried only on `navigator.onLine` transitions | Drain test with the API unreachable but `onLine === true` (route abort, not `setOffline`) |
| D7 | SYNC-16 | Service worker answers tRPC reads from cache after a 3 s timeout | Preview-stack spec with a throttled route for `cardReadout.readout` |
| D8 | SI-18 | USB reader does not recover after a serial error; `tryAutoReconnect` dead | Unit test: stream error, then status and reconnect |
| C1 | RES-11, DB-19 | Result list gives tied runners different places | `lists.resultList` integration test with a tie |
| C2 | RES-05 | Eventor upload ranks on relative times; early starters get no Position (reproduced again here) | `pushResults` integration test with a start before ZeroTime |
| C3 | RES-04, DB-05 | A time equal to ZeroTime is stored as "no time" | `timeConvert` and draw tests at `absolute == zeroTime` |
| C4 | RES-02 | Eventor result times stored without `toRelative` | Import fixture with non-zero times |
| C5 | DB-08 | `eventor.sync` clears desk-assigned cards and cancels finished runners | Sync test after desk edits |
| C6 | RES-07, SYNC-06, SI-08, DB-03 | `result.applied` replay maps most statuses to `unknown` | Round-trip test for statuses 2, 5, 6, 15 |
| C7 | DB-13, API-12 | Backup dumps the renamed `event_log` and hides psql errors | Backup test asserting each section has rows, not only that no failure trailer exists |
| C9 | SI-16, SI-22 | `card.read` dedupe ignores content | Second different read within 60 s is stored |
| C12 | API-36 | No router-wide authorisation sweep (this reviewer's "4 of ~300" was wrong: about 60 of 330 are asserted, mostly in the map and course routers) | API-36's sweep; the verifier suggests `.meta({ guard })` per builder and a snapshot without calling procedures (S–M) |
| A3 | DB-32 | Venue migration command uses `pnpm`, which the image lacks; no migrate step | `scripts/__tests__` check that the venue compose has a migrate dependency |
| A4 | DB-33 | Release compose always pulls a floating `stable` and migrates | Extend `release-compose.test.mjs` to assert the default pull policy |
| A8 | DB-35 | Cloud SQL without point-in-time recovery | none |

Defects the verifiers found beside their claims, also already reported: a re-read overwrites a jury DQ (SI-01, RES-01; found by the `computeStatus` verifier, see BLD-20); `linkCardToRunner` to a held card gives a raw 500 (API-37k); concurrent first reads create two `cards` rows (DB-34, SI-36); no `unhandledRejection` handler (API-37i, SYNC-39); the offline cache lookup ignores the competition (SYNC-19); the server's time of day uses the process zone (SI-23, RES-06).

---

## Clean

- Version stamping (`scripts/build-version.mjs`, `release-version.mjs`, `ghcr-ref.mjs`, the Dockerfile build args, the tag and package checks in `release.yml`): consistent with `docs/releases/README.md`.
- Postgres 18 volume paths are right in all compose files; Postgres is not published in the release and venue stacks.
- The API boots without a database (job engines and the supervisor catch their own rejections) and handles SIGTERM.
- E2E shard split: every non-preview spec lands in exactly one shard (checked with a dependency-free run over all 71 files); an empty shard passes rather than running everything.
- The E2E gate fails when any shard or the preview job is not successful; no `continue-on-error`, `|| true` or ignored exit code in any workflow; `forbidOnly` is on in CI.
- `paths-ignore` skips no test or build input.
- No server reuse: all `webServer` entries have `reuseExistingServer: false`, pinned by `scripts/__tests__/e2e-config.test.mjs`.
- Global setup fails loudly on a broken migration; every CI job that needs Postgres migrates a fresh database from scratch.
- `scripts/audit-prod.mjs`: lockfile walk and exit codes are sound.
- The E2E helpers' waits are polls with deadlines, not blind sleeps; no `networkidle`, no `toHaveScreenshot`, no `.only`.
- A candidate "an orphaned process keeps the verify lock forever" was reproduced and disproved (Node does not leak the lock fd to children).

## Not reviewed, or could not be verified

- **Nothing ran.** `node_modules` could not be installed, so no vitest, Playwright, tsc, Prisma CLI or Docker run was possible. Every "fails today" is from reading code, apart from the small reproductions listed under Method. Not checked: how many type errors BLD-16 would surface, whether BLD-14's time-zone pin makes current tests fail, whether the coverage thresholds pass today (BLD-31), whether schema and migrations drift today (BLD-17), the exact Prisma 7 `migrate diff` flags, actual CI durations.
- **External behaviour taken from documentation:** gcloud's replace semantics for `--set-env-vars` (BLD-02, corroborated by the repo's own docs), Compose's `pull_policy: always` offline behaviour (DB-33), GitHub's concurrency queueing (BLD-06), Playwright's exit code on a flaky pass (BLD-15). Not run on Cloud Run: BLD-01 end to end, psql 15 against a PG 18 server.
- **Repository settings outside the code:** whether Dependabot alerts are on (BLD-29), which checks are required for merge, branch protection, and the weekly dependency routine's own prompt.
- **Dependency CVEs:** no network audit was possible; lockfile versions post-date the reviewers' knowledge, so no CVE claims are made. The unconditional pnpm overrides (`undici`, `flatted`, `serialize-javascript`, `effect`, `postcss`, `defu`) were not checked for forcing an incompatible major onto a consumer.
- **Test suites not reviewed in depth:** the map, course, print, render, import, DEM and symbol-library suites in `packages/api` and `packages/shared` (about 200 of 304 files) and the corresponding web unit tests and E2E specs (`map-*`, `course-editor-*`, `editor-*`, `field-mode`) were swept with pattern greps only, not read for gaps; `map-gl-golden.spec.ts` GPU sensitivity was not assessed. `sync/*`, `liveresults.ts` and `online-input/puller.ts` were compared against their tests by test title only (area 06 covers their behaviour). Procedures never called from any API test, code not read: `event.{startScreen,runners,clubs,setRegistrationConfig,setCardFee,regenerateKioskKey}`, all of `liveresults.*`, `onlineInput.*`, `external.*`, `club.{update,delete}`, `race.lookupByCard`, `cardReadout.{recent,getById,cardDetail}`, `eventor.{syncClubs,syncRunnerDb,pushStartList}`; the Eventor XML parsers have no unit test (EVT-21).
- **Not read:** `docs/releases/slice-*.md` (grepped only), `docs/ops/demo.md`, `demo-map.md`, the printer docs, the measure and showcase generators, 12 of the 15 `scripts/__tests__` files, `e2e/showcase/*`, `docs/screenshots/capture.ts`, `e2e/helpers/{editor,mock-webbluetooth,mock-webusb}.ts` beyond their wait loops, `lib/reader-bt/*`, `lib/offline/projection*.ts` and their tests.
