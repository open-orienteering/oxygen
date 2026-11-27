# Map storage and delivery

Normative chapter for where map documents live and how they reach a
client. Research record: `docs/research/vector-map-pipeline/07-storage-delivery.md`
(decided 2026-10-07). Slice A, written incrementally: each section states
what is implemented and marks what is still pending.

## 1. Model

```
upload bytes ──sha256──▶ map_sources(file_hash)      the file as uploaded
      │
      └─ import (docs/map-import.md) ──▶ map_documents(hash)   the encoded document
                                              ▲        ▲
                map_files.document_hash ──────┘        └────── club_map_versions.document_hash
                (an event pins a document)              (a club map edition pins a document)
```

- Both blob tables are content-addressed and append-only: a row is
  written once with `createMany … skipDuplicates`, never updated. The
  same bytes uploaded twice, under any name, are one source row and one
  document row (06 §4.2).
- Every reference to a blob is a foreign key with `ON DELETE RESTRICT`.
  Only the garbage collector (§8) deletes blobs, and only rows nothing
  points at any more.
- The upload name is **not** part of the document: it lives on
  `map_sources.file_name` and in the import report. The document header's
  `source` block is `{kind, version, hash, bytes}` only, so the document
  hash depends on the bytes and the importer version alone
  (`docs/map-document-format.md` §2).

## 2. Tables

Migrations `20261016190000_map_documents_storage`,
`20261016210000_map_uploads_and_import_jobs`,
`20261019120000_map_import_jobs_started_by`,
`20261019130000_map_storage_source_hash_indexes` (`source_hash` indexes
on `map_files` and `club_map_versions` for the GC and the source route),
`20261019150000_club_symbol_decisions` and, dropping the legacy
pipeline's storage, `20261107120000_vector_map_pipeline_drops` (E5,
v0.6.1; `docs/migrations/2026-vector-map-pipeline.md`), and
`20261113120000_map_patches` (row G3), `20261114120000_map_gps_tracks`
(row G24), `20261114130000_map_heightfields` (row H4), `20261115120000_map_dem_jobs` (row H10), `20261115130000_map_patches_unresolved` (row G11) `20261116120000_map_version_patches` (row G12a: the three `patch` columns, `docs/map-patches.md` §5.1) `20261118120000_map_colour_settings` (row I6: `map_colour_settings` and `map_import_jobs.colour`) and `20261118190000_map_document_colour_settings` (row I7) and `20261127130000_map_import_job_attempts` (MAP-5: `map_import_jobs.attempts`). All in schema `oxygen`.

| Table | Key | Columns | Notes |
|---|---|---|---|
| `map_sources` | `file_hash CHAR(64)` | `kind` (`ocad`/`omap`), `bytes BYTEA`, `size_bytes`, `file_name`, `uploaded_by → users SET NULL`, `created_at` | the uploaded file; `bytes` is `STORAGE EXTERNAL` |
| `map_documents` | `hash CHAR(64)` | `bytes BYTEA`, `size_bytes`, `format_version`, `importer_version`, `library_version`, `source_hash → map_sources RESTRICT`, `header JSONB`, `report JSONB`, `created_at`, `last_referenced_at`, `patch JSONB NULL` | the encoded document; `header` is the summary (§3), `report` the import report; `patch` the version patch it was baked with (`docs/map-patches.md` §5; null = none, never `[]`) |
| `map_previews` | `(document_hash, kind, key)` | `png BYTEA`, `created_at` | `document_hash → map_documents CASCADE`; thumbnails, symbol swatches and the colour panel's pictures (`colour-order`, row I6), cache (§4.5) |
| `map_heightfields` | `(document_hash, source, version)` | `bytes BYTEA` (`STORAGE EXTERNAL`), `size_bytes`, `header JSONB`, `report JSONB` — null together for a document without contours — `created_at` | `document_hash → map_documents CASCADE`; the terrain a document's contours imply and its report, and the DEM's two fields (`ground.<provider>`, `contours.<provider>`), pure cache (§4.7) |
| `map_dem_jobs` | `(document_hash, provider, version)` | `state`, `reason`, `error`, `attempts`, `next_attempt_at`, `claimed_by`, `heartbeat_at`, `created_at`, `updated_at` | `document_hash → map_documents CASCADE`; the DEM job's state (§4.7 "The DEM") |
| `club_maps` | `id UUID` | `name`, `colour_profile`, `colour_overrides JSONB`, `north_lines_below`, `rotation_correction`, `created_by`, timestamps | a club's map as a series (06 §8) |
| `club_map_versions` | `id UUID` | `club_map_id → club_maps CASCADE`, `seq`, `label`, `source_hash RESTRICT`, `document_hash RESTRICT`, `uploaded_by`, `uploaded_at`, `patch JSONB NOT NULL DEFAULT '[]'`; `UNIQUE(club_map_id, seq)` | one version: an uploaded edition (`patch` `[]`), or a promoted one — the same source with an ordered list of correction layers (`docs/map-patches.md` §5); `uploadedAt` ordering, `seq` for display |
| `map_files` (+) | — | `source_hash RESTRICT`, `document_hash RESTRICT`, `club_map_version_id → club_map_versions SET NULL` | the event's pins. `document_hash` is null until the import pins (or when it failed); `source_hash` is set on every live event's row (the E5 migration's guard) and null only on a soft-deleted event's row that never had a source — a file name without bytes. Since E5 the row holds no bytes (`file_data`, `file_hash`, `render_key` and the colour-stack columns are dropped) |
| `map_uploads` | `id UUID` | `event_id → events CASCADE` (nullable), `file_name`, `kind`, `declared_bytes`, `chunk_bytes`, `uploaded_by SET NULL`, `created_at`, `finalised_hash → map_sources SET NULL` | one chunked upload in flight (§5); `kind` is set from the first chunk |
| `map_upload_chunks` | `(upload_id, n)` | `bytes BYTEA` | `upload_id → map_uploads CASCADE`; `STORAGE EXTERNAL`; deleted at finalise |
| `club_symbol_decisions` | `(fingerprint, library_version)` | `canonical_id` (NULL = keep as source), `decided_by → users SET NULL`, `decided_at` | a reviewed symbol outcome reused across documents (`docs/map-symbols.md` §8.5); written only by `mapImport.decide` (§6.8), read when a job is inserted (§6.1); no event or series column — the instance is one club's |
| `map_patches` | `id UUID` | `event_id → events CASCADE` (`UNIQUE`), `document_hash → map_documents RESTRICT`, `enabled`, `ops JSONB`, `symbols JSONB`, `version BIGINT`, timestamps | an event's corrections to its pinned document (`docs/map-patches.md` §3.1); a GC reference (§8.1) |
| `map_gps_tracks` | `id UUID` | `event_id → events CASCADE`, `name`, `source_name`, `points JSONB`, `point_count`, `recorded_at`, `trim_start` / `trim_end`, `derived_from UUID[]`, `single_pass JSONB`, `converted_op`, `created_by → users SET NULL`, `created_at`, `version BIGINT` | an event's GPS tracks in WGS 84 (`docs/map-gps-tracks.md` §1.1); no blob reference |
| `map_colour_settings` | `id UUID` | `club_map_id → club_maps CASCADE` (`UNIQUE`) **or** `event_id → events CASCADE` with `source_hash → map_sources CASCADE` (`UNIQUE(event_id, source_hash)`; a `CHECK` allows exactly one target), `colour_order` (`iof` \| `source`, default `iof`), `deviations JSONB NOT NULL DEFAULT '{}'` (an object), `updated_by → users SET NULL`, timestamps | a map's colour setting (`docs/map-symbols.md` §9.3 "Per map (row I6)"): the order its document is drawn in and its per-deviation overrides, only those that differ from the default (row I7 writes them). One row per club map series (kept across its versions) or per event and source file; no row = the defaults. Read by every import of the map (§6.1); not a GC reference; not in the dump or the checkout snapshot (§9) |
| `map_document_colour_settings` | `(document_hash, colour_key)` | `document_hash → map_documents CASCADE`, `colour_key TEXT` (the normalised setting as canonical JSON), `colour JSONB` (an object, `{ order, deviations }`), `created_at` | the colour settings known to give a stored document (row I7, `docs/map-symbols.md` §9.3 "Overrides (row I7)"): every finished import job writes the setting it was asked for, so an override that changes no bytes — the same hash, whose report (written once, by the first import) says *by default* — still finds its document. Read by dedup (§6.1), the re-match (§6.9) and `review.current`. Cache-like: a lost row costs one re-import, which writes it again; not a GC reference; not in the dump or the checkout snapshot (§9) |
| `map_import_jobs` | `id UUID` | `event_id CASCADE` / `club_map_id CASCADE` (the target, either nullable), `source_hash → map_sources CASCADE`, `decisions JSONB` (the decision snapshot, §6.1), `patch JSONB NOT NULL DEFAULT '[]'` (the version patch snapshot, §6.1), `colour JSONB NOT NULL DEFAULT '{}'` (the colour setting snapshot `{ order, deviations }`, §6.1; `{}` = the defaults), `state`, `stage`, `progress REAL`, `claimed_by`, `heartbeat_at`, `attempts INTEGER NOT NULL DEFAULT 0` (claims so far, §6.1), `document_hash → map_documents SET NULL`, `error`, `started_by → users SET NULL`, timestamps | one import run (§6); indexed on `(state, heartbeat_at)` for the claim query and on each target; `started_by` is the user whose request started it (null for the re-match and the retired backfill), read by §4.2 |

The legacy library table `club_map_files` (linked to its series by
`club_map_id`), the tile cache `map_tiles` and the rendered-map cache
`rendered_maps` were dropped by the E5 migration, after its guard
checked that every library row had a series.

`STORAGE EXTERNAL` on the two blob columns keeps TOAST from compressing
the bytes (compact binary that gains little) so `substring(bytes FROM … FOR …)`
reads only the chunks a range request needs instead of inflating the row.

Prisma models: `MapSource`, `MapDocument`, `MapPreview`, `ClubMap`,
`ClubMapVersion`, `MapUpload`, `MapUploadChunk`, `MapImportJob`, `ClubSymbolDecision`, `MapPatch`, `MapHeightfield`, `MapColourSetting`;
`MapFile.sourceHash / documentHash / clubMapVersionId`; `ClubMapFile.clubMapId`.

## 3. Store stage (import stage 9)

`packages/api/src/map-store/documents.ts`:

```ts
importAndStoreMap(db, fileBytes, fileName, kind /* "ocad" | "omap" */, { uploadedBy? })
  → { sourceHash, documentHash, deduplicated, result }   // result = importMapToDocument()
importAndStoreOcad(db, fileBytes, fileName, opts)         // = importAndStoreMap(…, "ocad", opts)

storeImportedDocument(db, { source: { bytes, fileHash, kind, fileName, uploadedBy? },
                            document: { bytes, hash, libraryVersion?, patch? }, report })
  → { sourceHash, documentHash, deduplicated }
```

- Refuses a document whose `header.source.hash` is not the source's
  `fileHash` (a document can only be stored under the file it came from).
- `map_documents.header` is `documentHeaderSummary(header)`: the header
  without `symbols` and `strings`, plus `symbolCount` / `stringCount` —
  enough for listings, small enough to index. The full header is in the
  bytes.
- `map_documents.report` is the 06 §4.4 `ImportReport`
  (`mapImport.importReportSchema`): importer, source `{kind, version,
  fileName, bytes, fileHash}`, `counts` (objects, coordinates, symbols,
  symbolsRendered / symbolsUnrendered, colours, texts, graphicObjects,
  missingSymbolObjects), code-keyed `warnings[]` with counts, `timings`,
  and since stages 6–7 landed `matching` (library, edition, thresholds,
  factor, symbol / object counts per state, `byMethod`, `scaleAnomalies`)
  and `colourStack` (source count, inserted, aliased, conflicts,
  unclassified; `areasAboveLowerPurple` since `ocad-16` / `omap-9`;
  `purplesDisplaced` since `ocad-18` / `omap-11`; `order` and, in the `iof`
  order, `layers` — rows, split, sourceOrdered, noRole, deviations,
  purpleInk — since `ocad-19` / `omap-12`, §9.3 "In the importer") —
  `docs/map-symbols.md` §8–§9; the stored `header` summary carries
  `colourOrder` from then; since stage 5 (`ocad-5` /
  `omap-2`) `georeference` and `north` (field list in
  `docs/map-import.md` §3.8; `north` is the legacy `NorthDetection` with
  the WMM fields at the import date, `asOf`); since `ocad-7`
  `readerWarnings` (the OCAD reader's own warning texts, at most 50,
  only when there are any — `docs/map-import.md` §3.6); since `ocad-10` /
  `omap-4` `warningDetails` (one `{code, message, symbolIdx?}` per warning
  emission, at most 500, only when there are any — the per-symbol detail
  behind the header's one-message-per-code `warnings`, `docs/map-import.md`
  §3.6); since G12a `corrections` (`{ layers, ops, issues }`, only for an
  import that baked a version patch, `docs/map-patches.md` §5.2).
- `map_documents.patch` is the job's version patch when it has layers,
  else NULL. The row is content-addressed: a bake that reproduces another
  document's bytes stores nothing and the existing row keeps its patch
  (`docs/map-patches.md`, Pending "A no-op layer").
- `library_version` is `"<library>@<SYMBOL_LIBRARY_VERSION>"`
  (`ISOM2017-2@2026.10.3`), the library the matcher chose for the
  document. Rows imported before the matcher carry `"none"`
  (`LIBRARY_VERSION_NONE`) and `importer ocad-3`; they are no longer
  dedup targets, so the next upload of the same bytes produces a new
  document row under the current importer and library version while the
  old row waits for GC (§8). The re-match pass (§6.9) moves the pins of
  such rows to fresh documents in bulk.
- `touchDocument(db, hash)` bumps `last_referenced_at`; called whenever a
  reference is created (`applyJobResult`), on a dedup hit before the job
  row is inserted (§6.1), and by every GC run for every document still
  referenced (§8.2). GC grace is measured from it.

### 3.1 Producers

The store stage no longer runs inline. Every producer writes the
`map_sources` row itself (`createMany … skipDuplicates`) and then
`startImportJob` (§6) with the source hash and a target; the job runs the
import in a worker thread and, when it finishes, stores the document and
applies the pins:

| Producer | Source row written by | Target | Pin applied by the job |
|---|---|---|---|
| chunked upload (§5) → `course.applyUploadedMap` → `applyEventMap` | finalise route | `eventId` | `map_files.document_hash` on every row of the event with that `source_hash` |
| `course.useClubMap` → `applyEventMap` | — (the latest version's `map_sources` row, §6.5) | `eventId` | same; the router then pins `club_map_version_id` to that version |
| chunked upload (§5) → `clubMap.addFromSource` | finalise route | `clubMapId` | a new `club_map_versions` row (§6.4) |
| `applyEventMap` with bytes (tests only) | `applyEventMap` | `eventId` | as the first row |

The chunked upload is the only way in since E5: the base64 procedures
`course.uploadMap` and `clubMap.upload` are gone, and the web uploads
every file in chunks (§5.2). `applyEventMap` creates the `map_files` row
with `source_hash`, the file name, `rotation_correction` (a club copy's
series value, else 0) and `from_club_library`, and `document_hash =
NULL`; starts the job; awaits it up to the hold (§6.2); then re-derives
the legs of the event's `length_source = 'derived'` courses for the new
scale (`rebuildCourseLengths`, `docs/course-layer.md` §4.1) and returns
`{fileName, size, rotationCorrection, meridianStalenessDeg, documentHash,
importJob {id, state, error}}`. Nothing parses the file at upload: the
quick-access columns are the pin's (§6.4) and `meridianStalenessDeg` is
the pinned document's `report.north` evaluated for today (null while the
job runs or when it failed). A failed job is logged by the engine and
leaves `document_hash = NULL` — the map panel then shows the job's error
(`MapImportState`). `course.mapMetadata` returns `documentHash`
(nullable); `mapImport.latestForEvent` returns the job. Both procedures
accept OCAD and Mapper sources (§5.1).

## 4. Delivery: `GET /api/map-documents/:hash`

`packages/api/src/map-store/routes.ts`, registered in `index.ts`.

### 4.1 Contract

| Condition | Status | Body / headers |
|---|---|---|
| `:hash` not 64 lowercase hex (upper-case is folded) | 400 | `{error}` |
| not authorised, anonymous | 401 | `{error}` |
| not authorised, signed in | 403 | `{error}` |
| authorised, no such document | 404 | `{error}` |
| `If-None-Match` matches `"<hash>"` (weak or strong, list, `*`) | 304 | common headers |
| `Range: bytes=a-b` satisfiable, single range | 206 | `Content-Range: bytes a-b/size`, identity-encoded slice |
| `Range` starts past the end | 416 | `Content-Range: bytes */size` |
| otherwise | 200 | whole document, `br` / `gzip` / identity by `Accept-Encoding` |

Common headers on every 2xx/304:

```
Content-Type: application/vnd.oxygen.map
Cache-Control: private, max-age=31536000, immutable
ETag: "<hash>"
Accept-Ranges: bytes
Vary: Accept-Encoding
```

Range semantics: `bytes=a-`, `bytes=-n` (suffix) and `bytes=a-b` with `b`
clamped to `size-1`; multiple ranges and malformed values are ignored
(200 whole). Ranges are never compressed — a slice must be byte-addressable
for the client's partial-read path. Whole responses are compressed only
when ≥ 1 024 B and the client accepts it (q-values honoured, `*`
counts as `br`); brotli quality 5, gzip level 6, computed per request —
documents are small (0.2–5 MB) and the browser caches the result.

Authorisation is checked before existence, so an unauthorised caller
cannot probe which hashes exist (404 only after a pass).

### 4.2 Authorisation predicate

Input: the hash; the signed-in user (per `AUTH_MODE`, same resolution as
tRPC); a kiosk key from `x-kiosk-key` or `?k=`; an event from
`x-event-id` / `x-competition-id` / `?event=`. The query forms exist so a
plain `<a href>` / `fetch(url)` (the dev page's `?url=`, the service
worker later) can address a document without custom headers.

```
authEnabled == false                                   → allow
event given ∧ event pins hash (map_files.document_hash)
    ∧ kiosk key matches the event's kiosk_key          → allow
    ∧ user has courses.view on that event              → allow
user signed in ∧ some club_map_versions row has hash   → allow
user signed in ∧ some map_import_jobs row has
    document_hash = hash ∧ started_by = user
    ∧ state <> 'failed'                                → allow
otherwise                                              → 401 if anonymous, 403 if signed in
```

`courses.view` comes from `resolveEventCapabilities` — admins, the
course-setter group, and (after an event completes) every signed-in
user, exactly as for the tRPC course procedures. Being a member of the
event is not enough: the member group has no `courses.view`.

Positive decisions are cached in-process for 60 s per
`(hash, user, kiosk key, event)`; negative ones are not. The cache is
`resetDocumentAccessCache()` for tests.

The fourth clause is 07 §6.2's "a running import job the caller
started": it lets the user who uploaded a map see the document an import
produced before anything pins it (the review round, `docs/map-import.md`
§2.2). Jobs had no owner, so `map_import_jobs.started_by` records the
requesting user (§6.1). Today `document_hash` is written only together
with `state = done`, so in practice the clause means "a done job I
started", for as long as the job row lives (7 days, §6.6). The review
round needs nothing more: `mapImport.decide` produces its document in an
ordinary job without a target (§6.8), so the decider sees the reviewed
document and its swatches through this clause until `finalise` pins it.
A failed job never carries a document.

The tRPC review procedures use the same predicate (`checkDocumentAccess`,
uncached), with the identity taken from the tRPC context. `decide` and
`finalise` use it in **edit mode** (`EDIT_ACCESS`): the event clause asks
for `courses.edit` instead of `courses.view` and the kiosk key is never
accepted; the club and own-job clauses are unchanged.


### 4.3 Blob access

`packages/api/src/map-store/blob-store.ts` is the 07 §3 seam between the
route and Postgres — the only code that reads or deletes blob bytes:

```ts
getBlob(db, "map_sources" | "map_documents", hash, range?)   // whole or substring(bytes FROM s FOR n)
getBlobSize(db, table, hash)                                   // size_bytes, no bytes read
deleteBlob(db, table, hash)                                    // raw DELETE; fails on RESTRICT
```

Everything above the seam talks in hashes and `Buffer`s; a future object
store implements the same three calls.

### 4.4 Source download: `GET /api/map-sources/:hash`

`packages/api/src/map-store/source-routes.ts`, registered in `index.ts`
next to the document route. The original file as uploaded, for the
people who may take it out of Oxygen (07 §6.1). Unlike a document it is
the club's property, not a rendered view, so it follows today's
download rules (`course.downloadMap`, `clubMap.download`,
`docs/system/authentication.md`) rather than the document predicate, and it is
not cached.

| Condition | Status | Body / headers |
|---|---|---|
| `:hash` not 64 lowercase hex (upper-case is folded) | 400 | `{error}` |
| not authorised, anonymous | 401 | `{error}` |
| not authorised, signed in | 403 | `{error}` |
| authorised, no such source | 404 | `{error}` |
| otherwise | 200 | the bytes, streamed |

```
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="<ascii name>"; filename*=UTF-8''<percent-encoded name>
Cache-Control: private, no-store
(no Content-Length — Transfer-Encoding: chunked; no ETag, no Range)
```

Streaming (07 §6.4): sources reach 36 MB today and the upload limit is
128 MiB, above Cloud Run's 32 MiB ceiling for a non-streamed response.
The body is a `Readable` that pulls `getBlob(…, range)` slices of 4 MiB
(`SOURCE_SLICE_BYTES`) one at a time, so the API holds one slice, never
the file. `size_bytes` and `file_name` are read first (one `map_sources` select)
to plan the slices;
a slice that comes back missing (the row vanished mid-stream) aborts the
response.

Authorisation, checked before existence as for documents. Input is the
same `identity()` as §4.2 (user, kiosk key, event); the kiosk key never
counts:

```
authEnabled == false                                              → allow
event given ∧ user has event.manage on it
    ∧ a map_files row of that event has source_hash = hash
    ∧ (that row's from_club_library = false ∨ user is admin)      → allow, filename = map_files.file_name
user signed in ∧ a club_map_versions row has source_hash = hash
    ∧ (user is admin ∨ that row's uploaded_by = user)             → allow, filename = map_sources.file_name
otherwise                                                         → 401 if anonymous, 403 if signed in
```

The event clause is `canDownloadEventMap`, the club clause
`canDownloadClubLibraryMap`, keyed by hash instead of by row. Decisions
are not cached (downloads are rare and the answer must follow a revoked
role at once). With auth off the filename is `map_sources.file_name`.

### 4.5 Previews

06 §5.2, 07 §6.1. PNGs derived from a document or from the bundled
library by the reference raster (`docs/map-rendering.md` §5.1); the
review UI (`docs/map-symbols.md` §8.7) reads them. `packages/api/src/map-store/previews.ts`
(rows, library cache) and `preview-routes.ts` (routes).

```
GET /api/map-documents/:hash/thumbnail.png                 the whole map, long edge 512 px
GET /api/map-documents/:hash/symbols/:idx.png              swatch of header.symbols[idx].render
GET /api/map-documents/:hash/colour-order/:order.png       the colour panel's picture, :order iof | source (row I6);
                                                           ?deviations=upper>lower:keep,… the map's overrides (row I7)
GET /api/map-documents/:hash/colour-order/:order.json      the document that order gives, { documentHash } (row I8a)
GET /api/library/:libraryId/:version/:code.png             swatch of a canonical entry
```

**Rows.** Document previews are `map_previews` rows keyed
`(document_hash, kind, key)`: `('thumbnail', '')` and
`('symbol', '<idx>')` and since row I6 `('colour-order', 'iof' | 'source')` — since row I7 also `('colour-order', 'iof-<digest>')` for an IOF picture drawn with overrides. A row is written once with `createMany …
skipDuplicates` and never updated, like the blobs (§1); it cascades with
its document and is pure cache — deleting rows only costs a re-render.
Who writes them:

| Row | Written by |
|---|---|
| thumbnail | import stage 10 (`derive`, §6.1) after the document is stored, including the dedup short-cut of `startImportJob`; otherwise on the first request that finds no row (documents stored before stage 10 existed, a skipped or failed derive) |
| symbol | the first request for that index |
| colour-order (`key` the order; row I7: `iof-<16 hex of sha256 of the normalised deviations query>` with overrides) | the first request for that order and overrides (row I6, I7) |

Reading a preview is not a reference: it never bumps
`last_referenced_at` (§3).

**Thumbnail.** The document through `documentRenderInput` with its
defaults (canonical layer on, hidden symbols off, proxies for symbols
without a render) → `symbolise` with the bundled fonts → reference raster
on white paper. The area is the print window when the header has one,
otherwise `header.bounds`; the density puts the longer side at 512 px.
Documents with more than `THUMBNAIL_MAX_OBJECTS` = 60 000 objects are
not thumbnailed: stage 10 logs and writes nothing, and the route answers
404. The check reads the object count from the stored header summary
(§3), so an over-cap document costs no blob read. Thumbnails render one
at a time per instance; concurrent requests for the same row share one
render. Measured on the local corpus (render + encode, one process):

| Map | Objects | Time | Peak RSS added |
|---|---|---|---|
| crop-b | 3 073 | 0.27 s | 18 MB |
| crop-a | 4 983 | 0.34 s | — |
| sprint (print window) | 10 680 | 0.43 s | 98 MB |
| club-2026 | 45 884 | 2.8 s | 166 MB |
| club-full | 101 729 | 4.7 s | 360 MB — over the cap |

**Symbol swatch.** `header.symbols[idx].render` drawn by the shared
swatch scene (`docs/map-rendering.md` §5.1.1) in the document's own
colour stack, at its native paper size — what the map prints, not
normalised to the library's reference scale. A symbol with
`render: null` has no swatch (404); `graphic` and `hidden` symbols
render like any other.

**Colour picture** (row I6; the review page's colour panel,
`docs/map-symbols.md` §8.7). The reviewed document over a capped window,
drawn by the reference raster on white paper, in the IOF order and in the
map's own order. The window is the thumbnail's area when it fits 80 mm
square, else the 80 mm tile (on a grid from the area's lower left) with
the most objects by the centre of their boxes, clipped to the area;
objects within 5 mm of it are drawn; 6 px/mm, so at most 480 px a side
(`colourPictureWindow`, `renderColourPicture` in `render/previews.ts`). The window is
computed from the reviewed document's geometry, which both orders share,
so the two pictures show the same place. The document's own order
(`header.colourOrder.order`; none = `source`) is drawn from it. The other
order is drawn from the document the switch would give — its source
imported with the same corrections and overrides in the other order — found
by dedup, else imported by an ordinary job without a target
(`started_by` the requester) on the first request: a GET may start an
import (decided overnight on the user's standing instruction,
2026-11-17, for review). The row is the reviewed document's
(`('colour-order', '<order>')`), written once like every preview. A
`source` document lists no deviations, so the review gives its IOF
picture's URL the map's overrides as `?deviations=` (normalised, keys
sorted; row I7): the other order is imported with them, and the row's key
and the ETag carry their digest, so a picture is never reused across
overrides (a malformed query is **400**). The keys stay bounded: the
query counts only on a `source` document's IOF picture (any other picture
is keyed by its order alone), and only for deviations a stored IOF document
of that source and corrections lists — the import's result narrows them
again — so overrides the map does not have give the defaults' picture.
The
render goes through the thumbnails' one-at-a-time queue, the import does
not (its derive stage renders a thumbnail through that queue). While the
import runs past a 20 s wait (`MAP_COLOUR_PICTURE_WAIT_MS`) the route
answers **503** with `Retry-After: 5` and the work goes on; the panel
retries every 5 s. A failed import is **502**, remembered for 10 minutes
per instance so the panel's retries start no new job; a queued or running
job without a target for the same source, corrections and setting is
waited for rather than doubled; when that job is someone else's, a done job
row of the requester's own is added after it by dedup (row I8a, shared with
the `.json` route below), so the requester may read the document. The documents are decoded inside the
render queue, after any import, so at most one picture's documents (the
reviewed one and the other order's) are held per instance. Unlike
the other previews the colour picture is not a pure function of its
document: its other order is drawn as of the first request (the club
decisions then).

