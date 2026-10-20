# Releasing slice A (import and storage) to the club instance

Runbook for the first vector-map-pipeline release: the one 09 §4 A calls
"no user-visible change", gated by the production backfill. It is the
order of operations and the exact commands; the design is in
`docs/map-storage.md` §6.7 (backfill), `docs/map-import.md` §6 (S0
determinism) and `docs/research/vector-map-pipeline/09-migration.md` §4,
§7 (gates and spikes).

Everything that talks to GCP needs `gcloud auth login` on the operator's
machine and `scripts/gcp/env.sh` (gitignored; `env.sh.example` shows the
shape). Nothing in this runbook changes the service's idle/event mode.

## Production as inspected on 2026-10-20

| | |
|---|---|
| Service | `oxygen`, `europe-north1`, image `ghcr.io/open-orienteering/oxygen:edge` pinned to the 2026-10-12 digest (revision `oxygen-00045-hbc`) — behind `main` by the free-order and dependency PRs |
| Resources | 4 GiB / 2 vCPU, timeout 300 s, max 2 instances, idle mode (min 0, CPU throttled) |
| Cloud SQL | `oxygen-pg`, Postgres 18, `db-f1-micro`, 10 GB SSD, zonal, daily backups; **`max_connections = 25`** |
| Database | 600 MB: 17 events, `map_files` 19 rows / 151 MB, `club_map_files` 4 rows / 51 MB, `map_tiles` 357 MB |
| Backfill footprint | ≤ 202 MB of `map_sources` (less after dedup of event copies) + documents at roughly a tenth of that; nothing to resize |
| Connections | service 8 per instance × 2 + migrate/backfill job; `backfill.sh` pins the job's pool to 2 |
| Jobs | `oxygen-migrate` exists; `backfill.sh` creates `oxygen-map-backfill` |

