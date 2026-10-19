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
`20261019120000_map_import_jobs_started_by` and
`20261019130000_map_storage_source_hash_indexes` (`source_hash` indexes
on `map_files` and `club_map_versions` for the GC and the source route). All in schema `oxygen`.

| Table | Key | Columns | Notes |
|---|---|---|---|
| `map_sources` | `file_hash CHAR(64)` | `kind` (`ocad`/`omap`), `bytes BYTEA`, `size_bytes`, `file_name`, `uploaded_by → users SET NULL`, `created_at` | the uploaded file; `bytes` is `STORAGE EXTERNAL` |
| `map_documents` | `hash CHAR(64)` | `bytes BYTEA`, `size_bytes`, `format_version`, `importer_version`, `library_version`, `source_hash → map_sources RESTRICT`, `header JSONB`, `report JSONB`, `created_at`, `last_referenced_at` | the encoded document; `header` is the summary (§3), `report` the import report |
| `map_previews` | `(document_hash, kind, key)` | `png BYTEA`, `created_at` | `document_hash → map_documents CASCADE`; thumbnails and symbol swatches, pure cache (§4.5) |
| `club_maps` | `id UUID` | `name`, `colour_profile`, `colour_overrides JSONB`, `north_lines_below`, `rotation_correction`, `created_by`, timestamps | a club's map as a series (06 §8) |
| `club_map_versions` | `id UUID` | `club_map_id → club_maps CASCADE`, `seq`, `label`, `source_hash RESTRICT`, `document_hash RESTRICT`, `uploaded_by`, `uploaded_at`; `UNIQUE(club_map_id, seq)` | one edition; `uploadedAt` ordering, `seq` for display |
| `map_files` (+) | — | `source_hash RESTRICT`, `document_hash RESTRICT`, `club_map_version_id → club_map_versions SET NULL` | the event's pins; nullable so the raster path keeps working when the import fails |
| `club_map_files` (+) | — | `club_map_id → club_maps SET NULL` | links the legacy library row to its series while both exist (§6.5) |
| `map_uploads` | `id UUID` | `event_id → events CASCADE` (nullable), `file_name`, `kind`, `declared_bytes`, `chunk_bytes`, `uploaded_by SET NULL`, `created_at`, `finalised_hash → map_sources SET NULL` | one chunked upload in flight (§5); `kind` is set from the first chunk |
| `map_upload_chunks` | `(upload_id, n)` | `bytes BYTEA` | `upload_id → map_uploads CASCADE`; `STORAGE EXTERNAL`; deleted at finalise |
| `map_import_jobs` | `id UUID` | `event_id CASCADE` / `club_map_id CASCADE` (the target, either nullable), `source_hash → map_sources CASCADE`, `decisions JSONB`, `state`, `stage`, `progress REAL`, `claimed_by`, `heartbeat_at`, `document_hash → map_documents SET NULL`, `error`, `started_by → users SET NULL`, timestamps | one import run (§6); indexed on `(state, heartbeat_at)` for the claim query and on each target; `started_by` is the user whose request started it (null for the backfill), read by §4.2 |

`STORAGE EXTERNAL` on the two blob columns keeps TOAST from compressing
the bytes (compact binary that gains little) so `substring(bytes FROM … FOR …)`
reads only the chunks a range request needs instead of inflating the row.

Prisma models: `MapSource`, `MapDocument`, `MapPreview`, `ClubMap`,
`ClubMapVersion`, `MapUpload`, `MapUploadChunk`, `MapImportJob`;
`MapFile.sourceHash / documentHash / clubMapVersionId`; `ClubMapFile.clubMapId`.

## 3. Store stage (import stage 9)

`packages/api/src/map-store/documents.ts`:

