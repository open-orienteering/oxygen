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
  Only the garbage collector (pending, §8) deletes blobs, and only rows
  nothing points at any more.
- The upload name is **not** part of the document: it lives on
  `map_sources.file_name` and in the import report. The document header's
  `source` block is `{kind, version, hash, bytes}` only, so the document
  hash depends on the bytes and the importer version alone
  (`docs/map-document-format.md` §2).

## 2. Tables

Migrations `20261016190000_map_documents_storage` and
`20261016210000_map_uploads_and_import_jobs`. All in schema `oxygen`.

| Table | Key | Columns | Notes |
|---|---|---|---|
| `map_sources` | `file_hash CHAR(64)` | `kind` (`ocad`/`omap`), `bytes BYTEA`, `size_bytes`, `file_name`, `uploaded_by → users SET NULL`, `created_at` | the uploaded file; `bytes` is `STORAGE EXTERNAL` |
| `map_documents` | `hash CHAR(64)` | `bytes BYTEA`, `size_bytes`, `format_version`, `importer_version`, `library_version`, `source_hash → map_sources RESTRICT`, `header JSONB`, `report JSONB`, `created_at`, `last_referenced_at` | the encoded document; `header` is the summary (§3), `report` the import report |
| `map_previews` | `(document_hash, kind, key)` | `png BYTEA`, `created_at` | `document_hash → map_documents CASCADE`; filled by the review slice (pending) |
| `club_maps` | `id UUID` | `name`, `colour_profile`, `colour_overrides JSONB`, `north_lines_below`, `rotation_correction`, `created_by`, timestamps | a club's map as a series (06 §8) |
| `club_map_versions` | `id UUID` | `club_map_id → club_maps CASCADE`, `seq`, `label`, `source_hash RESTRICT`, `document_hash RESTRICT`, `uploaded_by`, `uploaded_at`; `UNIQUE(club_map_id, seq)` | one edition; `uploadedAt` ordering, `seq` for display |
| `map_files` (+) | — | `source_hash RESTRICT`, `document_hash RESTRICT`, `club_map_version_id → club_map_versions SET NULL` | the event's pins; nullable so the raster path keeps working when the import fails |
| `club_map_files` (+) | — | `club_map_id → club_maps SET NULL` | links the legacy library row to its series while both exist (§6.5) |
| `map_uploads` | `id UUID` | `event_id → events CASCADE` (nullable), `file_name`, `kind`, `declared_bytes`, `chunk_bytes`, `uploaded_by SET NULL`, `created_at`, `finalised_hash → map_sources SET NULL` | one chunked upload in flight (§5); `kind` is set from the first chunk |
| `map_upload_chunks` | `(upload_id, n)` | `bytes BYTEA` | `upload_id → map_uploads CASCADE`; `STORAGE EXTERNAL`; deleted at finalise |
| `map_import_jobs` | `id UUID` | `event_id CASCADE` / `club_map_id CASCADE` (the target, either nullable), `source_hash → map_sources CASCADE`, `decisions JSONB`, `state`, `stage`, `progress REAL`, `claimed_by`, `heartbeat_at`, `document_hash → map_documents SET NULL`, `error`, timestamps | one import run (§6); indexed on `(state, heartbeat_at)` for the claim query and on each target |

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
  is a pending backfill (§8).
- `touchDocument(db, hash)` bumps `last_referenced_at`; called whenever a
  reference is created. GC grace is measured from it.

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
otherwise                                              → 401 if anonymous, 403 if signed in
```

`courses.view` comes from `resolveEventCapabilities` — admins, the
course-setter group, and (after an event completes) every signed-in
user, exactly as for the tRPC course procedures. Being a member of the
event is not enough: the member group has no `courses.view`.

Positive decisions are cached in-process for 60 s per
`(hash, user, kiosk key, event)`; negative ones are not. The cache is
`resetDocumentAccessCache()` for tests. Pending: "own running import
job" as a fourth clause (07 §4).

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
startImportJob(db, {sourceHash, eventId? | clubMapId?, holdMs?})
  │
  ├─ a map_documents row exists for (sourceHash, importer ∈ {ocad-4, omap-1}, library *@<current SYMBOL_LIBRARY_VERSION>)
  │     → insert state=done with that document_hash, applyJobResult, return   (06 §8 dedup, no worker)
  │
  └─ insert state=queued → kickImportJobs → hold ≤ holdMs for the result → return the row

kickImportJobs: one loop per instance
  claim (atomic updateMany: queued, or running with heartbeat older than 60 s)
  → running, claimed_by = INSTANCE_ID, stage parse
  → worker thread: parse → normalise → match → encode (stage + progress written at each boundary,
  → store: storeImportedDocument (§3)                 heartbeat every 10 s while it runs)
  → applyJobResult: pins (§6.4)
  → done | failed(error)
```

| `state` | meaning |
|---|---|
| `queued` | inserted, not yet claimed |
| `running` | claimed by `claimed_by`; alive while `heartbeat_at` is < 60 s old |
| `done` | `document_hash` set, pins applied |
| `failed` | `error` set (≤ 2000 chars); `UNSUPPORTED_FORMAT: …` for a source whose `kind` is neither `ocad` nor `omap` (unreachable from the upload routes, which sniff), the importer's message otherwise |

`stage` ∈ `parse 0.1 → normalise 0.4 → match 0.55 → encode 0.7 → store 0.9 → done 1`;
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
without `finalised_hash` older than 24 h, and `done` / `failed` job rows
not updated for 7 days, are deleted on each engine tick.

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


## 7. Client side

The GL dev page loads a stored document straight from the route:
`/dev/map-gl-doc?url=/api/map-documents/<hash>?event=<nameId>`. The
viewer (slice B) and the service-worker CacheFirst layer (07 §7,
`storage.persist()`) are pending; both key on the hash and may rely on
`immutable` and the `ETag`.

