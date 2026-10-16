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
  Only the garbage collector (pending, §6) deletes blobs, and only rows
  nothing points at any more.
- The upload name is **not** part of the document: it lives on
  `map_sources.file_name` and in the import report. The document header's
  `source` block is `{kind, version, hash, bytes}` only, so the document
  hash depends on the bytes and the importer version alone
  (`docs/map-document-format.md` §2).

## 2. Tables

Migration `20261016190000_map_documents_storage`. All in schema `oxygen`.

| Table | Key | Columns | Notes |
|---|---|---|---|
| `map_sources` | `file_hash CHAR(64)` | `kind` (`ocad`/`omap`), `bytes BYTEA`, `size_bytes`, `file_name`, `uploaded_by → users SET NULL`, `created_at` | the uploaded file; `bytes` is `STORAGE EXTERNAL` |
| `map_documents` | `hash CHAR(64)` | `bytes BYTEA`, `size_bytes`, `format_version`, `importer_version`, `library_version`, `source_hash → map_sources RESTRICT`, `header JSONB`, `report JSONB`, `created_at`, `last_referenced_at` | the encoded document; `header` is the summary (§3), `report` the import report |
| `map_previews` | `(document_hash, kind, key)` | `png BYTEA`, `created_at` | `document_hash → map_documents CASCADE`; filled by the review slice (pending) |
| `club_maps` | `id UUID` | `name`, `colour_profile`, `colour_overrides JSONB`, `north_lines_below`, `rotation_correction`, `created_by`, timestamps | a club's map as a series (06 §8) |
| `club_map_versions` | `id UUID` | `club_map_id → club_maps CASCADE`, `seq`, `label`, `source_hash RESTRICT`, `document_hash RESTRICT`, `uploaded_by`, `uploaded_at`; `UNIQUE(club_map_id, seq)` | one edition; `uploadedAt` ordering, `seq` for display |
| `map_files` (+) | — | `source_hash RESTRICT`, `document_hash RESTRICT`, `club_map_version_id → club_map_versions SET NULL` | the event's pins; nullable so the raster path keeps working when the import fails |

`STORAGE EXTERNAL` on the two blob columns keeps TOAST from compressing
the bytes (compact binary that gains little) so `substring(bytes FROM … FOR …)`
reads only the chunks a range request needs instead of inflating the row.

Prisma models: `MapSource`, `MapDocument`, `MapPreview`, `ClubMap`,
`ClubMapVersion`; `MapFile.sourceHash / documentHash / clubMapVersionId`.

## 3. Store stage (import stage 9)

`packages/api/src/map-store/documents.ts`:

```ts
importAndStoreOcad(db, fileBytes, fileName, { uploadedBy? })
  → { sourceHash, documentHash, deduplicated, result }   // result = importOcadToDocument()

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
  missingSymbolObjects), code-keyed `warnings[]` with counts, `timings`.
- `library_version` is `"none"` until the matcher (import stage 6) lands.
- `touchDocument(db, hash)` bumps `last_referenced_at`; called whenever a
  reference is created. GC grace is measured from it.

### 3.1 Producer today: the event map upload

`applyEventMap` (`packages/api/src/event-map.ts`, used by
`course.uploadMap` and `course.useClubMap`) runs the store stage inline
before the raster pipeline and writes `source_hash` / `document_hash` on
the new `map_files` row. The import is best-effort at this stage: a
failure is logged as `[map-store] event <id>: document import failed` and
the raster path continues with `document_hash = NULL`. Re-uploads that
change the pinned document log `[map-store] event <id>: document A → B`.
`course.mapMetadata` returns `documentHash` (nullable).

Moving the import into the 07 §9 job model (worker thread, heartbeat,
resumable) is the next step; the schema does not change for it.

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
job" as a fourth clause (07 §4, with the job model).

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

## 5. Client side

The GL dev page loads a stored document straight from the route:
`/dev/map-gl-doc?url=/api/map-documents/<hash>?event=<nameId>`. The
viewer (slice B) and the service-worker CacheFirst layer (07 §7,
`storage.persist()`) are pending; both key on the hash and may rely on
`immutable` and the `ETag`.

## 6. Pending in this chapter

Import job rows, heartbeat and resume (07 §9); chunked upload route
(07 §8); `GET /api/map-sources/:hash` streamed; previews route and rows
(review slice); club map CRUD on `club_maps` / `club_map_versions` and
the `useClubMap` pin (`club_map_version_id` is written as `NULL` today);
daily GC with a 30-day grace from `last_referenced_at` (07 §5); venue
checkout snapshot; backups by hash. Each lands with its own section here
and its own tests.

## 7. Tests

| Level | File | Covers |
|---|---|---|
| Unit (api) | `packages/api/src/__tests__/map-document-route.test.ts` | `parseRangeHeader` (forms, clamping, suffix, multi → ignored, unsatisfiable), `negotiateEncoding` (q-values, wildcard, refusal), `authoriseDocumentAccess` matrix over stub queries, `documentHeaderSummary` |
| Integration (api) | `packages/api/src/__tests__/integration/map-documents.test.ts` | store + dedup under another name, source/hash mismatch refused, `RESTRICT` on a pinned document, blob reads whole/range, `applyEventMap` pins + `mapMetadata`, route 400/401/403/404/200 with headers, `?event=` + kiosk key, brotli/gzip round trip, 304, 206/416/multi-range, club-version visibility, auth off |
| E2E | `e2e/map-documents.spec.ts` | UI upload on `itest` → `documentHash` → route 200/304/206/403 → dev page `?url=` loads it natively |

## 8. Where things live

| Path | Contents |
|---|---|
| `packages/api/prisma/migrations/20261016190000_map_documents_storage/` | tables above |
| `packages/api/src/map-store/blob-store.ts` | `BlobStore` seam |
| `packages/api/src/map-store/documents.ts` | store stage, report builder, `touchDocument` |
| `packages/api/src/map-store/routes.ts` | document route, range/encoding helpers, auth predicate |
| `packages/api/src/event-map.ts` | `applyEventMap` pins documents on event uploads |
| `packages/shared/src/import/report.ts` | `importReportSchema` |