**The other order's document (row I8a).** `….json` answers the hash of
the document the switch to `:order` gives — the picture's import without
the picture — for the review page's compare view
(`docs/map-symbols.md` §8.7 "Compare"): `{ "documentHash": "<hex>" }`,
`Cache-Control: no-store`. The document's own order answers its own hash
without a job. The other order is the picture's: the same validation
(`:order`, `?deviations=`, 400 before 401 / 403), the same §4.2
authorisation and `?event=` scoping, the same overrides and bounded keys,
dedup or an ordinary job without a target, the same 20 s wait (**503**
`Retry-After: 5`), and a failure remembered for 10 minutes (**502**); an
unknown document past authorisation is **404**. The document is then read
through §4.2's document route, so the requester must be able to: when the
answer came from someone else's job (a dedup hit, or a running job waited
for), the route adds a done job row of the requester's own by dedup (no
worker runs), which the own-job clause accepts. A document the requester
can already read — a club version, or one with a job of theirs that has
not failed — is answered without a row, so asking again writes nothing
(bounded rows, decision I7 (7)). The remembered work is per
requester for that reason. `colourOrderDocument` in `colour-pictures.ts`;
the picture's `produce` and it share `importOtherOrder`.

**Library swatch.** The entry resolved in the library's own palette
edition (`materialiseLibrary(id)`, `iof2024` today) through the same
swatch scene, at reference scale. `:code` is the entry code with an
optional variant letter — `418`, `302.b` — i.e. the entry id without the
library prefix. Rendered from the bundled library and cached in memory
per instance (bounded, least recently used out), never stored (07 §4.1):
it is a function of the library version alone. The version is part of
the path so `public, immutable` survives a `SYMBOL_LIBRARY_VERSION`
bump; a request for another version than the current one is 404.

**Contract.** Same order as §4.1: validate, authorise, then existence,
so a hash cannot be probed.

| Condition | Status |
|---|---|
| `:hash` not 64 hex; `:idx` not a non-negative safe integer; `:order` not `iof` / `source`; `:libraryId` not a shipped library; `:code` not `\d{3}(\.\d{1,2})?(\.[a-z])?` | 400 `{error}` |
| document routes: §4.2 predicate fails | 401 anonymous / 403 signed in |
| library route: auth on and no signed-in user | 401 |
| no such document; `idx` ≥ symbol count or `render: null`; thumbnail over the object cap; `:version` ≠ current; no such entry | 404 `{error}` |
| colour picture: the other order still importing after the wait / its import failed | 503 `Retry-After: 5` / 502 |
| `If-None-Match` matches the `ETag` | 304 |
| otherwise | 200 PNG |

| Route | Headers on 2xx / 304 |
|---|---|
| document previews | `Content-Type: image/png`, `Cache-Control: private, max-age=31536000, immutable`, `ETag: "<hash>/thumbnail"`, `"<hash>/symbols/<idx>"` or `"<hash>/colour-order/<key>"` (the row's key, §4.5) |
| library preview | `Content-Type: image/png`, `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<libraryId>@<version>/<code>"` |

No `Range`, no `Content-Encoding` (PNG is already deflated), no `Vary`.

Authorisation of the document previews is exactly §4.2 — the same
predicate, the same 60 s positive cache, shared with the document route
through `requireDocumentAccess(req, reply, hash)` in `routes.ts`, all
four clauses included — the uploader of a running import sees its
previews as it sees its document. The library route needs any
signed-in user, or `AUTH_MODE=off` (07 §6.1): the library is public data.

### 4.6 Server reads of the pinned document

Every server reader of map data reads the event's **pinned document**:
the latest `map_files` row's `document_hash` (`eventPin` /
`eventDocumentHash`, `map-store/event-document.ts`). Nothing on these
paths parses the original file (slice E1; decision log 2026-11-05); the
legacy byte columns it once read (`map_files.file_data`,
`club_map_files`) were dropped in E5, and `map_files.north_detection`
(the upload's OCAD north diagnostic) has had no writer since — the north
fields come from `report.north`.

**Every event.** The data readers never read `events.map_pipeline`:
the switch never gated imports, and since E3 it gates nothing
(`history/map-pipeline-switch.md`, history note) — every event draws and prints
its pinned document.

**No pin, no map.** A reader whose event has no `map_files` row, or
whose row has no `document_hash` yet (the import is running or failed,
or the row came from a restored pre-v0.6.1 dump the re-match has not
imported yet, §6.9), answers "no map": no frame, no objects,
no cuts, no obstacles, no north. It never falls back to an OCAD parse.
`course.mapMetadata` is the one exception in shape: it answers for every
`map_files` row (below).

| Reader | Answer from the document | No pin |
|---|---|---|
| `loadEventCrs` (`event-crs.ts`): course lengths (`rebuildCourseLengths`), IOF / Purple Pen export, `controlCoordinates`, `control.create` / `update` lat/lng, `course.checks` scale, course import, the pin's lat/lng sync | `mapGeo.PaperFrame` from `map_documents.header` (`unitsPerMm`, `mapScale`, `georeferencing`) with `correctionDeg = map_files.rotation_correction`. A frame whose CRS proj4 cannot project still carries `mapScale` (lengths); its WGS 84 conversions answer null | null |
| `loadEventMapObjects` (`event-map-objects.ts`): description autodetect, `control.suggestDescription`, `DESCRIPTION_STALE` | over the effective document (below): point / line / area objects, not hidden by the patch, of non-hidden symbols whose code — the applied match's canonical code, else the source code — is in `ISOM_DESCRIPTION_MAP`, as `SlimMapObject` (1/100 mm whatever `unitsPerMm`, `sym` = `204.1` → 204001, Béziers flattened in 8 steps, an area's outer ring) | null |
| `loadEventCutFeatures` | `course.cutFeaturesOfDocument` (`course-layer.md` §3.4) | null: no automatic cuts |
| `loadEventCheckDocument` | `course.checkObstaclesOfDocument` (`course-layer.md` §9.3) | null |
| north: `course.mapMetadata` (`meridianStalenessDeg`, `cutRotationDeg`), `clubMap.list` (`northDetection`, `meridianStalenessDeg`) | `map_documents.report.north` (`detectDocumentNorth`, written at import); staleness re-evaluated for today by `meridianStalenessFromDetection` | null |
| `clubMap.list` `bounds`, `northOffset` | `mapFileMetadataFor(header, report.north.meridian tilt, club_maps.rotation_correction)` of the latest version's document | null (no version) |
| `getBaseMapInfo` (`course-maps/map-source.ts`) | `scale` = `header.mapScale`, `meridianTiltDeg` = `report.north.meridian.medianTiltDeg` (0 without one), `version` = the document hash; `document` = `{hash}`, always (`course-print.md` §10) | throws "No base map uploaded" (`getBaseMapInfoOrNull` → null); a pin naming a missing `map_documents` row throws "Pinned map document is missing" |
| `resolveImportAlignment` (`course-import-align.ts`) | the club map a Purple Pen file names is the series whose latest version's label, else its source file name, matches (`matchClubVersion`); re-projection through that version's document frame with `club_maps.rotation_correction` | `unknown` / judged on the event calibration, as before |
| `course.setMapRotation`, `clubMap.setRotation` | `course.setMapRotation`: the `map_files` quick-access columns recomputed by `documentMapFileColumns` under the new correction — the pin's function (§6.4): `mapFileMetadataFor`, the source fallback for `crs: null`, tilt 0 without a report `north`, scale only when nothing projects. `clubMap.setRotation` stores `club_maps.rotation_correction` only (the list derives the rest, row above) | only the correction is stored; the pin recomputes the columns |

The three `loadEvent…` derivations read the **effective document** (G14,
`map-patches.md` §2.4): the decoded pin (`decodedDocument`, an LRU per
hash) with the event's patch applied (`eventPatchOnPin`, §3.3 there),
memoised per **hash + patch version** — a hit costs the pin and the
`map_patches.version` column; a miss reads the patch, applies it and
derives. A disabled, op-less or dormant patch gives the pinned
document's answer, and so does a row keyed
to the pin that does not parse — memoised under the version looked up,
so it is derived once, not on every call.

**`course.mapMetadata`.** Answers non-null for every `map_files` row:
the row's quick-access columns as stored (the pin writes them, §6.4 —
no lazy OCAD backfill), `rotationCorrection`, `uploadedAt`,
`documentHash` (null until the pin: the viewer's "no document" case),
`clubMapVersionId`, `patchVersion` (the token of the patch delivered
with that document, `"0"` when none is, `docs/map-patches.md` §3.3),
`terrain` (the pinned document's height field, §4.7 "Descriptor"; null
until the pin) and the north fields above. The legacy raster's
fields — `renderKey` and the colour stack's `colorProfile`,
`colorOverrides`, `northLinesBelow`, `resolvedProfile`, `resolvedBy` —
went with the raster in E4a (their last reader, `MapViewer`'s
`mapVersion`, went in E4b); E5 dropped `render_key` and the colour-stack
columns of `map_files`. With them went `course.setMapColorStack`, the
only writer of the event row's colour columns after the upload.

**The one source read.** A document whose header has `crs: null` — the
importer's `CRS_UNRESOLVED` (`map-import.md` §3.5: the ScalePar grid id is
not in the reader's table and the file has no EPSG) — lacks the CRS the
legacy readers inferred from the easting / northing range
(`getEpsgString`, `map-projection.ts`: SWEREF99 TM, ETRS-TM35FIN, UTM
32N / 33N). For that case only, `sourceFrameFallback` reads
`map_sources.bytes` of the document's source once, takes the OCAD
ScalePar through `frameFromOcadCrs` (with the inference) and caches it
per source hash; `loadEventCrs`, the club-map alignment and
`documentMapFileColumns` use it. A source the inference does not place
(or an OMAP source) yields no CRS. The north analysis of such a document
stays as the import wrote it (no centre, no staleness).

**Caches.** Keyed by content hash, so never stale and nothing bumps
`uploaded_at` to invalidate them (`importCourses` no longer does): the
header frame and the report's `north` (32 documents each), the decoded
document (3), the source fallback (8), and per derivation — slimmed
objects, cut features, obstacles — 3 documents each. The pin lookup
itself is one indexed `map_files` query per call.

**Parity.** `packages/api/src/__tests__/document-readers-parity.test.ts`
imports each map in memory and compares every reader's answer with the
legacy OCAD reader's over the same bytes (the OCAD readers live on as a
test-only oracle, `__tests__/helpers/ocad-oracle.ts`): WGS 84 of the
extent's corners and centre within 1e-8° (with and without an 11°
correction), scale exact; the autodetect object multiset exactly equal to
the OCAD slimming minus objects of hidden symbols (coordinates to 1e-6
units); north — meridian count exact, angles within 1e-6°, centre within
1e-8°; cut features within 1e-6 mm in x, y, r. Objects and cuts are
compared on source codes: an applied symbol match changing a code is the
document's rule, not a reader difference. The E2E fixture runs in CI;
the local corpus (`.local/corpus`, five club / sprint maps up to 37 MB,
never committed; `OXYGEN_CORPUS_DIR` overrides) runs when present — all
five equal on 2026-11-05.

### 4.7 Height field

Research 10 §4, 07 §6.1; row H4. The terrain a document's contours imply
(`docs/map-terrain.md` §1–5): derived from the document alone, stored
as a row beside it, served immutably by hash like the previews (§4.5).
`packages/api/src/map-store/heightfield.ts` (rows, the derive),
`heightfield-worker.ts` (the worker body) and `heightfield-routes.ts`
(the route).

```
GET /api/map-documents/:hash/height.bin?v=<TERRAIN_VERSION>     the OXHF field (map-terrain §5.1)
```

**Decided with the user (2026-11-14).**

1. **The terrain version is in the URL** (`?v=`), so `immutable` names
   one content: a `TERRAIN_VERSION` bump changes the URL, and a request
   for another version than the current one is 404 — the library
   route's precedent (§4.5). A DEM-based source adds `?source=` (H10,
   "The DEM" below); without it the route serves `contours`.
2. **The terrain report lives on the height-field row**, not in the
   document row (`map_documents` is append-only, §1, and the report
   changes with `TERRAIN_VERSION`). A document without contours gets a
   row without bytes, so it is not re-derived on every request. The
   report reaches the event's descriptor (`course.mapMetadata.terrain`)
   and the import review (`mapImport.review.terrain`).
3. **The cell cap is the graph's own 60 M-cell budget and refuses
   nothing by default.** The stored field is `deriveTerrain(doc)` with
   the defaults (map-terrain §5.5), so a cap cannot coarsen it, only
   refuse the document; the graph raster already grows its cell to stay
   under 60 M (map-terrain §2.4), which bounds the derive's memory
   (measured below). `MAP_HEIGHTFIELD_MAX_CELLS` lowers it per instance
   (a small venue box); a document whose estimate is over it is
   `over-cap`.

**Rows.** `map_heightfields`, migration `20261114130000_map_heightfields`:

