# Map tile rendering

How an uploaded OCAD map becomes the slippy-map tiles the web viewer
consumes, and why the renderer works a window at a time.

Code: `packages/api/src/map-tiles.ts` (pipeline and routes),
`map-window.ts` (geometry), `map-render-limits.ts` (resource limits),
`map-projection.ts` (coordinate conversion).

## Pipeline

```
map_files.file_data (OCD blob)
  │  readOcad + applyIofColorStack + ocadToSvg×2
  ▼
SVG full + SVG ink  ─ viewBox rewrite ─► window rasters (resvg)
  │                                            │
  │                                            │  bilinear warp per tile
  │                                            ▼
  └─ getCrs()/getBounds() ──► tile geometry ──► 256×512 stacked PNG ──► map_tiles
                                                 (composite top, ink bottom)
```

A tile request that misses `map_tiles` renders the whole *block* of
tiles around it, writes them all back, and serves the one asked for.
The ink half is transparent line art (colours above lower purple); the
viewer slices the PNG so course purple can sit between the halves. See
[`map-color-stack.md`](map-color-stack.md).

## Routes

| Route | Purpose |
|---|---|
| `GET /api/map-tile/:nameId/:z/:x/:y` | One **256×512** stacked PNG (composite top, ink bottom). Empty / out-of-map tiles return a **200 transparent PNG** (not 204; see `docs/bugfix-red-empty-tiles.md`). 404 for an unknown event. 500 on render failure. Client URLs include `f=2` so caches cannot serve pre-stack 256×256 tiles. |
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

## Keeping the event loop free

Rasterising goes through `renderAsync`, not `Resvg#render`, so it runs on
the libuv thread pool. This matters much more than it did for the
whole-map raster: that ran once per event, while this runs once per block
per zoom. Measured on a real club map, the synchronous call blocks the
event loop for **269 ms per render** and the asynchronous one for **1 ms**
— and a blocked loop stalls every other request in the process, not just
tiles. Symptoms of getting this wrong are diffuse and look nothing like a
map bug: unrelated queries time out while someone pans a map.

## Caching and concurrency

| Layer | Scope | Notes |
|---|---|---|
| `map_tiles` table | Shared | The real cache. Written with `ON CONFLICT DO NOTHING`, so concurrent renders of the same block across instances are harmless. |
| SVG cache | Per process | Parsed map SVGs, `MAP_SVG_CACHE_EVENTS` of them. Amortises the ~70 ms parse and the OCAD read. |
| In-flight block map | Per process | A viewport fetches ~20 tiles at once; they collapse onto one render per block. |
| Render semaphore | Per process | `renderGate()` in `map-render-limits.ts` bounds concurrent rasterisations (`MAP_RENDER_CONCURRENCY`). One permit covers a block's composite **and** ink rasters, run side by side. The course-map layout preview (`/api/maps/:nameId/window.png`) takes permits from the same pool. Foreground requests are served before pre-cache work, so background rendering never queues a user behind a whole sweep. |
| Queue bound | Per process | At most `MAP_RENDER_MAX_QUEUE` foreground blocks may wait for a permit. Beyond that the tile route answers **503 + `Retry-After: 5`** immediately instead of letting the request sit until the platform kills it. |

Everything above the database is a per-process optimisation, and losing
it costs time rather than correctness. Nothing in the tile path requires
a single instance.

### What one tile request costs

The request handler resolves the event's map settings **once** —
`ensureEventMapRenderKey`, a metadata-only read of `map_files` — and
threads that object through the render path and the pre-cache kick-off.
The OCAD blob is read in exactly one place, `loadMapSource`, once per
render key per process; `ensureEventMapRenderKey` only touches
`file_data` when `file_hash` is still null (one-off backfill). A cache
hit is therefore three or four indexed reads and no blob traffic. Keep
it that way: in September 2026 the same helper selected `file_data`
unconditionally and was called three times per miss, which pulled ~30 MB
through Cloud SQL per tile and took the service down — see
[bugfix-map-tile-cold-render-cloud-timeouts.md](bugfix-map-tile-cold-render-cloud-timeouts.md).

### Where a cold block's time goes

Measured on a 9.8 MB forest map (45 k objects, 16.7 MB composite SVG),
one 4×4 block at zoom 15–16 on a dev machine:

| Step | Cost | When |
|---|---|---|
| `readOcad` + `ocadToSvg` ×2 | ~7.5 s | Once per render key per process (`svgCache`) |
| resvg composite raster | ~6 s, **~5.7 s of it parsing the SVG** | Every block |
| resvg ink raster | ~2 s | Every block, in parallel with the composite |
| Sample 16 tiles + PNG encode + insert | <1 s | Every block |

resvg re-parses the whole SVG per call and exposes no way to reuse the
tree, so the parse dominates and the block size is the lever: doubling
`MAP_TILE_BLOCK_TILES` halves parses per tile at ~4× the window memory.

Uploading a map fires `onMapUpload`, which drops the SVG cache entry and
any in-flight blocks for that **render key**. `applyEventMap`, rotation
changes, and colour-stack updates recompute `map_files.render_key` and
call `gcOrphanTiles()` — they no longer `DELETE FROM map_tiles WHERE
event_id = …`.

## Content-keyed tile cache

`map_tiles` is keyed by `render_key`, not `event_id`:

```
renderKey = sha256(
  file_hash | rotationCorrection | profile | JSON(overrides)
  | northLinesBelow | TILE_FORMAT
).slice(0, 32)
```

Pure helper: `computeRenderKey()` in `packages/api/src/map-render-key.ts`.
`file_hash` is `sha256(file_data)` (backfilled on migrate; lazily filled
on upload). `render_key` is nullable and filled on first
`ensureEventMapRenderKey` / tile / metadata read.

Two events that adopt the same club-library map (same blob + same stack
settings) share tile rows. Changing profile or north-lines on one event
mints a new key; `gcOrphanTiles` drops rows whose key is no longer
referenced by any `map_files` or `club_map_files` row. A club-library
map keeps its tiles even when every event drops it — re-add is instant.

Client `tileVersion` is the `renderKey` string (`?v=<key>`). `TILE_FORMAT`
is already inside the key; `f=` stays for week-old browser caches.

Backup / showcase dumps omit `map_tiles` (pure cache; regenerates on
first view).

### Deploying a render-key change

Anything folded into the key — `TILE_FORMAT`, the colour-stack rules,
the hash inputs — orphans **every** cached tile on deploy, and the first
viewer of each map gets a fully cold render at every zoom they touch.
The overview zooms refill themselves (the progress poll drives
`preCacheChunk`; see below), but the deep zooms a course setter is
actually looking at render on demand, block by block, under the queue
bound. Plan for it:

- Deploy when nobody is setting courses, or accept a few minutes of
  progressive fill per map with tiles arriving under the 503/retry
  cadence.
- Because tiles are content-addressed, rows rendered anywhere are valid
  everywhere. A dev machine that has already viewed the same map holds
  rows with the identical `render_key`; copying them into the production
  `map_tiles` table (`pg_dump -t oxygen.map_tiles --data-only`) is a
  legitimate pre-warm.
- Do not bump `TILE_FORMAT` for changes the key already covers.

## Pre-caching and progress

After the first tile of an event renders, a background pass fills zooms
`PRECACHE_MIN_ZOOM`..`PRECACHE_MAX_ZOOM` (10–15) so the next viewer's
first paint is instant. It skips zoom levels whose row count already
matches what the bounds imply, so a restart resumes rather than redoing
work, and it pauses `MAP_PRECACHE_BLOCK_DELAY_MS` between blocks so
background rendering does not crowd out foreground requests.

The ceiling is low on purpose. Tile counts quadruple per level — for a
sprint map, zooms 10–15 are 27 tiles while 16 and 17 add another 198 —
and this renderer rasterises per block per zoom rather than amortising
one whole-map raster across the pyramid, so an exhaustive pre-cache
costs roughly eight times as much work for levels most viewers never
reach. A miss above the ceiling now costs a couple of hundred
milliseconds and fills a whole block, which is cheaper than rendering
those levels for everyone up front.

Set `MAP_TILE_PRECACHE=off` to render purely on demand — worth doing
where background CPU is not free, such as a scale-to-zero container that
only gets CPU while a request is in flight.

`/api/map-tile-progress` reports both numbers from the database:

- **total** — `expectedTileCount()` over the WGS84 bounds stored on
  `map_files.bounds` at upload. A pure function of stored data, so every
  instance computes the same denominator.
- **done** — a `map_tiles` row count over the pre-cache zoom span.

