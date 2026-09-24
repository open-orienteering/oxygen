# Bugfix: map tiles timing out on Cloud Run after the colour-stack release

**Date:** 2026-09-24
**Affected:** `oxygen` Cloud Run revision `oxygen-00036-vwj` (image `:edge`,
commit `7e6f0f9`, [PR #26](https://github.com/open-orienteering/oxygen/pull/26))
**Symptom:** `/api/map-tile/...` requests dying at 299.99 s with HTTP 504;
tRPC calls on the same instance 504-ing too; Cloud SQL connector
handshake failures.

## What happened

The colour-stack release changed the tile format (`TILE_FORMAT = 2`) and
folded it into the render key, so every tile already in `map_tiles` was
orphaned on deploy and the first view of each map was a fully cold
render. That part was expected. What wasn't: the first viewport on the
`Testkarta` map produced 23 tiles at 36–40 s each and 71 requests that
Cloud Run killed at its 300 s cap, and a second look 40 minutes later
did the same. For comparison the *previous* revision had cold-rendered
the same map that morning — p50 4.9 s, max 14.6 s, zero timeouts.

```
UTC 15:55  revision 00036 goes live
UTC 15:56  23 × 200 (36–40 s)   71 × 504 (299.99 s)
UTC 16:01  55 × 504
UTC 16:36  23 × 200             90 × 504, 3 × 500
UTC 16:38  "Cloud SQL connection failed", Prisma "Connection terminated
           unexpectedly" on user.findUnique — connection budget gone
```

CPU never went above ~40 %. The instance was not busy; it was waiting.

## Root cause 1 — the OCAD blob was read on every tile request

`ensureEventMapRenderKey()` resolves an event's colour-stack settings and
render key. Its `select` included `fileData` unconditionally so it could
compute `file_hash` if missing — but the hash is missing only once per
upload, and the select ran every time.

On the tile route the helper was called **three times per cache miss**:
in the handler, again inside `getMapSource`, and again inside
`maybePreCache` (whose de-duplication flag was set *after* an `await`,
so a burst of 20 tile requests all passed it). Cache hits called it once
or twice. `Testkarta` is 9.8 MB, so one uncached viewport moved roughly
2 GB through a `db-f1-micro` Cloud SQL instance over a pool capped at
eight connections. Every other query on the instance — including the
`user.findUnique` behind every authenticated request — queued behind
those blob transfers. Locally the blob comes off loopback in ~250 ms,
which is why nothing looked wrong in development.

## Root cause 2 — two sequential rasters, parse-dominated

Each block now rasterises a composite layer and an ink layer. They ran
one after the other, each taking its own semaphore permit. Measured
locally on the same map: composite 6.2 s (5.7 s of which is resvg
*parsing* the 16.7 MB SVG — an 8-pixel-wide render costs the same), ink
2.1 s. So ~8.5 s per block against ~6.2 s before, and on Cloud Run's
2 vCPUs with three permits, considerably more.

## Why it queued to 300 s

Cloud Run admits 160 concurrent requests per instance and holds each for
up to 300 s. The render semaphore allows 3. Nothing between the two said
"no": every tile request that could not get a permit simply waited, and
the blob traffic from root cause 1 made every step in front of the
permit slow as well. Requests piled up until the platform killed them,
and since they were still holding connections and admission slots while
they waited, tRPC starved too.

## The fix

1. **Metadata-only reads** (`map-render-cache.ts`). `ensure*RenderKey`
   and `refresh*RenderKey` select the stack columns only; `file_data` is
   fetched by a second query solely when `file_hash` is null. A cache
   hit no longer touches the blob at all.
2. **One resolution per request** (`map-tiles.ts`). The handler resolves
   `MapMeta` once and passes it to `getMapSource`, `renderBlock`,
   `preCacheChunk` and `maybePreCache`. The `preCacheConsidered`
   check-and-mark now happens before the first `await`.
3. **Bounded queue → fast 503** (`map-render-limits.ts`, `map-tiles.ts`).
   `Semaphore.run` takes `maxQueue`; a foreground block that finds
   `MAP_RENDER_MAX_QUEUE` (default 4) waiters already in line throws
   `RenderBusyError`, which the route turns into
   `503 Retry-After: 5, Cache-Control: no-store`. `TileLayer` already
   honours `Retry-After`, so tiles fill in progressively instead of the
   request sitting in Cloud Run's admission queue. Background pre-cache
   work is never refused.
4. **Parallel rasters under one permit.** Composite and ink render side
   by side, so a block costs roughly the slower of the two (~3.6 s
   locally, was ~8.5 s). Memory per permit doubles; the doc's sizing
   formula is updated.

Adjacent hot paths found in the same sweep:

- `course.mapFileInfo` selected `fileData` to report `.length` — every
  page load downloaded the map. Now `octet_length(file_data)` in SQL.
- `course.mapMetadata` re-read and re-parsed the OCAD on every call to
  work out what an `auto` profile resolved to. The answer is a function
  of the render key; it is now memoised per key (`map-profile-cache.ts`).

## Before / after (local, same 9.8 MB map, zoom 16)

| | Before | After |
|---|---|---|
| Cache hit | ~250 ms + 9.8 MB from DB | 7–9 ms, no blob |
| Cold block | ~8.5 s (sequential rasters) | ~3.6 s |
| First block ever on an instance | ~16 s (estimated from the step timings) | ~13.5 s (OCAD parse + 2 × `ocadToSvg` dominate) |
| 20-tile burst over 5 uncached blocks | unbounded wait | 10.8 s, all 200 (queue depth ≤ 4) |
| Surplus requests when the queue is full | wait for 300 s → 504 | immediate 503, retried after 5 s |

## Tests

- `map-render-cache.test.ts` — the helpers never select `fileData` when
  a hash is stored; exactly one blob read when it is not.
- `map-render-limits.test.ts` — `maxQueue` semantics: refuses foreground
  beyond the bound, never refuses background, unbounded when unset.
- `integration/map-tiles.test.ts` — four concurrent uncached blocks with
  `MAP_RENDER_MAX_QUEUE=0`: permits' worth of 200s, the rest 503 with the
  right headers, and the refused tile renders on retry.
- `integration/course-maps.test.ts` — `mapFileInfo.size` equals the
  fixture's byte length; `mapMetadata` resolves the same profile across
  calls.

## Operational notes

- A render-key change is a full cache invalidation. Deploy it off-peak
  or pre-warm; since tiles are content-addressed, rows rendered on any
  machine for the same key are valid in production. See "Deploying a
  render-key change" in [map-tile-rendering.md](map-tile-rendering.md).
- If tiles 503 continuously rather than briefly, the renderer is
  genuinely under-provisioned for the load — raise
  `MAP_RENDER_CONCURRENCY` (CPU permitting) or `MAP_TILE_BLOCK_TILES`
  (memory permitting), not `MAP_RENDER_MAX_QUEUE`.
- The 504s on unrelated tRPC calls during the incident were starvation,
  not bugs in those routes; the same pattern appears in
  [bugfix-cloud-sql-handshake-eof.md](bugfix-cloud-sql-handshake-eof.md).