| Column | |
|---|---|
| `document_hash` | `→ map_documents CASCADE`; part of the key |
| `source` | `TEXT`, part of the key: `contours` (this section), or a DEM source `ground.<provider>` / `contours.<provider>` ("The DEM" below; free text, so H10 needed no change to this table) |
| `version` | `INT`, part of the key: `TERRAIN_VERSION` (map-terrain §5.5); the container version stays inside the bytes |
| `bytes` | `BYTEA STORAGE EXTERNAL`, nullable: `encodeHeightField(field)`, uncompressed; null when the document has no contours |
| `size_bytes` | `INT`, nullable with `bytes` |
| `header` | `JSONB`, nullable with `bytes`: the field's `HeightFieldHeader` (map-terrain §5.1) |
| `report` | `JSONB`, nullable with `bytes`: the `TerrainReport` (map-terrain §3.6), camelCase as stored |
| `created_at` | |

A `CHECK` holds `bytes`, `size_bytes`, `header` and `report` null
together. A row is written once with `createMany … skipDuplicates` and
never updated, like the previews; it cascades with its document and is
cache — deleting it only costs a derive. Reading it is not a reference
(no `last_referenced_at` bump). The `contours` row is always
`deriveTerrain(doc)` with no options (map-terrain §5.5), so the key names
one field and two instances deriving the same key write the same bytes.

| Writer | When |
|---|---|
| import stage 10 (`derive`, §6.1) | after the thumbnail, in a worker run and in the dedup short-cut of `startImportJob`; a failure is logged and never fails the job |
| the route | on the first request that finds no row (documents stored before H4, a failed or skipped derive) |