```ts
importAndStoreMap(db, fileBytes, fileName, kind /* "ocad" | "omap" */, { uploadedBy? })
  → { sourceHash, documentHash, deduplicated, result }   // result = importMapToDocument()
importAndStoreOcad(db, fileBytes, fileName, opts)         // = importAndStoreMap(…, "ocad", opts)

storeImportedDocument(db, { source: { bytes, fileHash, kind, fileName, uploadedBy? },
                            document: { bytes, hash, libraryVersion? }, report })
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
  unclassified) — `docs/map-symbols.md` §8–§9.
- `library_version` is `"<library>@<SYMBOL_LIBRARY_VERSION>"`
  (`ISOM2017-2@2026.10.1`), the library the matcher chose for the
  document. Rows imported before the matcher carry `"none"`
  (`LIBRARY_VERSION_NONE`) and `importer ocad-3`; they are no longer
  dedup targets, so the next upload of the same bytes produces a new
  document row under the current importer and library version while the
  old row waits for GC (§8). Re-matching already-stored documents in bulk
  is a pending backfill (§9).
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
| `course.uploadMap` (base64, ≤ 8 MiB) → `applyEventMap` | `applyEventMap` | `eventId` | `map_files.document_hash` on every row of the event with that `source_hash` |
| chunked upload → `course.applyUploadedMap` → `applyEventMap` | finalise route (§5) | `eventId` | same |
| `course.useClubMap` → `applyEventMap` | `applyEventMap` (bytes from the library row) | `eventId` | same; the router then pins `club_map_version_id` to the series version with that `source_hash` |
| `clubMap.upload` (base64) / `clubMap.addFromSource` (chunked) | router / finalise route | `clubMapId` | a new `club_map_versions` row (§6.4) |

`applyEventMap` creates the `map_files` row with `source_hash` set and
`document_hash = NULL`, starts the job, runs the raster pipeline while the
job works, then awaits the job up to the hold (§6.2) and returns
`importJob {id, state, error}` plus `documentHash` when the job is done.
A failed job is logged by the engine and leaves `document_hash = NULL`;
the raster path is unaffected. `course.mapMetadata` returns
`documentHash` (nullable); `mapImport.latestForEvent` returns the job.

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
started", for as long as the job row lives (7 days, §6.6); it is written
as `state <> 'failed'` so A6's review state is covered without another
change. A failed job never carries a document.


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
`docs/authentication.md`) rather than the document predicate, and it is
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
review UI (slice B) reads them. `packages/api/src/map-store/previews.ts`
(rows, library cache) and `preview-routes.ts` (routes).

```
GET /api/map-documents/:hash/thumbnail.png                 the whole map, long edge 512 px
GET /api/map-documents/:hash/symbols/:idx.png              swatch of header.symbols[idx].render
GET /api/library/:libraryId/:version/:code.png             swatch of a canonical entry
```

**Rows.** Document previews are `map_previews` rows keyed
`(document_hash, kind, key)`: `('thumbnail', '')` and
`('symbol', '<idx>')`. A row is written once with `createMany …
skipDuplicates` and never updated, like the blobs (§1); it cascades with
its document and is pure cache — deleting rows only costs a re-render.
Who writes them:

| Row | Written by |
|---|---|
| thumbnail | import stage 10 (`derive`, §6.1) after the document is stored, including the dedup short-cut of `startImportJob`; otherwise on the first request that finds no row (documents stored before stage 10 existed, a skipped or failed derive) |
| symbol | the first request for that index |

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
| `:hash` not 64 hex; `:idx` not a non-negative safe integer; `:libraryId` not a shipped library; `:code` not `\d{3}(\.\d{1,2})?(\.[a-z])?` | 400 `{error}` |
| document routes: §4.2 predicate fails | 401 anonymous / 403 signed in |
| library route: auth on and no signed-in user | 401 |
| no such document; `idx` ≥ symbol count or `render: null`; thumbnail over the object cap; `:version` ≠ current; no such entry | 404 `{error}` |
| `If-None-Match` matches the `ETag` | 304 |
| otherwise | 200 PNG |

| Route | Headers on 2xx / 304 |
|---|---|
| document previews | `Content-Type: image/png`, `Cache-Control: private, max-age=31536000, immutable`, `ETag: "<hash>/thumbnail"` or `"<hash>/symbols/<idx>"` |
| library preview | `Content-Type: image/png`, `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<libraryId>@<version>/<code>"` |

No `Range`, no `Content-Encoding` (PNG is already deflated), no `Vary`.

Authorisation of the document previews is exactly §4.2 — the same
predicate, the same 60 s positive cache, shared with the document route
through `requireDocumentAccess(req, reply, hash)` in `routes.ts`, all
four clauses included — the uploader of a running import sees its
previews as it sees its document. The library route needs any
signed-in user, or `AUTH_MODE=off` (07 §6.1): the library is public data.

## 5. Chunked upload: `/api/map-uploads`

07 §7. Browsers upload map files in slices so a 100 MB OCAD file survives
a flaky venue connection and never has to fit one request body or a
base64 string. `packages/api/src/map-store/upload-routes.ts`; pure rules
in `uploads.ts`.

### 5.1 Contract

```
POST /api/map-uploads                      {fileName, bytes, chunkBytes?}      → 201 {uploadId, chunkCount, chunkBytes}
PUT  /api/map-uploads/:id/chunks/:n        application/octet-stream body       → 204
POST /api/map-uploads/:id/finalise                                             → 200 {fileHash, bytes, deduplicated}
```

Scope comes from the headers: with `x-event-id` (or `x-competition-id`)
the upload belongs to that event; without, it is a club-library upload.
Limits: `bytes ≤ 128 MiB`, `chunkBytes ≤ 8 MiB` (default 8 MiB), chunk
bodies capped at `chunkBytes + 64 KiB` by Fastify's `bodyLimit`.

