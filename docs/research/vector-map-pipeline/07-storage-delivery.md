# 07 — Storage and delivery

Status: proposed 2026-10-07 (recommendation §13); awaiting decision.
Depends on: [01](01-tiling-vs-whole-document.md) (whole-document delivery,
budgets, offline is one file), [02](02-document-format.md) (content hash
as identity, `map_documents`, source retained), [05](05-print-pdf.md)
(print profiles and uploaded ICC profiles need a home),
[06](06-import-pipeline.md) (sources, documents, jobs, uploads, club map
versions, symbol decisions — the rows this topic gives tables to).
Feeds: 08 (course-layer and patch-layer rows reference
`(documentHash, objectIndex)`), 09 (migration of `map_files`,
`club_map_files`, `map_tiles`, `rendered_maps`; backup format).

## The question

Where do the bytes live, how are they keyed, when are they deleted, how do
they reach the browser, and what still works when the browser or the venue
box has no internet? Specifically:

1. **Store** — Postgres `bytea`, object storage, filesystem, or a mix — for
   sources (`.ocd` / `.omap`), documents (02 binary), previews, ICC
   profiles and graphics; across the three deployment shapes Oxygen has.
2. **Schema** — the tables behind 06's sources, documents, uploads, jobs,
   club map series/versions, symbol decisions, and 05's print profiles;
   which event-scoped tables reference them.
3. **Immutability and garbage collection** — documents are content
   addressed and never updated; what decides when one may be deleted.
4. **Delivery** — routes, headers, auth, compression, range requests,
   platform body limits.
5. **Offline** — the PWA on a phone in the forest, and the venue box with a
   leased-out event.
6. **Backups** — what the per-event dump and the database backups carry.

Out of scope: the document format itself (02), what the importer does (06),
how the viewer loads and buckets a document (01 §6, 04 §6), the migration
order (09).

## 1. Requirements, by consumer

| Consumer | Needs from storage and delivery |
|----------|------------------------------|
| GL viewer (01, 04) | One immutable document per event map, fetched once per device, cached forever by hash; ≤ 1 MB event maps, ≤ 8 MB Club-full (01 budgets); optional byte ranges later (01 Option C) |
| Print (05) | Server reads the document and the print profile (incl. ICC bytes) in one place; graphics as rasterised PNG; later the same in the browser |
| Import (06) | Source bytes by `fileHash`; source-document cache by `(fileHash, importerVersion)`; final documents by content hash; job state visible to any API instance; previews next to documents |
| Club library (06 §6) | Series + versions; events pin a version; a version's source and document shared, not copied, across events; club symbol decisions and print profiles are club-level |
| Course editor (08) | Stable `(documentHash, objectIndex)` references; the document an event points at never changes under its feet |
| Kiosk / stations at a venue (`offline-architecture.md`) | The post-readout map (`MapPanel`, `CardMapPreview`) and the course view must render with zero internet when the venue node holds the lease |
| Backups (`backup-restore.md`) | Per-event dump restores the map; club-library sources stay instance-admin gated (`club-library.md`) |
| Deployments | Cloud Run + Cloud SQL (IAP, 2 instances, request-based CPU in idle mode), self-host docker-compose, venue box — one code path for all three |
| Operators | Delete an event or a club map version and be sure the bytes go too — eventually and safely |

## 2. Current state, and what to keep

**Measured in the development database (2026-10-07):**

| Table | Rows | Blob bytes | Relation size |
|-------|------|-----------|---------------|
| `map_files.file_data` | 6 (5 distinct hashes) | 22 MB | 39 MB |
| `club_map_files.file_data` | 3 | 48 MB | 32 MB (TOAST-compressed) |
| `club_map_files.preview_png` | 3 | 1.1 MB | — |
| `map_tiles.tile_data` | 5 609 | 208 MB | 219 MB |
| `rendered_maps` | 0 | — | — |
| `graphics.data` | 2 | 115 kB | — |
| whole database | | | 361 MB |

Tiles are 60 % of the database and are a cache. Sources are 70 MB, of
which one event copy duplicates a club map byte for byte
(`course.useClubMap` copies `fileData` into `map_files`; one `map_files`
row shares its `file_hash` with a `club_map_files` row).

**What exists and where it stands:**

- **Everything is in Postgres.** `bytea` columns in `map_files`,
  `club_map_files`, `map_tiles`, `rendered_maps`, `graphics`,
  `club_directory` logos, `card_readout_backups.raw_bytes`. All three
  deployment shapes share only this one store: Cloud SQL in the cloud,
  the compose Postgres for self-hosters, `venue-pg-data` on the box.
  There is no object store, no shared filesystem, and the venue box never
  will have either.
- **Copy-on-use** gives events an independent copy of a club map
  (`club-library.md`). The *intent* — later library changes do not alter
  events — is right; the *mechanism* (duplicating 36 MB) is what 06 §6
  replaces with version pinning.
- **Blob access rules** exist and must survive: `from_club_library` gates
  `course.downloadMap` and `/api/backup/event` (instance admin for club
  sources); `clubMap.download` is uploader-or-admin; `/api/map-tile/*`
  accepts `courses.view` or the kiosk key (`authentication.md`).