**The derive.** `getOrDeriveHeightfield(db, hash)`: the row if there is
one; otherwise the cap check, then the document's bytes into a
`worker_threads` worker of its own (`heightfield-worker.ts`, launched
through `workerBootstrap` like the import and print workers, §6.3):
decode, `deriveTerrain(doc)`, `encodeHeightField`; the encoded bytes,
header and report come back and the worker is terminated. Not in the
import worker: the dedup short-cut and the route have no import worker,
and the import's and the derive's peaks never stack inside a job (the
import worker is gone before stage 10). One derive runs at a time per
instance; concurrent requests for one key share one derive; a derive
over 240 s (under Cloud Run's 300 s request timeout) is terminated and
counts as failed. The 240 s bound is the worker's: a request queued
behind another derive waits for it first, so on an instance deriving
two large maps at once a lazy request can outlast a 300 s proxy timeout
(the client retries; the first derive's row then serves it). A failure writes nothing and is remembered in-process
for 10 minutes, so a document whose derive fails is not re-derived on
every request.

**The cap check** reads the stored header summary (§3), no blob: the
graph raster covers the contours' box plus 2 mm on each side at 0.1 mm
(map-terrain §2.4), so `(w + 4 mm) · (h + 4 mm) / 0.01 mm²` over
`header.bounds` is an upper bound, clamped to the 60 M budget. Over
`MAP_HEIGHTFIELD_MAX_CELLS` (default 60 M, so never) is `over-cap`,
logged, nothing written. A summary without bounds is not refused.

**Memory, measured.** A `.local/` script (not committed: the corpus is
real club maps) runs `deriveTerrain` on each corpus map's decoded
document, one map per process, and reads the process's peak RSS above
the decoded document. 2026-11-14, 16-core machine:

| Map | graph cells | added peak | time | field |
|---|---|---|---|---|
| crop-a | 1.4 M | 63 MB | 0.5 s | 0.76 MB |
| crop-b | 1.1 M | 51 MB | 0.4 s | 0.60 MB |
| sprint | 11.8 M | 225 MB | 2.2 s | 6.25 MB |
| club-2026 | 13.9 M | 331 MB | 5.6 s | 7.38 MB |
| club-full | 46.4 M | 840 MB | 19.1 s | 6.16 MB |
| club-full, graph budget 30 M (for scale) | 30 M | 501 MB | 12.1 s | 7.09 MB |
| club-full, graph budget 16 M (for scale) | 16 M | 410 MB | 8.2 s | 3.78 MB |

On club-full the added peak grows about 14 B per graph cell above a
~190 MB floor, so a document at the 60 M budget adds about 1.1 GB. On
the Cloud Run sizing (4 GiB, `ops/deploy-gcp-cloud-run.md`) one derive
beside the worst recorded print (Club-full, 2.6 GB for the whole
process) is about 3.7 GB, under the limit;
the import worker never overlaps the job's own derive, but a lazy derive
from the route can overlap another import or a print. The V8 heap flag
does not bound it: the rasters are typed arrays, outside the heap.

**Descriptor.** `course.mapMetadata.terrain` (§4.6) and
`mapImport.review.terrain` (§6.8) read the row only — neither waits for
a derive:

| `state` | When | `url` | `decided` / `report` |
|---|---|---|---|
| `ready` | a row with bytes | the route, `?v=` current | `report.share.decided` / the report |
| `none` | a row without bytes: no contours | null | null |
| `over-cap` | no row, the estimate is over the cap | null | null |
| `pending` | no row otherwise: not derived yet, deriving, or a failed derive | the route (fetching it derives) | null |

`mapMetadata.terrain` is `{ state, source: "contours", version, url,
decided }`; it is null when the event has no pin. The review's carries
the whole report and the field's `width`, `height` and `cellMm`
instead of `decided`. The 3D gate (`decided` ≥ 0.8, answer 7) is the
viewer's (`docs/map-rendering.md` §5.4 "3D mode", H7: it fetches `url`
only when someone switches to 3D, and a `pending` fetch is followed by a
fresh read of the descriptor); the review shows one terrain line (`docs/map-symbols.md`
§8.7).

**Contract.** Same order as §4.1: validate, authorise, then existence.

| Condition | Status |
|---|---|
| `:hash` not 64 hex; `v` absent or not a positive integer | 400 `{error}` |
| §4.2 predicate fails | 401 anonymous / 403 signed in |
| no such document | 404 `{error}` |
| `v` ≠ `TERRAIN_VERSION` | 404 `{error, reason: "version"}` |
| no contours (a row without bytes) | 404 `{error, reason: "no-contours"}` |
| over the cap | 404 `{error, reason: "over-cap"}` |
| the derive failed or timed out (now or in the last 10 minutes) | 503 `{error}` |
| `If-None-Match` matches the `ETag` (checked after the version, before the row is read: the ETag names immutable content only a 200 handed out) | 304 |
| otherwise | 200, the encoded field; `br` / `gzip` / identity by `Accept-Encoding` (§4.1's negotiation, computed asynchronously off the event loop) |

Headers on 2xx / 304: `Content-Type: application/vnd.oxygen.heightfield`,
`Cache-Control: private, max-age=31536000, immutable`,
`ETag: "<hash>/height/contours/<version>"`, `Vary: Accept-Encoding`. No
`Range`. Authorisation is §4.2 through `requireDocumentAccess`, as for
the previews, all four clauses and the 60 s positive cache included.

**Not carried.** The field is not in the venue checkout snapshot (§7.2)
or the per-event dump (§7.3): a box or a restore derives its own on the
first request (the slice H split). Nor are the DEM rows or `map_dem_jobs`:
a box or a restore fetches its own, where its instance enables a provider.

#### The DEM (H10)

Research 10 §3–4; row H10; `docs/map-terrain.md` §7. A digital elevation
model fetched for the document on the server, in the background, and
derived into two more `map_heightfields` rows per provider. Decided with
the user 2026-11-14 (map-terrain §7.0): the document's own frame with a
misalignment gate; provider and resolution in `source`; one job table;
fetching opt-in.

| `source` | Content |
|---|---|
| `ground.<provider>` | the DEM resampled onto the `contours` field's grid (map-terrain §7.4); `report` = `{ dem: { provider, tiles, tilesRead, dataShare, fetchedAt } }`; the level read is the header's `provider.resolutionM` |
| `contours.<provider>` | the contour field re-derived with the DEM's per-chain heights (map-terrain §4.9, §7.5), `datum: "absolute"`; `report` = the `TerrainReport` at the top level (so `share.decided` reads as for `contours`) plus `anchor` (the `AnchorReport`, map-terrain §6.9) and `heights` (§6.8's report) |

`<provider>` is the provider and the resolution chosen: `lantmateriet-2m`
(or `lantmateriet-1m`, `MAP_DEM_LANTMATERIET_RESOLUTION_M=1`) and
`glo30-30m`. A map whose window at that resolution is over the 64 M cell
cap is read one overview coarser under the same `source` (map-terrain
§7.0c answer 12: 4 m in a `lantmateriet-2m` row, 2 m in a `-1m` one); the
header's `provider.resolutionM` is the level read. Research 10 §4's key `(document hash, provider, resolution)`
is this `source` with `version = TERRAIN_VERSION` in H4's key. Both rows
carry the provider's licence, attribution and vertical datum in the
header's `provider` block (map-terrain §5.1), so they travel with the
bytes. Both are written together, once, with `createMany …
skipDuplicates`, never updated, cascade with the document, and are cache:
deleting them costs a fetch. Raw tiles are not stored (§7.0 answer 3).

**The job.** `map_dem_jobs`, migration `20261115120000_map_dem_jobs`, one
row per `(document_hash, provider, version)`; `packages/api/src/map-store/dem-jobs.ts`:

| `state` | `reason` | Meaning |
|---|---|---|
| `queued` | — | waiting for the engine |
| `running` | — | claimed by `claimed_by`, heartbeat every 10 s; re-claimed after 60 s of silence |
| `done` | — | both rows written |
| `unavailable` | `no-georeference` (no CRS proj4 knows, no paper origin, no usable bounds), `no-coverage` (the provider has no tile there, or no contour chain is covered), `no-contours`, `over-cap` (H4's cap, or more than 16 tiles, or more than 10 STAC pages, or more than 64 M window cells at the chosen level and at the next coarser overview, map-terrain §7.0c answer 12; `error` names the cap: `field: …`, `tiles: …`, `stac-pages: …`, `window-cells: …`), `misaligned` (an anchor-grade DEM accepts under half of the contour length it covers, map-terrain §7.0 answer 2) | final; nothing written; `error` null except on `over-cap` |
| `failed` | `auth` (401 / 403), `http` (another status, no range support, a refused redirect), `format` (a TIFF the reader does not read), `timeout` (30 s per request, 240 s per derive, 10 min per job), `derive` (anything else) | retried from `next_attempt_at`: 1 min, 10 min, 1 h, 6 h after attempts 1–4 (`auth` never under 1 h); after the fifth attempt `next_attempt_at` is null and it is final |

**Recovery.** A job that failed for good is queued again from its first
attempt by an import of its document (stage 10 and the dedup short-cut,
`enqueueDocumentDem(…, { requeueFinal: true })`), not by a request.
Jobs that failed on `auth` — waiting or final — are queued again when an
account is saved in Settings → Height data (map-terrain §7.8, every
`lantmateriet-*` job, no restart needed) and when the engine starts
(`requeueAuthFailures`), where a fixed environment secret first reaches
an instance through a new revision or restart. Jobs that ended
`unavailable: over-cap` with a null `error` — before H13, which stores the
cap on every such ending — are queued again from their first attempt when
the engine starts (`requeueOverCap`, map-terrain §7.0c answer 12), so the
coarser overview gets its one try; one that ends over the cap again
stores its cap and is not taken a second time. A `running` job that goes stale
on its last attempt (it took its instance down each time, never reaching
its own failure path) is not re-claimed but marked `failed: derive`,
final. The heartbeat runs from the claim, so a job waiting behind another
derive in the queue is not taken as stale; past the 10-minute timeout no
derive is started.

`CHECK`s hold the state to the five values, `reason` non-null exactly on
`unavailable` and `failed`, and `error` (the message, never the
credential) to 2000 characters. An instance without enabled providers
never claims a job; a job of a provider not enabled on this instance is
left for one that has it.

| Trigger | |
|---|---|
| import stage 10 (§6.1) and the dedup short-cut | after the `contours` field, `enqueueDocumentDem` — not awaited, never fails the import |
| the route | a request for a DEM source with no row and no job queues that provider's job |
| a `no-coverage` ending | queues the next enabled provider (Lantmäteriet → GLO-30) |
| the 60 s tick (`startDemJobEngine`) | re-reads Settings → Height data over the environment (map-terrain §7.8) and resumes queued, due and stale jobs; it runs with no provider on too, so one turned on in the tab needs no restart |

`enqueueDocumentDem(db, hash)` queues the first enabled provider whose
job has not ended `no-coverage`. The engine claims atomically
(`updateMany` on a still-claimable row, like §6.2), then runs the job on
the height field's derive queue (`serialisedDerive`), so one derive of
either kind runs at a time per instance. A job: the cap check on the
stored summary; `documentPaperFrame(db, hash, 0)` (§4.6, the source
fallback included); the extent (map-terrain §7.3); the provider's tiles
read by range on the main thread (§7.2); then a worker of its own
(`dem-worker.ts`) builds the paper grid, `deriveAnchoredTerrain` and the
ground field, and returns both encoded; the window buffers are
transferred, not copied.

**Memory, measured** (map-terrain §7.7, the corpus with T2's local
tiles): added peak 23–35 MB on the crops and the sprint, 198 MB on
club-2026, 1010 MB on club-full (41 s), at the 2 m overview — the order
of the contour derive's (840 MB on club-full) and serialised with it, so
the 4 GiB sizing (`ops/deploy-gcp-cloud-run.md`) holds. The windows read
(up to 64 M cells, 256 MB, refused above) are on the main thread until
they are transferred to the worker.

**Descriptor.** `course.mapMetadata.terrain` and `mapImport.review.terrain`
gain `dem` (their other fields unchanged); it reads the job and row
tables only, never waits:

| `dem.state` | When | `provider` | `ground` / `anchored` |
|---|---|---|---|
| `disabled` | no provider enabled on this instance | null | null |
| `unavailable`, `reason: "rotation-corrected"` | the event's pin has a `rotation_correction ≠ 0` (`course.mapMetadata.terrain` only, map-terrain §7.0 answer 2; the import review describes the document, whatever any pin's correction) | null | null |
| `pending` | the first enabled provider not ended `no-coverage` has no job yet, or it is queued or running | its `HeightFieldProvider` | the routes; `anchored.decided` null — fetching one queues the job |
| `ready` | that job is `done` | the anchored row's `HeightFieldProvider` (licence, attribution; `resolutionM` the level read, map-terrain §7.0c answer 12), the registry's if the row's block is missing or another id | the routes; `anchored.decided` = the anchored row's `share.decided` |
| `failed` / `unavailable` | that job ended so | its `HeightFieldProvider` | null; `reason` |
| `unavailable`, `reason: "no-coverage"` | every enabled provider ended `no-coverage` | null | null |

`dem` is `{ state, reason, provider, ground: { url } | null, anchored:
{ url, decided } | null }`. The viewer's 3D mode offers ground and draws
the anchored field as the map's terrain, and shows the provider's
attribution with either (`docs/map-rendering.md` §5.4 "3D mode" "Surface
(H11)").

**Contract** with `?source=` (`packages/api/src/map-store/heightfield-routes.ts`).
`source` absent or `contours` is the table above, unchanged. In order:

| Condition | Status |
|---|---|
| `source` neither `contours` nor `ground.<id>` / `contours.<id>` (`^(ground|contours)\.[a-z0-9][a-z0-9-]{0,47}$`) | 400 `{error}`, with the hash and `v` checks |
| §4.2 predicate fails | 401 / 403 |
| no such document; `v` not current | 404 as above |
| the source's provider is not enabled on this instance | 404 `{error, reason: "source"}` |
| `If-None-Match` matches `"<hash>/height/<source>/<version>"` | 304 |
| the row exists | 200, as above |
| no job (it is queued now), or queued / running | 503 `{error, reason: "pending"}`, `Retry-After: 15` |
| `done` without its row | the job is queued again; 503 pending |
| `unavailable` | 404 `{error, reason}` |
| `failed`, retried | 503 `{error, reason}`, `Retry-After` until `next_attempt_at` (at most 6 h) |
| `failed`, final | 404 `{error, reason}` |

The headers on 2xx / 304 are as above with the source in the `ETag`.

## 5. Chunked upload: `/api/map-uploads`

07 §7. Browsers upload map files in slices so a 100 MB OCAD file survives
a flaky venue connection and never has to fit one request body or a
base64 string. `packages/api/src/map-store/upload-routes.ts`; pure rules
in `uploads.ts`.

### 5.1 Contract

```
POST /api/map-uploads                      {fileName, bytes, chunkBytes}       → 201 {uploadId, chunkCount, chunkBytes}
PUT  /api/map-uploads/:id/chunks/:n        application/octet-stream body       → 204
POST /api/map-uploads/:id/finalise                                             → 200 {fileHash, bytes, deduplicated}
```

Scope comes from the headers: with `x-event-id` (or `x-competition-id`)
the upload belongs to that event; without, it is a club-library upload.
Limits: `bytes ≤ 128 MiB`, `chunkBytes ≤ 8 MiB` (required), **at most 4096 chunks
per upload** (`MAX_UPLOAD_CHUNKS`: `ceil(bytes / chunkBytes)`; there is no
floor on `chunkBytes` itself), chunk
bodies capped at `chunkBytes + 64 KiB` by Fastify's `bodyLimit`.

| Condition | Route | Status |
|---|---|---|
| auth on, anonymous | all | 401 |
| event scope without `courses.edit`; club scope without a user | all | 403 |
| unknown event / upload id not a UUID or not found | init / chunk, finalise | 404 |
| missing or non-positive `fileName`/`bytes`, `chunkBytes` missing or > 8 MiB | init | 400 |
| more than 4096 chunks (`chunkBytes is too small for this file: at most 4096 chunks per upload`; checked after the 413) | init | 400 |
| `bytes` > 128 MiB | init | 413 |
| `n` out of range, body size ≠ expected size for `n` | chunk | 400 |
| first chunk is neither OCAD nor OMAP | chunk 0 | 415 |
| upload already finalised | chunk | 409 |
| chunks missing | finalise | 409 `{missing: [n…], missingCount}`: `missing` names the first 100 (`MISSING_REPORT_LIMIT`), `missingCount` is the whole count |
| row declares more than 4096 chunks (inserted around init's check) | finalise | 400 `Upload has too many chunks; start a new upload`, before any chunk is read |
| kind never sniffed (chunk 0 never arrived) | finalise | 415 |
| assembled size ≠ declared | finalise | 400 |

Chunks may arrive in any order and may be re-sent (upsert); the client
retries per chunk. Kind is sniffed from chunk 0 (`AD 0C` OCAD magic;
`<map` + `openorienteering` for OMAP) and stored on the upload row so a
mistaken file is rejected before the rest is sent. Finalise concatenates
the chunks in order, hashes them (SHA-256 → `fileHash`), writes the
`map_sources` row with `createMany … skipDuplicates` (`deduplicated: true`
when the bytes were already there), stores `finalised_hash` and deletes
the chunk rows. Finalising twice returns the same 200. Uploads never
finalised are deleted after 24 h by housekeeping (§6.6).

The route only produces a source; importing it is the caller's next
step — `course.applyUploadedMap {fileHash, fileName?}` for an event,
`clubMap.addFromSource {fileHash, fileName?, name?}` for the library.
Both take OCAD and Mapper sources since E5 removed the upload's OCAD
parse and its dual writes (`docs/map-import.md` §2.2); the web's file
pickers still offer `.ocd` only until a UI row widens them. `fileName`
overrides the name recorded on the
upload — the source row keeps whatever the first uploader called it, so
the event's `map_files.file_name` and the version label come from the
request, not the shared row.

**Possession (API-17 / MAP-4).** A source is content-addressed and global, so
quoting a hash must not be enough to turn someone else's file into a library
map or an event map (that would sidestep the download rule of §4.4). With
login on, both calls first run `assertMayConsumeSource`
(`map-store/source-possession.ts`): the caller is an instance admin, or has a
`map_uploads` row with `finalised_hash = fileHash` and `uploaded_by` = the
caller (any event scope). Finalise records the hash even when the bytes
deduplicated onto an existing source, so uploading the same file again is
always the way in; upload rows live 24 h (§6.6), so the proof is "uploaded it
within the last day". Otherwise `FORBIDDEN` "Upload the file again". The
uploader of the library version a job creates is the job's `started_by` (the
caller), not the source row's first uploader, and `createClubMap` no longer
rewrites it afterwards. `AUTH_MODE=off` skips the check.

### 5.2 Client

`packages/web/src/lib/map-upload.ts`. Every map upload — `MapPanel` and
the club-library settings page, whatever the file's size — goes through
the chunked routes; a file under 8 MiB is one chunk (three requests). The
base64 tRPC mutations (`course.uploadMap`, `clubMap.upload`) were removed
in E5. `uploadMapFileChunked(file, {eventNameId?, onProgress?, signal?})` runs
init → 4 chunks in flight (`File.slice()`, 3 retries each on network
errors / 5xx / 408 / 429, none on other 4xx) → finalise and resolves with
`{fileHash, bytes, deduplicated}`; the caller then applies the hash.

## 6. Import jobs

07 §8. An import is a `map_import_jobs` row, not an in-process object:
anything that polls it can also finish it, so a restart or a second API
instance loses nothing. `packages/api/src/map-store/jobs.ts`.

### 6.1 Lifecycle

```
startImportJob(db, {sourceHash, eventId? | clubMapId?, startedBy?, patch?, colour?, holdMs?})
  │
  ├─ decisions = club_symbol_decisions for the source's kind (docs/map-symbols.md §8.5)   → the row's `decisions`
  ├─ patch = the version patch to bake (docs/map-patches.md §5; default [])                → the row's `patch`
  ├─ colour = the caller's, else the target's map_colour_settings row — a club map's       → the row's `colour`
  │   series' (also for a promote), else the event's for this source — else the defaults
  │   (docs/map-symbols.md §9.3 "Per map (row I6)")
  │
  ├─ a map_documents row exists for (sourceHash, importer ∈ {ocad-12, omap-6}, library *@<current SYMBOL_LIBRARY_VERSION>)
  │   with the same patch (null ≡ []) that follows `decisions` and `colour` (newest first)
  │     → touchDocument, insert state=done with that document_hash, applyJobResult, thumbnail (§4.5), return;
  │       the height field (§4.7) is started, not awaited                                   (06 §8 dedup, no import worker)
  │
  └─ insert state=queued → kickImportJobs → hold ≤ holdMs for the result → return the row

kickImportJobs: one loop per instance
  claim (atomic updateMany: queued, or running with heartbeat older than 60 s)
  → running, claimed_by = INSTANCE_ID, stage parse
  → worker thread: parse → normalise → match → bake the patch → encode (stage + progress written at each boundary,
  → store: storeImportedDocument (§3)                 heartbeat every 10 s while it runs)
  → applyJobResult: pins (§6.4)
  → derive: thumbnail row (§4.5), then the height-field row (§4.7); a failure of either is logged, never fails the job;
            then the DEM job is queued, not awaited (§4.7 "The DEM"; a no-op without enabled providers)
  → done | failed(error)
```

| `state` | meaning |
|---|---|
| `queued` | inserted, not yet claimed |
| `running` | claimed by `claimed_by`; alive while `heartbeat_at` is < 60 s old; `attempts` counts the claims |
| `done` | `document_hash` set, pins applied |
| `failed` | `error` set (≤ 2000 chars); `IMPORT_ABANDONED: …` for a job given up after its third claim went silent (§6.2 "Attempt limit"); `DAMAGED_FILE: …` for a map file the reader cannot follow to its end (`docs/map-import.md` §3.6; the parse timer below); `UNSUPPORTED_FORMAT: …` for a source whose `kind` is neither `ocad` nor `omap` (unreachable from the upload routes, which sniff), the importer's message otherwise |

**Decision snapshot.** The club symbol decisions are an input to the
document bytes, so they are read once, when the row is inserted, and
stored in `decisions` (`SymbolDecision[]` as stage 6 takes it, sorted;
camelCase like `header` / `report`). The worker imports with exactly that
list, so a re-claimed job produces the same document even if somebody
decided in between; a decision made after the insert applies to the next
job. A malformed value imports without decisions rather than failing.
The **patch snapshot** is the same kind of input: the version patch the
store stage bakes (`docs/map-patches.md` §5.2), set by the caller from the
version or the document being replaced (§5.5 there) and stored in
`patch`, so a re-claimed job bakes the same layers; the stored document
records it in `map_documents.patch`, and dedup reuses only a document of
the same patch.
The **colour snapshot** (row I6) is the map's colour setting
`{ order, deviations }` (`map-store/colour-settings.ts`), normalised (an
override equal to its default is dropped, keys sorted) and passed to stage
7 as `{ colourOrder, deviations }` (`importMapToDocument(…, { match })`,
`docs/map-import.md` §2.2). A job with a target reads its map's row; a job
without one (`decide`, `setColourOrder`, the colour picture) is given the
setting by its caller — `decide` and the CRT import pass the reviewed
document's own (`colourSettingsOfReport`), so deciding on a document in
the map's own order stays in it. `{}` (a row an older image inserted)
reads as the defaults. Dedup reuses only a document that follows that
setting (`documentFollowsColour`): its report says it was built so
(`reportFollowsColour`: the same order, and in `iof` the same overrides
among the deviations it lists; the header records only the outcome,
`map-document-format.md` §2), or a setting recorded for it in
`map_document_colour_settings` matches — every finished job records the
setting it imported with there, after the store (row I7: an override that
changes no bytes gives a hash whose report is the first import's).
The dedup short-cut uses the same list: a stored document is reused only
if `documentFollowsDecisions` holds for it — re-importing it now would
apply exactly the decisions it records — so a decision or a `reset`
makes the next import produce (or find) the right document. A report
without `explicit` matches and an empty decision list needs no header
read; otherwise the check reads the header (two range reads, §4.5).

`startedBy` is the signed-in user whose request started the job:
`applyEventMap` takes it as its own option (`applyUploadedMap` and
`useClubMap` pass `ctx.user` — for `useClubMap` that is not the library
row's uploader), `addFromSource` passes `ctx.user`, the re-match (§6.9)
passes nothing. It feeds the fourth clause of §4.2 and, for a library
job, the new `club_map_versions.uploaded_by` (§6.4; the caller proved
possession of the bytes, §5.1 "Possession", so the version is theirs, not the
first uploader's of the shared source row).

A dedup hit, and a worker run whose document row already existed
(`storeImportedDocument` reports `deduplicated`), touch the document
before pinning it, so a GC run racing the pin sees a fresh
`last_referenced_at` and skips the row (§8.2).

`stage` ∈ `parse 0.1 → normalise 0.4 → match 0.55 → encode 0.7 → store 0.9 → derive 0.95 → done 1`;
`progress` is that fixed ladder, not a byte count. The `derive` stage
holds the job until the height field is stored (seconds; club-full
about 19 s, §4.7), so a large map's upload response may come back
`running` where it used to be `done`; the heartbeat keeps running. The
dedup short-cut is not bounded by `holdMs` (it runs inside the request),
so it does not wait for the height field: for a document stored before
H4, or one whose derive failed, the derive is started and the request
returns; the row lands shortly after, or the route derives it. Every progress and
terminal write is guarded by `claimed_by = INSTANCE_ID`, so an instance
whose job was re-claimed after a stall cannot overwrite the new owner's
state. Re-runs are deterministic (`docs/map-import.md` §6): a re-claimed
job produces the same document hash.

The worker has two clocks: `JOB_TIMEOUT_MS` (10 min) for the whole run, and
**`IMPORT_PARSE_TIMEOUT_MS` (120 s)** for the parse stage alone: it starts with
the worker and is cleared when the worker reports `normalise`; if it fires the
worker is terminated and the job fails with `DAMAGED_FILE: the map file could
not be read within 120 s; it is probably damaged.` (MAP-3, a reader stuck in a
damaged file). The stage callback's progress write is fire and forget
(`reportStage`): a failed write is logged, never an unhandled rejection
(MAP-6).

### 6.2 Engine

The poll is the engine. `mapImport.status` calls `kickImportJobs` whenever
the job it reads is claimable, so a job orphaned by a crash resumes on the
next status request from any client. For unattended instances
`startImportJobEngine` (started in `index.ts`) ticks every 60 s: kick,
then housekeeping (§6.6). One worker runs per instance at a time; jobs
are taken oldest first.

**Attempt limit (MAP-5).** Every claim adds one to `attempts`
(`attempts + 1` in the claiming `updateMany`). A `running` job with a stale
heartbeat is re-claimed only while `attempts < IMPORT_MAX_ATTEMPTS` (3); the
same filter applies to the pick (`nextClaimable`). Before each pick
`failExhausted` fails the stale `running` rows with `attempts ≥ 3`, each with a
guarded `updateMany`: `state = failed`, `error = IMPORT_ABANDONED: the import
stopped the server on each of 3 attempts and was given up. The file was not
imported.` A promote job (§6.4) has its pending version removed as `execute`
does (`abandonPromote`); the waiters are notified. `isClaimable` is false for
such a row, but the status poll and `awaitImportJob` kick on `needsKick` (queued,
or `running` with a stale heartbeat), so the poll settles it. A job that merely
has a slow worker keeps its heartbeat and is never counted again; a redeploy
that interrupts a job costs it one attempt.

`startImportJob` holds the request open up to `holdMs`
(default 30 s, `MAP_IMPORT_HOLD_MS`) waiting for the terminal row, so the
common small-map case returns `state: "done"` in the upload response and
the UI needs no polling. Larger maps return `running`; the client polls
`mapImport.status`. A ten-minute worker timeout terminates a runaway
import and fails the job.

### 6.3 Worker

`import-worker.ts` runs `importMapToDocument` for the source's `kind`
with the job's decisions and patch (the bake runs inside the `encode`
stage, `docs/map-patches.md` §5.2)
(with `onStage` posting `parse` / `normalise` / `match` / `encode`) and
`buildImportReport`, and posts the
document bytes, hashes and report back. It is launched with
`new Worker(bootstrap, { eval: true })`: when the API runs from TypeScript
(`tsx watch`, vitest, the E2E stack) the bootstrap registers
`tsx/esm/api` inside the worker before importing the `.ts` body — tsx's
loader does not reach `worker_threads` on Node 20 — and from `dist/` it
imports the `.js` body directly (`worker-bootstrap.ts`, shared with the
print worker, `course-print.md` §8.2). The worker is terminated as soon as it
settles.

The height field (§4.7) is derived in a worker of its own,
`heightfield-worker.ts`, started the same way by `heightfield.ts` for
stage 10, the dedup short-cut and the route alike — not inside the
import worker, which has already been terminated when stage 10 runs.

### 6.4 Pins (`applyJobResult`)

Idempotent; also run for dedup hits:

- `eventId` set → `map_files.document_hash = hash` on every row of that
  event with `source_hash = job.source_hash`, and the quick-access
  columns `scale`, `bounds`, `north_offset`, `calibration` on each of
  those rows recomputed from `map_documents.header` (unitsPerMm,
  mapScale, georeferencing, bounds) and `report.north.meridian`, with
  the row's own `rotation_correction` (`writePinnedMapFileColumns` over
  `documentMapFileColumns`, `map-store/event-document.ts`; rules in
  `docs/map-import.md` §3.8). Since E5 the pin is the only writer after
  an upload (the upload no longer parses the file), so it takes the
  rules the upload's parse had: a document whose header has `crs: null`
  gets its CRS from the source's ScalePar (the one source read, §4.6),
  a report without `north` (a pre-`ocad-5` / `omap-2` document) gives
  tilt 0, and a frame nothing projects writes the scale alone.
  `applyMapRotationCorrection` writes the same columns through the same
  function (decision log 2026-10-19, A11; 2026-11-07, E5).
  `north_detection` is not written. Then the event's positioned controls get their
  `lat` / `lng` from the pinned frame
  (`synchronizePositionedControlCoordinates`, `event-crs.ts`): the upload
  no longer converts them before the pin exists, so an import that
  outlives the upload's hold still ends with correct positions. Last,
  the event's map patch is re-keyed onto the pinned document
  (`reresolveEventPatch`, `docs/map-patches.md` §4.4; row G11): its ops
  follow their objects, what cannot follow is kept as unresolved. A
  failure there is logged and leaves the patch dormant; it never fails
  the pin.
- A club version is its source **and** its patch (`docs/map-patches.md`
  §5 answer 1): the club half finds the series' versions of the job's
  source whose `patch` equals the job's (null ≡ `[]`, key order ignored),
  not one per `(clubMapId, source_hash)`.
- `clubMapId` set, no such version and the job's patch empty → insert one with `seq = max + 1`, label copied
  from the source row and **uploader = the job's `started_by`** (the source
  row's uploader only when the job has none, e.g. the backfill). With a
  non-empty patch nothing is created
  (promote creates its version, `docs/map-patches.md` §5.3) and a warning
  is logged. `clubMap.addFromSource` then overwrites only the label with the
  request's name when the job finished within the hold, since the source row
  keeps the first uploader's name; the uploader is never rewritten after the
  fact.
- `clubMapId` set and that version exists → its `document_hash` follows
  the job's document (an in-place update; `seq`, label and uploader stay;
  every matching version, though a series has one per patch).
  An edition is the uploaded *file*; its document is that file's latest
  import — a reviewed one (`finalise`, §6.8) or a re-matched one (§6.9).
  Events that used the edition keep the document they pinned
  (`map_files.document_hash`, 06 §6 copy-on-use); moving them to the new
  document stays an explicit "update to latest". Readers of a version
  must not cache its `document_hash` as if it were immutable; the hash
  itself is.
- Both set with a non-empty patch — a **promote job**
  (`docs/map-patches.md` §5.3) → the club half above (the promoted
  version moves onto the baked document), then the event half is
  `completePromote` instead of the plain event pin: under the patch row
  lock, only while the event's rows of the source still name the base
  version, the promoted ops removed from the event's patch and the rows
  pinned to the document and the new version; then the quick-access
  columns, the controls and re-resolution as above (§5.4 there). A failed
  promote job deletes its version (`abandonPromote`).
- Neither set (a `decide` job, §6.8) → nothing is pinned.
- `touchDocument(hash)`.

`finalise` (§6.8) calls the same function with the reviewed document as
`documentHash`, so a review pins exactly as an import does.

### 6.5 Club library on the series

The club library (`clubMap.*`, `course.useClubMap`, Settings → Maps and
the event map panel's **From club library** picker) reads and writes the
`club_maps` series and its `club_map_versions`. The library id the
client sees is `club_maps.id` (a UUID). The legacy library table
`club_map_files`, which every series once mirrored for rollback, was
dropped in E5 once its guard had checked that every row had a series.
`clubMap.list` never starts an import: a read does not create series.

```
clubMap.list → [{
  id,                      club_maps.id
  name, colorProfile, colorOverrides, northLinesBelow, rotationCorrection,   the series
  createdBy, createdAt,    club_maps.created_by / created_at
  version: {id, seq, label, sourceHash, documentHash, uploadedAt, uploadedBy,
            layers, corrections} | null,   latest seq; layers / corrections: its promoted correction layers and ops (0 for an upload)
  versionCount,
  importJob: {id, state, error} | null,   newest job of the series, only while version is null
  fileName,                version label, else map_sources.file_name of the version (or the job's source);
                           a promoted version (layers > 0): map_sources.file_name (its label is the promote's free text, G12b)
  sizeBytes,               map_sources.size_bytes of the same source
  scale,                   map_documents.header.mapScale of the latest version, else null
  uploadedAt, uploadedBy, uploader {email, displayName},   the version's, else the series creator's
  previewUrl,              /api/map-documents/<documentHash>/thumbnail.png (§4.5), else null
  bounds, northOffset,     the version's header + report.north tilt under rotationCorrection (§4.6)
  northDetection, meridianStalenessDeg,   the version's report.north; staleness for today
}]                         ordered by club_maps.created_at desc
```

**The card** (Settings → Maps, `SettingsPage.tsx`; row G12b): the
series' name, file, size, scale, uploader and time; the version line
(`library-map-version`, `data-seq`, `data-corrections`): *Version n*, a
promoted version's label (`library-map-version-label`) and, with
corrections, the note "Original file; n corrections applied by Oxygen"
(`library-map-corrections`, `docs/map-patches.md` §5 answer 8). For a
promoted latest version, its uploader or an admin (`AUTH_MODE=off`
allows) gets *Delete version n* (`library-map-delete-version`), which
confirms (`library-version-delete-confirm`) and calls
`clubMap.removeVersion`; a refusal (`VERSION_NOT_LATEST`,
`VERSION_NOT_PROMOTED`, `PATCH_PROMOTING`) is said in the dialog
(`library-version-delete-error`).

`colorProfile`, `colorOverrides` and `northLinesBelow` are the series'
stored settings (`club_maps` columns, not part of the E5 drops); since
E4a nothing draws with them, no procedure changes them, and since E5
`useClubMap` no longer copies them (the event's colour columns are
gone). A series without a version has no preview: the card shows an empty
frame while its import runs and the list polls until the version lands
(the OCAD-rendered PNG preview, `/api/club-map-preview/:id`, went in
E4a).

`documentHash` is read on every call: a version's `document_hash` is
updated in place when its file is reviewed or re-matched (§6.4), so the
card's thumbnail follows the latest import and nothing here caches it.

| Procedure | Series side |
|---|---|
| `addFromSource {fileHash, fileName?, name?}` | `club_maps` row (`rotation_correction` 0), `startImportJob {clubMapId}` on the finalised source (§5) → version 1 (§6.4); returns `{id: club_maps.id, name, fileName, sizeBytes, rotationCorrection, meridianStalenessDeg, importJob}`, the staleness from the version's `report.north` when the job finished inside the hold. OCAD and Mapper sources (§5.1) |
| `rename {id, name}` | `club_maps.name` |
| `setRotation {id, degrees}` | `rotation_correction`; returns `{success, rotationCorrection}` (the list derives extent and north from it, §4.6) |
| `remove {id}` | deletes the series: versions cascade, `map_files.club_map_version_id` of events that pinned one is set `NULL`, jobs cascade |
| `removeVersion {id, versionId}` | deletes the latest version when it is a promoted one (`docs/map-patches.md` §5.6): its `uploaded_by` or an admin; `VERSION_NOT_LATEST`, `VERSION_NOT_PROMOTED`, `PATCH_PROMOTING` while its promote job runs; events on it keep their document with `club_map_version_id` set `NULL` |
| `download {id}` | the latest version's `map_sources` bytes, named by the version label (else `map_sources.file_name`) — the original file also for a promoted version (`docs/map-patches.md` §5 answer 8), which is named by `map_sources.file_name` (row G12b: its label is free text, the event's name, with no file extension; decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17) |
| `course.useClubMap {clubMapId}` | the series' rotation correction and the latest version's source (by hash, no bytes copied) **and its patch** (the import bakes it; dedup finds the version's document) **and its colour setting** (row I6: the series' `map_colour_settings` row copied to (event, that source) before the import, or the event's row for it removed when the series has none; later changes on either side do not travel); the event's map file named by the version label, a promoted version's by `map_sources.file_name` (row G12b, as `download`); then `map_files.club_map_version_id` = that version on the event's rows with its `source_hash` |

The base64 `clubMap.upload` went in E5 (the web uploads chunked, §5.2),
and with `club_map_files` its write-through to every mutation above.

- **Blobs.** `remove` deletes no `map_sources` or `map_documents` row and
  calls no `deleteBlob`. Event copies keep their own `source_hash` /
  `document_hash` (copy-on-use); a document nothing references any more
  is collected by the GC after the grace (§8).
- **Authorisation.** `addFromSource` needs the caller's own upload of the
  bytes (§5.1 "Possession"). `remove` is allowed for `club_maps.created_by` or an
  instance admin; `download` for the version's `uploaded_by` or an admin
  — the club clause of the source route (§4.4); `AUTH_MODE=off` skips
  both. Upload and rename carry no owner check, as before
  (`system/club-library.md`).
- **No version yet.** A series whose import failed, or is still running
  past the hold, is listed with `version: null` and its `importJob`.
  `download` and `useClubMap` answer `PRECONDITION_FAILED`: an event pins
  a version (06 §6), and a failed club import must not become an event
  map. The picker shows the entry disabled with its import state; the
  fix is uploading the file again (a new series).
- `remove` while the series' import is still running cascades the job
  row away; the worker's `applyJobResult` then fails on the
  `club_map_versions` foreign key and logs the job as failed. Nothing is
  left behind; the document, if stored, waits for the GC.
- `NOT_FOUND` for an unknown id; `BAD_REQUEST` (Zod) for a malformed one.
- Versions after the first come from promote (`docs/map-patches.md` §5):
  the same source with correction layers, `seq` 2, 3, …. There is still
  no "new edition" upload, so every version of a series shares version
  1's source (06 §6).

### 6.6 Status API and housekeeping

```
mapImport.status {jobId}          authed; event jobs require courses.view on the event
  → {id, state, stage, progress, sourceHash, documentHash, error, eventId, clubMapId, createdAt, updatedAt, report}
mapImport.latestForEvent          coursesView; newest job for the current event or null
```

`report` is the stored document's import report (§3), present once the
job is done. Housekeeping (`sweepImportHousekeeping`, 07 §4.4): uploads
older than 24 h — abandoned or finalised; a finalised row has no use once
the client holds the hash, and it is not a GC reference (§8.1) — and
`done` / `failed` job rows not updated for 7 days, are deleted on each
engine tick and as the GC's last pass (§8.2).

### 6.7 Backfill of pre-pipeline rows (retired in E5)

09 slice A. Rows written before this chapter existed had bytes but no
document: `club_map_files` without a `club_maps` series, and `map_files`
with `document_hash IS NULL` in live events. `map-store/backfill.ts`
walked them one map at a time — the club row's bytes to a source, a
series copied from the row, an import job for version 1; the event row's
`file_data` to a source and a job pinning it — with two front ends,
Settings → Maintenance → **Map documents** (`mapImport.backfillStatus` /
`backfillStart`) and `pnpm map:backfill`. Production ran it for slice A
and E0 verified every live row sourced and pinned
(`docs/releases/slice-e.md` §0).

E5 removed it with the tables it walked: there is no `file_data` left to
read. Its two remaining uses moved:

- **A live event's map without a document** (an import that failed or
  never ran): `pnpm map:rematch` imports every live sourced row without a
  document (§6.9, reason `unpinned`). The map panel asks the user to
  upload the map again (`MapImportState`).
- **A per-event dump written before v0.6.1**: its `map_files` section
  carries the bytes in `file_data`; `packages/api/scripts/restore-legacy-map-files.sql`
  makes them sources and the rows that pin them, and the re-match imports
  them (§7.3).

Up to v0.6.0 the backfill is still in the image: the E5 migration's guard
names it (`scripts/gcp/backfill.sh` on the v0.6.0 image) as the fix for a
live map without a source.

### 6.8 Review, decide, finalise

06 §5.1 sketched the review round in front of the pin: import → review →
decide → finalise links. Here the import job still pins the matcher's
output at once (§6.4) — an event map is usable the moment it is uploaded,
and accepting the defaults is a no-op (06 §5.1) — and the review round
runs *after* it, on any stored document:

```
mapImport.review   { documentHash, clubMapId? }   rows + stack + report + terrain + colour (docs/map-import.md §2.2; terrain §4.7;
                                                  colour: the panel, docs/map-symbols.md §8.7 — the map is clubMapId,
                                                  else the event of x-event-id; `current` also needs its colour setting)
mapImport.decide   { documentHash, decisions }    club_symbol_decisions writes (packages/api/src/map-store/decisions.ts)
                                                  → startImportJob { sourceHash, startedBy, patch } — no target;
                                                    patch = the reviewed document's (docs/map-patches.md §5.5)
                                                  → the reviewed document, stored, unpinned
mapImport.finalise { documentHash, target }       applyJobResult with that document: event rows of the source,
                                                  or the club map's version of the source (§6.4, in place) —
                                                  of the document's patch: a row (its pinned document's patch, or
                                                  unpinned its club version's) or version of another patch is
                                                  `source-mismatch`
mapImport.exportCrt / importCrt                   the decisions as a Mapper CRT and back; the import resolves
                                                  to decide's list and runs decideOnDocument (map-symbols §8.6)
mapImport.setColourOrder { documentHash, order,   the map's colour order (row I6, docs/map-symbols.md §9.3): written on the
                           target }               target's map_colour_settings row — the club series, or (event, the
                                                  document's source) — then startImportJob { sourceHash, startedBy,
                                                  patch, colour } — no target, as decide; finalise pins the result
```

`decide` and `importCrt` pass the reviewed document's own colour setting
(read from its report), so a decision on a document in the map's own
order gives a document in that order. `setColourOrder` checks its target
as `finalise` does (404 for no map or an unknown series, 412 when the
target holds another source) and takes the same permission as `decide`
and `finalise`: the document's `EDIT_ACCESS` and, for the event,
`courses.edit`. The setting is written at once: a re-match moves a pin
whose document is in another setting (§6.9) even if **Use this version**
was never pressed (decided overnight on the user's standing instruction,
2026-11-17, for review). The write and the job are one function
(`changeColourSettings` in `review.ts`) that row I7's `setDeviation`
reuses with another change.

```
mapImport.setDeviation { documentHash, key,       one deviation override (row I7, docs/map-symbols.md §9.3 "Overrides"):
                         choice, target }         keep | drop a key the document's report lists (else 400), or default
                                                  (removes the key); changeColourSettings with withDeviationChoice —
                                                  setColourOrder's target, permission and errors
```

- A decide job is an ordinary row (§6.1) with `event_id` and
  `club_map_id` null: it holds the document for the decider (§4.2 own-job
  clause) and against the GC (§8.1) for as long as the row lives (7 days,
  §6.6); after that an unfinalised reviewed document is collectable after
  the grace.
- There is no `review` job state (07 §4.4 listed one): a
  reviewed-but-unfinalised document is a `done` job without a target.
- There is no source-model cache (`map_source_documents`, 07 §4.1
  "optional"): `decide` re-runs stages 3–8 in the worker — the same time
  as the first import (seconds for an event map, longer for a club-wide
  one; the job is polled like an upload).
- Decisions apply club-wide from the moment `decide` writes them: any
  later import of any file with those symbols (an upload, `useClubMap`,
  the re-match pass) uses them. Existing pins move only through
  `finalise` or the re-match pass (§6.9).

### 6.9 Re-match pass

`packages/api/src/map-store/rematch.ts`, front end
`pnpm map:rematch [--event <nameId>] [--limit n] [--dry-run]`
(`src/cli/map-rematch.ts`; in the image
`node packages/api/dist/cli/map-rematch.js`; `scripts/gcp/backfill.sh
--rematch` on Cloud Run). This pass revisits pins whose document is
**stale** — not what importing its source gives now — and runs an
ordinary import job (§6.1) for each with the pin's target, so
`applyJobResult` moves the pin to the fresh document. Since E5 it also
takes the retired backfill's last job (§6.7): a live event's `map_files`
row with a `source_hash` but no `document_hash` is an item with reason
`unpinned`, imported like the others:

| Stale because (`staleReason`) | `club_map_versions` | `map_files` (events not soft-deleted) |
|---|---|---|
| `importer` — not a current importer (`ocad-3` … `ocad-6`, `omap-1` rows) | re-matched | re-matched |
| `library` — not the current library release (`none` rows, an older release) | re-matched | re-matched |
| `decisions` — does not follow the current club decisions | re-matched | **kept** |
| `colour` — not in its map's colour setting (row I6): the series', or the event's for that source | re-matched | re-matched |
| `unpinned` — a sourced row without any document (E5) | — | imported |

The Demo Competition fixture relies on `unpinned`: its `map_files` row
names the demo map's source and no document, and `scripts/load-showcase.sh`
runs `map-rematch --event demo_competition` after loading it
(`docs/ops/demo.md`, "How the fixture holds the map").

A club edition's document is its file's latest import (§6.4), so all
four move it. The colour setting is the map's own, judged per pin (all
rows read once per run; a document follows it by its report or by a
setting recorded for it, row I7), last: a document stale for another reason is
listed under that one. An event pin stale only by `decisions` and also in
another colour setting is re-matched for `colour`, and the job applies the
current decisions too (decided overnight on the user's standing
instruction, 2026-11-17, for review). An event keeps the document it pinned when only the
decisions changed (06 §6 copy-on-use): moving it is `finalise` or a new
upload. Importer and library staleness is a format migration and moves
event pins too (03 §6.5: a re-match keeps reviewed
rows and re-proposes the rest — the job applies the club decisions,
across releases, `docs/map-symbols.md` §8.5).

Each item re-imports with its patch (`docs/map-patches.md` §5.5): a club
item with its version's, an event item with that of the document it replaces,
an `unpinned` row with its club version's — so a promoted version and the
events on it keep their corrections. There is no staleness reason for the
patch itself (a version is its source and patch; decision log, G12a).
Each document is judged once per run whatever pins it; event pins are
one item per (event, source). Items run one at a time, club editions
first; a failure is reported and the pin left as it was, never an abort.
Everything is keyed by content hash, so a second run finds nothing left
(the integration test checks it). `--event` restricts the pass to that
event's pins and skips club editions; `--dry-run` lists the items with
their reason and writes nothing. Exit 1 if any item failed, 2 on bad
arguments.

Moving an event pin carries its map patch: every item's pin re-keys it
(§6.4), and the pass ends with a **patch sweep** that re-keys every
live event's patch still keyed to another document than its pin
(`docs/map-patches.md` §4.4; `--event` restricts it to that event;
`--dry-run` lists them as `patch` items and writes nothing; a failure is
reported like an item's). Sweep items count in the run's `total`,
`done` and `failed` like the pins'.
Filter regions' document symbol indices (`filter_region` course
objects, `course-layer.md` §8.3) are not re-keyed yet (§9).


## 7. Offline and backups

### 7.1 Devices

The viewer (`docs/map-rendering.md` §5.4) reads a document through
`lib/map-document-cache.ts`; the GL dev page still loads one straight from
the route (`/dev/map-gl-doc?url=/api/map-documents/<hash>?event=<nameId>`).

**Request.** `GET /api/map-documents/<hash>` with the event as
`x-event-id: <nameId>` and the page's kiosk key (`?k=`) as
`x-kiosk-key` — headers, never the query, so the URL is the hash alone:
the service worker's cache key, and a club map pinned by several events is
cached once. The whole document (200) is read; no `Range` and no
`If-None-Match` from the client (the browser's own cache and the service
worker handle revalidation of an `immutable` response). §4.2 decides
access exactly as for any other caller — on the request that fills the
cache: a device keeps a document it has cached after its access is
revoked, until the entry expires or is evicted (inherent in 07 §9.1's
CacheFirst). The request goes through `venueAwareFetch` (G17), so a
venue session reads the document from the box's copy (§7.2), as it reads
every other route; the cache key stays the same-origin hash URL.

**In memory.** One request per hash per session: concurrent callers share
it and get the same `ArrayBuffer`; the last four documents are kept
(`MEMORY_ENTRIES`), older ones are dropped and re-read from Cache Storage.
The header is decoded once (`readMapDocumentHeader`); the body is decoded
in the viewer's worker. A failed request is not remembered, so *Try
again* asks again. Failures are classified for the viewer's message:
401 / 403 `unauthorised`, 404 `missing`, a network error or non-200 while
`navigator.onLine === false` `offline` ("not cached on this device and
the network is unavailable" — 07 §9.1's eviction detection; there is no
app-wide offline banner to reuse), anything else (or bytes that are not a
document) `failed`.

**Service worker** (`vite.config.ts`, Workbox `generateSW`):

| Route | Match | Strategy | Cache | Expiration |
|---|---|---|---|---|
| Documents | same origin, `^/api/map-documents/[0-9a-f]{64}$` | CacheFirst | `map-documents` | 20 entries, 365 days, purge on quota error; 200 only |
| Viewer fonts and text atlas | same origin, `/assets/*.ttf` and `/assets/text-atlas.*` | CacheFirst | `map-fonts` | 16 entries, 365 days; 200 only |

The tile layer's `map-tiles` route (CacheFirst, 2 000 PNG tiles) went in
E4b. Workbox cleans up only its own precaches, so the web deletes that
Cache Storage on start (`dropLegacyCaches`, `lib/legacy-caches.ts`).

The document route matches documents only, not `/thumbnail.png` or
`/symbols/…`: the review page's per-symbol swatches would evict the
documents from a 20-entry cache (07 §9.1 had previews share the route).
Previews keep the browser's HTTP cache and their `ETag`. The fonts (two
Liberation faces, 247 kB) and the MSDF text atlas pages
(`docs/map-rendering.md` §4.10: Latin 675 kB, Cyrillic 222 kB, PNG +
JSON; the Cyrillic page only for documents whose strings need it) are
cached on first use rather than precached, so a device that never opens
a vector map does not download them. The
regex is `MAP_DOCUMENT_PATH_RE`; Workbox stringifies the route function,
so `vite.config.ts` repeats it as a literal.

