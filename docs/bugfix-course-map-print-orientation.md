# Bugfix: course-map print orientation used the wrong rotation source

## Symptom

Maps rendered by the course-map print pipeline (layout editor preview,
`window.png`, PDF export) showed meridian lines leaning several degrees,
while the exact same base map looked perfectly straight in the regular map
view (course editor / MapViewer). For Nackareservatet
(`north_offset ≈ 7.71°`) the print output leaned ~4.4° counterclockwise
with `rotationDeg = -north_offset`, and ~11° clockwise with
`+north_offset` — no sign of `north_offset` could make it straight.

## Root cause

The two pipelines do not start from the same raster orientation, so the
same rotation value cannot serve both:

```
tile pipeline (MapViewer)
  OCAD paper space ──(warp to true-north mercator)──► tiles
  tiles ──CSS rotate(-north_offset)──► meridians vertical

print pipeline (window.png / PDF)
  OCAD paper space ──(viewBox crop, NO warp)──► raster
  raster ──rotate(?)──► ...
```

`map_files.north_offset` is the bearing from **true north** to the
display-up direction (`displayNorthOffsetDeg` = paper +Y bearing + the
in-paper meridian tilt, see `map-north.ts`). MapViewer's tiles are warped
into true-north mercator first (`map-tiles.ts` computes each tile quad via
WGS84 → OCAD), so rotating them by `-north_offset` is correct.

The print pipeline renders raw paper coordinates. There the meridians only
lean by their **in-paper tilt** — the ISOM 601.x lines are often drawn
rotated inside the sheet (Nackareservatet: 3.3°, measured by
`probeMeridianLines`). The paper-to-true-north bearing (~4.4° at Nacka)
never enters the print raster, so compensating for it over-rotates by
exactly that amount.

Numerically: raw print render leans +3.3° clockwise (matches the meridian
probe); `rot=-7.71` leaves 3.3 − 7.71 ≈ −4.4° (counterclockwise lean, as
reported); `rot=-3.3` is straight.

## Fix

- `course-maps/map-source.ts`: `parsedMap` runs `probeMeridianLines` on
  the parsed OCAD objects and caches `meridianTiltDeg` (0 when the file
  has no meridian cluster — those drawings are magnetic-north-up and the
  viewer shows them paper-up too). `getBaseMapInfo` exposes it;
  `getBaseMapInfoOrNull` is a tolerant variant for the tRPC routers.
- `course-maps/resolve-layout.ts`: input renamed
  `northOffsetDeg` → `meridianTiltDeg`; `rotationDeg = -meridianTiltDeg`.
- `routers/courseMap.ts`, `routers/mapTemplate.ts`,
  `course-maps/routes.ts`: feed the tilt from `getBaseMapInfo*` instead of
  reading `map_files.north_offset`. The routers now share the print
  pipeline's cached OCAD parse instead of an extra DB read.

No schema change: the tilt is derived from the drawing on demand and
cached with the parsed file.

## How it was diagnosed

Eyeballing rotated map renders proved unreliable (two earlier attempts
flipped the sign back and forth). What settled it:

1. Cross-correlating `window.png?rot=X` renders against `rot=0` proved the
   `rot` parameter applies exactly one clockwise-positive rotation.
2. A thin-line column-sum scan (thick roads filtered out by a local
   density threshold) measured the raw print render's meridian lean at
   ~3.2° clockwise — matching `probeMeridianLines`' 3.3° in-paper tilt,
   not `north_offset`'s 7.71°.
3. Reading the tile pipeline showed the mercator warp that explains why
   MapViewer needs the full `-north_offset` while print must not use it.