- **Tile delivery** sets `Cache-Control: public, max-age=604800` and a
  `?v=` cache-buster; the service worker caches `/api/map-tile/`
  CacheFirst with 2 000 entries and `purgeOnQuotaError`
  (`packages/web/vite.config.ts`). tRPC responses are NetworkFirst, same
  origin only (venue responses are never cached — the single-writer rule).
- **Checkout snapshot** (`sync/lease.ts` `SNAPSHOT_TABLES`) carries
  controls, courses, classes, runners, cards, punches, readouts, units —
  explicitly *not* map or tile blobs: "server-local caches, re-creatable,
  and not part of the results closure". With tiles that was the only
  option (thousands of rows, hundreds of MB). `offline-architecture.md`
  lists "map tiles, 50 MB uploads" as cloud-owned endpoints that are
  "simply unavailable at an offline venue".
- **Per-event backup** (`backup.ts`) emits `\copy` of event-scoped tables
  including `map_files`, omits `map_tiles`
  (`map-tile-rendering.md`), and gates on `from_club_library`.
- **Platform limits.** Fastify `bodyLimit` is 50 MB and uploads are
  base64 in tRPC JSON (06 §8). Cloud Run adds a limit the current code
  does not account for: **32 MiB per HTTP/1 request, and 32 MiB per
  response unless it is streamed / chunked** (Cloud Run quotas;
  requests are downgraded to HTTP/1 inside the container unless h2c is
  configured). Club-full (35.9 MB) therefore cannot be uploaded *or
  downloaded* through the cloud deployment today regardless of
  `bodyLimit`; the 9.3 MB and 4 MB maps work.
- **Serverless CPU.** In idle mode Cloud Run allocates CPU only while a
  request is in flight; the tile pre-cache learned to make "the progress
  poll the engine" (`map-tile-rendering.md`). Two instances may serve
  alternate requests, so job state in process memory is not visible to
  the next poll. Background singletons elect through
  `oxygen.instance_lease` (`background-jobs-lease.md`).
- **Browser storage.** The PWA manifest is `display: standalone`; the
  web app uses Dexie (`lib/offline/db.ts`) for the outbox and read
  projections, and Cache Storage via Workbox for assets and tiles.

Keep: Postgres as the only store; the access rules; the kiosk-key read
path; NetworkFirst/CacheFirst split in the service worker; the checkout
snapshot mechanism; the `\copy` backup format. Change: the blob tables,
copy-on-use, the upload and download transports, the job model, what the
snapshot carries.

## 3. Where the bytes live

### 3.1 What has to be stored

| Blob | Size (corpus) | Mutability | Lifetime |
|------|---------------|-----------|----------|
| Source file (`.ocd`, `.omap`) | 2–36 MB | immutable (keyed by SHA-256) | as long as any version or event references it; club property |
| Document (02 binary) | 0.17–3.5 MB | immutable (content hash) | while referenced + grace; re-derivable from source + importer + decisions |
| Source document (06 §4.2 cache) | ≈ document | immutable, keyed `(fileHash, importerVersion)` | pure cache; drop any time |
| Previews / thumbnails / symbol PNGs | 10–400 kB each | derived from document | pure cache |
| ICC output-intent profiles (05) | 0.5–3 MB | immutable upload | club property, referenced by print profiles |
| Graphics (SVG/PNG) + 600 dpi raster (05) | kB–few MB | upload immutable; raster derived | as today |
| Upload staging (06 §8) | up to 128 MB per upload | temporary | minutes |

Projection for a club: 20 club map versions × (36 MB source + 3.5 MB
document) ≈ 0.8 GB worst case with every version Club-full-sized; realistic
(mostly crops and seasonal extents) 100–300 MB. Fifty events × 0.3 MB
documents ≈ 15 MB. Previews ≈ 10 MB. Removing `map_tiles` alone frees
more than this whole projection consumes.

### 3.2 Options

| Option | Description | For | Against |
|--------|-------------|-----|---------|
| **A. Postgres `bytea`, content-addressed tables** | One row per blob keyed by hash; `STORAGE EXTERNAL` on the blob columns | Already the only store all three deployments have; transactional with the rows that reference it (import commits document + references atomically); `pg_dump` backups and the per-event `\copy` dump cover it; `ON DELETE` semantics do the reference counting; uncompressed out-of-line TOAST makes `substring(bytes from … for …)` fetch only the chunks covering a byte range, so HTTP `Range` is O(range) not O(file) | Bytes travel DB → API → client (one extra hop vs. a CDN); Cloud SQL storage is the priciest GB in the stack ($0.17/GB-month SSD — ~$0.05 for the projection above); a 36 MB `bytea` is read into one `Buffer` by Prisma, fine at these sizes, not a streaming API |
| **B. Object storage (GCS / S3 / MinIO)** | Blobs by hash in a bucket; DB holds metadata | Cheap GB; signed URLs could bypass the API for downloads; CDN-friendly | A second store that must be deployed, credentialed, backed up and kept consistent with the DB in every shape — the venue box would need MinIO or a filesystem fallback; signed URLs break the IAP-only topology (`deploy-gcp-cloud-run.md` rejected the LB + CDN route on cost); loses transactional import; sizes are far below where object storage earns its keep |
| **C. Filesystem volume** | Blobs under a data directory | Simple locally | No shared disk on Cloud Run (two instances), ephemeral container FS; a second backup path; nothing A does not do better here |
| **D. A then B behind an interface** | Ship A; keep a small `BlobStore` seam so B can be added for a large multi-club deployment | Keeps A's simplicity now, leaves the door open | Interfaces cost little only if they stay thin |