## 8. Pending in this chapter

`GET /api/map-sources/:hash` streamed; previews route and rows (review
slice); club map CRUD that reads from `club_maps` / `club_map_versions`
instead of mirroring into them; "own running import job" as a fourth
authorisation clause on the document route (§4.2); daily GC with a 30-day
grace from `last_referenced_at` (07 §5); venue checkout snapshot; backups
by hash; a re-import pass for documents stored under an older importer or
library version (`ocad-3` / `none` rows). Each lands with its own section
here and its own tests.

## 9. Tests

| Level | File | Covers |
|---|---|---|
| Unit (api) | `packages/api/src/__tests__/map-document-route.test.ts` | `parseRangeHeader` (forms, clamping, suffix, multi → ignored, unsatisfiable), `negotiateEncoding` (q-values, wildcard, refusal), `authoriseDocumentAccess` matrix over stub queries, `documentHeaderSummary` |
| Integration (api) | `packages/api/src/__tests__/integration/map-documents.test.ts` | store + dedup under another name, source/hash mismatch refused, `RESTRICT` on a pinned document, blob reads whole/range, `applyEventMap` pins + `mapMetadata`, route 400/401/403/404/200 with headers, `?event=` + kiosk key, brotli/gzip round trip, 304, 206/416/multi-range, club-version visibility, auth off |
| Unit (api) | `packages/api/src/__tests__/map-import-jobs.test.ts` | `isClaimable` matrix, `stageProgress` monotonic, worker import produces the same hashes and `libraryVersion` as the inline importer with stages `parse → normalise → match → encode`, worker rejects garbage, upload validators (`validateUploadInit`, `expectedChunkSize`, `sniffMapKind`, `missingChunks`, `assembleChunks`) |
| Integration (api) | `packages/api/src/__tests__/integration/map-import-jobs.test.ts` | `applyEventMap` job done + pins + report, dedup under another name, garbage / OMAP failures, `holdMs: 0` queued then finished by the engine, stale reclaim vs live job, `mapImport.status` auth (stranger 403, course setter ok) + `latestForEvent`, housekeeping sweep, club upload → series + version 1, `useClubMap` pin, rename / colour-stack mirroring, `addFromSource`, `remove` deletes the series, upload routes 401/403/404/400/413/201, out-of-order and repeated chunks, 415, 409 missing, finalise dedup + idempotency, 409 after finalise, `applyUploadedMap` under the upload's name, `applyJobResult` idempotent |
| Unit (api) | `packages/api/src/__tests__/map-backfill-cli.test.ts` | CLI argument parsing, per-map lines and summary |
| Integration (api) | `packages/api/src/__tests__/integration/map-backfill.test.ts` | plan counts and ordering, dry run writes nothing, legacy club row → series (settings copied) + version 1 (label / uploader / time from the row), event rows → pins with dedup and club-version pin, unreadable rows reported and left unpinned, second run revisits only what is missing, `--event` scope and soft-deleted events skipped, `backfillStatus` / `backfillStart` admin-only, background run and `CONFLICT` |
| Unit (web) | `packages/web/src/__tests__/map-upload.test.ts` | threshold, init → chunks → finalise call order and progress, per-chunk retry on 5xx, no retry on 4xx, `x-event-id` only for event uploads |
| E2E | `e2e/map-backfill.spec.ts` | legacy club row inserted directly → Maintenance card shows it pending → Import now → "Imported n, failed 0" → series + version exist → no longer pending |
| E2E | `e2e/map-documents.spec.ts` | UI upload on `itest` → `documentHash` → route 200/304/206/403 → dev page `?url=` loads it natively → `latestForEvent` done with report; chunked route (chunks out of order) → `applyUploadedMap` → `mapMetadata`; `clubMap.upload` → `mapImport.status` done |

## 10. Where things live

| Path | Contents |
|---|---|
| `packages/api/prisma/migrations/20261016190000_map_documents_storage/` | tables above |
| `packages/api/src/map-store/blob-store.ts` | `BlobStore` seam |
| `packages/api/src/map-store/documents.ts` | store stage, report builder, `touchDocument` |
| `packages/api/src/map-store/routes.ts` | document route, range/encoding helpers, auth predicate |
| `packages/api/src/map-store/uploads.ts` | pure upload rules: limits, chunk sizes, kind sniffing, assembly |
| `packages/api/src/map-store/upload-routes.ts` | `POST /api/map-uploads`, `PUT …/chunks/:n`, `POST …/finalise` |
| `packages/api/src/map-store/jobs.ts` | job rows, claim / heartbeat / stale reclaim, worker launcher, `applyJobResult`, housekeeping, engine tick |
| `packages/api/src/map-store/import-worker.ts` | worker-thread body: `importMapToDocument` by kind + report |
| `packages/api/src/map-store/backfill.ts` | plan, per-row backfill, run loop, in-process run for the Maintenance tab |
| `packages/api/src/cli/map-backfill.ts` (+ `-args.ts`) | `pnpm map:backfill` |
| `packages/api/src/routers/mapImport.ts` | `mapImport.status`, `latestForEvent`, `backfillStatus`, `backfillStart` |
| `packages/web/src/components/MaintenancePanel.tsx` | Map documents card |
| `packages/api/src/event-map.ts` | `applyEventMap` writes the source row and starts the event job |
| `packages/api/src/routers/course.ts` / `clubMap.ts` | `applyUploadedMap`, `useClubMap` version pin; `createClubMap`, `addFromSource`, series mirroring |
| `packages/web/src/lib/map-upload.ts` | client chunked uploader |
| `packages/shared/src/import/report.ts` | `importReportSchema` |
