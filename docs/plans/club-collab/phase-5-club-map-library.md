# Phase 5 — Club Base-Map Library

Depends on: phase 3 (uploader attribution, `authedProcedure`). Creates the
`/library` page that phase 6 extends with a Controls tab.

## Goal

Club members upload OCAD base maps once, globally; anyone setting up an
event picks a map from the library and it is copied into the event, feeding
the existing per-event pipeline (tiles, CRS cache, geometry rebuild)
unchanged.

## Current state (verified)

- Maps are strictly per-event: `course.uploadMap` (`{ fileName,
  fileDataBase64 }`, 50 MB Fastify body limit) does
  `mapFile.deleteMany` → `create` → clear `map_tiles` + `rendered_maps` →
  `fireMapUpload(eventId)` → `rebuildCourseGeometry` for
  `geometrySource: "editor"` courses → `emitCourseUpserted` per course.
- OCAD metadata (scale, WGS84 bounds, north offset) is never persisted —
  parsed lazily from the blob via `ocad2geojson` `readOcad` +
  `ocadBoundsToWgs84` / `computeMapNorthOffset`
  (see `course.mapMetadata`, `packages/api/src/event-crs.ts`,
  `packages/api/src/map-projection.ts`).
- Upload UI: `packages/web/src/components/MapPanel.tsx` — `.ocd` file
  input/drop, `FileReader.readAsArrayBuffer` → base64, refetches
  `mapFileInfo` + `mapMetadata` on success.

## Data model

New model + migration `YYYYMMDDHHMMSS_club_map_files`:

```prisma
model ClubMapFile {
  id          BigInt   @id @default(autoincrement())
  name        String                                  // display name, defaults to fileName
  fileName    String   @map("file_name")
  fileData    Bytes    @map("file_data")
  scale       Float?                                  // parsed at upload; null if parse failed
  bounds      Json?                                   // { north, south, east, west } WGS84
  northOffset Float?   @map("north_offset")
  uploadedBy  String?  @map("uploaded_by") @db.Uuid   // users.id, SET NULL on delete
  uploadedAt  DateTime @default(now()) @map("uploaded_at") @db.Timestamptz(6)
  updatedAt   DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  uploader User? @relation(fields: [uploadedBy], references: [id], onDelete: SetNull)
  @@map("club_map_files")
  @@schema("oxygen")
}
```

Metadata is parsed **at upload** (unlike the event path) so the library list
renders scale/coverage without loading blobs. Parse failure is non-fatal:
store nulls, warn in log (mirror the `mapMetadata` catch pattern).

## API changes

### Refactor (no behavior change)

Extract the body of `course.uploadMap` into
`applyEventMap(db, eventId, fileName, buffer)` in a new
`packages/api/src/event-map.ts`; `uploadMap` becomes a thin wrapper.
Existing map-upload integration/E2E coverage must stay green.

### New router `clubMapRouter` (registered as `clubMap`)

All procedures `authedProcedure` (global scope — no event header needed):

| Procedure | Input | Behavior |
|-----------|-------|----------|
| `list` | — | All maps **without** `fileData`: id, name, fileName, sizeBytes (`octet_length` via select or store a `sizeBytes` column — prefer computing with Prisma `_count`-style raw select or storing `sizeBytes Int` at upload; **store the column**, simplest), scale, bounds, uploadedAt, uploader `{ email, displayName } \| null` |
| `upload` | `{ name?: string, fileName: string, fileDataBase64: string }` | Decode, parse metadata (best-effort), create row with `uploadedBy: ctx.user?.id ?? null` |
| `rename` | `{ id: number, name: string.min(1) }` | Update name |
| `remove` | `{ id: number }` | Hard delete. Allowed for uploader or admin; others `FORBIDDEN` (skip check when auth off) |
| `download` | `{ id: number }` | `{ fileName, fileDataBase64 }` |