**Choice: A, with D's seam.** The seam is a module, not a plugin system:
`getBlob(table, hash, range?)`, `putBlob(table, hash, bytes, meta)`,
`deleteBlob(table, hash)` over the three content-addressed tables, used by
the routes and the import job. If a deployment ever outgrows Postgres,
the same hash keys name objects in a bucket and the tables keep the
metadata.

Postgres specifics:

- `ALTER TABLE … ALTER COLUMN bytes SET STORAGE EXTERNAL` on sources,
  documents and ICC profiles. Documents are delta-varint and gain ~30 %
  from gzip (02 §4) — TOAST's pglz would spend CPU for a similar gain and
  disable sliced reads; keep them uncompressed at rest and compress on the
  wire (§6). Sources (OCAD) compress well, but 10–30 % of 70 MB is not
  worth losing range reads and `pg_dump` speed; `EXTERNAL` too.
- Reads of a whole blob go through Prisma `Bytes`; range reads use one
  raw query `SELECT substring(bytes FROM $1 FOR $2) …`. `octet_length`
  is stored in `size_bytes` so `Content-Length`/`Content-Range` never
  touch the blob.
- No large objects (`pg_largeobject`): a second API, excluded from
  `\copy` dumps, no gain at these sizes.

## 4. Schema

### 4.1 Content-addressed blobs

```sql
-- Original uploaded file; club property. Shared by every version/event
-- that imported the same bytes (today's copy-on-use duplicate goes away).
CREATE TABLE oxygen.map_sources (
  file_hash     TEXT PRIMARY KEY,                 -- sha256 hex of bytes
  kind          TEXT NOT NULL,                    -- 'ocad' | 'omap'
  bytes         BYTEA NOT NULL,                   -- STORAGE EXTERNAL
  size_bytes    INT  NOT NULL,
  file_name     TEXT NOT NULL,                    -- first upload's name, informational
  uploaded_by   UUID REFERENCES oxygen.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Imported document (02). Immutable; the hash is the identity the viewer,
-- print and course layers use.
CREATE TABLE oxygen.map_documents (
  hash              TEXT PRIMARY KEY,             -- sha256 hex of bytes
  bytes             BYTEA NOT NULL,               -- STORAGE EXTERNAL
  size_bytes        INT  NOT NULL,
  format_version    INT  NOT NULL,                -- 02 header format.version
  importer_version  TEXT NOT NULL,                -- 06 §4.3
  library_version   TEXT NOT NULL,                -- 03 canonical library
  source_hash       TEXT NOT NULL REFERENCES oxygen.map_sources(file_hash) ON DELETE RESTRICT,
  header            JSONB NOT NULL,               -- 02 JSON header minus symbol table: scale, bounds,
                                                  -- georeferencing, colour summary — the quick-access
                                                  -- metadata map_files.scale/bounds/calibration hold today
  report            JSONB NOT NULL,               -- 06 §4.4 ImportReport
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_referenced_at TIMESTAMPTZ NOT NULL DEFAULT now()   -- bumped when a reference is created; GC input
);
CREATE INDEX ON oxygen.map_documents (source_hash);

-- Derived rasters: thumbnails, symbol previews (06 §5.2). Pure cache.
CREATE TABLE oxygen.map_previews (
  document_hash TEXT NOT NULL REFERENCES oxygen.map_documents(hash) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                    -- 'thumbnail' | 'symbol'
  key           TEXT NOT NULL DEFAULT '',         -- symbol index for 'symbol'
  png           BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_hash, kind, key)
);

-- 06 §4.2 source-document cache. Optional table: stages 3–5 for Club-full
-- take seconds, so caching is worth a row; drop freely.
CREATE TABLE oxygen.map_source_documents (
  file_hash        TEXT NOT NULL REFERENCES oxygen.map_sources(file_hash) ON DELETE CASCADE,
  importer_version TEXT NOT NULL,
  bytes            BYTEA NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (file_hash, importer_version)
);
```

Library symbol previews (`GET /api/library/:libraryId/:code.png`) are
rendered from the bundled library and cached in memory or on disk per
instance — not stored; they are a function of the library version alone.

### 4.2 References: who points at a document