| Condition | Route | Status |
|---|---|---|
| auth on, anonymous | all | 401 |
| event scope without `courses.edit`; club scope without a user | all | 403 |
| unknown event / upload id not a UUID or not found | init / chunk, finalise | 404 |
| missing or non-positive `fileName`/`bytes`, `chunkBytes` > 8 MiB | init | 400 |
| `bytes` > 128 MiB | init | 413 |
| `n` out of range, body size ≠ expected size for `n` | chunk | 400 |
| first chunk is neither OCAD nor OMAP | chunk 0 | 415 |
| upload already finalised | chunk | 409 |
| chunks missing | finalise | 409 `{missing: [n…]}` |
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
Both reject a `fileHash` whose source kind is not `ocad`: a Mapper
source imports to a document through the job (§6) but cannot be made an
event's or a club's map until the legacy tile consumers are replaced
(`docs/map-import.md` §2.2). `fileName` overrides the name recorded on the
upload — the source row keeps whatever the first uploader called it, so
the event's `map_files.file_name` and the version label come from the
request, not the shared row.

### 5.2 Client

`packages/web/src/lib/map-upload.ts`. `shouldUseChunkedUpload(bytes)` is
true above 8 MiB; below that `MapPanel` and the club-library settings page
keep the base64 tRPC mutations (`course.uploadMap`, `clubMap.upload`), so
small files — including every E2E fixture — take one request.
`uploadMapFileChunked(file, {eventNameId?, onProgress?, signal?})` runs
init → 4 chunks in flight (`File.slice()`, 3 retries each on network
errors / 5xx / 408 / 429, none on other 4xx) → finalise and resolves with
`{fileHash, bytes, deduplicated}`; the caller then applies the hash.

## 6. Import jobs

07 §8. An import is a `map_import_jobs` row, not an in-process object:
anything that polls it can also finish it, so a restart or a second API
instance loses nothing. `packages/api/src/map-store/jobs.ts`.

### 6.1 Lifecycle

```
startImportJob(db, {sourceHash, eventId? | clubMapId?, startedBy?, holdMs?})
  │
  ├─ a map_documents row exists for (sourceHash, importer ∈ {ocad-4, omap-1}, library *@<current SYMBOL_LIBRARY_VERSION>)
  │     → touchDocument, insert state=done with that document_hash, applyJobResult, derive, return   (06 §8 dedup, no worker)
  │
  └─ insert state=queued → kickImportJobs → hold ≤ holdMs for the result → return the row

kickImportJobs: one loop per instance
  claim (atomic updateMany: queued, or running with heartbeat older than 60 s)
  → running, claimed_by = INSTANCE_ID, stage parse
  → worker thread: parse → normalise → match → encode (stage + progress written at each boundary,
  → store: storeImportedDocument (§3)                 heartbeat every 10 s while it runs)
  → applyJobResult: pins (§6.4)
  → derive: thumbnail row (§4.5); a failure is logged, never fails the job
  → done | failed(error)
```

| `state` | meaning |
|---|---|
| `queued` | inserted, not yet claimed |
| `running` | claimed by `claimed_by`; alive while `heartbeat_at` is < 60 s old |
| `done` | `document_hash` set, pins applied |
| `failed` | `error` set (≤ 2000 chars); `UNSUPPORTED_FORMAT: …` for a source whose `kind` is neither `ocad` nor `omap` (unreachable from the upload routes, which sniff), the importer's message otherwise |