A map whose georeference could not be parsed has no stored bounds and
reports `{ total: 0, done: 0, rendering: false }`, which the frontend
renders as a plain spinner rather than a progress bar.

### The progress poll is also the engine

On Cloud Run the container's CPU is throttled to near zero whenever no
request is in flight, so the detached `preCacheTiles` loop above makes
almost no progress between requests. That bites hardest right after an
upload, when there is no traffic left to keep the instance awake and the
map most needs filling.

So the progress endpoint steals work. When it finds rendering
incomplete it renders up to `CHUNK_BLOCKS` (2) still-missing blocks
inline before answering, picking them with `missingBlocks()` over the
rows already present at that zoom. The work now happens inside a request
lifetime, on the clock. `MapViewer` keeps polling every 2 s until the
server reports `rendering: false` — past first paint, not just while the
loading overlay is up — so one viewer opening a new map drives it to
completion for everyone after.

Two guards keep this from compounding: a per-event `chunkInFlight` flag
serialises overlapping polls, and the client chains `setTimeout` rather
than using `setInterval`, so a poll that spends a second rendering does
not stack up behind the next tick.

## Configuration

All optional; the defaults in `map-render-limits.ts` suit both a dev
machine and a 4 GiB container.

| Variable | Default | Effect |
|---|---|---|
| `MAP_TILE_BLOCK_TILES` | 4 | Tiles per side per window. Larger amortises the SVG parse further but squares the memory. |
| `MAP_TILE_SUPERSAMPLE` | 2 | Window density relative to the tiles. 1 is cheaper and slightly softer. |
| `MAP_RENDER_CONCURRENCY` | 2 | Concurrent block renders per process (each rasterises composite + ink in parallel). Cloud Run runs 3 (see `scripts/gcp/deploy.sh`), which its 2 vCPUs can actually overlap. |
| `MAP_RENDER_MAX_QUEUE` | 4 | Foreground blocks allowed to wait for a permit before further tile requests get 503 + `Retry-After`. `0` refuses any queueing. Background (pre-cache) work is never refused. |
| `MAP_SVG_CACHE_EVENTS` | 4 | Parsed map SVGs held in memory. |
| `MAP_WINDOW_MAX_PIXELS` | 64M | Backstop against a pathological projection; normally never binds. |
| `MAP_TILE_PRECACHE` | `on` | `off` disables background pre-rendering. |
| `MAP_PRECACHE_MIN_ZOOM` / `MAP_PRECACHE_MAX_ZOOM` | 10 / 15 | Pre-cache zoom span. Also the span the progress endpoint reports. |
| `MAP_PRECACHE_BLOCK_DELAY_MS` | 50 | Pause between pre-cache blocks. |

Peak render memory is roughly
`4 bytes × (blockTiles × 256 × supersample × √2)² × 2 layers × concurrency`,
about 600 MB at the defaults.

Sizing `MAP_RENDER_MAX_QUEUE`: a cold block costs 10–15 s on a 2 vCPU
Cloud Run instance, so with concurrency 3 and four waiters the worst
case is about a minute — well inside the platform's 300 s request
timeout, which is what the unbounded queue used to run into.

## North: georeference, meridian lines, display

Three independent things, deliberately kept apart
(`map-north.ts`, `event-map.ts`):

- **Georeference** — the file's ScalePar (grid, offset, scale, angle)
  is authoritative. `rotation_correction` on `map_files` /
  `club_map_files` defaults to 0 and is never set automatically; it is
  an ops-only override (`course.setMapRotation`, `clubMap.setRotation`)
  for a file that is genuinely mis-registered. `withGrivationCorrection`
  applies it, and `loadEventCrs`, `parseOcadMapMetadata`,
  `loadMapSource` and the tile warp all go through the same wrapper.
- **Drawn meridian lines** (ISOM 601.x) — a compass aid at the
  declination of the production date. `detectMapNorth` finds the
  cluster, measures its in-paper tilt and computes

  `staleness = declination(now) + trueNorthFromGrid − declaredGrivation − meridianTilt`

  i.e. today's grivation minus the grivation the lines were drawn at
  (≈ 0.1–0.2°/yr drift in Sweden). The static parts are persisted in
  `north_detection`; `meridianStalenessFromDetection` re-evaluates the
  WMM for today, so `clubMap.list` and `course.mapMetadata` return a
  live `meridianStalenessDeg`. `|staleness| ≥ 1°` is shown as an amber
  badge (Settings → Maps, course-editor map panel) and as a one-off
  notice after upload. Purely informational.