The Cloud SQL Auth Proxy is not installed on the operator machine; the
SQL checks below need it (`docs/deploy-gcp-cloud-run.md`, "Syncing a
local database") or go through a one-off Cloud Run job with the
`oxygen-database-url` secret, as `backfill.sh` does. `psql` rejects the
secret's `?schema=oxygen` parameter — strip it and keep `host=/cloudsql/…`.

## 0. Preconditions

| Gate | Where | Done when |
|------|-------|-----------|
| S0 corpus check, local half | `scripts/measure-import.mjs` over `.local/corpus` and the OOM samples (the script lands with the S0 PR) | zero `UNSUPPORTED_*` warnings, `sameAsPrevious` on two runs, hash JSON saved — on the commit that will be released (importer `ocad-7` / `omap-2` since A12; a hash JSON from an `ocad-6` run does not compare) |
| Dev-database backfill | `pnpm map:backfill` on :5432 | zero failures (done 2026-10-16: 9/9). Those rows predate `ocad-7` and are stale by importer: the next upload of the same file re-imports it, and `pnpm map:rematch` re-imports them and moves their pins (`docs/map-storage.md` §6.9) — run it before relying on the dev documents |
| 07 integration matrix, 02 determinism test | CI on the `main` PR | green |
| Compose v5 build fix | task card | optional; the image builds in CI regardless |

## 1. Land A on `main`

```bash
git fetch origin
git checkout -b release/slice-a origin/vector-map-pipeline
gh pr create --base main --title "Slice A: import, storage, previews, review, CRT, stage 5" \
  --body "See docs/release-slice-a.md. Additive schema only; rollback = previous image tag."
```

CI runs lint/build/unit, integration and E2E on the PR; the `audit` job
runs because the lockfile changed and must be clean (it is after PR #43).
Merge with a merge commit (keeps the sub-slice history). The `main` push
publishes `ghcr.io/open-orienteering/oxygen:sha-<commit>` and `:edge`
(`docs/releases-and-images.md`).

Afterwards `vector-map-pipeline` keeps going: merge `main` into it once
(the merge commit), as after PR #43.

## 2. Cut the release

```bash
git tag vX.Y.Z <main merge commit>
git push origin vX.Y.Z          # release.yml retags sha-… as vX.Y.Z and stable
```

What this release carries that an operator will notice: club library
ids are UUIDs (A9), the library card thumbnail is the document render,
version-less entries show their import state, and **a legacy club map
that has not been backfilled is not listed until the backfill runs** —
hence step 3 and 4 are one window.

## 3. Deploy

```bash
cd scripts/gcp
./deploy.sh vX.Y.Z              # Cloud Run job: prisma migrate deploy, then the service
```

`deploy.sh` preserves min-instances / CPU throttling. The migrations are
additive (`map_sources`, `map_documents`, `map_previews`, `club_maps`,
`club_map_versions`, `club_symbol_decisions`, `map_import_jobs`,
`map_uploads`, the `map_files` / `club_map_files` link columns); an
older image runs against the new schema, so rollback is
`./deploy.sh <previous tag>` and no down-migration exists or is needed.

## 4. Backfill (slice A gate)

Immediately after the deploy, in the same session:

```bash
./backfill.sh --tag vX.Y.Z --dry-run    # plan: club rows, then event rows still missing a document
./backfill.sh --tag vX.Y.Z              # the run; one map at a time; exit 1 on any failure
```

`backfill.sh` runs `node packages/api/dist/cli/map-backfill.js` in the
released image as the Cloud Run job `oxygen-map-backfill` (same service
account, Cloud SQL instance and `DATABASE_URL` secret as the migrate
job), waits, and prints the job log. The alternative is the UI:
Settings → Maintenance → **Map documents** → *Import now* (`docs/map-storage.md`
§6.7); same `runBackfill`, same result.

Gate: **zero `failed` jobs**. A failed map is a `map_import_jobs` row in
state `failed` with its error in the report; fix the importer on the
branch, release again, re-run — the run only revisits rows still missing
a document.

## 5. S0, production half: hash identity across machines

The backfill is the second machine. For each entry of the local hash
JSON (`file_hash → documentHash`, on the released commit):

The service sits behind IAP, which a plain `gcloud auth print-identity-token`
does not satisfy for a user account, so do the check from a browser tab
that is already signed in as an instance admin (DevTools console):

```js
for (const h of ["<documentHash>", "…"]) {
  console.log(h.slice(0, 12), (await fetch(`/api/map-documents/${h}`, { method: "HEAD" })).status);
}
```

`200` — Cloud Run produced byte-identical bytes from the same file;
`404` — it did not, and the determinism rule in `docs/map-import.md` §6
is broken for that map: a finding, not a release blocker, but it must be
fixed before slice B relies on content addressing. The SQL form, through
the Cloud SQL Auth Proxy (`docs/deploy-gcp-cloud-run.md` "Syncing a local
database"):

```sql
select d.source_hash as file_hash, d.hash as document_hash,
       d.importer_version, d.library_version, s.file_name
from oxygen.map_documents d
join oxygen.map_sources s on s.file_hash = d.source_hash
order by d.source_hash;
```

(`map_sources` is keyed by `file_hash`, `map_documents` by `hash`;
`schema.prisma` models `MapSource` / `MapDocument`.) The comparison is
only valid for the same `importer_version` and `library_version`, which
is why the local run is on the released commit.

The OOM `.omap` samples cannot go this way (club/event *apply* is OCAD-only
until slice C): compare them from a second machine running
`measure-import.mjs`, or from the API image on the same machine as a weak
proxy.

## 6. S4: 36 MB chunked upload in idle mode

On the released image, with the service in idle mode (`./idle-mode.sh`;
it is the default):

1. Upload `club-full.ocd` (35.9 MB) through Settings → Maps → club
   library. Above 8 MiB the client takes `POST /api/map-uploads` →
   5 × `PUT …/chunks/:n` (four in flight) → `POST …/finalise`.
2. Watch `mapImport.status` polling in the UI until `done`.
3. Verify in the DB (proxy + psql) and the logs:

```sql
select id, state, stage, progress, claimed_by, heartbeat_at, document_hash,
       error, created_at, updated_at
from oxygen.map_import_jobs order by created_at desc limit 5;
```

```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=oxygen AND (textPayload:"map-import" OR httpRequest.status>=400)' \
  --project="$PROJECT_ID" --limit=100 --order=asc --freshness=1h
```

Exit criteria (09 §7): finalise + import reach `done` via polling; no
413 / `request too large` (the 32 MiB HTTP/1 ceiling); **exactly one**
execution — `claimed_by` must not change hands unless a heartbeat older
than 60 s shows the first instance really was recycled, and even then
the second run must dedup to the same document hash. Watch the revision's
memory (`Memory limit … exceeded`): Club-full peaks around 360 MB RSS for
the thumbnail on top of the import.

If Club-full is already in the library (the backfill imported it), S4 is
run with a fresh upload of the same file: dedup must answer at
`finalise` without starting a job — also a pass.

## 7. Rollback

- Service: `./deploy.sh <previous tag>`; the new tables are ignored by
  the old image and keep their rows.
- Data: nothing to undo; the backfill writes only new rows and the two
  link columns. A second release re-uses every document by hash.

## 8. After the gate

Record the production run in the decision log (date, rows, failures,
hash comparison result, S4 numbers) and set the `A-gate`, `S0` and `S4`
rows in `docs/research/vector-map-pipeline/SLICES.md` to `done`. Slice B
continues on `vector-map-pipeline`.