(Adjust `sizeBytes Int` into the Prisma model above — required.)

### `course.useClubMap` (new, on `courseRouter`)

- Base: same procedure tier as `course.uploadMap` (whatever it is when this
  phase executes — `eventProcedure` today, `coursesEditProcedure` once
  phase 4 has landed).
- Input `{ clubMapId: number }`. Load blob → `applyEventMap(db,
  ctx.event.id, clubMap.fileName, buffer)`. Return `{ success, fileName,
  size }` like `uploadMap`. `NOT_FOUND` for missing id.
- The event keeps its own **copy**; later library edits don't touch events.

## Web changes

### Library page — `packages/web/src/pages/LibraryPage.tsx` (new)

- Route `/library` in `App.tsx` (top-level, lazy, before the `/:nameId/*`
  catch-all — **important**: `/library` must be registered above the
  nameId wildcard, and `library` should be added to whatever reserved-slug
  handling exists for `sanitizeNameId` collisions; verify an event named
  "library" can't shadow the route — if `competition.create` lacks a
  reserved-slug check, add one rejecting `library`, `admin`, and existing
  reserved paths with `BAD_REQUEST`).
- Header + tab strip: "Maps" (this phase) and "Controls" (placeholder
  hidden until phase 6). Link to `/library` from the CompetitionSelector
  action area (visible to all authed users).
- Maps tab: upload dropzone (reuse the MapPanel FileReader→base64 pattern;
  factor that conversion into `packages/web/src/lib/file-to-base64.ts` and
  use it from both places), list of map cards: name (inline-editable),
  fileName, size, scale (`1:10 000` formatting), uploaded by/at, buttons
  download (client-side blob download) and delete (confirm modal,
  visible per the permission rule).

### `MapPanel.tsx`

- Beside "Upload map" / "Replace map": a "From club library" button
  (`data-testid="use-club-map"`) opening a modal with the `clubMap.list`
  entries (name, scale, size); selecting one calls `course.useClubMap`,
  then refetches `mapFileInfo` + `mapMetadata` (same as upload success
  path). Hide the button when `clubMap.list` is empty.

### i18n

New namespace `library` (both locales + registration in `i18n.ts`;
`i18next.d.ts` picks it up from `resources`). Keys for the page, upload,
rename, delete confirm, "From club library" modal, empty states.

## Tests (write first)

- **Integration**
  `packages/api/src/__tests__/integration/club-maps.test.ts`:
  upload (with a small real OCD fixture — reuse bytes from `e2e/test.ocd`)
  → list has metadata and no blob; rename; download round-trips bytes;
  remove by non-uploader non-admin → `FORBIDDEN`; `useClubMap` on a test
  event → `map_files` row created, `map_tiles` cleared, editor-source
  course geometry rebuilt (create one editor course first and assert its
  geometry updates), uploading again replaces.
- **Unit**: `applyEventMap` extraction covered by existing suites; add a
  small unit for the metadata parse guard (corrupt buffer → nulls, no
  throw).
- **E2E** `e2e/club-map-library.spec.ts`: from `/library`, upload
  `e2e/test.ocd`, rename it; create an `E2E_` event, open the map panel,
  "From club library" → pick the map → map viewer renders and
  `mapFileInfo` filename matches; delete from library afterwards; event
  map unaffected (copy semantics).

## Documentation

New `docs/club-library.md` (maps section now, controls section in phase 6);
update `docs/features.md`.

## Acceptance criteria

1. Library upload/list/rename/download/delete works with attribution.
2. Copy-on-use: event map pipeline (tiles, CRS, geometry rebuild) behaves
   identically to a direct upload; later library changes don't affect the
   event.
3. Route `/library` can't be shadowed by an event slug.
4. Full §6 checklist passes.

## Out of scope

- Map versioning/deduplication, per-map permissions, previews/thumbnails
  (tile rendering for library maps), non-OCAD formats.