```sql
-- Club map series: settings about the map, not the file (06 §6).
CREATE TABLE oxygen.club_maps (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  name                TEXT NOT NULL,
  colour_profile      TEXT NOT NULL DEFAULT 'auto',    -- today's color_profile
  colour_overrides    JSONB NOT NULL DEFAULT '{}',
  north_lines_below   BOOLEAN NOT NULL DEFAULT true,
  rotation_correction DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_by          UUID REFERENCES oxygen.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oxygen.club_map_versions (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  club_map_id    UUID NOT NULL REFERENCES oxygen.club_maps(id) ON DELETE CASCADE,
  seq            INT  NOT NULL,                               -- 1, 2, 3 … within the series
  label          TEXT NOT NULL DEFAULT '',                    -- "2026 spring", free text
  source_hash    TEXT NOT NULL REFERENCES oxygen.map_sources(file_hash) ON DELETE RESTRICT,
  document_hash  TEXT NOT NULL REFERENCES oxygen.map_documents(hash) ON DELETE RESTRICT,
  uploaded_by    UUID REFERENCES oxygen.users(id) ON DELETE SET NULL,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (club_map_id, seq)
);

-- Event map: one row per event (today's map_files, without file_data).
ALTER TABLE oxygen.map_files
  DROP COLUMN file_data,
  ADD COLUMN source_hash          TEXT REFERENCES oxygen.map_sources(file_hash) ON DELETE RESTRICT,
  ADD COLUMN document_hash        TEXT REFERENCES oxygen.map_documents(hash)   ON DELETE RESTRICT,
  ADD COLUMN club_map_version_id  UUID REFERENCES oxygen.club_map_versions(id) ON DELETE SET NULL;
-- scale, bounds, north_offset, calibration, north_detection: kept, now
-- copied from map_documents.header at import. color_profile,
-- color_overrides, north_lines_below, rotation_correction: kept as the
-- event's *view* overrides (01 §10, 02 §4), initialised from the club map
-- series when a version is adopted. from_club_library becomes
-- `club_map_version_id IS NOT NULL` (kept as a column for one release
-- for the auth rules, then dropped — 09).
```

`ON DELETE RESTRICT` from every reference to a document and a source is
deliberate: deleting an event cascades `map_files` (as today), and only the
GC job (§5) deletes blobs — after the references are gone, never through a
cascade that could race an import. `club_map_version_id … SET NULL`
preserves the copy-on-use intent: deleting a library version leaves the
event on the exact document it pinned, now merely "not from the library".

08's course layer and patch rows reference `(document_hash, object_index)`
with the same `RESTRICT` FK to `map_documents(hash)`; 08 defines the
tables.

### 4.3 Club-level settings from 05 and 06

```sql
CREATE TABLE oxygen.club_symbol_decisions (          -- 06 §5.3, verbatim
  fingerprint     TEXT NOT NULL,
  library_version TEXT NOT NULL,
  canonical_id    TEXT,                                -- NULL = explicitly unmatched
  decided_by      UUID REFERENCES oxygen.users(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fingerprint, library_version)
);

CREATE TABLE oxygen.club_print_profiles (            -- 05 §6 PrintProfile
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  name              TEXT NOT NULL UNIQUE,
  mode              TEXT NOT NULL DEFAULT 'cmyk',     -- 'cmyk' | 'cmyk-offset' | 'rgb'
  colour_overrides  JSONB NOT NULL DEFAULT '{}',      -- by colour-stack id → CMYK
  min_line_width_um INT,
  overprint         BOOLEAN NOT NULL DEFAULT false,
  spot_colours      JSONB NOT NULL DEFAULT '{}',
  bleed_mm          DOUBLE PRECISION NOT NULL DEFAULT 0,
  crop_marks        BOOLEAN NOT NULL DEFAULT false,
  icc_profile       BYTEA,                            -- uploaded output intent (STORAGE EXTERNAL)
  icc_description   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- map_templates / course_maps gain print_profile_id UUID REFERENCES … ON DELETE SET NULL (05, 08).

ALTER TABLE oxygen.graphics ADD COLUMN raster_png BYTEA;   -- 05 §7: SVG rasterised at 600 dpi on upload
```

The ICC profile lives on the profile row rather than in `graphics`
(05 §6 said "graphics-like store"): it is not placeable on a page, has one
owner, and a 3 MB column on a handful of rows needs no indirection.

### 4.4 Uploads and jobs

```sql
-- Chunked upload staging (§7). One row per chunk so two API instances
-- can receive alternate chunks; assembled and hashed on finalise.
CREATE TABLE oxygen.map_uploads (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id       BIGINT REFERENCES oxygen.events(id) ON DELETE CASCADE,   -- NULL for club-library uploads
  file_name      TEXT NOT NULL,
  declared_bytes INT  NOT NULL,
  chunk_bytes    INT  NOT NULL,
  uploaded_by    UUID REFERENCES oxygen.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalised_hash TEXT                                   -- set when assembled into map_sources
);
CREATE TABLE oxygen.map_upload_chunks (
  upload_id  UUID NOT NULL REFERENCES oxygen.map_uploads(id) ON DELETE CASCADE,
  n          INT  NOT NULL,
  bytes      BYTEA NOT NULL,
  PRIMARY KEY (upload_id, n)
);

-- Import job (06 §4.1). State in the DB so any instance can report or
-- resume it (§8).
CREATE TABLE oxygen.map_import_jobs (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id       BIGINT REFERENCES oxygen.events(id) ON DELETE CASCADE,
  club_map_id    UUID REFERENCES oxygen.club_maps(id) ON DELETE CASCADE,
  source_hash    TEXT NOT NULL REFERENCES oxygen.map_sources(file_hash) ON DELETE CASCADE,
  decisions      JSONB NOT NULL DEFAULT '[]',          -- review-round input (06 §5.1)
  state          TEXT NOT NULL,                        -- 'queued' | 'running' | 'review' | 'done' | 'failed'
  stage          TEXT,                                 -- 06 §4.1 stage name
  progress       REAL NOT NULL DEFAULT 0,
  claimed_by     TEXT,                                 -- NODE_ID / instance id
  heartbeat_at   TIMESTAMPTZ,
  document_hash  TEXT REFERENCES oxygen.map_documents(hash) ON DELETE SET NULL,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Both are housekeeping tables: uploads older than 24 h without
`finalised_hash` and jobs older than 7 days are deleted by the GC job.

### 4.5 The shape, in one picture

```
 club_maps ──< club_map_versions ──┬──> map_sources ──< map_source_documents (cache)
   │ settings                      │        ▲
   │                               └──> map_documents ──< map_previews (cache)
   │                                        ▲   ▲
 events ──< map_files ─── view overrides ───┘   │ (08) course layers, patch rows,
             │ pins (source, document, version)  │       layout objects by (hash, objectIndex)
             └── club_map_version_id (nullable)

 club_symbol_decisions   club_print_profiles (+ icc)   graphics (+ raster_png)
 map_uploads ──< map_upload_chunks          map_import_jobs
