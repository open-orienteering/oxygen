# Map tile rendering

How an uploaded OCAD map becomes the slippy-map tiles the web viewer
consumes, and why the renderer works a window at a time.

Code: `packages/api/src/map-tiles.ts` (pipeline and routes),
`map-window.ts` (geometry), `map-render-limits.ts` (resource limits),
`map-projection.ts` (coordinate conversion).

## Pipeline

```
map_files.file_data (OCD blob)
  │  readOcad + ocadToSvg            (ocad2geojson, cached per event)
  ▼
SVG document  ──── viewBox rewrite ────►  window raster   (resvg)
  │                                            │
  │                                            │  bilinear warp per tile
  │                                            ▼
  └─ getCrs()/getBounds() ──► tile geometry ──► 256×256 PNG ──► map_tiles
```

A tile request that misses `map_tiles` renders the whole *block* of
tiles around it, writes them all back, and serves the one asked for.

## Routes

| Route | Purpose |
|---|---|
| `GET /api/map-tile/:nameId/:z/:x/:y` | One 256×256 PNG. 204 when the tile is outside the map, 404 for an unknown event. |
| `GET /api/map-tile-progress` | Pre-cache progress for the event in the `x-competition-id` header. |

Both are guarded by `assertRestAccess` with the `courses.view` capability
and allow kiosk keys.

## Why windows

Tiles are not axis-aligned crops of the map. Projection convergence and
the map's grivation mean a tile is a rotated quadrilateral in OCAD
coordinates, so producing one involves resampling from a raster rather
than slicing it.

The original design rasterised the entire map once into a single RGBA
bitmap and resampled every tile from it. That is simple and it caches
well, but the bitmap is sized by the *map*, not by what is being looked
at:

- A 42544 × 38937-unit sprint map at 1 px/unit is 1.66 gigapixels — 6.6 GB
  of RSS, and past the 4 GB ceiling Node will allocate a Buffer at.
- Capping it (`MAP_RASTER_MAX_PIXELS`) fixed the memory but set a
  resolution ceiling. At the cap that fit a 4 GiB container the source
  was 0.35 px/unit while a z20 tile wants 0.52 — so deep zoom was being
  upsampled, and looked soft.
- The cached bitmaps also pinned the process: one instance could hold
  only a couple of events, so `--max-instances=1` was load-bearing.

Rendering a window instead decouples the raster from the map. For a
block of tiles the renderer computes the OCAD bounding box those tiles
cover, rewrites the SVG's root `viewBox` to that rectangle, and
rasterises it at a density derived from the tiles themselves. Cost then
scales with what is on screen:

| | Whole-map raster | Windowed |
|---|---|---|
| Source density at z20 | 0.35 px/unit (capped) | 0.52 px/unit ×2 supersample |
| Peak allocation | 763 MB | 20 MB |
| Time to first z20 tile | 2.7 s | 0.16 s |
| Tiles produced per render | 1 | 16 |

(Measured on `Bagissprinten utsnitt.ocd`, 42544 × 38937 units. Sharpness,
as mean absolute Laplacian over the tile, rose from 2.33 to 4.32.)

## Geometry

`ocadToSvg` emits a root `viewBox` spanning the OCAD bounds with the y
axis flipped — it negates y and translates the content by `minY + maxY`.
A window is therefore a plain sub-rectangle of that user space:

```
viewBoxX = rootMinX + (rect.minX - boundsMinX)
viewBoxY = rootMinY + (boundsMaxY - rect.maxY)
```

`windowViewBox()` verifies the root viewBox actually spans the bounds
before trusting this, and returns null otherwise; the renderer turns
that into a loud error rather than serving tiles from the wrong part of
the map, because an upstream change to ocad2geojson is the one thing
that could silently invalidate the mapping.