`startedBy` is the signed-in user whose request started the job:
`applyEventMap` takes it as its own option (`course.uploadMap`,
`applyUploadedMap` and `useClubMap` pass `ctx.user` — for `useClubMap`
that is not the library row's uploader), `clubMap.upload` /
`addFromSource` pass `ctx.user`, the backfill passes nothing. It feeds
the fourth clause of §4.2 and nothing else.

A dedup hit, and a worker run whose document row already existed
(`storeImportedDocument` reports `deduplicated`), touch the document
before pinning it, so a GC run racing the pin sees a fresh
`last_referenced_at` and skips the row (§8.2).

`stage` ∈ `parse 0.1 → normalise 0.4 → match 0.55 → encode 0.7 → store 0.9 → derive 0.95 → done 1`;
`progress` is that fixed ladder, not a byte count. Every progress and
terminal write is guarded by `claimed_by = INSTANCE_ID`, so an instance
whose job was re-claimed after a stall cannot overwrite the new owner's
state. Re-runs are deterministic (`docs/map-import.md` §6): a re-claimed
job produces the same document hash.

### 6.2 Engine

The poll is the engine. `mapImport.status` calls `kickImportJobs` whenever
the job it reads is claimable, so a job orphaned by a crash resumes on the
next status request from any client. For unattended instances
`startImportJobEngine` (started in `index.ts`) ticks every 60 s: kick,
then housekeeping (§6.6). One worker runs per instance at a time; jobs
are taken oldest first.

`startImportJob` holds the request open up to `holdMs`
(default 30 s, `MAP_IMPORT_HOLD_MS`) waiting for the terminal row, so the
common small-map case returns `state: "done"` in the upload response and
the UI needs no polling. Larger maps return `running`; the client polls
`mapImport.status`. A ten-minute worker timeout terminates a runaway
import and fails the job.

### 6.3 Worker

`import-worker.ts` runs `importMapToDocument` for the source's `kind`
(with `onStage` posting `parse` / `normalise` / `match` / `encode`) and
`buildImportReport`, and posts the
document bytes, hashes and report back. It is launched with
`new Worker(bootstrap, { eval: true })`: when the API runs from TypeScript
(`tsx watch`, vitest, the E2E stack) the bootstrap registers
`tsx/esm/api` inside the worker before importing the `.ts` body — tsx's
loader does not reach `worker_threads` on Node 20 — and from `dist/` it
imports the `.js` body directly. The worker is terminated as soon as it
settles.

### 6.4 Pins (`applyJobResult`)

Idempotent; also run for dedup hits:

- `eventId` set → `map_files.document_hash = hash` on every row of that
  event with `source_hash = job.source_hash`.
- `clubMapId` set and no `club_map_versions` row for `(clubMapId,
  source_hash)` → insert one with `seq = max + 1`, label and uploader
  copied from the source row. `clubMap.upload` / `addFromSource` then
  overwrite label and uploader with the request's name and user when the
  job finished within the hold, since the source row keeps the first
  uploader's values.
- `touchDocument(hash)`.

### 6.5 Club library dual-write

Until the library UI reads from the new tables, every `club_map_files`
row created now also gets a `club_maps` series (`club_map_files.club_map_id`
links them), the job writes version 1, and the legacy mutations mirror:
`rename` → `club_maps.name`, `setColorStack` → `colour_overrides`,
`setRotation` → `rotation_correction`, `remove` → deletes the series (its
versions cascade; the document stays for GC). `course.useClubMap` pins
`map_files.club_map_version_id` to the version matching the row's
`file_hash` when one exists.

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

### 6.7 Backfill of pre-pipeline rows

09 slice A. Rows written before this chapter existed have bytes but no
document: `club_map_files` without a `club_maps` series (or whose series
has no version — a previous attempt failed), and `map_files` with
`document_hash IS NULL` in events that are not soft-deleted.
`packages/api/src/map-store/backfill.ts` walks them one map at a time,
club rows first:

```
club row     file_hash ?? sha256(file_data) → map_sources (name, uploader, upload time from the row)
             no series yet → club_maps copied from the row (name, colour profile / overrides,
                             north lines, rotation, created_by / created_at), club_map_id set
             startImportJob {clubMapId} → version 1 (label, uploader, uploaded_at from the row)

event row    source_hash ?? file_hash ?? sha256(file_data) → map_sources; file_hash / source_hash set
             startImportJob {eventId} → map_files.document_hash (§6.4)
             a club_map_versions row has that source_hash → club_map_version_id (oldest edition)
```

Each map is an ordinary import job (§6.1), so dedup applies — an event
copy of a club map, or the same map in two events, imports once — and a
failure is a `failed` job plus an entry in the run's failure list, never
an abort. Everything is keyed by content hash and guarded by "does it
exist already", so a re-run only revisits rows still missing a document;
the gate for the slice is a run with zero failures on the development
and the club's production database.

Two front ends, same `runBackfill`:

| | |
|---|---|
| Settings → Maintenance → **Map documents** | `mapImport.backfillStatus` (admin): `plan {clubRows, eventRows}` still missing + this instance's current / last `run`; `mapImport.backfillStart {limit?}` (admin) starts one in the background, `CONFLICT` while one runs; the card polls every second until the run finishes and lists failed maps by name |
| `pnpm map:backfill [--event <nameId>] [--limit n] [--dry-run]` | `src/cli/map-backfill.ts` (`docker exec <api> node packages/api/dist/cli/map-backfill.js` inside the image); one line per map, summary, exit 1 if any map failed. `--event` restricts the event rows (club rows are always processed); `--dry-run` lists what a run would touch. The restore procedure for a pre-vector dump ends with this command |

The CLI is its own job instance: if an API next to it claims the jobs
it inserts, `awaitImportJob` notices through the DB poll rather than the
in-process waiter, so a run finishes either way.


## 7. Offline and backups

### 7.1 Devices

The GL dev page loads a stored document straight from the route:
`/dev/map-gl-doc?url=/api/map-documents/<hash>?event=<nameId>`. The
viewer (slice B) and the service-worker CacheFirst layer (07 §7,
`storage.persist()`) are pending; both key on the hash and may rely on
`immutable` and the `ETag`.

### 7.2 Venue checkout snapshot

07 §9.2. A venue box that checks an event out (`lease.checkout`,
`docs/offline-architecture.md` "The lease") receives the event's map rows
and the blobs they pin, so the box answers `/api/map-documents/:hash` for
its kiosk and stations from its own tables, under the unchanged §4.2
predicate evaluated against its own event copy.

**What travels.** The snapshot gains an optional `maps` part:

| Part | Rows | Columns carried |
|---|---|---|
| `files` | every `map_files` row of the event with `source_hash IS NOT NULL` | all but `id`, `event_id`, `file_data` |
| `sources` | the distinct `map_sources` rows those rows pin, plus the `source_hash` of every pinned document | `file_hash`, `kind`, `size_bytes`, `file_name` |
| `documents` | the distinct `map_documents` rows pinned by `document_hash` | `hash`, `size_bytes`, `format_version`, `importer_version`, `library_version`, `source_hash`, `header`, `report` |

The part carries no bytes. The venue fetches each blob it does not
already hold through a ranged peer procedure:

```
lease.exportBlob { table: "map_sources" | "map_documents", hash, start, length ≤ 4 MiB }
  → { base64, sizeBytes }        peerProcedure (shared secret), event-scoped by x-event-id
```

It answers `NOT_FOUND` unless the context event's `map_files` reference
the hash: as `source_hash` or `document_hash`, or (sources) as the
`source_hash` of a document they pin. The slices are §4.4's
(`SOURCE_SLICE_BYTES`, 4 MiB), read with `getBlob` ranges (§4.3); the
venue assembles them and checks `size === size_bytes` and
`sha256(bytes) === hash` before inserting. 07 §9.2 put the bytes base64
inside the one JSON snapshot; sources reach 36 MB and `map_files` also
carries the bytes, which would pass Cloud Run's 32 MiB response ceiling
(07 §6.4), so the bytes take the "second part" 07 §9.2 allowed.

**Import** (`importEventSnapshot`, inside the snapshot transaction, after
the event row): sources, then documents, `createMany … skipDuplicates`
(append-only, §1 — a blob the venue already holds is neither fetched nor
rewritten); then the `map_files` rows with the local `event_id`,
`file_data` set to the source's bytes (identical by construction:
`applyEventMap` and the backfill pin the hash of `file_data`), and on the
venue copy:

- `map_sources.uploaded_by` and `map_files.club_map_version_id` are
  NULL — the box has neither the users nor the club library; both are
  cloud metadata and the §4.2 predicate does not read them for an event
  pin.
- `created_at` / `last_referenced_at` take the venue's defaults: the GC
  (§8) on the box ages its own copies, and the pins keep them while the
  event exists there.

A blob that is missing on the peer, or whose hash or size does not match,
fails the checkout; the existing rollback releases the peer lease, and
the event is not checked out. A re-checkout replaces the `map_files`
rows with the event (cascade) and leaves the blobs alone.

**Not carried.** `map_files` rows without a `source_hash` (pre-pipeline
rows, §6.7 — run the backfill before checkout; the checkout result counts
them as `skipped`); `map_previews` (a cache; §4.5 renders on a miss);
`club_maps` / `club_map_versions`; `map_import_jobs`, uploads; graphics,
templates and print (cloud-owned during a lease, 07 §9.2).

`lease.checkout` returns, next to `imported`,
`maps: { files, sources, documents, fetchedBytes, skipped }`.

Both directions interoperate with a node that predates the part: an old
exporter sends no `maps` (the box gets no map, as before); an old
importer ignores it.

**Coexistence (09 §10).** The document travels from slice A on whatever
the event's map pipeline: it is pinned on upload for `legacy` events too
(09 §3: the switch gates reads, never imports). A box checked out before
an event is flipped to `vector` therefore already holds what the new
viewer reads. The per-event switch (`events.map_pipeline`, slice B) does
not feed results, so under the boundary rule it is cloud-owned and is
not in `EXCLUDED_FIELDS` of the settings refresh
(`packages/api/src/sync/settingsRefresh.ts`): a flip on the cloud reaches
a checked-out box within `SYNC_SETTINGS_REFRESH_MS`, with no re-checkout.
What does not reach it is a *new* document: a map re-imported on the
cloud during the lease is not refreshed on the box (Pending, §9); the box
keeps serving the snapshot's document.

Checkin carries nothing map-related back: documents are immutable and
the venue never writes them.

### 7.3 Per-event dump

07 §10. `GET /api/backup/event` (`docs/backup-restore.md`) emits two more
`\copy` sections, in FK order before `map_files`:

| Section | Rows |
|---|---|
| `map_sources` | `file_hash` in the event's `map_files.source_hash` ∪ the `source_hash` of the documents they pin |
| `map_documents` | `hash` in the event's `map_files.document_hash` |

All columns, `bytes` as Postgres `\x` hex in the CSV. `map_previews`
are omitted (cache).

**Restore is idempotent on hash.** `packages/api/scripts/restore-map-blobs.sql`
loads both sections through temp tables with
`INSERT … ON CONFLICT DO NOTHING` on the primary key, so a database that
already holds a blob keeps its row (content-addressed rows are never
updated), and running it twice changes nothing. `uploaded_by` is kept
only when that user exists in the target database, else NULL. With an
event id it then loads the `map_files` section with `event_id` rewritten
and `club_map_version_id` kept only when that version exists. The rest
of the dump restores as before (`docs/backup-restore.md`).

A dump taken before the pipeline has no blob sections and empty hashes;
after restoring it, `pnpm map:backfill --event <name_id>` (§6.7, 09 §5)
gives the map its document.

The download gate is unchanged: a dump whose newest `map_files` row has
`from_club_library` needs an instance admin, because it contains the
club's source bytes (it did before, in `file_data`). 07 §10's
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
| `map_documents` | no reference and old enough | `map_files.document_hash`, `club_map_versions.document_hash`, `map_import_jobs.document_hash` | `last_referenced_at < now − grace` |
| `map_sources` | no reference and old enough | `map_documents.source_hash`, `club_map_versions.source_hash`, `map_files.source_hash`, `map_import_jobs.source_hash` | `created_at < now − grace` |

- `map_files` and `club_map_versions` reference with `RESTRICT`, so a
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

### 8.2 A run

```
runStorageGc(db, { now?, graceDays?, dryRun?, shouldStop? })
  → { graceDays, dryRun, stopped, touched, documents: hash[], sources: hash[], skipped, uploads, jobs }
```

1. **Touch** — `UPDATE map_documents SET last_referenced_at = now()` for
   every document a `map_files`, `club_map_versions` or
   `map_import_jobs` row still references. `touchDocument` is only called
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
4. **Uploads and jobs** — `sweepImportHousekeeping` (§6.6).

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

A leader-lease singleton (`docs/background-jobs-lease.md`): the
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
every 60 s; the GC's pass 4 is the same idempotent sweep.

### 8.4 Running it by hand

```
mapStorage.gcRun { dryRun? }    admin → the §8.2 summary (hashes included)
```

A manual run does not move the schedule. The Maintenance card 07 §5
mentions is pending (§9).

## 9. Pending in this chapter

Club map CRUD that reads from
`club_maps` / `club_map_versions` instead of mirroring into them; a re-import pass for documents
stored under an older importer or library version (`ocad-3` / `none`
rows); a Settings → Maintenance card for the GC (§8.4: status of the
last run, dry run, run now); refreshing a checked-out box's `map_files`
row and document when the map is re-imported on the cloud during the
lease (07 §9.2, §7.2); the documents-only dump variant for non-admin
event managers (07 §10, §15 — not restorable while a document needs its
source row, §7.3). Each lands with its own section here and its own
tests.

## 10. Tests

