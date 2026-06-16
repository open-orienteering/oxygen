# Bugfix: Finnish Livelox replays showed no map (missing EPSG:3067 CRS)

## Symptom

Loading a Finnish event in the standalone replay viewer — e.g.
`/replay?classId=1208676` (Kotka-Jukola 2026, Jukolan Viesti) — rendered
the participant list, the course controls, and the playback controls, but
**no orienteering map**: the map area was blank white.

Swedish events (and any other event whose Livelox route data is in
EPSG:3006) were unaffected, which is what made this look event-specific
rather than a general regression.

## Root cause

Two facts combine into the blank map:

1. **The Livelox replay CRS module only knew about Sweden.**
   Livelox publishes per-participant GPS route data in a *projected* CRS,
   identified by `blob.projectionEpsgCode`. The decoder
   (`packages/api/src/livelox/decoder.ts`) interprets each waypoint as
   `easting×10 / northing×10` **only when** the transform hands it a
   `toLatLng` converter; otherwise it falls back to treating the two
   values as raw `lng×1e6 / lat×1e6`.

   `packages/api/src/livelox/crs.ts` only defined parameters for
   **EPSG:3006 (SWEREF 99 TM, Sweden)**. Finnish events use
   **EPSG:3067 (ETRS-TM35FIN)**, so `getProjectedToLatLng(3067)` returned
   `null`, the transform set `isProjected = false`, and every waypoint was
   mis-decoded:

   ```
   easting×10  = 4 946 255   → read as lng×1e6 →  lng = 4.946255
   northing×10 = 67 160 745   → read as lat×1e6 →  lat = 67.160745
   ```

   i.e. all 975 507 waypoints landed at ~(67.16 N, 4.95 E) — in the
   Norwegian Sea — instead of Kotka (~60.58 N, 26.90 E). The course
   controls came out correct because they are read straight from the
   blob's lat/lng `position`, never through the projected decoder. That
   asymmetry (controls on the map, routes nowhere near it) was the tell.

2. **The follow camera averages waypoint positions, with no sanity guard.**
   `ReplayViewer`'s follow-camera RAF loop (active by default) computes the
   bounding box of every visible runner's interpolated position via
   `latLngToMapPx(...)` and pans the viewport centre there — even while
   paused. With every waypoint projecting to ≈ `(−1 036 000, −381 000)`
   map-pixels, the camera centre ran away to `cx ≈ −1 034 425`, which the
   map canvas faithfully honoured: the tiles were drawn ~231 000 px off
   the left edge of an 786 px-wide canvas. The tiles loaded fine
   (20× HTTP 200 through `/api/livelox-tile`); they were simply painted
   off-screen.

This is **not** related to the in-progress offline-sync rework — it is a
pre-existing gap in `crs.ts` that only surfaces for Finnish (or any
non-3006) events.

## Fix

Add EPSG:3067 to the Livelox CRS table
(`packages/api/src/livelox/crs.ts`). It is UTM zone 35 on the GRS80
ellipsoid (central meridian 27°E), so it reuses the existing inverse-TM
implementation unchanged:

```ts
const CRS_PARAMS: Record<number, TMParams> = {
  // SWEREF 99 TM (Sweden)
  3006: { centralMeridianDeg: 15, scaleFactor: 0.9996, falseEasting: 500000, falseNorthing: 0 },
  // ETRS-TM35FIN (Finland) — UTM zone 35 on GRS80, central meridian 27°E.
  3067: { centralMeridianDeg: 27, scaleFactor: 0.9996, falseEasting: 500000, falseNorthing: 0 },
};
```

With 3067 supported, `getProjectedToLatLng(3067)(494625.5, 6716074.5)`
returns `(60.5806 N, 26.9019 E)`, which projects to map pixel
`(3198, 3352)` — inside the 3354×4724 map — so the routes, the
follow-camera bbox, and therefore the map canvas are all sane again.

The same EPSG already had a (correct) definition on the OCAD side in
`packages/api/src/map-projection.ts`; the Livelox replay path simply
hadn't been taught about it.

### Hardening (so this class of bug fails loud, not blank)