Density comes from the tile quad's edge lengths (`quadDensity`), not
from its bounding box, so a rotated block is not rendered softer than an
aligned one. The window is then rendered at `supersample` times that,
which is what keeps deep zoom crisp: the sampler always reads a source
finer than its output. The achieved density is read back from the
produced raster rather than assumed, so rasteriser rounding cannot shift
a tile.

Tiles are sampled at pixel centres (`(i + 0.5) / 256`), so neighbouring
tiles share their edge samples exactly and no hairline seam appears
between them. Windows are aligned to a global block lattice
(`blockOrigin`), which means the same tile always comes from the same
window regardless of which request triggered the render.

## Caching and concurrency

| Layer | Scope | Notes |
|---|---|---|
| `map_tiles` table | Shared | The real cache. Written with `ON CONFLICT DO NOTHING`, so concurrent renders of the same block across instances are harmless. |
| SVG cache | Per process | Parsed map SVGs, `MAP_SVG_CACHE_EVENTS` of them. Amortises the ~70 ms parse and the OCAD read. |
| In-flight block map | Per process | A viewport fetches ~20 tiles at once; they collapse onto one render per block. |
| Render semaphore | Per process | Bounds concurrent rasterisations (`MAP_RENDER_CONCURRENCY`). |

Everything above the database is a per-process optimisation, and losing
it costs time rather than correctness. Nothing in the tile path requires
a single instance.

Uploading a map fires `onMapUpload`, which drops the SVG cache entry and
any in-flight blocks for that event; `applyEventMap` deletes the event's
`map_tiles` rows in the same transaction.

## Pre-caching and progress

After the first tile of an event renders, a background pass fills zooms
`PRECACHE_MIN_ZOOM`..`PRECACHE_MAX_ZOOM` (10–17) so panning and zooming
out are instant. It skips zoom levels whose row count already matches
what the bounds imply, so a restart resumes rather than redoing work.
Set `MAP_TILE_PRECACHE=off` to render purely on demand — worth doing
where background CPU is not free, such as a scale-to-zero container that
only gets CPU while a request is in flight.

Above zoom 17 tiles are always rendered on demand.

`/api/map-tile-progress` reports both numbers from the database:

- **total** — `expectedTileCount()` over the WGS84 bounds stored on
  `map_files.bounds` at upload. A pure function of stored data, so every
  instance computes the same denominator.
- **done** — a `map_tiles` row count over the pre-cache zoom span.

A map whose georeference could not be parsed has no stored bounds and
reports `{ total: 0, done: 0, rendering: false }`, which the frontend
renders as a plain spinner rather than a progress bar.

## Configuration

All optional; the defaults in `map-render-limits.ts` suit both a dev
machine and a 4 GiB container.

| Variable | Default | Effect |
|---|---|---|
| `MAP_TILE_BLOCK_TILES` | 4 | Tiles per side per window. Larger amortises the SVG parse further but squares the memory. |
| `MAP_TILE_SUPERSAMPLE` | 2 | Window density relative to the tiles. 1 is cheaper and slightly softer. |
| `MAP_RENDER_CONCURRENCY` | 2 | Concurrent rasterisations per process. |
| `MAP_SVG_CACHE_EVENTS` | 4 | Parsed map SVGs held in memory. |
| `MAP_WINDOW_MAX_PIXELS` | 64M | Backstop against a pathological projection; normally never binds. |
| `MAP_TILE_PRECACHE` | `on` | `off` disables background pre-rendering. |

Peak render memory is roughly
`4 bytes × (blockTiles × 256 × supersample × √2)² × concurrency`, about
300 MB at the defaults.

## Tests

- `packages/api/src/__tests__/map-window.test.ts` — window and tile
  geometry, including the y-flip and the guard against an unexpected
  root viewBox.
- `packages/api/src/__tests__/map-render-limits.test.ts` — setting
  parsing, cache eviction, semaphore.
- `packages/api/src/__tests__/integration/map-tiles.test.ts` — the
  routes end to end against `e2e/test.ocd`: render, cache hit, whole
  block cached, deep zoom on demand, progress from the database.