- **Display orientation** — `northOffset` is the bearing of the
  *display-up* direction: the meridian direction when the file has one
  (`displayNorthOffsetDeg` folds the tilt in), else paper +Y. The viewer
  rotates by `-northOffset` and the print pipeline by `-meridianTiltDeg`,
  so north lines render vertical. Presentation only; nothing moves
  geographically.

History: an earlier version read the staleness as a georeference error
and auto-applied it, shifting GPS by ~200 m. See
`docs/bugfix-auto-north-correction-gps-offset.md` (and the superseded
`docs/bugfix-map-north-correction.md`).

## Client tile loading

`TileLayer` does **not** use bare `<img src>` — that hid HTTP status and
let a viewport fire ~20–30 uncapped requests, which on Cloud Run
(`--max-instances=2`) produced 429 storms. Worse, the old client
blacklisted every failed key forever in a `failedTiles` Set, so one
429 blanked that tile for the session.

Current behaviour (`tile-fetcher.ts` + `tile-retry.ts`):

| Condition | Behaviour |
|---|---|
| Empty / out-of-map | Server 200 transparent PNG — normal success |
| 429 | Back off, honour `Retry-After` when present |
| 503 (renderer busy) | Server refused to queue the block; retry after `Retry-After` (5 s). Expected during a cold fill, not an error. |
| 500 / network error | Back off 2s → 10s → 30s → 60s |
| Concurrency | Max 12 fetches in flight, nearest-to-centre first |
| Scroll-out | `AbortController` cancels queued/in-flight work |
| Success | Object URL; retry state cleared |

The concurrency cap bounds connection pressure, not render load: a
cached tile is one indexed read, and an uncached one queues behind the
server's own render semaphore however many the client asks for.

Not every 429 comes from tile load. Cloud Run also returns 429 at the
admission layer when instances are saturated for unrelated reasons — an
exhausted Cloud SQL connection budget makes every request hang until the
300 s timeout, which jams admission and produces 429s on static assets
too. If you see 429 on `/api/version` or `/manifest.webmanifest`, the
cause is not the tile pipeline; see
[bugfix-cloud-sql-handshake-eof.md](bugfix-cloud-sql-handshake-eof.md).

### Service-worker cache

The PWA caches `/api/map-tile/…` with Workbox `CacheFirst` (cache
`map-tiles`, 2000 entries, 7 days — matching the `Cache-Control` the
route sends). A revisit therefore paints without touching IAP, Cloud
Run or Cloud SQL at all.

No invalidation is needed: every tile URL carries `?v=<upload
timestamp>`, so re-uploading a map lands on fresh cache keys and the old
entries age out. Only 200s are cached — caching a 401 or 5xx as a tile
would strand it permanently, since the retry book never gets to see it.
The rule matches `/api/map-tile/` with the trailing slash so
`/api/map-tile-progress` stays live.

## Tests

- `packages/api/src/__tests__/map-window.test.ts` — window and tile
  geometry, including the y-flip and the guard against an unexpected
  root viewBox.
- `packages/api/src/__tests__/map-render-limits.test.ts` — setting
  parsing, cache eviction, semaphore.
- `packages/api/src/__tests__/map-projection-correction.test.ts` —
  grivation correction composition and OCAD ↔ WGS84 round-trip.
- `packages/api/src/__tests__/map-north.test.ts` — meridian clustering,
  staleness arithmetic and its re-evaluation from a stored row.
- `packages/web/src/lib/__tests__/tile-retry.test.ts` — backoff,
  Retry-After, concurrency cap, abort.
- `packages/api/src/__tests__/integration/map-tiles.test.ts` — the
  routes end to end against `e2e/test.ocd`: render, cache hit, whole
  block cached, deep zoom on demand, progress from the database, and
  the progress poll advancing the pre-cache with no tile request to
  trigger the background loop.
- `packages/api/src/__tests__/integration/map-rotation.test.ts` —
  `setMapRotation` (ops override) re-derives metadata, re-syncs control
  coordinates and drops tiles.
- `packages/api/src/__tests__/integration/reset-auto-north-corrections.test.ts`
  — the data migration that undoes auto-applied corrections.