Two follow-ups landed alongside the CRS entry so a future
unsupported-projection (or a single glitchy GPS sample) degrades visibly
instead of silently blanking the map:

1. **Fail loud on an unsupported projection.** `transformToReplayData`
   now throws when `projectionEpsgCode` is present but unconvertible,
   instead of silently falling back to the lat/lng decoder. The
   `livelox.importClass` procedure already wraps thrown errors in
   `TRPCError(PRECONDITION_FAILED)` with the message preserved, and
   `ReplayPage` already renders `error.message` — so the user now sees
   *"Unsupported map projection EPSG:NNNN … Supported projections:
   EPSG:3006 (SWEREF 99 TM (Sweden)), EPSG:3067 (ETRS-TM35FIN
   (Finland))."* rather than a blank canvas. `crs.ts` exports
   `isSupportedProjection()` and `describeSupportedProjections()` to keep
   that message in sync with the actual `CRS_PARAMS` table.

2. **Clamp the follow camera to the map.** The follow-camera RAF
   (`ReplayViewer`) now (a) skips runner/control positions that project
   far outside the map image when building its bounding box — so a single
   bad sample can't dominate it, and if *every* visible runner is off-map
   the camera simply holds its current fit position — and (b) clamps the
   resulting viewport centre to the map bounds. New pure helpers
   `isOnMap()` / `clampToMap()` in `projection-utils.ts` carry the logic
   and are unit-tested. Net effect: even a future decode bug leaves the
   map on-screen (routes would be missing/wrong, which is far more
   debuggable than a white screen).

### Why a hard reload didn't show the fix

The replay payload is cached in **three** places, none of which a Chrome
"Empty Cache and Hard Reload" clears (that only touches the HTTP cache):

- the workbox **service-worker** `trpc-api` cache (`NetworkFirst`,
  `networkTimeoutSeconds: 3`, 24 h) — and because this `importClass`
  payload is tens of MB it can't download inside the 3 s window, so once a
  copy is cached the SW keeps serving it;
- React Query's **IndexedDB** persistence (`keyval-store`, 24 h);

To force-refresh after a deploy: DevTools → **Application → Storage →
"Clear site data"** (or unregister the service worker). This caching
behaviour is a separate latent issue from the CRS bug; worth revisiting
whether the large `importClass` response should be cached the same way as
small queries.

## Tests

- `packages/api/src/__tests__/livelox-crs.test.ts` (new) — unit tests for
  `getProjectedToLatLng` / `latLngToTM`: a Sweden (3006) reference point, a
  Finland (3067) regression test that asserts the bug's exact route
  coordinate decodes to Kotka rather than the Norwegian Sea, a 3067
  round-trip, and `null` for unsupported EPSG codes.
- `packages/api/src/__tests__/livelox-transform.test.ts` — added the
  projection-guard cases: throws (with the EPSG + supported list) for an
  unsupported projection, no-throws for 3067 / no-projection.
- `packages/api/src/__tests__/livelox-import-class.test.ts` — added a case
  asserting the unsupported-projection error surfaces as
  `TRPCError(PRECONDITION_FAILED)` with the EPSG in the message.
- `packages/web/src/components/replay/__tests__/projection-utils.test.ts`
  (new) — `isOnMap` / `clampToMap`, including the exact mis-decoded
  coordinate from this bug.

## Files touched

- `packages/api/src/livelox/crs.ts` (add EPSG:3067 + header comment;
  export `isSupportedProjection` / `describeSupportedProjections`)
- `packages/api/src/livelox/transform.ts` (throw on present-but-unsupported
  projection)
- `packages/web/src/components/replay/projection-utils.ts`
  (`isOnMap` / `clampToMap`)
- `packages/web/src/components/replay/ReplayViewer.tsx` (follow-camera
  bounds skip + clamp)
- `packages/api/src/__tests__/livelox-crs.test.ts` (new)
- `packages/api/src/__tests__/livelox-transform.test.ts`
- `packages/api/src/__tests__/livelox-import-class.test.ts`
- `packages/web/src/components/replay/__tests__/projection-utils.test.ts` (new)
- `docs/bugfix-livelox-finnish-crs.md` (this file)
