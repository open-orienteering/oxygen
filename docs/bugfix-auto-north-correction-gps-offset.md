# Bugfix: auto-applied north correction displaced GPS by ~200 m

## Symptom

On `Testkarta` (base map `Nackareservatet 260620.ocd`) the live GPS
dot sat consistently ~200 m south of the runner's true position. On
`Nackares` (`Nackareservatet 2023-03-29.ocd`) it was spot on. Setting
the event's rotation correction to 0° and reloading fixed `Testkarta`.

## Cause

The 2026 file had a `rotation_correction` of **+1.7°** that import-time
north detection had applied automatically
([bugfix-map-north-correction.md](bugfix-map-north-correction.md)). The
2023 file had been ingested before that logic existed and kept 0°.

A 1.7° rotation about the map's grid origin, a few kilometres from the
map area, is a ~190 m translation of every WGS84 coordinate — exactly
the observed offset.

The detection formula itself was sound, but it was answering a
different question than the one it was used for:

```
declination(now) + trueNorthFromGrid − declaredGrivation − meridianTilt
```

is the angle between the **drawn magnetic-north lines** (ISOM 601.x)
and **today's** magnetic north. That is the *age* of the north lines —
declination drifts ≈ 0.1–0.2°/yr eastward in Sweden, so lines drawn a
few years ago lag behind. It is not a georeference error. ScalePar's
grid registration is independent of magnetism and was correct in both
files. Treating the staleness as a correction and rotating the CRS by it
broke a georeference that was already right.

The three "norths" involved, kept separate from now on:

| Concept | Source | Time-dependent? | Used for |
|---|---|---|---|
| Georeference | ScalePar (grid, offset, angle) | No | GPS, controls, bounds, tiles |
| Drawn meridian lines | Mapper's choice on production date | Yes (declination drift) | Compass aid on paper |
| Display orientation | Meridian tilt folded into `northOffset` | No | What is "up" on screen and print |

## Fix

1. **Never auto-apply.** `resolveMapNorth` (`event-map.ts`) sets
   `rotationCorrection` to the club-library value when copying a
   library map and to 0 otherwise. `map-north.ts` no longer exports a
   "suggested correction"; `detectMapNorth` returns
   `meridianStalenessDeg` instead, with the same arithmetic and a
   comment explaining what it measures.
2. **Live staleness.** `north_detection` still stores the static parts
   (grid angle, meridian tilt, map centre). `meridianStalenessFromDetection`
   re-evaluates the WMM for *today* from that row, so
   `clubMap.list` and `course.mapMetadata` report a value that grows
   over the years without re-parsing the OCAD blob. `computeDeclination`
   returns `null` outside the bundled WMM epochs instead of throwing.
3. **Surfaced, not enforced.** Threshold `MERIDIAN_STALE_WARN_DEG = 1.0`
   (≈ 6 years of drift; WMM uncertainty is ≈ 0.2°). Shown as an amber
   `NorthLinesBadge` on Settings → Maps, next to the file name in the
   course-editor map panel, and as a dismissible notice right after a
   map upload / club-library copy.
4. **UI input removed.** The "North correction (°)" input is gone from
   Settings → Maps. `clubMap.setRotation` and `course.setMapRotation`
   stay as ops-only escape hatches for a file that is genuinely
   mis-registered — the right fix for that is in OCAD, then re-upload.
5. **Data migration** `20260918160000_reset_auto_north_corrections`:
   rows where `north_detection.shouldAutoApply` is true and
   `rotation_correction` equals `suggestedCorrectionDeg` are reset to
   0. Event rows get scale/bounds/northOffset/calibration cleared so
   `course.mapMetadata` re-derives them on first read (the same legacy
   path pre-metadata rows use), which now also re-syncs positioned
   control lat/lng. Tile and rendered-map caches for those events are
   dropped and `uploaded_at` is bumped to bust client caches. Manual
   values (differing from the suggestion) are left untouched.
6. `computeTrueNorthFromGrid` now goes through the shared
   `getEpsgString`, so a file without an explicit grid code (like the
   E2E fixture) gets the same coordinate-range inference the rest of
   the WGS84 pipeline uses.
7. **Legacy rows are backfilled lazily.** Maps uploaded before the
   `north_detection` column existed had `NULL` there, which the UI
   showed as "no magnetic north lines found" — while the same file,
   freshly copied into an event, showed a staleness badge. The first
   `clubMap.list` / `course.mapMetadata` read now parses the blob once,
   runs `detectNorthFromBuffer`, and persists the result (an
   unparseable file persists an all-null detection so it is never
   re-parsed). "No north lines" now always means the analysis ran.

## What did not change

- The on-screen and printed orientation still puts the drawn meridian
  lines vertical (`displayNorthOffsetDeg`, `meridianTiltDeg` in the
  course-map pipeline). That is presentation only.
- `withGrivationCorrection` and the `rotation_correction` columns
  remain, defaulting to 0.

## Deferred

Re-drawing north lines at today's grivation on printed course maps.
The staleness number is what such a feature would consume.

## Tests

- Unit: `map-north.test.ts` — staleness arithmetic, growth over time,
  no auto-apply fields, WMM out-of-range → null, re-evaluation from a
  stored row. `packages/web/src/lib/__tests__/north-lines.test.ts` —
  badge state.
- Integration: `club-maps.test.ts` — upload keeps `rotationCorrection`
  0 while reporting ≈ 6.5° staleness on the fixture, bounds equal a
  correction-0 parse; list/mapMetadata backfill `north_detection` for
  legacy rows (including an unparseable-blob marker).
  `reset-auto-north-corrections.test.ts` — runs the migration SQL
  against seeded auto/manual rows.
- E2E: `club-map-library.spec.ts` — stale badge on Settings → Maps, no
  correction input; upload notice + course-editor badge.
- Fixture: `e2e/test.ocd` now contains twelve ISOM 601 lines drawn
  along grid north, ≈ 6.5° stale at its location.