**App-code copy** (G17). The service worker caches a document only on a
page it controls and for a same-origin request, so the app keeps its own
copy in the same cache: after a 200 the document is put into
`map-documents` under `mapDocumentUrl(hash)` unless it is there already,
and a request that fails without a response (or a non-200 while
`navigator.onLine === false`) reads it back from there
(`ignoreVary`: the route sends `Vary: Accept-Encoding`) before it is
classified `offline`. A first visit, the dev server and a document read
from a venue box are kept that way. Workbox's expiration learns such an
entry on its first CacheFirst hit (`cachedResponseWillBeUsed`), so the
20-entry cap applies to it from then on. Same cache and key: no second
copy, no IndexedDB.

**Prefetch** (07 §9.1 "Prefetch"; G17). When an event page opens
(`useEventOfflineMaps`, mounted by the sync indicator, which every event
page shows) for a user with `courses.view` (the capability
`course.mapMetadata` asks outside a kiosk; a kiosk page has no sync
indicator) and `course.mapMetadata.documentHash` is set,
`prefetchMapDocument(hash, nameId)` makes the one request unless the
document is in `map-documents` already: stored, not decoded, not kept in
memory. Once per hash per session; skipped offline and when the browser
asks to save data (`navigator.connection.saveData`). So a device that has
opened the event has its map, before any map was shown.

**Offline ready** (07 §9.1 "Pinning"; G17). The sync panel's *Maps on
this device* block (`offline-maps`), for a user with `courses.view` on
an event with a map:

| Line | Shows |
|---|---|
| `offline-maps-document` | *Map stored on this device* / *Map not stored on this device* (`isMapDocumentStored(hash)`: in memory or in `map-documents`) |
| `offline-maps-print` | *Print stored {{time}} ({{count}} exports)*, *Print partly stored {{time}}* (`complete: false`), *Print not stored*, or *Printing offline needs a device that can compose PDFs* (`deviceLimit` 0) — the manifest of `course-print.md` §8.6 "Offline" |
| `offline-maps-persisted` | *Storage: kept by the browser* / *Storage: may be cleared by the browser* (`navigator.storage.persisted()`; absent API: the second) |

and **Make maps available offline** (`offline-maps-store`), which runs
the print store step with its progress on the button
(`course-print.md` §8.6 "Offline").

**Pinning.** After the first document loads, the app calls
`navigator.storage.persist()` once per session (absent API or a refusal
is ignored), so Cache Storage survives storage pressure (07 §9.1).

**No IndexedDB copy** (07 §9.1): Cache Storage holds the bytes, the
worker holds the decoded arrays for the session.

### 7.2 Venue checkout snapshot

07 §9.2. A venue box that checks an event out (`lease.checkout`,
`docs/system/offline-architecture.md` "The lease") receives the event's map rows
and the blobs they pin, so the box answers `/api/map-documents/:hash` for
its kiosk and stations from its own tables, under the unchanged §4.2
predicate evaluated against its own event copy.

**Layout rows** (row G18; slice G answer 4, which deviates from 08 §4.8
and from 07 §9.2's "graphics and templates not in the snapshot"). The box
prints from its copy (`docs/course-print.md` §8.7), so `map_templates`,
`course_maps` and `course_objects` (`docs/course-layer.md` §8) travel with
the event's tables (`SNAPSHOT_TABLES`, rows verbatim: UUIDs, `seq`, FKs,
scope UUIDs, JSON, token) although they are cloud-owned and not journaled.
Insert order: templates before classes (`classes.sheet_template_id`),
sheets after courses, classes and templates. On import a class's
`sheet_template_id` or a sheet's `template_id` naming a template the
snapshot does not carry (an exporter that predates G18) becomes NULL —
before G18 a class with a print override made the checkout fail on that FK.
A sheet's JSON-null `window_center` is written as SQL NULL, and so is
a course object's JSON-null `attach` (J10, `NULLABLE_JSON_OBJECT_FIELDS`
in `sync/lease.ts`; the G19 refresh's mirror the same).

**Tokens** (`docs/course-layout.md` §2, `course-layer.md` §8.5). The
rows' `version` is an HLC above 2^53, and the snapshot crosses HTTP as
JSON, where a BigInt becomes a rounded number (`bigint-json.ts`); a box
editor would then send a rounded `baseVersion` to the cloud and get
`CONFLICT`. The exact tokens travel beside the rows as decimal strings,
`versions: { courseObject, courseMap, mapTemplate: { [id]: "…" } }`, and
the importer writes them over the rounded ones. The rows keep their
`version` field, so an importer that predates `versions` still accepts
them (rounded, as before); a row the map lacks keeps what it carries.

**Graphics.** The snapshot's optional `graphics` part carries every
`graphics` row of the event and every club graphic (`event_id` NULL) that
one of the event's layout rows references — an image object's `graphicId`
in a template's or sheet's `objects`, or a course object's
`props.graphicId`. A club graphic nothing references stays behind. Each
entry is `{ id, club, name, mime, sizeBytes, sha256, createdAt,
updatedAt }`, without bytes; `id` is the cloud's (decimal), since the JSON
references graphics by number, and `sha256` is computed by the exporter
(the table has no hash column). The bytes come through `lease.exportBlob`
by id (below).

**What travels.** The snapshot gains an optional `maps` part:

| Part | Rows | Columns carried |
|---|---|---|
| `files` | every `map_files` row of the event with `source_hash IS NOT NULL` | all but `id`, `event_id` |
| `sources` | the distinct `map_sources` rows those rows pin, plus the `source_hash` of every pinned document | `file_hash`, `kind`, `size_bytes`, `file_name` |
| `documents` | the distinct `map_documents` rows pinned by `document_hash` | `hash`, `size_bytes`, `format_version`, `importer_version`, `library_version`, `source_hash`, `header`, `report`, and `patch` only for a document baked with a version patch (`docs/map-patches.md` §5; an older peer's rows have none and store NULL) |
| `decisions` | the whole `club_symbol_decisions` table (`docs/map-symbols.md` §8.5) | `fingerprint`, `library_version`, `canonical_id`, `decided_at` |

The part carries no bytes. The venue fetches each blob it does not
already hold through a ranged peer procedure:

```
lease.exportBlob { table: "map_sources" | "map_documents", hash, start, length ≤ 4 MiB }
               | { table: "graphics", id, start, length ≤ 4 MiB }
  → { base64, sizeBytes }        peerProcedure (shared secret), event-scoped by x-event-id
```

It answers `NOT_FOUND` unless the context event's `map_files` reference
the hash: as `source_hash` or `document_hash`, or (sources) as the
`source_hash` of a document they pin. A graphic it answers only when it
is the context event's own, or a club graphic one of the event's layout
rows references (the `graphics` part's rule); a graphic is at most
8 MiB (J2), so up to two slices (tested in `venue-print.test.ts`). The
snapshot carries no pixel size: the importing box computes `width_px` /
`height_px` from the bytes. The slices are §4.4's
(`SOURCE_SLICE_BYTES`, 4 MiB), read with `getBlob` ranges (§4.3); the
venue assembles them and checks `size === size_bytes` and
`sha256(bytes) === hash` before inserting. 07 §9.2 put the bytes base64
inside the one JSON snapshot; sources reach 36 MB, which would pass
Cloud Run's 32 MiB response ceiling (07 §6.4), so the bytes take the
"second part" 07 §9.2 allowed.

**Import** (`importEventSnapshot`, inside the snapshot transaction, after
the event row): sources, then documents, `createMany … skipDuplicates`
(append-only, §1 — a blob the venue already holds is neither fetched nor
rewritten); then the `map_files` rows with the local `event_id` — each
row's source must be on the box by then (fetched or held) — and on the
venue copy:

- `map_sources.uploaded_by` and `map_files.club_map_version_id` are
  NULL — the box has neither the users nor the club library; both are
  cloud metadata and the §4.2 predicate does not read them for an event
  pin.
- `created_at` / `last_referenced_at` take the venue's defaults: the GC
  (§8) on the box ages its own copies, and the pins keep them while the
  event exists there.
- the fields of a v0.6.0 exporter's rows that E5 dropped (`map_files`
  `fileData`, `fileHash`, `renderKey` and the colour stack;
  `events.mapPipeline` / `overprintCutsVersion`; `courses.geometry` /
  `geometrySource`) are stripped before insert
  (`sync/dropped-columns.ts`), so a v0.6.1 box can check out from a
  v0.6.0 cloud; a v0.6.0 box fills them from their defaults.
- `club_symbol_decisions` rows merge by primary key: the newer
  `decided_at` wins (the order stage 6 reads them in, `map-symbols.md`
  §8.5), `decided_by` is NULL, and nothing is deleted, so a `reset` on
  the cloud does not reach a box that already held the row. The table
  has no event column and its fingerprints need the full document
  header, so it travels whole; it is club-level state, small, and lets a
  box re-match like the cloud would. The box does not write decisions
  (`mapImport.decide` is cloud-owned and forwarded during a lease).

- graphics (`sync/snapshotGraphics.ts`) are fetched before the
  transaction like the blobs: the event's always (the import's event
  delete cascades them), a club graphic only when the box does not hold
  that id with the same SHA-256. Each is checked for size and hash, then
  inserted after the event row under the cloud's id, `event_id` the local
  event's or NULL. A club-library row (`event_id` NULL) in a travelling
  id's place (one a box uploaded outside a checkout) is replaced: the
  box's `graphics` mirror the cloud by id. A row **owned by another event
  on the box** (`event_id` non-null and not the event being checked out)
  fails the checkout with `GRAPHIC_ID_CLASH` and nothing is written,
  unless the operator confirms `lease.checkout { replaceClashingGraphics:
  true }` in the Venue panel (a deviation from G18, decision D10 of
  2026-11-25). `findGraphicClashes` runs right after the snapshot is
  exported, before any bytes are fetched, and the import refuses the same
  way unless the flag is set. The lease-time refresh below does not
  refuse: it skips the clashing graphic (the box keeps the other event's
  row, bytes and name), logs a warning naming it, and applies the rest of
  the refresh, so one clash cannot roll back the whole map refresh every
  cycle. It never sets the flag, so it warns at every refresh until the
  clash is resolved. A re-checkout over the
  event's own copy of a graphic is no clash. The id sequence is then set to the largest id, so a
  graphic uploaded on the box later takes an id past the cloud's.

