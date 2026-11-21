# Release runbook — slices G and H (map corrections, GPS tracks, terrain) — v0.8.0

> The shared steps (preconditions, landing on `main`, tag, backup, deploy, re-match, rollback) are in [runbook.md](runbook.md); this note keeps what was particular to this release and its record.

Slice G is map corrections inside an event plus GPS tracks turned into map
objects. It covers `docs/research/vector-map-pipeline/SLICES.md` rows
G2–G29, with V1, D9c and C15 beside them:

- the per-event map patch (hide, move, draw, change symbol, nodes, join,
  split and holes in Map mode), applied on screen, on the kiosk and in
  print;
- promoting a patch into a new club map version;
- the print pipeline moved into the shared package, with a browser-side
  PDF where the device can and offline print from the stored job;
- venue printing from the checkout snapshot, and a box that follows the
  cloud's map data;
- GPX import, averaging, trim and split, conversion with ISSkiOM track
  symbols and snapping to the track network;
- the importer that knows ski-O (G21), and course purples placed by rule
  (C15);
- Field mode's offline write queue (D9c);
- one version aligned with the git tag (V1).

Slice H is the 3D terrain (rows H1–H13): contour chains and levels, the
height field, a mesh with the map draped on it, the 3D mode in the viewer,
GPS tracks and replay on the terrain, and the DEM anchor with its settings
page (Settings → Height data). Both slices ship as one tag, **v0.8.0**, on
top of v0.7.0. The version is set by `pnpm release:version 0.8.0`.

## 1. What changes for the operator

Six migrations, all additive. `deploy.sh`'s migrate job applies them
before the service starts:

| Migration | Row | Kind | An older image |
|---|---|---|---|
| `20261113120000_map_patches` | G3 | new table `map_patches` (one per event) | never reads it: the event's map draws without corrections |
| `20261114120000_map_gps_tracks` | G24 | new table `map_gps_tracks` | never reads it |
| `20261114130000_map_heightfields` | H4 | new table `map_heightfields` | never reads it |
| `20261115120000_map_dem_jobs` | H10 | new table `map_dem_jobs` | never reads it |
| `20261115130000_map_patches_unresolved` | G11 | two columns on `map_patches` | never reads them |
| `20261116120000_map_version_patches` | G12a | `patch` columns on `club_map_versions`, `map_import_jobs` and `map_documents` (defaults `[]` / null) | ignores them; a promoted version's baked document draws as any other |

No migration rewrites data, so no preflight survey is needed.

**Importer versions changed**: `ocad-16` → `ocad-18` and `omap-9` →
`omap-11`. G21 adds ski-O green to every colour stack, and C15 places the
course purples by rule. Every pinned map must be re-matched after the
deploy (§3).

**Environment variables.** None are required. Height data fetching is
**off by default**. It turns on in one of two ways:

- an admin saves the instance's Geotorget account in Settings → Height
  data;
- the `oxygen-geotorget-credentials` secret exists, in which case
  `deploy.sh` passes it with `MAP_DEM_PROVIDERS=lantmateriet,glo30`.

See `docs/ops/deploy-gcp-cloud-run.md` "Height data". Until either is done,
the terrain uses contours only.

## 2. Backup, deploy

With the v0.8.0 image published (`release.yml` after the tag):

```bash
source scripts/gcp/env.sh
gcloud sql backups create --instance="$SQL_INSTANCE" --project="$PROJECT_ID" \
  --description="before v0.8.0 (slices G, H)"
gcloud sql backups list --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --limit=1
cd scripts/gcp && ./deploy.sh v0.8.0
```

## 3. Re-match

```bash
cd scripts/gcp && ./backfill.sh --tag v0.8.0 --rematch --dry-run
./backfill.sh --tag v0.8.0 --rematch
```

The re-match moves each pin to the new importer versions. A patch whose
pin moves is re-resolved against the new document (G11): an operation
that no longer finds its object shows in Map mode's *Corrections* list.

## 4. Rollback

**Per event**: switch off Map mode's *Apply corrections* toggle
(`map-patches.md` §1.4). Every consumer (screen, kiosk, print) then draws
the pinned document unchanged, and the patch is kept.

**Whole release**: run `./deploy.sh v0.7.0`. The migrations are additive,
so v0.7.0 runs on the migrated database (see the table in §1), and no
restore is needed. In that state, events with corrections draw without
them. Maps re-matched under v0.8.0 keep their new pins: v0.7.0 opens them,
and re-matches them on its own importer version only if
`./backfill.sh --tag v0.7.0 --rematch` is run. If a clean state is needed,
restore the §2 backup with
`gcloud sql backups restore <BACKUP_ID> --restore-instance="$SQL_INSTANCE" --project="$PROJECT_ID"`.

## 5. Gates on production

**G-gate** (the user and the club; `SLICES.md` row G-gate):

- A real ski-O correction from GPX:
  1. Import at least two logged passes of one track.
  2. Average them and trim a break.
  3. Convert the result with an ISSkiOM track symbol.
  4. Snap its ends to the network.
  5. Check it in the editor, on the kiosk and in the printed PDF.
  6. Promote it and re-match, with the track kept.
- An imported ISSkiOM map's track symbols matched in the review.
- One correction to the club's map (a hidden object and a new path):
  1. Check it in the editor, on the kiosk and in print.
  2. Switch the toggle off and on.
  3. Promote it and re-match, with the correction kept.
- One event's maps exported on a laptop with the network off.
- One checked-out box printing with its uplink pulled.

**H-gate** (row H-gate):

- The club's own map opened in 3D on a laptop and on a phone, and
  recognised by a club member.
- One course and one logged GPS track seen on the terrain.
- Frame time on the S1 phone within budget.

The DEM track (H9–H13) ships in this tag, but fetching stays off (§1). It
gets its own check when the Geotorget account is saved in Settings →
Height data. That step stands in for the separate DEM release (`SLICES.md` slice H,
answer 10).

### Club production, 2026-11-17

v0.8.0 (`main` `f7bc8195`, PR #223):

- **Backup**: on-demand backup `1794946501678` ("before v0.8.0 (slices G, H)").
- **Deploy**: `./deploy.sh v0.8.0` applied the six migrations (execution
  `oxygen-migrate-mw8r4`). Revision `oxygen-00055-mk8` serves 100 % of
  traffic. DEM fetch is off: there is no `oxygen-geotorget-credentials`
  secret and `MAP_DEM_PROVIDERS` is unset.
- **Re-match**: the dry run listed 20 stale pins (4 club maps, 16 event
  pins). The run re-matched all 20 with 0 failures, in 89.8 s, and derived
  the height fields. Nackareservatet 2023-03-29 still gets no thumbnail:
  it has 101 729 objects, over the 60 000 cap, as before.
- **Logs**: the new revision logged no errors. It logged one
  `[map-import] housekeeping: Connection terminated unexpectedly` (Cloud
  SQL dropping an idle connection). It is not new: v0.6.1 and v0.7.0
  revisions log it too.

The G-gate and H-gate (§5) are the user's.
