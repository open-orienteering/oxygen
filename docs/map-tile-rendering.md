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
| `GET /api/map-tile/:nameId/:z/:x/:y` | One 256×256 PNG. Empty / out-of-map tiles return a **200 transparent PNG** (not 204; see `docs/bugfix-red-empty-tiles.md` for the time the "transparent" pixel was red). 404 for an unknown event. 500 on render failure. |
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
| Render semaphore | Per process | Bounds concurrent rasterisations (`MAP_RENDER_CONCURRENCY`). Foreground requests are served before pre-cache work, so background rendering never queues a user behind a whole sweep. |

Everything above the database is a per-process optimisation, and losing
it costs time rather than correctness. Nothing in the tile path requires
a single instance.

Uploading a map fires `onMapUpload`, which drops the SVG cache entry and
any in-flight blocks for that event; `applyEventMap` deletes the event's
`map_tiles` rows in the same transaction.

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
| `MAP_RENDER_CONCURRENCY` | 2 | Concurrent rasterisations per process. Cloud Run runs 3 (see `scripts/gcp/deploy.sh`), which its 2 vCPUs can actually overlap. |
| `MAP_SVG_CACHE_EVENTS` | 4 | Parsed map SVGs held in memory. |
| `MAP_WINDOW_MAX_PIXELS` | 64M | Backstop against a pathological projection; normally never binds. |
| `MAP_TILE_PRECACHE` | `on` | `off` disables background pre-rendering. |
| `MAP_PRECACHE_MIN_ZOOM` / `MAP_PRECACHE_MAX_ZOOM` | 10 / 15 | Pre-cache zoom span. Also the span the progress endpoint reports. |
| `MAP_PRECACHE_BLOCK_DELAY_MS` | 50 | Pause between pre-cache blocks. |

Peak render memory is roughly
`4 bytes × (blockTiles × 256 × supersample × √2)² × concurrency`, about
300 MB at the defaults.

## North correction

Some OCAD files declare ScalePar `a=0` while the drawing is rotated
relative to true north. Projection code already honours the file's
grivation, so those maps need a stored override:

- Columns `map_files.rotation_correction` and
  `club_map_files.rotation_correction` (degrees, CW positive).
- Import-time auto-detect in `map-north.ts`:
  `suggested = declination + trueNorthFromGrid − declaredGrivation − meridianTilt`
  (~1.7° for Nackareservatet — not the physics-only 4.5°/5°, and not
  the earlier unverified ~11°). The meridian-tilt term matters because
  the drawn 601.x north lines are the ground truth and can be tilted
  inside the paper drawing (3.3° at Nacka). Meridian clusters also gate
  auto-apply.
- `withGrivationCorrection` in `map-projection.ts` adds the correction
  to grivation and reimplements `toProjectedCoord`.
- `parseOcadMapMetadata` / `resolveMapNorth` and `loadMapSource` all
  apply the wrapper, so bounds, `northOffset`, calibration, and tile
  warps stay consistent.
- **Display vs georeference:** the correction only fixes the
  georeference (GPS overlays). On-screen uprightness comes from
  `northOffset`, which `metadataFromOcad` computes as the bearing of
  the *display-up* direction — the meridian-line direction when the
  file has one, else paper +Y. The viewer rotates by `-northOffset`,
  so meridian lines render vertical regardless of the correction
  value. (Changing the correction alone can never straighten the map:
  it rotates the tiles and `northOffset` by the same amount, which
  cancels on screen.)
- Admin UI: single input on **Settings → Maps** (`clubMap.setRotation`).
  `course.useClubMap` copies the library correction into the event.
  `course.setMapRotation` remains for ops/API. See
  `docs/bugfix-map-north-correction.md`.

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
- `packages/api/src/__tests__/map-north.test.ts` — declination /
  convergence formula and meridian clustering.
- `packages/web/src/lib/__tests__/tile-retry.test.ts` — backoff,
  Retry-After, concurrency cap, abort.
- `packages/api/src/__tests__/integration/map-tiles.test.ts` — the
  routes end to end against `e2e/test.ocd`: render, cache hit, whole
  block cached, deep zoom on demand, progress from the database, and
  the progress poll advancing the pre-cache with no tile request to
  trigger the background loop.
- `packages/api/src/__tests__/integration/map-rotation.test.ts` —
  `setMapRotation` re-derives metadata and drops tiles.