| Level | File | Covers |
|---|---|---|
| Unit (api) | `packages/api/src/__tests__/map-document-route.test.ts` | `parseRangeHeader` (forms, clamping, suffix, multi → ignored, unsatisfiable), `negotiateEncoding` (q-values, wildcard, refusal), `authoriseDocumentAccess` matrix over stub queries (including the own-job clause), `documentHeaderSummary` |
| Unit (api) | `packages/api/src/__tests__/map-source-route.test.ts` | `sliceRanges` (empty, exact multiple, remainder, bad size), `contentDisposition` (ASCII fallback, RFC 5987 escapes), `authoriseSourceAccess` matrix: auth off, event manager vs `courses.view`, club-library copy admin-only, kiosk key never, club uploader / admin / stranger / anonymous |
| Unit (api) | `packages/api/src/__tests__/map-storage-gc.test.ts` | `gcCutoff`, `parseGraceDays` (default, override, rejects), `isGcDue` (never ran, 23 h / 24 h, in progress < 1 h, crashed > 1 h), `isForeignKeyViolation` (the Prisma 7 / adapter-pg `23001` shape, `23503`, unrelated errors) |
| Integration (api) | `packages/api/src/__tests__/integration/map-storage-gc.test.ts` | old unreferenced document + previews + source deleted; young rows kept by `last_referenced_at` / `created_at`; grace honoured; pinned document kept and touched, then waits a fresh grace after dereference; club version and job references keep documents; a job-only reference keeps a source and its job; a finalised upload does not; idempotent second run; dry run lists (source as if document gone) and changes nothing; references and touches made after selection skip the row; stop between rows and finish on the next run; the real `RESTRICT` error is recognised; housekeeping pass; schedule writes `started_at` / `finished_at` / `last_result`, not due within a day, waits on a recent start, grace override; `mapStorage.gcRun` admin-only, dry run |
| Integration (api) | `packages/api/src/__tests__/integration/map-sources.test.ts` | route 400 / 401 / 403 / 404 / 200; event manager streams the upload under the event's file name, chunked, no `Content-Length`, `no-store`; `?event=`; anonymous with kiosk key 401, course setter / stranger / manager of another event 403; club-library copy admin-only; club uploader / admin under the source's name; auth off; a 33 MiB source byte-exact; `streamBlob` slice sizes and a source that changed mid-stream |
| Integration (api) | `packages/api/src/__tests__/integration/map-documents.test.ts` | store + dedup under another name, source/hash mismatch refused, `RESTRICT` on a pinned document, blob reads whole/range, `applyEventMap` pins + `mapMetadata`, route 400/401/403/404/200 with headers, `?event=` + kiosk key, brotli/gzip round trip, 304, 206/416/multi-range, club-version visibility, own import job (done → 200, other user 403, failed → 403), auth off |
| Unit (api) | `packages/api/src/__tests__/map-import-jobs.test.ts` | `isClaimable` matrix, `stageProgress` monotonic, worker import produces the same hashes and `libraryVersion` as the inline importer with stages `parse → normalise → match → encode`, worker rejects garbage, upload validators (`validateUploadInit`, `expectedChunkSize`, `sniffMapKind`, `missingChunks`, `assembleChunks`) |
| Integration (api) | `packages/api/src/__tests__/integration/map-import-jobs.test.ts` | `applyEventMap` job done + pins + report, dedup under another name, garbage / OMAP failures, `holdMs: 0` queued then finished by the engine, stale reclaim vs live job, `mapImport.status` auth (stranger 403, course setter ok) + `latestForEvent`, `started_by` recorded by `applyEventMap` / `applyUploadedMap` / `clubMap.upload` and null for a dedup without a user, dedup hit touches the document, housekeeping sweep (finalised uploads included), club upload → series + version 1, `useClubMap` pin, rename / colour-stack mirroring, `addFromSource`, `remove` deletes the series, upload routes 401/403/404/400/413/201, out-of-order and repeated chunks, 415, 409 missing, finalise dedup + idempotency, 409 after finalise, `applyUploadedMap` under the upload's name, `applyJobResult` idempotent |
| Unit (api) | `packages/api/src/__tests__/map-backfill-cli.test.ts` | CLI argument parsing, per-map lines and summary |
| Integration (api) | `packages/api/src/__tests__/integration/map-backfill.test.ts` | plan counts and ordering, dry run writes nothing, legacy club row → series (settings copied) + version 1 (label / uploader / time from the row), event rows → pins with dedup and club-version pin, unreadable rows reported and left unpinned, second run revisits only what is missing, `--event` scope and soft-deleted events skipped, `backfillStatus` / `backfillStart` admin-only, background run and `CONFLICT` |
| Unit (web) | `packages/web/src/__tests__/map-upload.test.ts` | threshold, init → chunks → finalise call order and progress, per-chunk retry on 5xx, no retry on 4xx, `x-event-id` only for event uploads |
| Unit (api) | `packages/api/src/__tests__/map-previews.test.ts` | preview request parsing (`:idx`, `.png`, library code, hash), ETags and `If-None-Match`, library preview of an entry and a variant, 404 for unknown code / other version, per-instance cache hit |
| Unit (api) | `packages/api/src/render/__tests__/previews.test.ts` | swatch pixel probes (418 at 3×, 505 dash on the dash point and gaps, 403 fill, 704 text ink, neutral swatch), library entry PNG size, thumbnail long edge 512 px, object cap |
| Integration (api) | `packages/api/src/__tests__/integration/map-previews.test.ts` | stage 10 thumbnail row after `applyEventMap`, dedup short-cut re-derives, failed derive non-fatal, over-cap decided from the header summary; thumbnail and symbol routes 400/401/403/404/200/304, kiosk key and `?event=`, render on miss, row written once, every fixture symbol 200 and one past the end 404, `render: null` 404, previews never bump `last_referenced_at`; library route 400/401/200/304/404 incl. variant and other version; auth off |
| E2E | `e2e/map-backfill.spec.ts` | legacy club row inserted directly → Maintenance card shows it pending → Import now → "Imported n, failed 0" → series + version exist → no longer pending |
| E2E | `e2e/map-documents.spec.ts` | UI upload on `itest` → `documentHash` → route 200/304/206, own import job admits the uploader through a non-pinning event, anonymous 401 → thumbnail and symbol swatch 200 / 401 anonymous, library swatch by the header's library and version → source route streams `test.ocd` back (200, `no-store`, attachment), anonymous 401 → dev page `?url=` loads it natively → `latestForEvent` done with report; chunked route (chunks out of order) → `applyUploadedMap` → `mapMetadata`; `clubMap.upload` → `mapImport.status` done |
| Unit (api) | `packages/api/src/__tests__/snapshot-maps.test.ts` | `pinnedHashes` (dedup, each document's own source), `partitionMapFiles` (pre-pipeline rows skipped, local identity dropped), `exportBlobInput` bounds (table, hash, start, 4 MiB), `verifyBlob` size and hash, `fetchBlob` slice order, peer hash / size mismatch, short slice |
| Unit (api) | `packages/api/src/__tests__/backup.test.ts` | dump table order (blobs before `map_files`, no previews / tiles), one `\copy` per table, blob filters by the event's pins, `splitBackupSections` |
| Integration (api) | `packages/api/src/__tests__/integration/lease.test.ts` | checkout carries file + source + document (bytes, header, pin, `file_data`, view overrides, venue-local NULLs, pre-pipeline row skipped, counts); document route on the venue 401 anonymous / 200 with the kiosk key; tampered bytes fail the checkout, release the peer lease and store nothing; exporter without `maps`; `exportBlob` refuses other events' blobs and a start past the end; re-checkout fetches nothing and keeps the blob rows |
| Integration (api) | `packages/api/src/__tests__/integration/backup.test.ts` | dump completes with exactly the event's source and document as `\x` hex before `map_files`, no previews; event and blobs deleted → `restore-map-blobs.sql` restores byte-exact into another event (`uploaded_by` of a missing user NULL, grace restarted), second run a no-op, tampered bytes refused with nothing written, blobs alone without an event id |
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
| `packages/api/src/render/previews.ts` | swatch and thumbnail renderers (reference raster) |
| `packages/api/src/map-store/source-routes.ts` | source route: download predicate, slice planner, `streamBlob` |
| `packages/api/src/map-store/gc.ts` | `runStorageGc`, daily schedule (`maybeStartStorageGc` / `stopStorageGc`), grace and due rules |
| `packages/api/src/routers/mapStorage.ts` | `mapStorage.gcRun` |
| `packages/api/prisma/migrations/20261019120000_map_import_jobs_started_by/` | `map_import_jobs.started_by`, `document_hash` index |
| `packages/api/prisma/migrations/20261019130000_map_storage_source_hash_indexes/` | `source_hash` indexes on `map_files`, `club_map_versions` |
| `packages/api/src/map-store/uploads.ts` | pure upload rules: limits, chunk sizes, kind sniffing, assembly |
| `packages/api/src/map-store/upload-routes.ts` | `POST /api/map-uploads`, `PUT …/chunks/:n`, `POST …/finalise` |
| `packages/api/src/map-store/jobs.ts` | job rows, claim / heartbeat / stale reclaim, worker launcher, `applyJobResult`, housekeeping, engine tick |
| `packages/api/src/background/supervisor.ts` | lease-holder reconcile; starts / stops the GC |
| `packages/api/src/map-store/import-worker.ts` | worker-thread body: `importMapToDocument` by kind + report |
| `packages/api/src/map-store/backfill.ts` | plan, per-row backfill, run loop, in-process run for the Maintenance tab |
| `packages/api/src/cli/map-backfill.ts` (+ `-args.ts`) | `pnpm map:backfill` |
| `packages/api/src/routers/mapImport.ts` | `mapImport.status`, `latestForEvent`, `backfillStatus`, `backfillStart` |
| `packages/web/src/components/MaintenancePanel.tsx` | Map documents card |
| `packages/api/src/event-map.ts` | `applyEventMap` writes the source row and starts the event job |
| `packages/api/src/routers/course.ts` / `clubMap.ts` | `applyUploadedMap`, `useClubMap` version pin; `createClubMap`, `addFromSource`, series mirroring |
| `packages/web/src/lib/map-upload.ts` | client chunked uploader |
| `packages/api/src/sync/snapshotMaps.ts` | checkout snapshot map part: export, `exportBlobSlice`, `fetchSnapshotBlobs`, `importSnapshotMaps` |
| `packages/api/src/sync/lease.ts` / `routers/lease.ts` | `EventSnapshot.maps`, `LeasePeer.exportBlob`, `lease.exportBlob`, checkout `maps` counts |
| `packages/api/src/backup.ts` | `BACKUP_TABLES`, `buildBackupScript`, `splitBackupSections` |
| `packages/api/scripts/restore-map-blobs.sql` | idempotent restore of the dump's map sections |
| `packages/shared/src/import/report.ts` | `importReportSchema` |
