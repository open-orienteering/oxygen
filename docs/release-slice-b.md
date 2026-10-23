# Release runbook — slice B (GL viewer behind the per-event switch)

Slice B lands on `main` the same way slice A did ([release-slice-a.md](release-slice-a.md)):
one PR from `vector-map-pipeline`, a merge commit, a tag, `deploy.sh`.
Everything user-visible is behind the per-event switch
([map-pipeline-switch.md](map-pipeline-switch.md)); with the instance
defaults every event stays on tiles, so the release is a no-op for
operators until an event is switched. The point of deploying it now is
S4 (the 36 MB upload on the released image) and, later, the B-gate's
real-event run on the club's own instance (09 §4 B).

## What this release carries

| Area | Change an operator can notice |
|---|---|
| Events | new column `events.map_pipeline` (`legacy` \| `vector`, default `legacy`; migration `20261022120000_event_map_pipeline`, additive, ignored by older images) |
| Instance flags | `map.pipeline.default` and `map.pipeline.allowLegacy` in `oxygen.settings`, both absent = `legacy` / `true`; no UI, SQL only (switch spec §1) |
| Event page | **Use new map engine** toggle in the map-info row while `allowLegacy`; switching an event to `vector` makes every map view draw the GL base map from the map document and stops tile requests for it; the pre-cache job skips `vector` events; no WebGL2 → tiles fallback while `allowLegacy` |
| Import | importer `ocad-13` / `omap-7`, library `2026.10.3`; every document the v0.2.0 backfill produced is now *stale* (older importer/library) — the library keeps serving it; a re-match is needed before an event is switched to `vector` (below) |
| Previews | library thumbnails and symbol swatches come from the reference raster (unchanged route) |
| CI | `measure-parity` test independent of the runner's fonts (#60); E2E `map-legacy` / `map-vector` projects |

Rollback: flip the event (or leave the instance default) back to
`legacy` — tiles still exist or regenerate; or `./deploy.sh <previous tag>`
— the column and settings are ignored by the older image.

## 0. Preconditions

- `vector-map-pipeline` green (full AGENTS.md §6 run on the merge commit; the
  last PRs' CI).
- `gcloud auth login` done on the operator machine (`scripts/gcp/env.sh`).
- Service in idle mode (`./idle-mode.sh`; the default).

## 1. Land B on `main`

```bash
git fetch origin
git checkout -b release/slice-b origin/vector-map-pipeline
gh pr create --base main --title "Slice B: GL viewer behind the per-event switch" \
  --body "See docs/release-slice-b.md. Additive schema (events.map_pipeline); rollback = previous image tag."
```

Merge with a merge commit. Afterwards merge `main` back into
`vector-map-pipeline` once.

## 2. Cut the release

```bash
git tag v0.3.0 <main merge commit>
git push origin v0.3.0          # release.yml retags sha-… as v0.3.0 and stable
```

## 3. Deploy

```bash
cd scripts/gcp
./deploy.sh v0.3.0              # Cloud Run job: prisma migrate deploy (the one new migration), then the service
```

Check: the service answers, an event page shows the map as before
(tiles), and `select map_pipeline, count(*) from oxygen.events group by 1`
is all `legacy`.

## 4. Re-match the production documents (before any event switches)

Production documents are at the v0.2.0 importer/library. Nothing reads
them while every event is `legacy`, so this can wait, but it must happen
before the first event is switched to `vector` (the viewer wants the
current pins):

```bash
cd scripts/gcp
./backfill.sh --tag v0.3.0 --rematch --dry-run   # lists the stale pins
./backfill.sh --tag v0.3.0 --rematch             # Cloud Run job oxygen-map-rematch
```

Same job wiring as the backfill (released image, `oxygen-database-url`
secret, pool of 2), different CLI. Expect every pin re-matched, 0 failed,
and the same document hashes a dev re-match of the same sources produces
(S0's two-machine identity, now on the new importer).

## 5. S4: 36 MB chunked upload in idle mode

As [release-slice-a.md §6](release-slice-a.md): upload `club-full.ocd`
through the club library. Club-full (Nackareservatet 2023-03-29) is
already in the library from the backfill, so the identical file must
dedup at `finalise` without starting a job — a pass. To exercise the
whole path (chunks → inline-start job → `done` under the idle-mode
limits), upload a changed copy (re-save in OCAD, or a different map of
similar size) and watch `mapImport.status` to `done` with exactly one
execution (`claimed_by` stable). Record the numbers in the decision log
and set `S4` to `done` in `SLICES.md`.

## 6. After the release

- Decision-log row: date, tag, migration, re-match result, S4 result.
- `SLICES.md`: `S4` done; the B-gate's "one real event run with `vector`"
  can now be scheduled on the club's instance (switch one event, race it,
  switch back or leave it).