```

## 5. Immutability and garbage collection

- **Documents and sources are never updated.** A new import, re-match or
  review round writes a new `map_documents` row and repoints the
  reference. Rows reachable from the UI are therefore stable for the
  lifetime of any `(hash, objectIndex)` someone holds — the property 02 §7
  and 08 rely on.
- **Reference counting is the FK graph.** A document is referenced by
  `map_files`, `club_map_versions`, 08's tables and `map_import_jobs`.
  `RESTRICT` means a `DELETE` of a still-referenced blob fails loudly, so
  GC cannot be wrong, only late.
- **GC job** (`background-jobs-lease.md` singleton, daily, also runnable
  from Settings → Maintenance): delete `map_documents` rows with no
  referencing row whose `last_referenced_at` is older than the grace
  period (30 days); then `map_sources` rows referenced by no document, no
  version, no `map_files` and no job; then expired uploads and jobs.
  Each pass is one `DELETE … WHERE NOT EXISTS (…)` per referencing table,
  with `RESTRICT` as the belt to the braces.
- **Grace period** covers: an import that produced a document the user
  has not yet attached (review in progress — the job row references it
  anyway), soft-deleted events awaiting `competition.purgeDeleted`
  (their `map_files` rows still exist, so no grace is even needed), and
  "I replaced the map by mistake" (the previous hash is in the event log
  and can be re-attached for 30 days).
- **Caches** (`map_previews`, `map_source_documents`) cascade with their
  parent and may additionally be truncated by the GC when older than the
  grace period; they regenerate on demand.
- **Audit**: every repoint of `map_files.document_hash` and every GC
  deletion writes an `event_log` / server log line with the hashes; the
  per-event dump (§10) is the recovery path if a deletion was wrong.

## 6. Delivery

### 6.1 Routes

| Route | Body | Cache headers | Auth |
|-------|------|---------------|------|
| `GET /api/map-documents/:hash` | document bytes, `application/vnd.oxygen.map` | `Cache-Control: private, max-age=31536000, immutable`, `ETag: "<hash>"`, `Accept-Ranges: bytes` | §6.2 |
| `GET /api/map-documents/:hash/thumbnail.png`, `…/symbols/:idx.png` | PNG | same | same |
| `GET /api/map-sources/:hash` | original file, `Content-Disposition: attachment` | `private, no-store` | event manager for an event's own upload; instance admin or uploader for club sources (today's rules, now by `club_map_version_id` / `uploaded_by`) |
| `GET /api/library/:libraryId/:code.png` | PNG | `public, max-age=31536000, immutable` (library versioned in the path) | any signed-in user |
| `GET /api/print-profiles/:id/icc` | ICC | `private, no-store` | event manager / club member |

`private` rather than `public`: the deployments sit behind IAP or app
auth with no shared HTTP cache in between, and `private` keeps a
misconfigured proxy from ever serving one club's map to another. Cache
Storage in the browser ignores the directive anyway (Workbox decides);
`immutable` is for the HTTP cache and for `ETag` revalidation that never
needs to happen.

### 6.2 Authorisation of a hash URL

The hash is 256 bits and not enumerable (unlike `/api/map-tile/<slug>/z/x/y`,
which `deploy-gcp-cloud-run.md` flags as the obstacle to a CDN), but
unguessability is not authorisation. The route accepts a request when
either:

- the caller has `courses.view` on an event whose `map_files.document_hash`
  is this hash (header `x-event-id`, as today), or
- the caller presents that event's kiosk key (`?k=` / `x-kiosk-key`), or
- the caller is a signed-in user and the hash belongs to a
  `club_map_versions` row (library browsing), or
- the hash is referenced by a running import job the caller started
  (review previews).

One SQL `EXISTS` over the four reference tables; the result is cached per
`(hash, principal)` for a minute in memory. Because the URL does not
contain the event, the same document under two events is one Cache
Storage entry on the client.

### 6.3 Transport compression

Documents gain ~30 % from gzip (02 §4). The compose stacks have nginx in
front, but it only gzips text types and is absent on Cloud Run (single
container, `WEB_DIST_DIR` static serving). Add `@fastify/compress` scoped
to the document route (brotli quality 5 / gzip 6, `application/vnd.oxygen.map`
added to the type list) and *disabled when a `Range` header is present* —
`Content-Encoding` and `Content-Range` do not compose. Cost at these sizes
is tens of milliseconds per request; a precompressed `bytes_gz` column is
the fallback if it ever shows on a profile.

### 6.4 Streaming and the 32 MiB response ceiling

Sources (up to 36 MB today, 128 MB limit) exceed Cloud Run's non-streamed
response ceiling. `GET /api/map-sources/:hash` therefore streams:
`reply.send(Readable)` without `Content-Length` yields chunked transfer,
and the readable pulls 4 MB slices with `substring(bytes FROM … FOR …)` so
the API never holds the whole file. Documents (≤ 8 MB budget) are sent
whole with `Content-Length`; if Club-full-class club maps ever exceed the
ceiling they go through the same streaming path.

### 6.5 Range requests

Supported from day one on `/api/map-documents/:hash` (`206`,
`Content-Range`, single range only, served by `substring`). Nothing uses
them in phase 1; 01 Option C and a "header first, geometry when the
viewport needs it" loader need nothing else from the server later. The
service worker must bypass its CacheFirst handler for ranged requests
(Workbox `RangeRequestsPlugin` can serve ranges *from* a cached full
response, which is the right behaviour once the full document is cached).

## 7. Upload transport

06 §8 proposed `POST /api/map-upload` streaming to a temp file with a
128 MB limit. Two facts from §2 change the mechanism, not the contract:
Cloud Run rejects HTTP/1 requests above 32 MiB, and two instances do not
share a temp directory.

- **Chunked upload to the database.** `POST /api/map-uploads`
  `{ fileName, bytes, chunkBytes: 8 MiB }` → `{ uploadId }`;
  `PUT /api/map-uploads/:id/chunks/:n` (raw `application/octet-stream`,
  `bodyLimit` 8 MiB + slack) stores a `map_upload_chunks` row — any
  instance, any order, idempotent per `n`;
  `POST /api/map-uploads/:id/finalise` checks the chunk set is complete,
  streams them in order through SHA-256 into one `map_sources` row (or
  finds the hash already there — dedup), deletes the chunks, returns
  `{ fileHash, bytes, deduplicated }`. `mapImport.start` takes `fileHash`.
- **Client**: `File.slice()` per chunk, four in flight, retry per chunk,
  byte progress for free. Small files (< 8 MiB, i.e. every event map in
  the corpus) are one chunk and one finalise — three requests instead of
  one, which is acceptable for an operation that happens once per event.
- **Why not tus / resumable protocols**: three routes and a table do what
  tus does for this one file type; resumability across page reloads falls
  out of `uploadId` in `sessionStorage` if ever wanted.
- **Why not end-to-end HTTP/2 on Cloud Run** (which lifts the request
  limit): it changes the container's listener to h2c for every route to
  solve one upload path, and the self-host and venue stacks would still
  take the chunked route through nginx; one mechanism everywhere is
  simpler.
- **Validation**: `declared_bytes ≤ 128 MB`, chunk count matches, kind
  sniffed from the first chunk (OCAD magic `0xCAD` / OMAP XML prolog)
  before accepting the rest.
- The tRPC `course.uploadMap(fileDataBase64)` and `clubMap.upload`
  survive one release for E2E fixtures (`e2e/test.ocd` is small), then go
  (09).

## 8. Running the import job on serverless and on two instances

06 §4.5 tracked jobs "in memory with a status endpoint". With Cloud Run's
request-scoped CPU and `--max-instances=2` that is not enough:

- **Job rows, not job objects** (`map_import_jobs`, §4.4). `start`
  inserts the row and *also* begins executing it in the current request's
  worker thread, writing stage/progress to the row every stage boundary
  and a heartbeat every 10 s.
- **The poll is the engine, again.** `status` returns the row. If the row
  is `running` with a heartbeat older than 60 s (the instance that
  claimed it was throttled or recycled), the polling instance claims it
  (`UPDATE … WHERE heartbeat_at < now() − 60 s RETURNING`) and re-runs
  from the start — stages 3–8 are deterministic (06 §9), so a re-run
  produces the same hashes and partial writes are idempotent `INSERT …
  ON CONFLICT DO NOTHING` on content-addressed rows.
- **Hold `start` open** for up to 30 s before returning the job id, so
  the common case (an event map imports in 1–3 s) completes inside one
  request with no polling at all; Club-full continues under the poll.
- **One worker per instance**; a second concurrent `start` queues (row
  state `queued`) and is picked up by the next poll or the next free
  worker. Club-scale concurrency is one upload at a time.
- **Venue box**: same code, no throttling; the job just runs.

## 9. Offline

### 9.1 The PWA on a device

What must work with no network after a map has been seen once: the
viewer (course view, kiosk map, GPS position on the mobile map), and —
later — browser-side PDF (05 §9 "browser/offline later").

- **Service worker**: a CacheFirst route for `/api/map-documents/`
  (`maxEntries: 20`, `maxAgeSeconds: 365 d`, `purgeOnQuotaError: true`,
  `cacheableResponse: { statuses: [200] }`), replacing the `map-tiles`
  route. Twenty documents at ≤ 8 MB is 160 MB worst case; realistic
  usage is a few MB. Thumbnails share the route. Ranged requests bypass
  the cache (§6.5) or are served from the cached full response with
  `RangeRequestsPlugin`.
- **No IndexedDB copy of the document.** Cache Storage already holds the
  bytes; the decoded typed arrays live in the viewer's worker for the
  session (01 §10 found a persisted tessellation cache unnecessary).
  Dexie stays what it is: outbox and read projections.
- **Pinning**: when an operator opens an event's map on a device, the
  app calls `navigator.storage.persist()` once. Chromium grants it
  silently for installed or engaged origins and then exempts the origin
  from storage-pressure eviction; Safari decides on its own criteria. The
  existing "offline ready" indicator can show `navigator.storage.persisted()`.
- **iOS**: Safari deletes script-writable storage after seven days of
  Safari use without interaction with the site — but installed Home
  Screen apps in `standalone` display mode are exempt, and the manifest
  already says `standalone`. The install prompt copy should say so for
  venue phones.
- **Prefetch**: opening an event with a map warms the cache by fetching
  the document (it is one request); nothing else to plan.
- **Eviction detection**: `caches.match()` miss while offline shows the
  existing offline banner with "map not cached on this device", not a
  blank canvas.

### 9.2 The venue box

The checkout snapshot excluded map blobs because tiles were hundreds of
MB and re-creatable. A document is 0.2–3.5 MB and *is* what the kiosk and
stations render. So:

- **Add to `SNAPSHOT_TABLES`**: `mapFile` (the event's row with its
  hashes and view overrides), and the referenced `map_documents` row(s)
  with their `map_previews` thumbnail. Exported as part of the same JSON
  snapshot (base64 for the bytes; 3.5 MB → 4.7 MB, within the snapshot
  route's limits — or as a second streamed part if the snapshot route
  is later converted to streaming).
- **Not in the snapshot**: `map_sources` (club property, tens of MB, not
  needed to render), `map_source_documents`, graphics and templates
  (print is cloud-owned during a lease — `offline-architecture.md` — and
  stays so; 05's isomorphic PDF module makes venue printing possible
  later by adding `graphics`, `map_templates`, `course_maps` and the
  print profile to the snapshot).
- **Venue serves the same routes**: `/api/map-documents/:hash` from its
  own `map_documents`, auth by the same rules against its event copy.
  Stations on the LAN get the map from the box. The service worker's
  same-origin-only rule for tRPC does not apply to the document route —
  the response is identical by construction (same hash), so caching the
  venue's copy under the cloud origin's cache key would be harmless, but
  Workbox keys by URL, and the venue URL differs, so no rule change is
  needed.
- **Map changes during a lease** (re-import on the cloud while the event
  is checked out): the event's `map_files` row is cloud-owned non-critical
  data; the venue refreshes it on the slow settings cadence and fetches
  the new document from the cloud when online. Offline, it keeps serving
  the snapshot's document. Course geometry is in paper coordinates and
  unaffected (06 §6).
- **Checkin** carries nothing back: documents are immutable and the venue
  never writes them.

## 10. Backups

- **Per-event dump** (`/api/backup/event`): add `\copy` of the
  `map_documents` row(s) and `map_sources` row referenced by the event's
  `map_files`, keyed by hash so a restore into a database that already
  has them is an `ON CONFLICT DO NOTHING`. The club-library gate becomes
  "`club_map_version_id IS NOT NULL` → instance admin, or the dump omits
  `map_sources` and includes documents only" — the second variant is new
  and lets an event manager back up and restore a *renderable* event
  without ever holding the club's source file. `map_previews` are omitted
  (cache).
- **Database backups** (Cloud SQL daily, `pg_dump -n oxygen` for
  self-hosters) cover everything; dropping `map_tiles` shrinks them by
  the 60 % measured in §2.
- **Restore** of an event dump on a fresh instance: the `INSERT INTO
  oxygen.events` header, then the `\copy` blocks in FK order — sources,
  documents, then `map_files`. `backup-restore.md` gets the new order in
  09.

## 11. Capacity and cost

| Deployment | Store | Projection (§3.1) | Note |
|------------|-------|------------------|------|
| Cloud Run + Cloud SQL `db-f1-micro`, 10 GB SSD (auto-grow) | Postgres | 0.1–0.8 GB | Replaces 0.2+ GB of tiles; $0.17/GB-month → cents. Memory: a 36 MB source read is one `Buffer`; the import worker peaks at a few hundred MB for Club-full (06), well inside 4 GiB |
| Self-host compose | Postgres volume | same | `pg_dump` size drops |
| Venue box | Postgres volume | documents only (MB) | snapshot grows by one document per event |

Bandwidth: one 0.3 MB document per device per event replaces hundreds of
tile requests; Club-full browsing in the library is 3.5 MB once per device
per version. The Cloud CDN question in `deploy-gcp-cloud-run.md` closes
itself: there is nothing left worth a load balancer.

## 12. Tests

| Layer | What |
|-------|------|
| Unit (shared/api) | Chunk assembly + SHA-256 streaming; range header parsing → `substring` offsets; auth predicate over the four reference tables (pure function over a fixture); GC candidate selection |
| Integration (api, `:5433`) | `map_sources`/`map_documents` insert-dedup; `RESTRICT` prevents deleting a referenced document; GC deletes only unreferenced rows past grace, keeps club-version sources; chunked upload out-of-order + duplicate chunk + finalise; `/api/map-documents/:hash` 200/206/304/403 matrix incl. kiosk key; `Content-Encoding` absent on ranged requests; streaming source download of a > 32 MiB synthetic file; job claim by stale heartbeat re-runs deterministically; snapshot export/import carries the document; per-event dump contains the blob rows and omits previews |
| E2E | Upload (chunked) → review → event renders the document; adopt a club version → delete the version → event still renders (pinned); offline: load map, go offline (`context.setOffline`), reload, map renders from cache; venue stack (`docker-compose.venue.yml` E2E job): checkout → stop cloud → kiosk readout shows the map |

## 13. Options and recommendation

Options for the store are in §3.2 (A chosen). The rest of the topic is
less a choice between alternatives than a set of consequences of 01, 02 and
06 applied to the deployments Oxygen actually has. Recommendation:

1. **Postgres `bytea`, content-addressed, `STORAGE EXTERNAL`** for
   sources, documents, ICC profiles; `pg` is the only store in all three
   deployments and the FK graph is the reference counter. A thin
   `BlobStore` module keeps object storage possible without planning for
   it.
2. **Schema** as §4: `map_sources`, `map_documents` (+ `header`,
   `report`, `last_referenced_at`), `map_previews`, optional
   `map_source_documents`; `club_maps` / `club_map_versions` with
   `map_files` pinning `(source_hash, document_hash, club_map_version_id)`
   and keeping view overrides; `club_symbol_decisions`,
   `club_print_profiles` (ICC inline), `graphics.raster_png`;
   `map_uploads`/`map_upload_chunks`, `map_import_jobs`.
3. **Blobs are never updated or cascaded away**; `RESTRICT` FKs plus a
   daily GC with a 30-day grace delete unreferenced documents, then
   orphan sources, then expired uploads/jobs. Deleting a library version
   `SET NULL`s the event's pin and leaves it on its document.
4. **Delivery**: `/api/map-documents/:hash` with `private, immutable`,
   `ETag`, single-range `206` via TOAST slicing, route-scoped
   `@fastify/compress` (off for ranges); auth = event capability, kiosk
   key, library membership or own job — over the reference tables, not
   the URL. Sources stream chunked (Cloud Run's 32 MiB ceiling).
5. **Upload** is chunked into the database (8 MiB chunks, 128 MB total,
   any instance), finalised into `map_sources` by streaming hash with
   dedup; replaces 06 §8's temp-file stream for the same client contract.
6. **Import jobs are rows**; `start` executes inline for 30 s, the status
   poll resumes stale jobs by heartbeat; determinism makes re-runs safe.
7. **Offline on devices** is the service worker's CacheFirst on the
   document route plus `navigator.storage.persist()` when a map is
   opened; `standalone` install exempts iOS from the seven-day rule.
   No IndexedDB copy.
8. **Offline at the venue**: `map_files` + referenced `map_documents` join
   the checkout snapshot; the venue serves the same document route;
   sources, graphics and print stay cloud-owned for now.
9. **Backups** carry sources and documents by hash with `ON CONFLICT DO
   NOTHING`; a documents-only variant lets non-admins restore a
   renderable event without the club's source.

## 14. Effort

| Work | Estimate |
|------|----------|
| Schema + migrations (new tables, `map_files` columns, `EXTERNAL` storage, FKs) and Prisma models | 1 week |
| `BlobStore` module, document/source/preview routes (auth, ETag, range, compress, streaming) | 1.5 weeks |
| Chunked upload routes + client uploader | 1 week |
| Job table + claim/resume + inline-start | 1 week (shared with 06's job work) |
| GC job + Maintenance button + audit lines | 0.5 week |
| Service worker route, persist prompt, eviction banner | 0.5 week |
| Checkout snapshot extension + venue serving | 1 week |
| Backup/restore changes + docs | 0.5 week |
| Tests per §12 | 1.5 weeks |
| **Total** | **≈ 8–9 weeks** (overlaps 06 by about a week) |

## 15. Open questions carried forward

- **Snapshot transport size.** The lease snapshot is one JSON body today;
  with documents inside it approaches the 32 MiB ceiling only for
  Club-full-class event maps (4.7 MB base64 is fine). Convert
  `exportSnapshot` to a streamed multipart response when 08's course and
  patch layers add more bulk, not before.
- **Documents-only backup variant** (§10) changes the backup page's
  wording and the restore doc; confirm with the operators that a backup
  without the source file is what non-admin event managers expect.
- **GC grace period** is 30 days by assertion; make it a setting
  (`oxygen_settings`) with 30 as default rather than debate it.
- **Browser-side import/PDF** (06 §4.5, 05 §9) will want the document
  *and* the fonts/library offline; the document route covers the first,
  the precache manifest covers the second — nothing to decide here now,
  but 09 should list the bundle-size consequence.
- **Multi-club instances** (several clubs on one deployment) would make
  `club_*` tables need an owner column; Oxygen is single-club per instance
  today (`club-library.md`: "one owning club") and this topic keeps that
  assumption explicit rather than half-solving it.