A blob or graphic that is missing on the peer, or whose hash or size does
not match, fails the checkout; the existing rollback releases the peer
lease, and the event is not checked out. A re-checkout replaces the
`map_files` rows, the layout rows and the event's graphics with the event
(cascade) and leaves the blobs and held club graphics alone.

**Writes during a lease.** Layout and print data stay cloud-owned:
`courseMap.`, `mapTemplate.`, `layout.`, `graphics.` and `courseObject.`
mutations on a box are forwarded to the cloud, and offline answer the
typed 412 (`docs/system/offline-architecture.md` "Non-critical data"), so
nothing edited on a box is lost at checkin. Their reads (`courseMap.list`,
`resolveSheet`, `courseObject.list`, the print routes) answer from the
box's copy, which follows the cloud's (row G19, "Following the cloud
during a lease" below): within the refresh interval, and at once for a
write the box forwarded itself.

**Not carried.** `map_files` rows without a `source_hash` (only a
soft-deleted event's since E5, and a soft-deleted event is not checked
out; the result still counts them as `skipped` for older nodes);
`map_previews` (a cache; §4.5 renders on a miss); `map_heightfields`
(a cache; the box derives its own on the first request, §4.7);
`club_maps` / `club_map_versions`; `map_import_jobs`, uploads; the club
template library (`club_map_templates`; `mapTemplate.listClub` is empty on
a box) and club graphics no layout row references; the event's GPS tracks
(`map_gps_tracks`, `docs/map-gps-tracks.md` §1.3: a box holds none, its
`mapTrack.list` is empty during a lease, and `mapTrack.` writes are
forwarded).

**Map patch** (`docs/map-patches.md` §3.4). The event's `map_patches`
row travels as `maps.patch` — all columns, the token as a decimal string
(an HLC exceeds 2^53 and the snapshot is JSON) — when its document is
among `documents`; a dormant patch (keyed to another document than the
pin) stays behind. The box inserts it verbatim after the `map_files`
rows (its document is there by then; `RESTRICT`), and its route
`GET /api/maps/:nameId/patch` and `mapPatch.get` answer from that copy.
`mapPatch.` writes on a box are forwarded to the cloud; the copy then
follows the cloud's patch like the other map rows (below).

**Following the cloud during a lease** (row G19; 07 §9.2 "Map changes
during a lease", extended — see the decision log). While a box holds an
event's lease and the cloud answers, it makes its copy of the event's
cloud-owned map rows equal to what a fresh checkout would hold:

- **When.** On the settings cadence (`SYNC_SETTINGS_REFRESH_MS`, default
  5 min, `docs/system/offline-architecture.md` "The lease"), right after the
  settings refresh, for every event whose active lease this node holds;
  and once right after the box's forwarder gets a 2xx from the cloud for
  a forwarded `courseMap.`, `mapTemplate.`, `layout.`, `graphics.`,
  `courseObject.` or `mapPatch.` mutation (the event named by
  `x-event-id` or the web's `x-competition-id`), before it replies (bounded:
  after 10 s the reply goes out and the refresh finishes behind it). So a
  box editor's refetch reads its own write with the cloud's token, and
  its next write of the row is not a `CONFLICT`. Refreshes of one event
  run one at a time on a node (a second waits for the first, and runs
  only if the lease is still held then). The cloud reads the export in
  one repeatable-read transaction, so a sheet never arrives without the
  template it names.
- **What travels.** A peer query, `peerProcedure` (shared secret),
  event-scoped by `x-event-id`:

  ```
  lease.exportMapRows → {
    maps,            // the snapshot's `maps` part without `decisions`
    tables: { mapTemplate, courseMap, courseObject },   // rows verbatim
    versions,        // exact tokens of those rows, as in the snapshot
    graphics,        // the snapshot's `graphics` part
    classOverrides: [{ id, printScale, sheetTemplateId }]
  }
  ```

  Each part is built by the same exporter as the checkout's, so the copy
  a refresh leaves is the copy a re-checkout would import. Bytes come
  through `lease.exportBlob` as at checkout. `classOverrides` are the two
  cloud-owned layout columns of every class of the event
  (`docs/course-layout.md` §6, `referenceJournal.ts`
  `CLASS_LAYOUT_FIELDS`: stripped from `class.upserted`, written by
  `layout.setClassOverride` on the cloud).
- **Fetch, then one transaction.** The box fetches every map blob it does
  not hold and every graphic it does not hold under that id with the same
  owner (event or club) and SHA-256, each checked for size and hash,
  before it opens one transaction. Any failure — the cloud unreachable, a
  cloud that predates `exportMapRows`, a blob missing or not matching —
  writes nothing, and the box keeps what it has (offline it keeps serving
  the copy it holds, 07 §9.2). The settings refresh and the map refresh
  fail independently; each failure is one warning per event and cycle.
- **Apply, in FK order.** (1) Blobs, append-only as at checkout. (2) The
  event's `map_files` rows, replaced as a set (delete and create, venue
  NULLs as at checkout) when they differ from the cloud's as a multiset
  — compared without `id`, `event_id`, `club_map_version_id`; nothing
  references a `map_files` id. (3) The patch: upserted by `event_id`
  verbatim, token exact, when the export carries it; deleted when it
  does not (none on the cloud, or dormant after the pin moved — the
  box's route then answers `{ version: "0", patch: null }`, as for a
  dormant row, `docs/map-patches.md` §3.2). (4) Graphics: the event's
  and the travelling club graphics upserted under the cloud's id; the
  event's graphics the export lacks deleted; a club graphic never
  deleted; the id sequence moved past the largest id. (5) Templates,
  (6) the classes' `print_scale` / `sheet_template_id`, (7) sheets,
  (8) course objects, each mirrored by id: rows the cloud lacks deleted,
  new rows created, changed rows updated in place (never delete and
  reinsert: a template delete would null the classes' and sheets'
  references). `UNIQUE (event_id, name)` and the one-auto-template-per-key
  index (`map_templates_one_auto_per_key`) are not deferrable, and one
  cloud edit can move two rows (a key change promotes an extra,
  `course-layout.md` §5): an updated template whose name, `auto_key` or
  `is_extra` changes is first parked under its own UUID as an extra, then
  every update writes the cloud's values. A reference to a
  template the export lacks becomes NULL, as at checkout. A sheet whose
  `course_id` or `class_id` is not on the box (the box owns courses and
  classes during the lease) is skipped and counted, and the next refresh
  tries again. (9) The `event_seqs` counters of `map_templates`,
  `course_maps` and `course_objects` are raised past the largest `seq` of
  the export's rows (skipped sheets included) and the box's, so a row the
  box itself creates later does not collide; a counter already past it is
  not written.
- **What counts as changed.** A layout row is written only when its
  content — every column but `event_id`, `updated_at` and `version`,
  compared as canonical JSON — or its exact token differs; never by
  `updated_at` alone (the box's trigger rewrites it on update) nor by
  token alone (`courseObject.reorder` moves `z` without a token). A
  graphic is written when its owner or hash differs (bytes fetched,
  the row replaced as at checkout) or its name or mime does (updated in
  place; its `updated_at` is then the box's);
  a class only when one of its two columns differs. An unchanged cloud
  means no write on the box.
- **The mirror is exact.** Rows deleted on the cloud are deleted on the
  box, including rows the box wrote itself outside the forwarder: a
  course object `course.importCourses` wrote on the box, or a map
  uploaded on the box (map uploads are cloud-owned,
  `docs/system/offline-architecture.md` "Non-critical data", but not forwarded)
  lasts until the next refresh (Pending, §9).
- **Not touched.** Every race-critical table (`controls`, `courses`,
  `course_controls`, `classes` but its two layout columns,
  `class_course_pools`, `runners`, `teams`, `cards`, `card_readouts`,
  `punches`, `control_units`), the journal and its sync state, the event
  row (the settings refresh's), the `event_seqs` counters of journaled
  tables, and `club_symbol_decisions` (checkout only: the box re-matches
  as of its checkout). The class columns emit no journal entry (they are
  not in `class.upserted`). The box does not run the pin's control
  lat/lng sync (§6.4) when its pin moves: controls are the box's during
  the lease (Pending, §9).
- **Interop.** A cloud that predates `exportMapRows` answers an unknown
  procedure: the refresh logs and the box keeps its copy, as before G19.
  A cloud that predates a part of it is as at checkout (an exporter
  without `graphics` carries none — the box then keeps its graphics).

`lease.checkout` returns, next to `imported` (which now counts
`mapTemplate` and `courseMap` too),
`maps: { files, sources, documents, fetchedBytes, skipped, decisions, patches }`
and `graphics: { rows, fetchedBytes }`.

Both directions interoperate with a node that predates a part: an old
exporter sends no `maps` (the box gets no map, as before), and none of
`tables.mapTemplate`, `tables.courseMap`, `versions` or `graphics` (the
box gets no sheets, templates or graphics, and its classes no print
template); an old importer ignores all of them. An old importer still
fails on a class with a print template, as it did before G18.

**Coexistence (09 §10).** The document travels from slice A on whatever
the event's map pipeline: it was pinned on upload for `legacy` events too
(09 §3: the switch gated reads, never imports), so a box checked out
before E3 already holds what the viewer reads. The retired per-event
switch (`events.map_pipeline`, `docs/history/map-pipeline-switch.md`) was dropped
in E5. A *new* document — a map re-imported on the cloud during the
lease — reaches the box with its source at the next refresh (row G19,
above); offline the box keeps serving the document it holds.

Checkin carries nothing map-related back: documents are immutable and
the venue never writes them.

### 7.3 Per-event dump

07 §10. `GET /api/backup/event` (`docs/ops/backup-restore.md`) emits three
more `\copy` sections, before `map_files` (the blobs in FK order):

| Section | Rows |
|---|---|
| `map_sources` | `file_hash` in the event's `map_files.source_hash` ∪ the `source_hash` of the documents they pin |
| `map_documents` | `hash` in the event's `map_files.document_hash` |
| `club_symbol_decisions` | all (club-level; a restored event's re-match, §6.9, reads them) |

All columns, `bytes` as Postgres `\x` hex in the CSV; `map_documents`
since G12a with `patch` last (`docs/map-patches.md` §5). `map_previews`
and `map_heightfields` are omitted (caches; §4.5, §4.7). The `map_files` section holds no bytes since E5 —
only the pins; the blob sections carry the file.

The event's `course_objects` rows (`docs/course-layer.md` §8.5) are a
plain event-scoped section after `class_course_pools`. Its
`map_patches` row (`docs/map-patches.md` §3.5) is one directly after
`map_files`, restored with `event_id` rewritten like the other plain
sections; the `map_documents` and `map_sources` sections also carry the
patch's document and that document's source, so a dormant patch (keyed
to a document the event no longer pins) restores too. Its GPS tracks
(`docs/map-gps-tracks.md` §1.3) are a `map_gps_tracks` section directly
after `map_patches`, restored by `packages/api/scripts/restore-map-gps-tracks.sql
-v event_id=<id>`: `event_id` rewritten, `created_by` kept only when that
user exists, `ON CONFLICT (id) DO NOTHING`.

`restore-map-blobs.sql` reads the `map_documents` section's header row
(`head -n 1`) and, for a dump written before G12a, loads it without the
`patch` column, which the restored rows then have NULL: `\copy` matches
columns by position and does not interpolate variables, so the temp
table takes the section's shape.

**Restore is idempotent on hash.** `packages/api/scripts/restore-map-blobs.sql`
loads both sections through temp tables with
`INSERT … ON CONFLICT DO NOTHING` on the primary key, so a database that
already holds a blob keeps its row (content-addressed rows are never
updated), and running it twice changes nothing. `uploaded_by` is kept
only when that user exists in the target database, else NULL. Decisions
merge as on the venue (§7.2: newer `decided_at` wins, nothing deleted;
`decided_by` kept only when that user exists). With an
event id it then loads the `map_files` section with `event_id` rewritten
and `club_map_version_id` kept only when that version exists. The rest
of the dump restores as before (`docs/ops/backup-restore.md`).

**A dump written before v0.6.1** has `file_data` (and, before the
pipeline, no hashes and no blob sections) in its `map_files` section, a
column the v0.6.1 schema no longer has. Its blob sections, if any, load
with `restore-map-blobs.sql` as above (without `-v event_id`); its
`map_files` section loads with `packages/api/scripts/restore-legacy-map-files.sql
-v event_id=<id>`: the script builds its temp table from the section's
own header row (the column set differs between releases), refuses a row
whose bytes do not hash to its `source_hash`, makes each row's bytes a
`map_sources` row (`kind` sniffed as the upload route does) and inserts
the event's row pinning it — with the dump's `document_hash` when this
database holds that document for that source, else none. Then
`pnpm map:rematch --event <name_id>` imports every row still without a
document (§6.9, `unpinned`). It replaces the retired
`pnpm map:backfill --event` of 09 §5 (decision log 2026-11-07, E5).
Idempotent, as the blob script.

The download gate is unchanged: a dump whose newest `map_files` row has
`from_club_library` needs an instance admin, because it contains the
club's source bytes (it did before E5 in `file_data`, now in the
`map_sources` section). 07 §10's
documents-only variant for non-admin event managers is not built: a
`map_documents` row cannot exist without its `map_sources` row
(`source_hash NOT NULL`, `RESTRICT`, §2), so such a dump would not
restore (Pending, §9).

## 8. Garbage collection

07 §5. Blobs are never updated and never cascaded away; the collector is
the only code that deletes them (`deleteBlob` semantics, §4.3), and it
deletes only what no row points at. `packages/api/src/map-store/gc.ts`.

### 8.1 What is collectable

| Table | Collectable when | References checked (`NOT EXISTS`) | Age rule |
|---|---|---|---|
| `map_documents` | no reference and old enough | `map_files.document_hash`, `club_map_versions.document_hash`, `map_import_jobs.document_hash`, `map_patches.document_hash` | `last_referenced_at < now − grace` |
| `map_sources` | no reference and old enough | `map_documents.source_hash`, `club_map_versions.source_hash`, `map_files.source_hash`, `map_import_jobs.source_hash` | `created_at < now − grace` |

- `map_files`, `club_map_versions` and `map_patches` reference with `RESTRICT`, so a
  `DELETE` of a blob they still point at fails — the belt. The job
  references are not `RESTRICT` (`document_hash` is `SET NULL`,
  `source_hash` `CASCADE`), so for them the `NOT EXISTS` is the only
  guard: without it the GC would strip a review job of its document, or
  delete a queued job with its source.
- `map_uploads.finalised_hash` is **not** a reference (`SET NULL`;
  finalised rows are swept after 24 h, §6.6). A source between finalise
  and `applyUploadedMap` is covered by the age rule: it is collectable
  only if its bytes were first stored more than `grace` ago and nothing
  has pointed at them since. If such a re-upload races the daily run,
  `applyUploadedMap` answers `NOT_FOUND` ("upload it again") and the
  re-upload stores the row afresh.
- Sources have no `last_referenced_at`; a source loses its last
  reference only when its last document is collected (whose age rule is
  stricter, since `created_at ≤ last_referenced_at`) or when an event /
  club map pointing at it is deleted.
- `map_previews` cascade with their document. They are not truncated by
  age (07 §5 allows it; nothing needs the space yet).
- `map_heightfields` and `map_dem_jobs` cascade with their document too,
  and are not a reference. Rows of a superseded `TERRAIN_VERSION`
  (`version < TERRAIN_VERSION`, every source — `contours` and the DEM's,
  §4.7 — and the DEM jobs) are deleted by pass 4 (§8.2): after a bump
  nothing reads them (the URL names the version, §4.7), and each field is
  up to ~8 MB; a bump re-fetches the DEM lazily. `<`, not `<>`: an older
  image's run during a rollout leaves the newer image's rows alone.

### 8.2 A run

```
runStorageGc(db, { now?, graceDays?, dryRun?, shouldStop? })
  → { graceDays, dryRun, stopped, touched, documents: hash[], sources: hash[], skipped, heightfields, uploads, jobs }
```

1. **Touch** — `UPDATE map_documents SET last_referenced_at = now()` for
   every document a `map_files`, `club_map_versions`, `map_import_jobs`
   or `map_patches` row still references. `touchDocument` is only called
   when a reference is created, so without this a document referenced
   for two years and dereferenced yesterday (event purged, club map
   removed) would be collected on the next run. With it, the grace runs
   from the last daily pass that saw a reference — the dereference, give
   or take a day — which is what "re-attachable for 30 days" (07 §5)
   needs.
2. **Documents** — select the candidates (§8.1), oldest first; then one
   autocommit statement per row:
   `DELETE … WHERE hash = $1 AND last_referenced_at < $cutoff AND NOT EXISTS (…) RETURNING …`.
   The conditions are re-checked by the delete itself, so a reference or
   a touch committed after the candidate query makes that row a no-op
   (Postgres re-evaluates the row's own columns after waiting on a
   concurrent writer). A foreign-key refusal (`23001` for `RESTRICT`,
   `23503` for `NO ACTION` — a reference created in the same instant) is
   caught and counted as `skipped`; the run carries on. `map_previews` go with the row.
3. **Sources** — the same over `map_sources`, after the documents so a
   source freed by pass 2 goes in the same run.
4. **Height fields** — one `DELETE` of the superseded-version rows of
   every source and one of the superseded DEM jobs (§8.1); a dry run
   counts the rows. `heightfields` is the count of rows, in the summary
   line and the stored `last_result`; the DEM jobs deleted are logged.
5. **Uploads and jobs** — `sweepImportHousekeeping` (§6.6).

07 §5 sketched one `DELETE … WHERE NOT EXISTS` per pass. One statement
per row is used instead: an interrupted run (deploy, lost lease) leaves
every row either deleted or untouched and the next run picks up the
rest, and one row that loses a race is skipped instead of failing the
whole pass. `shouldStop()` is checked between rows.

Audit: one server log line per deletion,
`[map-gc] deleted document <hash> (source <hash>, <n> B, last referenced <iso>)`
/ `[map-gc] deleted source <hash> (<kind>, <n> B, "<file_name>")`, and a
summary line per run. There is no `event_log` table (07 §5 named one);
the scheduled run also stores its summary (counts, not hashes) in
`settings`. Recovery from a wrong deletion is the per-event dump.

`dryRun` skips the touch and every delete and returns the candidates
the run would delete; the source candidates are computed as if the
document candidates were already gone.

### 8.3 Schedule

A leader-lease singleton (`docs/system/background-jobs-lease.md`): the
supervisor's `reconcile()` on the lease holder calls
`maybeStartStorageGc()`, which starts a run in the background (the
reconcile loop is not held up) when it is due:

| `settings` key | |
|---|---|
| `map_storage_gc.started_at` | ISO time written when a run starts |
| `map_storage_gc.finished_at` | ISO time written when it finishes |
| `map_storage_gc.last_result` | the summary JSON (counts) |
| `map_storage_gc.grace_days` | optional override of the 30-day default (07 §15); a positive integer, at least 1; anything else is ignored with a warning |

Due (`isGcDue`) when there is no `finished_at` or it is ≥ 24 h old, and
no `started_at` is younger than 1 h and newer than `finished_at` (a run
in progress, or one that crashed less than an hour ago). The timestamps
live in the database, so the schedule survives restarts and leadership
moves; a local timer would never fire on instances recycled more often
than daily. The settings are read at most every 15 minutes per
instance. Losing the lease asks a running GC to stop after its current
row (`stopAll`); a stopped run stores its `last_result` (with
`stopped: true`) and clears `started_at` instead of writing
`finished_at`, so the next leader finds it due at once. Two runs overlapping after a handover are harmless —
every delete re-checks its conditions.

The per-instance engine tick (§6.2) keeps running the housekeeping sweep
every 60 s; the GC's pass 5 is the same idempotent sweep.

### 8.4 Running it by hand

```
mapStorage.gcRun { dryRun? }    admin → the §8.2 summary (hashes included)
```

A manual run does not move the schedule. The Maintenance card 07 §5
mentions is pending (§9).

## 9. Pending in this chapter

A Maintenance card for the re-match pass (§6.9 is CLI-only); re-keying
filter regions' document symbol indices when an event's pin moves (§6.9;
the map patch is re-keyed since G11); a Settings →
Maintenance card for the GC (§8.4: status of the last run, dry run, run
now); of the service-worker routes, `map-documents` and `map-fonts`
(and `print-worker`, `course-print.md` §8.6) are exercised only by the
preview-build smoke (G29, `e2e/offline-print.preview.spec.ts`, §10):
an offline export after a reload, the document and faces answered from
the service worker's caches. The rest of the suite runs the Vite dev server,
which registers no service worker, so there G17's app-code copy (§7.1)
is what is exercised. (The `trpc-api` and `api-misc` routes were removed
in review package 9, SYNC-16; `e2e/outage.preview.spec.ts` checks that no
tRPC answer is cached.) Not exercised end to end: offline navigation
(`navigateFallback`), and a viewer
opened offline from `map-documents` (the smoke prints, it does not draw
the map); `course.importCourses` run on a box still writes its
`course_objects` locally, and a map uploaded on a box still pins it
locally — since G19 both last only until the next refresh (§7.2, the
mirror is exact; forwarding the import's object part and the upload is
a row of its own); the box's positioned controls keep the old frame's
lat/lng when a refresh moves its pin (the pin-time sync, §6.4, is not run
on the box: controls are its own during the lease); `club_symbol_decisions`
reach a box at checkout only;
the documents-only dump variant for non-admin event managers (07 §10,
§15 — not restorable while a document needs its source row, §7.3); the
web's map pickers offering Mapper files (`.omap` / `.xmap`) — the server
takes them since E5 (§5.1); the series' colour-stack columns
(`club_maps.colour_profile`, `colour_overrides`, `north_lines_below`)
and `map_files.north_detection`, which nothing writes or reads since E5
(kept: E5 drops only what its row names); §4.7's DEM for a rotation-corrected pin (a per-pin DEM) and for a
document without contours (no field grid to resample onto); a DEM
backfill for documents stored before a provider was enabled (their job is
queued by the first request for a DEM source, which the descriptor's
`pending` invites, or by a re-import); the Club maps card for promoted
versions (version, label, corrections, the original-file note, delete of
the latest promoted version — row G12b; the API is §6.5 `removeVersion`
and `list`'s `layers` / `corrections`); a venue box's copy of a promoted
version (the snapshot carries `map_documents.patch` for the event's
documents, not `club_map_versions`, as for any version); a map's colour
setting (`map_colour_settings`, row I6) in the per-event dump (§7.3) and
the checkout snapshot (§7.2): neither carries it, so an event restored
from a dump keeps its pinned document but goes back to the IOF order at
the next re-match, and a box imports its own uploads in the IOF order
(decided overnight on the user's standing instruction, 2026-11-17, for
review). Each lands with its own section here and its own tests.

## 10. Tests

| Level | File | Covers |
|---|---|---|
| Unit (api) | `packages/api/src/__tests__/map-colour-settings.test.ts`, `map-import-jobs.test.ts` (I6 part), `map-rematch-cli.test.ts` (I6 part), `map-previews.test.ts` (I6 part), `render/__tests__/previews.test.ts` (I6 part) | row I6: the colour setting parsed (malformed → defaults), normalised, read from a report (fallback, overrides, pre-layers), `reportFollowsColour`; the worker applies a job's setting as the inline import; `staleReason` `colour` last; `:order` parsing and ETag; the picture's window (a small map whole, a large one capped at the densest tile) and both orders over one window, differing |
| Integration (api) | `packages/api/src/__tests__/integration/map-colour-settings.test.ts` | row I6: the table's checks, uniqueness and cascade; `map_import_jobs.colour` default `{}` and check; `setColourOrder` on a club map (the row, the job's snapshot, a `source` document pinned nowhere, `review.current` / `colour.setting`, back to `iof` = the original by dedup); the setting survives a re-match (reason `colour`, then nothing) and a promote (version 2 in the series' order); `useClubMap` copies it; an event's own upload keeps it across a re-upload of the same file, another file starts at the defaults; the permission (anonymous, stranger, `courses.view`, kiosk key; 404, 412, 400); decide on a `source` document stays `source`; the picture route (400 / 401 / 403, own order from the document, the other order imported once as a job without a target, row written once, 304, two different pictures; 503 while importing) |
| Integration (api) | `packages/api/src/__tests__/integration/map-deviation-overrides.test.ts` | row I7: `map_document_colour_settings` (a row per finished job, the check, the cascade); an override that changes no bytes keeps the pin current (`review.current`, no re-match item, dedup); `setDeviation` on a club map (keep a dropped deviation, drop a kept one, resets back to the original by dedup, kept through `source` and back; 400 for an unlisted or malformed key, 404, 401) and on an event's own upload (`courses.edit`, the re-match); a `source` document's IOF picture with `?deviations=` under its own key and ETag |
| Integration (api) | `packages/api/src/__tests__/integration/map-colour-order-document.test.ts` | row I8a: `GET …/colour-order/:order.json` — its own order is the document, no job; the other order imported once as a job without a target, then by dedup, and back; nothing pinned or written; the picture imports nothing more; a `source` document's IOF side with `?deviations=` (and the defaults' without); a second user gets the first user's document and may then fetch it; 400 / 401 / 403 / 404; 503 + `Retry-After`, then 200; 502 remembered, no new job; an event's own map through `?event=` for a `courses.view` reader |
| Unit (api) | `packages/api/src/__tests__/map-colour-settings.test.ts` (I8a part) | row I8a: the colour-order route's file name, `.png` the picture, `.json` the document |
| Integration (api) | `packages/api/src/__tests__/integration/map-promote.test.ts` | G12a (`docs/map-patches.md` §5): the three `patch` columns; a promote job's pins (§6.4: the version onto the baked document, the event onto the version); dedup per patch (§6.1); `decide` / `finalise` per patch (§6.8); `useClubMap` on a promoted series and `removeVersion` (§6.5); the re-match of a promoted version and its event (§6.9); the GC keeps promoted documents (§8.1); the per-event dump with `map_documents.patch` restored (§7.3); G12b: the promoted version's download and list `fileName` are the source's (§6.5) — the full list in `docs/map-patches.md` "Tests" |
| Unit (api) | `packages/api/src/__tests__/snapshot-maps.test.ts` (G12a part) | `snapshotDocumentPatch`: a promoted document's patch written on the box, none for null / `[]` / garbage (§7.2) |
| Unit (api) | `packages/api/src/__tests__/map-document-route.test.ts` | `parseRangeHeader` (forms, clamping, suffix, multi → ignored, unsatisfiable), `negotiateEncoding` (q-values, wildcard, refusal), `authoriseDocumentAccess` matrix over stub queries (including the own-job clause), `documentHeaderSummary` |
| Unit (api) | `packages/api/src/__tests__/map-source-route.test.ts` | `sliceRanges` (empty, exact multiple, remainder, bad size), `contentDisposition` (ASCII fallback, RFC 5987 escapes), `authoriseSourceAccess` matrix: auth off, event manager vs `courses.view`, club-library copy admin-only, kiosk key never, club uploader / admin / stranger / anonymous |
| Unit (api) | `packages/api/src/__tests__/map-storage-gc.test.ts` | `gcCutoff`, `parseGraceDays` (default, override, rejects), `isGcDue` (never ran, 23 h / 24 h, in progress < 1 h, crashed > 1 h), `isForeignKeyViolation` (the Prisma 7 / adapter-pg `23001` shape, `23503`, unrelated errors) |
| Integration (api) | `packages/api/src/__tests__/integration/map-storage-gc.test.ts` | old unreferenced document + previews + source deleted; young rows kept by `last_referenced_at` / `created_at`; grace honoured; pinned document kept and touched, then waits a fresh grace after dereference; club version, job and map-patch references keep documents (a patch-only reference touched, `RESTRICT` recognised, collected after the patch is gone and a fresh grace); a job-only reference keeps a source and its job; a finalised upload does not; idempotent second run; dry run lists (source as if document gone) and changes nothing; references and touches made after selection skip the row; stop between rows and finish on the next run; the real `RESTRICT` error is recognised; housekeeping pass; schedule writes `started_at` / `finished_at` / `last_result`, not due within a day, waits on a recent start, grace override; `mapStorage.gcRun` admin-only, dry run |
| Integration (api) | `packages/api/src/__tests__/integration/map-sources.test.ts` | route 400 / 401 / 403 / 404 / 200; event manager streams the upload under the event's file name, chunked, no `Content-Length`, `no-store`; `?event=`; anonymous with kiosk key 401, course setter / stranger / manager of another event 403; club-library copy admin-only; club uploader / admin under the source's name; auth off; a 33 MiB source byte-exact; `streamBlob` slice sizes and a source that changed mid-stream |
| Integration (api) | `packages/api/src/__tests__/integration/map-documents.test.ts` | store + dedup under another name, source/hash mismatch refused, `RESTRICT` on a pinned document, blob reads whole/range, `applyEventMap` pins + `mapMetadata`, route 400/401/403/404/200 with headers, `?event=` + kiosk key, brotli/gzip round trip, 304, 206/416/multi-range, club-version visibility, own import job (done → 200, other user 403, failed → 403), auth off |
| Unit (api) | `packages/api/src/__tests__/map-import-jobs.test.ts` | `isClaimable` matrix (with `attempts`), `needsKick`, `reportStage` swallows a failed write (MAP-6), upload init chunk limit and `missingChunks(…, limit)` (API-23), `stageProgress` monotonic, worker import produces the same hashes and `libraryVersion` as the inline importer with stages `parse → normalise → match → encode`, worker rejects garbage, upload validators (`validateUploadInit`, `expectedChunkSize`, `sniffMapKind`, `missingChunks`, `assembleChunks`) |
| Unit (api) | `packages/api/src/__tests__/import-ocad-damaged.test.ts` | MAP-3: `test.ocd` and `colour-layers.ocd` cut to 99 / 90 / 75 / 50 % through `runImportInWorker` end with an error within 10 s; a copy whose object, string or symbol index block names itself as the next block ends with `DAMAGED_FILE`; `readOcad` on it returns warnings recognised by `isDamagedFileWarning`; intact fixtures still import; `parseTimeoutMs: 1` rejects `DAMAGED_FILE` (needs the patched reader, `patches/`) |
| Integration (api) | `packages/api/src/__tests__/integration/map-import-jobs.test.ts` | `applyEventMap` job done + pins + report, dedup under another name, garbage / OMAP failures, `holdMs: 0` queued then finished by the engine, stale reclaim vs live job, the attempt limit (attempts 1 on a fresh job; stale at 2 → claimed, 3, done; stale at 3 → `IMPORT_ABANDONED`, never run, a live one left alone; an exhausted promote job removes its pending version; MAP-5), `mapImport.status` auth (stranger 403, course setter ok) + `latestForEvent`, `started_by` recorded by `applyEventMap` / `applyUploadedMap` / `addFromSource` and null for a dedup without a user, dedup hit touches the document, housekeeping sweep (finalised uploads included), chunked club upload → series (`rotation_correction` 0) + version 1, `useClubMap` pin by UUID, rename / rotation on the series, unknown id `NOT_FOUND`, `addFromSource` dedup, `remove` deletes the series — pins `NULL`, document and source kept, second remove `NOT_FOUND`, a Mapper source as an event map (`applyUploadedMap`) and a club map (`addFromSource`) (E5), upload routes 401/403/404/400/413/201, out-of-order and repeated chunks, 415, 409 missing (first 100 + `missingCount`), more than 4096 chunks → 400 at init and at finalise (API-23), finalise dedup + idempotency, 409 after finalise, `applyUploadedMap` under the upload's name, `applyJobResult` idempotent; pin writes the quick-access columns equal to `parseOcadMapMetadata`, recomputes them with a row's `rotation_correction` (11°) idempotently, report carries `georeference` / `north`, the Mapper job's stored report carries `warningDetails` (the `MISSING_SYMBOL` stub with its symbol index), a no-CRS document (`CRS_UNRESOLVED`) gets the columns through the source fallback, equal to the oracle (`helpers/ocad-oracle.ts` `parseOcadMapMetadata`, the upload's parse until E5) |
| Integration (api) | `packages/api/src/__tests__/integration/vector-map-pipeline-drops.test.ts` | the E5 migration on a scratch database built to the migration before it: a live event's unsourced `map_files` row → the guard fails and nothing is dropped; an unlinked `club_map_files` row → fails; only a soft-deleted event's unsourced row → passes, every named table / column / type gone (`information_schema`), `length_source` and `north_detection` kept, the tombstone row kept without bytes |
| Unit (api) | `packages/api/src/__tests__/map-symbol-decisions.test.ts` | `map-symbols.md` §8.5 (G21) |
| Unit (api) | `packages/api/src/__tests__/map-document-route.test.ts` (edit mode) | `EDIT_ACCESS`: `courses.view` not enough, `courses.edit` admits, kiosk key never, club and own-job clauses unchanged |
| Integration (api) | `packages/api/src/__tests__/integration/map-review.test.ts` | `review` rows on the fixture (702 suggested 703 with candidates, swatch URLs, colour class, counts, stack, report), predicate (stranger 403, anonymous 401, kiosk key with and without a user, wrong key 401, 404, bad hash); `decide` writes the row, snapshots it on the job, makes a new unpinned document drawn canonically, own-job review, old document no longer `current`, determinism, validation 400, stranger / kiosk 403; the decision applied to a second file of the same symbols; dedup to the decided document; `finalise` on the event (pins, `mapMetadata`, idempotent, other source 412, no capability 403, no event 400) and on a club version (in place, seq / label kept, event pin unchanged, 412, unknown club map 404); club target anonymous 401; `reset` back to the matcher's document; `decide` with an ISSkiOM overlay entry (G21): the row under the document library's release, the job's document draws the explicit overlay match and is `current`, reset returns to the matcher's document |
| Unit (api) | `packages/api/src/__tests__/map-crt.test.ts` | `crtFileName` (Mapper's `SOURCE-TARGET.crt`), the 1 MiB limit, `planCrtImport` on the `e2e/test.ocd` header (a decision, an unchanged variant line, a reported target; the full table round trip records nothing), decide's 5 000 cap |
| Integration (api) | `packages/api/src/__tests__/integration/map-crt.test.ts` | `exportCrt` header only before any decision, the four auto matches on `includeMatches` (three until A12 added the framed 603 text to the fixture), a decision with its `# fp` from both documents of the source, predicate (stranger 403, anonymous 401, kiosk key reads, 404, bad hash); `importCrt` of the export after a `reset` writes the same row and yields the same document as `decide` (unpinned), `# keep` recorded and exported, dry run writes nothing, unappliable lines reported with no row and no job, the full-table round trip records nothing; stranger / anonymous / kiosk refused, 404, over 1 MiB 400 |
| Unit (api) | `packages/api/src/__tests__/map-rematch-cli.test.ts` | `staleReason` matrix, CLI flags (parsing, either spelling, bad values), plan / item / summary lines |
| Integration (api) | `packages/api/src/__tests__/integration/map-rematch.test.ts` | §6.9; `map-patches.md` §4.4 (G11) |
| Integration (api) | `packages/api/src/__tests__/integration/showcase-fixture.test.ts` | the Demo Competition fixture loaded as `load-showcase.sh` loads it (source row from the committed `.omap`, `showcase.sql`, re-match): the `unpinned` row is imported and pinned with its quick-access columns, `course.mapMetadata` answers, positioned controls get `lat` / `lng` inside the pin's bounds, courses read their controls with the stored lengths, a second load gives the same pin (`docs/ops/demo.md`) |
| Unit (api) | `packages/api/src/__tests__/club-map-library.test.ts` | `projectClubMapRow` (series settings, version label → source name fallback, header scale → legacy scale, legacy raster metadata, version-less row with its job and the job's source and no preview URL, nulls, job dropped once a version exists), `canRemoveClubMap` / `canDownloadClubMapVersion` matrices, `latestVersionOrRefuse` → `PRECONDITION_FAILED`; `review` counts from the import report's `matching.symbols`, null without a matched document; a promoted version's `fileName` is its source's, not its label (G12b) |
| Integration (api) | `packages/api/src/__tests__/integration/club-maps.test.ts` | chunked upload keyed by the series UUID, list carries version / hashes / thumbnail URL / source facts, staleness from the version's report, rename, download by version source; a version-less series lists no north and no preview URL; an unimportable upload (OCAD magic, garbage after) listed with a failed job and no preview URL, its bytes kept as the source, `download` / `useClubMap` `PRECONDITION_FAILED`; unknown id `NOT_FOUND`, malformed `BAD_REQUEST`; remove stranger `FORBIDDEN`, creator ok, versions cascade; `setRotation` on the series → event copy (columns from the pin, `length_source` stays `derived`); an event upload keeps ScalePar (columns equal to the oracle); an unpinned row answers with no document and no north; `course.downloadMap` returns the source's bytes; download stranger `FORBIDDEN`; club-library copy and backup gates; the listed `review` equals the version document's report counts; possession (API-17 / MAP-4): another user's hash is `FORBIDDEN` "Upload the file again" for `addFromSource` and `applyUploadedMap`, `clubMap.download` and `GET /api/map-sources/:hash` stay 403, an admin may use any hash, the caller's own deduplicated upload is the way in and makes them the version's uploader |
| Unit (web) | `packages/web/src/lib/__tests__/map-document-cache.test.ts` | §7.1 |
| Unit (web) | `packages/web/src/lib/__tests__/map-document-cache.test.ts` (G17) | §7.1 "App-code copy" |
| E2E | `e2e/course-maps.spec.ts` "offline print: the job kept on the device" (G17) | opening the event stores its document in `map-documents` before any map is shown (the dev server has no service worker: the app-code copy); the sync panel's *Maps on this device* lines after *Make maps available offline* |
| E2E (preview build) | `e2e/offline-print.preview.spec.ts` (G29; project `preview`, `docs/dev/e2e-sharding.md` "The preview stack") | §7.1 "Service worker" |
| E2E | `e2e/map-vector-layer.spec.ts` | §7.1 through the viewer: the pinned document by hash, no query, `x-event-id` |
| Unit (web) | `packages/web/src/__tests__/map-upload.test.ts` | a small file is one chunk (no base64 path, E5), init → chunks → finalise call order and progress, per-chunk retry on 5xx, no retry on 4xx, `x-event-id` only for event uploads |
| Unit (api) | `packages/api/src/__tests__/map-previews.test.ts` | preview request parsing (`:idx`, `.png`, library code, hash), ETags and `If-None-Match`, library preview of an entry and a variant, 404 for unknown code / other version, per-instance cache hit |
| Unit (api) | `packages/api/src/render/__tests__/previews.test.ts` | swatch pixel probes (418 at 3×, 505 dash on the dash point and gaps, 403 fill, 704 text ink, neutral swatch), library entry PNG size, thumbnail long edge 512 px, object cap |
| Integration (api) | `packages/api/src/__tests__/integration/map-previews.test.ts` | stage 10 thumbnail row after `applyEventMap`, dedup short-cut re-derives, failed derive non-fatal, over-cap decided from the header summary; thumbnail and symbol routes 400/401/403/404/200/304, kiosk key and `?event=`, render on miss, row written once, every fixture symbol 200 and one past the end 404, `render: null` 404, previews never bump `last_referenced_at`; library route 400/401/200/304/404 incl. variant and other version; auth off |
| Unit (api) | `packages/api/src/__tests__/map-heightfield.test.ts` | §4.7 |
| Integration (api) | `packages/api/src/__tests__/integration/map-heightfields.test.ts` | §4.7 |
| Unit (api) | `packages/api/src/__tests__/backup.test.ts` (H4, H10) | `map_heightfields` and `map_dem_jobs` not in the dump |
| Unit (api) | `packages/api/src/__tests__/snapshot-maps.test.ts` (H10) | the blob export refuses `map_dem_jobs` like `map_heightfields` |
| Unit (api) | `packages/api/src/__tests__/map-dem-jobs.test.ts` | §4.7 "The DEM" |
| Integration (api) | `packages/api/src/__tests__/integration/map-dem.test.ts` | §4.7 "The DEM", §7.0 (H4, H13) |
| Unit (web) | `packages/web/src/lib/__tests__/map-review.test.ts` (H4) | `terrainLine`: the decided share floored against the 80 % gate, the other states |
| E2E | `e2e/map-documents.spec.ts` (H4, H10) | the demo `.omap` through the chunked route → `mapMetadata.terrain` ready with decided > 80 % → `height.bin` 200 (`OXHF`, headers), 304, anonymous 401, another version 404; with no DEM provider enabled `terrain.dem` is `disabled`, a DEM source 404 `source`, a malformed one 400, `source=contours` the same field |
| E2E | `e2e/map-review.spec.ts` (H4) | the event map's review shows the terrain line "no contours" for `test.ocd` |
| E2E | `e2e/club-map-library.spec.ts` | UI upload → card keyed by the series UUID with the document thumbnail → rename → **From club library** renders the event map → delete leaves the event's map; an unparseable upload is listed as "Import failed", without download, and disabled in the event picker; north-lines badge |
| E2E | `e2e/map-mode.spec.ts` (G12b part) | §6.5 |
| E2E | `e2e/map-documents.spec.ts` | UI upload on `itest` → `documentHash` → route 200/304/206, own import job admits the uploader through a non-pinning event, anonymous 401 → thumbnail and symbol swatch 200 / 401 anonymous, library swatch by the header's library and version → source route streams `test.ocd` back (200, `no-store`, attachment), anonymous 401 → dev page `?url=` loads it natively → `latestForEvent` done with report; chunked route (chunks out of order) → `applyUploadedMap` → `mapMetadata`; the same source → `clubMap.addFromSource` → `mapImport.status` done |
| E2E | `e2e/map-review.spec.ts` | §8.7 |
| Unit (api) | `packages/api/src/__tests__/snapshot-maps.test.ts` | `pinnedHashes` (dedup, each document's own source), `partitionMapFiles` (sourceless rows skipped, local identity dropped), `exportBlobInput` bounds (table, hash, start, 4 MiB; a graphic by decimal id, not by hash, not a map table by id), `verifyBlob` size and hash, `fetchBlob` slice order, peer hash / size mismatch, short slice; `tokenMapOf` / `applyTokens` (exact decimal tokens through a JSON round trip that rounds the rows', a row the map lacks, no map; a malformed or out-of-int8 token refused with the typed error), `withDbNulls` |
| Unit (api) | `packages/api/src/__tests__/snapshot-graphics.test.ts` | `referencedGraphicIds` (templates' and sheets' image objects, course objects' `props.graphicId`, sorted and distinct; malformed JSON ignored), `verifyGraphic` size and hash, `fetchGraphic` one slice, peer size mismatch, short slice |
| Unit (api) | `packages/api/src/__tests__/backup.test.ts` | dump table order (blobs before `map_files`, decisions present, no previews / tiles / `rendered_maps`), one `\copy` per table, blob filters by the event's pins, decisions unfiltered, `splitBackupSections` |
| Integration (api) | `packages/api/src/__tests__/integration/lease.test.ts` | checkout carries file + source + document (bytes, header, pin, view overrides, venue-local NULLs, a sourceless row skipped, counts); document route on the venue 401 anonymous / 200 with the kiosk key; tampered bytes fail the checkout, release the peer lease and store nothing; exporter without `maps`; `exportBlob` refuses other events' blobs and a start past the end; re-checkout fetches nothing and keeps the blob rows; `lease.exportBlob` through the router (no / wrong secret 401, 4 MiB bound); club decisions merged (newer cloud row wins over a stale venue copy, venue-only row kept, `decided_by` NULL); G18: the lifecycle's checkout through a JSON round trip carries the template, the sheet (`window_center` NULL), the course object and the class's print template verbatim with tokens above 2^53 exact; the event's graphic and the club graphic a course object draws byte-exact under the cloud's ids, an unreferenced club graphic left behind, a later box upload takes a larger id; an exporter without templates, sheets, `versions` or `graphics` checks out with the class's print template NULL; tampered graphic bytes fail the checkout and release the peer lease; `exportBlob` for graphics refuses another event's graphic, an unreferenced club graphic and an unknown id, slices a club graphic, a start past the end 400; re-checkout fetches the event's graphic again and not the held club graphic; a local graphic in a travelling id's place is replaced; forwarding on a venue box against a stub cloud: `courseMap.` / `layout.` / `courseObject.` writes reach the cloud with body, `x-event-id` and the user header, a race-critical write runs locally, offline the typed 412 `CLOUD_UNREACHABLE`, a mixed batch 412 `MIXED_BATCH` with nothing run |
| Integration (api) | `packages/api/src/__tests__/integration/venue-print.test.ts` | `course-print.md` §8.7 (G18, G14) |
| Unit (api) | `packages/api/src/__tests__/known-fields.test.ts` | `knownFields`: keys the model lacks dropped (the E5 columns of a v0.6.0 exporter's map file / event / course among them), join tables, a warning once per model and name, an unknown model returned as is, the input not mutated |
| Integration (api) | `packages/api/src/__tests__/integration/lease.test.ts` (D10, MC-32) | another event's graphic in a travelling id's place: the checkout is refused with `GRAPHIC_ID_CLASH`, the other event's bytes are intact, the peer lease is free and no local event was created; `replaceClashingGraphics: true` replaces it as G18 says; a re-checkout over the event's own copy is no clash; the import itself refuses without the flag; the lease-time refresh skips the clashing graphic with a warning and applies the rest; the club-library case unchanged |
| Unit (api) | `packages/api/src/__tests__/map-refresh.test.ts` | G19: `canonicalJson` (sorted keys, dates and BigInts as over HTTP, a JSON round trip equal), `planMirror` (an unchanged row whatever its `updated_at`, content changed under the same token, an exact token change a rounded one cannot see, creates and sorted deletes, only the cloud row's columns compared), `sameMapFiles` (local identity and venue NULL ignored, multiset, a moved pin), `knownTemplateOf`, `refreshWrites`, `holdsGraphic` (owner and bytes; an event graphic only with the local event named), `refreshesMapRows`, `requestEventName` (`x-event-id`, else the web's `x-competition-id`) |
| Integration (api) | `packages/api/src/__tests__/integration/lease.test.ts` (G19 describe) | an unchanged cloud writes and fetches nothing (`updated_at`, `map_files` ids kept); not the holder → no peer call; `lease.exportMapRows` 401 without the secret, its parts; on the cloud a sheet edited (token above 2^53 exact), a template renamed, an object reordered without a token, a class print scale changed, a sheet created drawing a club graphic nothing drew, an event graphic uploaded, a sheet for a course only the cloud has → after one refresh the box equals the cloud, the stray sheet skipped, the `course_maps` counter past the cloud's seq and the skipped sheet's, the race-critical digest unchanged, a second refresh writes and fetches nothing; rows and the event graphic deleted on the cloud deleted on the box, the club graphic kept; a key change promoting a lower-seq extra and a name swap between two templates applied in one refresh, a template deleted on the cloud deleted on the box with its sheet's `template_id` NULL; a graphic renamed on the cloud updated in place, new bytes under the same id fetched; a course object and a `map_files` row the box wrote itself deleted at the next refresh, a box-local object's seq past the cloud's; two concurrent refreshes settle in turn; offline and tampered bytes write nothing; a map re-imported on the cloud → new source and document byte-exact, the pin, the document route 200 with the kiosk key, the dormant patch deleted, pin back → patch verbatim with nothing fetched; `refreshAllSettingsOnce` runs both refreshes and a cloud without `exportMapRows` still refreshes the settings; a forwarded `courseMap.` write naming the event by the web's `x-competition-id` is on the box with the cloud's token when its reply arrives; a slow refresh holds the reply only for the bound |
| Unit (api) | `packages/api/src/__tests__/venueForwarder.test.ts` | G18 prefixes: each of `courseMap.` / `mapTemplate.` / `layout.` / `graphics.` / `courseObject.` forwards its mutation and serves its query locally; `course.` and `class.` stay local; `isMixedCloudBatch`; the refusal body's `reason` |
| Unit (web) | `packages/web/src/lib/__tests__/trpc-links.test.ts` | G18: `isCloudOwnedOp`; `cloudOwnedApart` sends cloud-owned mutations through their own link and queries / local mutations through the other; `ensureSheetsBestEffort` skips on `CLOUD_UNREACHABLE` only |
| Integration (api) | `packages/api/src/__tests__/integration/backup.test.ts` | dump completes with exactly the event's source and document as `\x` hex before `map_files`, no previews; event and blobs deleted → `restore-map-blobs.sql` restores byte-exact into another event (`uploaded_by` of a missing user NULL, grace restarted), second run a no-op, tampered bytes refused with nothing written, blobs alone without an event id; every `map_files` column restored; decisions in the dump, restore brings back a lost row and keeps the newer of two; `restore-legacy-map-files.sql` (E5): refuses a v0.6.1 section and a row whose `file_data` does not match its `source_hash`, makes a pre-vector row's bytes a source and pins it (idempotent), `map:rematch` then imports it; a v0.6.0-shaped row keeps its document when held for that source, else none |
| Unit (api) | `packages/api/src/__tests__/event-document.test.ts` | §4.6 |
| Unit (api) | `packages/api/src/__tests__/event-map-objects.test.ts` | `ocadSymbolNumber`; `slimObjectsOfDocument`: kept / dropped symbols and object types, hidden, graphic, applied-match code, outer ring, Bézier flattening, unit scaling |
| Unit (api) | `packages/api/src/__tests__/document-readers-parity.test.ts` | §4.6 "Parity": CRS, autodetect objects, north, cut features — document vs the legacy OCAD readers on `e2e/test.ocd` and, when present, the local corpus |
| Integration (api) | `packages/api/src/__tests__/integration/map-document-readers.test.ts` | §4.6 |
| E2E | `e2e/backup.spec.ts` | UI upload on `itest` → Download backup → `map_sources` / `map_documents` sections hold the source and document hashes before `map_files`, no previews |

## 11. Where things live


| Path | Contents |
|---|---|
| `packages/api/prisma/migrations/20261016190000_map_documents_storage/` | tables above |
| `packages/api/src/map-store/blob-store.ts` | `BlobStore` seam |
| `packages/api/src/map-store/documents.ts` | store stage, report builder, `touchDocument` |
| `packages/api/src/map-store/routes.ts` | document route, range/encoding helpers, auth predicate, `requireDocumentAccess` |
| `packages/api/src/map-store/previews.ts` | `map_previews` rows (read, render on miss, stage 10 derive), library preview cache |
| `packages/api/src/map-store/preview-routes.ts` | thumbnail, symbol and library preview routes |
| `packages/api/src/render/previews.ts` | swatch, thumbnail and colour-picture renderers (reference raster) |
| `packages/api/src/map-store/source-routes.ts` | source route: download predicate, slice planner, `streamBlob` |
| `packages/api/src/map-store/gc.ts` | `runStorageGc`, daily schedule (`maybeStartStorageGc` / `stopStorageGc`), grace and due rules |
| `packages/api/src/routers/mapStorage.ts` | `mapStorage.gcRun` |
| `packages/api/src/routers/clubMap.ts` | club library on the series (§6.5) |
| `packages/api/src/club-map-library.ts` | `projectClubMapRow`, owner checks, `latestVersionOrRefuse` |
| `packages/api/prisma/migrations/20261019120000_map_import_jobs_started_by/` | `map_import_jobs.started_by`, `document_hash` index |
| `packages/api/prisma/migrations/20261019130000_map_storage_source_hash_indexes/` | `source_hash` indexes on `map_files`, `club_map_versions` |
| `packages/api/src/map-store/uploads.ts` | pure upload rules: limits, chunk sizes, kind sniffing, assembly |
| `packages/api/src/map-store/upload-routes.ts` | `POST /api/map-uploads`, `PUT …/chunks/:n`, `POST …/finalise` |
| `packages/api/src/map-store/jobs.ts` | job rows, claim / heartbeat / stale reclaim, worker launcher, `applyJobResult`, housekeeping, engine tick |
| `packages/api/src/map-store/event-document.ts` | server reads of the pinned document (§4.6): `eventPin`, `eventDocumentHash`, `documentFrame`, `documentNorth` / `reportNorth`, `decodedDocument`, `documentPaperFrame`, `sourceFrameFallback`, `documentMapFileColumns`, `writePinnedMapFileColumns` (pin-time write, §6.4), caches |
| `packages/api/src/event-crs.ts` / `event-map-objects.ts` | `loadEventCrs`, `synchronizePositionedControlCoordinates`; `slimObjectsOfDocument`, `loadEventMapObjects`, `loadEventCutFeatures`, `loadEventCheckDocument` (§4.6) |
| `packages/api/src/map-store/map-file-metadata.ts` | `mapFileMetadataFor` (quick-access columns from a document frame + meridian tilt + correction), `documentFrameSchema` |
| `packages/api/src/background/supervisor.ts` | lease-holder reconcile; starts / stops the GC |
| `packages/api/src/map-store/import-worker.ts` | worker-thread body: `importMapToDocument` by kind + report |
| `packages/api/prisma/migrations/20261019150000_club_symbol_decisions/` | `club_symbol_decisions` |
| `packages/api/src/map-store/decisions.ts` | decision rows: load, plan and write `decide`'s changes, job snapshot schema, "does a stored document follow the decisions" |
| `packages/api/src/map-store/review.ts` | review payload, `decideOnDocument` (row I7: with the map's setting when the document follows it), `finaliseDocument`, `isDocumentCurrent`, `changeColourSettings` (row I6; row I7: under a lock on the target), `changeDeviation` (row I7) |
| `packages/api/src/map-store/colour-settings.ts` | a map's colour setting: parse, normalise, read from a report, the rows (`map_colour_settings`), the job's setting, `useClubMap`'s copy (row I6); one deviation's choice (`withDeviationChoice`), the recorded settings (`map_document_colour_settings`, `documentFollowsColour`), the picture's `deviations` query (row I7) |
| `packages/api/src/map-store/review-colours.ts`, `colour-pictures.ts` | the review's colour block (row I7: each deviation's `choice` and `overridden`); the before / after picture (row I6; row I7: an IOF picture of a `source` document with the map's overrides, keys bounded to the deviations the IOF document lists); the other order's document for the compare view (row I8a, `colourOrderDocument`) |
| `packages/api/src/map-store/crt.ts` | CRT export (rows → `mapImport.formatCrt`, file name) and import (`planCrtImport` → `decideOnDocument`) |
| `packages/api/src/map-store/rematch.ts` | re-match plan and run (§6.9) |
| `packages/api/src/cli/map-rematch.ts` (+ `-args.ts`) | `pnpm map:rematch` |
| `packages/shared/src/import/decisions.ts` | fingerprints, rows → decisions, review rows (`docs/map-symbols.md` §8.5) |
| `packages/shared/src/import/crt.ts` | the CRT codec: `parseCrt`, `formatCrt`, `resolveCrt` (`docs/map-symbols.md` §8.6) |
| `packages/api/src/routers/mapImport.ts` | `mapImport.status`, `latestForEvent`, `review`, `decide`, `finalise` |
| `packages/api/src/event-map.ts` | `applyEventMap` writes the source row (when given bytes) and the event's pin row, starts the event job, re-derives derived course legs |
| `packages/api/src/routers/course.ts` / `clubMap.ts` | `applyUploadedMap`, `useClubMap` version pin, `downloadMap` / `mapFileInfo` from `map_sources`; `createClubMap`, `addFromSource` |
| `packages/api/prisma/migrations/20261107120000_vector_map_pipeline_drops/` | E5: the guard, then the legacy pipeline's tables and columns dropped |
| `packages/api/prisma/migrations/20261113120000_map_patches/` | `map_patches` (row G3) |
| `packages/api/prisma/migrations/20261114130000_map_heightfields/` | `map_heightfields` (row H4) |
| `packages/api/src/map-store/heightfield.ts` | §4.7: rows, `getOrDeriveHeightfield` (cap, queue, in-flight sharing, failure memo), the worker launcher, `deriveDocumentHeightfield` (stage 10), `terrainDescriptor` / `terrainReview` with `demDescriptor` (H10), `serialisedDerive` (the one derive queue), `parseHeightfieldSource` |
| `packages/api/src/map-store/heightfield-worker.ts` | worker-thread body: decode, `deriveTerrain`, `encodeHeightField` |
| `packages/api/src/map-store/heightfield-routes.ts` | `GET /api/map-documents/:hash/height.bin`, `?source=` (H10) |
| `packages/api/prisma/migrations/20261115120000_map_dem_jobs/` | `map_dem_jobs` (row H10) |
| `packages/api/src/map-store/dem-jobs.ts` | §4.7 "The DEM": the job table's engine (enqueue, claim, heartbeat, retries, the fallback), the worker launcher, `startDemJobEngine` |
| `packages/api/src/map-store/dem-worker.ts` | worker-thread body: paper grid, `deriveAnchoredTerrain`, the ground field, both encoded, the misalignment gate |
| `packages/api/src/map-store/dem-registry.ts` | the instance's enabled providers (`setDemProviders`, set at startup from `MAP_DEM_PROVIDERS`) |
| `packages/api/src/map-store/{dem.ts,dem-cog.ts,dem-providers.ts,dem-live-check.ts}` | `docs/map-terrain.md` §7: extent and sampler, the COG reader, the providers, the live check |
| `packages/api/src/map-store/instance.ts` | `INSTANCE_ID`, the import and DEM jobs' `claimed_by` |
| `packages/api/prisma/migrations/20261114120000_map_gps_tracks/` | `map_gps_tracks` (row G24) |
| `packages/api/src/gps-tracks.ts` / `routers/mapTrack.ts` | GPS track storage and `mapTrack.*` (`docs/map-gps-tracks.md` §1) |
| `packages/api/src/map-store/patches.ts` / `routers/mapPatch.ts` | the patch store, delivery rule and writes; `mapPatch.get` / `applyChange` / `setEnabled`; the route is in `routes.ts` (`docs/map-patches.md` §3) |
| `packages/api/scripts/restore-map-blobs.sql` / `restore-legacy-map-files.sql` | dump restore: blobs, decisions and a v0.6.1 `map_files` section / a pre-v0.6.1 `map_files` section (§7.3) |
| `packages/api/scripts/restore-map-gps-tracks.sql` | dump restore: the `map_gps_tracks` section (§7.3) |
| `packages/api/src/sync/dropped-columns.ts` | the fields E5 dropped, stripped from a v0.6.0 exporter's snapshot rows (§7.2) |
| `packages/web/src/lib/map-upload.ts` | client chunked uploader |
| `packages/web/src/lib/map-document-cache.ts` | the viewer's document loader, `MAP_DOCUMENT_PATH_RE`, `requestPersistentStorage`, `useMapDocument` (§7.1) |
| `packages/web/vite.config.ts` | service-worker routes `map-documents`, `map-fonts` (§7.1) |
| `packages/web/src/lib/legacy-caches.ts` | deletes the retired `map-tiles` Cache Storage on start (§7.1) |
| `packages/api/src/sync/snapshotMaps.ts` | checkout snapshot map part: export, `exportBlobSlice`, `fetchSnapshotBlobs`, `importSnapshotMaps` (`insertSnapshotBlobs`, `createSnapshotMapFiles`, `createSnapshotPatch`, shared with the G19 refresh); `exportBlobInput` (map blob or graphic), `tokenMapOf` / `applyTokens`, `withDbNulls` |
| `packages/api/src/sync/snapshotGraphics.ts` | checkout snapshot graphics part (G18): `referencedGraphicIds`, `exportSnapshotGraphics`, `exportGraphicSlice` / `exportPeerBlobSlice` (the `lease.exportBlob` dispatcher), `fetchSnapshotGraphics`, `holdsGraphic`, `importSnapshotGraphics`, `mirrorSnapshotGraphics` (G19) |
| `packages/api/src/sync/mapRefresh.ts` | the box follows the cloud's map rows during a lease (G19): `exportMapRows` (`lease.exportMapRows`), `refreshCloudOwnedMaps`, `applyMapRows`, `planMirror`, `sameMapFiles`; called from `shipper.ts` `refreshAllSettingsOnce` and `venueForwarder.ts` `refreshAfterForward` |
| `packages/api/src/sync/lease.ts` | `SNAPSHOT_TABLES` (layout rows since G18), `versions`, the import's template-reference and token handling |
| `packages/shared/src/cloud-ownership.ts` | the cloud-owned mutation list (moved from `api/src/sync/ownership.ts` in G18, which re-exports it); `packages/web/src/lib/trpc-links.ts` batches them apart |
| `packages/api/src/sync/lease.ts` / `routers/lease.ts` | `EventSnapshot.maps`, `LeasePeer.exportBlob`, `lease.exportBlob`, checkout `maps` counts |
| `packages/api/src/backup.ts` | `BACKUP_TABLES`, `buildBackupScript`, `splitBackupSections` |
| `packages/api/scripts/restore-map-blobs.sql` | idempotent restore of the dump's map sections |
| `packages/shared/src/import/report.ts` | `importReportSchema` |
