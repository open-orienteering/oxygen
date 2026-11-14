# Map patches

Normative specification of the **map patch**: an event's corrections to
its pinned map document (hide, move or reshape, change symbol, add), how
they are stored and merged, and how a patch is applied to give the
**effective document**, the one screen, print and kiosk draw. Research
record: `docs/research/vector-map-pipeline/08-course-editor.md` §4.1,
§4.7, `02-document-format.md` §7, §10 and `04-render-core.md` §7
"Appending objects". The decisions this chapter makes beyond the research
are in `decisions/slice-g.md`. Slice G; the Map mode UI is
`course-editor.md` §13 (row G6).

Implementation: `packages/shared/src/map-document/patch.ts`, exported
with the rest of the document module (`import { mapDocument } from
"@oxygen/shared"` → `mapDocument.applyPatch`, …).

## 1. Model

A patch belongs to one event and one document hash (the document the
event pins, `map-storage.md` §5). It never changes the document, which
stays immutable and content-addressed (`map-document-format.md` §6); it
is applied on top of it, before symbolisation (08 §4.1).

### 1.1 Keyed states, not a log

The patch is a set of **keyed states**, not an ordered list of edits
(`course-layer.md` §7; slice G answer 1). There is at most one op per
`(target, kind)`, and its **op id** says which:

| Op id | Op | State it sets |
|---|---|---|
| `hide:<sourceIndex>` | `hide` | the document object is not drawn |
| `modify:<sourceIndex>` | `modify` | the document object's coordinates (and, optionally, rotation) are these |
| `resymbol:<sourceIndex>` | `resymbol` | the document object is drawn with this symbol |
| `add:<uuid>` | `add` | this new object exists |

Because an op sets a state rather than applying a change, putting the
same op twice equals putting it once, and ops on different ids may be
put in any order with the same result. Editing an added object rewrites
its `add` op; hiding an added object removes it. A hide, a modify and a
resymbol of the same object are three independent states, all kept: the
object is drawn nowhere while hidden, and *Restore* (removing the hide)
brings back the moved shape in its new symbol.

### 1.2 Schema

`mapPatchSchema` (Zod):

```ts
type PatchCoord = [x: number, y: number] | [x: number, y: number, flags: number];

type PatchSymbolRef =
  | { doc: number }       // index into the pinned document's header.symbols
  | { patch: string };    // key into patch.symbols

type PatchOp =
  | { op: "hide";     sourceIndex: number }
  | { op: "modify";   sourceIndex: number; coords: PatchCoord[]; angle?: number }
  | { op: "resymbol"; sourceIndex: number; symbol: PatchSymbolRef }
  | { op: "add";      id: string; type: 1 | 2 | 3; symbol: PatchSymbolRef; coords: PatchCoord[]; angle?: number };

interface MapPatch {
  documentHash: string;                     // the document the ops are keyed onto (64 hex)
  enabled: boolean;                         // default true
  ops: Record<string, PatchOp>;             // key = patchOpId(op)
  symbols: Record<string, PatchSymbol>;     // key = the full library entry id it was materialised from
}
```

- **Targets are `sourceIndex`**, the object's position in the source
  file's object list (`map-document-format.md` §2.4). It is unique within
  a document (both importers number the source list; dropped objects
  leave gaps). An op never stores an `objectIndex`: for the pinned hash
  it is derived, and after a re-import it is wrong, while `sourceIndex`
  re-resolves a re-import of the same file exactly (02 §7; row G11).
  It is a u32 below `0xFFFFFFFF`, which marks an added object (§2.2).
- **A record key must equal the op's id**: `patchOpId(op)` is
  `` `${op.op}:${op.sourceIndex}` `` for the three document-object ops and
  `` `add:${op.id}` `` for an add. A mismatched key is a schema error.
- **Geometry** is in the document's native units (`unitsPerMm`), the JSON
  projection's coordinate form (`map-document-format.md` §7): `[x, y]` or
  `[x, y, flags]` with integer `x`, `y` in int32 and a `COORD_FLAG` byte
  (0–255), at least one coordinate.
- **`angle`** is the object's rotation in 0.1°, as `attrs.angle` holds it
  (int16). On `modify` it is optional and absent means the document's own
  rotation; on `add` absent means 0. (User 2026-11-13, G2 question 1: a
  point's, an area pattern's or a text's rotation lives in `attrs.angle`,
  not in the coordinates, so `modify` carries it rather than turning a
  rotation into hide + add, which would lose the object's `sourceIndex`
  identity at re-resolution and promote. Extends 08 §4.7's geometry-only
  `modify`.)
- **`add`** creates a point (1), line (2) or area (3) object; no text
  (slice G: no text creation). Its `id` is a lowercase UUID, generated
  by the client that draws it.
- **`modify`** keeps the object's type, symbol (unless resymbolled) and
  text; a text object can therefore be moved but not edited.

### 1.3 Patch symbols

`symbols` holds the symbols the patch adds to the document's table:
library entries **materialised** for this document (03 §1; row G8 —
colours aligned to the document's stack, scaled to it, including entries
of another library than the document's, such as `ISSkiOM2019`). It is a
**record keyed by the full library entry id** the symbol was materialised
from (`"ISOM2017-2:206"`, `"ISSkiOM2019:…"`), and ops reference a symbol
as `{ doc: index }` (the document's own table) or `{ patch: key }`. (User
2026-11-13, G2 question 2. 08 §4.7 had an array appended after the
document's table and a combined `symbolIdx` in the ops. With per-op
merging two clients materialising on first use would both claim the
index after the document's last symbol, and every stored index would
shift when the patch is re-keyed onto a document with another symbol
count; materialisation is deterministic per document, so two puts of
the same key are the same state.) The combined table exists only in the
effective document (§2.2).

`patchSymbolSchema` is the document symbol schema
(`map-document-format.md` §2.2) without `match` and `sourceIndex`, and
with a non-null `render`. **A patch symbol is drawn from its own
`render`, never through a canonical match**: the render bridge redraws an
applied match from the library at the document's `documentFactor`, which
is wrong for an entry of another library (scaled by its own
`libraryFactor`, G8). A `match` in the input is dropped by the parse.

What fills `symbols` is `materialiseSymbol(doc, entryId)`
(`map-symbols.md` §11.1): the entry resolved through the document's
stack and scaled to it, or not materialisable when the stack lacks one of
its colours. Map mode offers the entries through `mapPalette`
(`map-symbols.md` §11.2) and materialises one on first use (row G9).

### 1.4 The toggle

`enabled: false` turns the patch off without losing it (09 §6, the
rollback; Map mode's *Apply corrections* box): every consumer then draws
the pinned document unchanged.

### 1.5 Merging

`mergePatch(patch, change)` is the per-op-id merge the server runs under
the row lock (`mapPatch.applyChange`, row G3) and a client runs for its
optimistic copy:

```ts
interface PatchChange {
  put?: PatchOp[];                          // set these states (replace by id)
  remove?: string[];                        // drop these op ids (absent ids are no-ops)
  putSymbols?: Record<string, PatchSymbol>; // add or replace these symbols by key
}
```

`patchChangeSchema` rejects a change that puts one id twice or both puts
and removes it. The result is a new patch (the input is not mutated) with
`ops` and `symbols` keys in sorted order, so two merges reaching the same
state also serialise to the same JSON. Merging the same change twice
equals merging it once; changes to different ids commute. Two changes to
the same id are last-writer-wins: the merge is per state, not per field.
Symbols are only put, never removed by a change: one no op references is
harmless (it is appended to the effective table and listed by the
palette).

## 2. Application: the effective document

`applyPatch(doc, patch)` → `{ document, issues }`. Pure, deterministic,
never throws on patch content, and never mutates `doc`.

- **The caller pairs the patch with its document**: `doc` must be the
  document whose hash is `patch.documentHash`. A decoded document does
  not know its own hash, so `applyPatch` cannot check it; delivery (row
  G3) and re-resolution (row G11) guarantee it, and a consumer (G4, G14)
  applies the patch it received with the document it pins. A patch keyed
  onto another edition would otherwise apply by `sourceIndex` to the
  wrong objects.
- **`doc` is a pinned document, not an effective one**: applying ops to
  an already-effective document is a programming error and throws (the
  identity cases of §2.1 still return it as it is).

### 2.1 Identity

When `patch` is null or undefined, `enabled` is false, or it has no ops,
`document` **is `doc`** (the same object) and `issues` is
empty. Everything drawn from it is then exactly what the unpatched
document gives; print's "toggle off is byte-identical" (row G14) rests on
this.

### 2.2 The effective document

The effective document is a `MapDocument` (`map-document-format.md`
§3–5's decoded form), so every existing reader works on it unchanged,
with two optional fields:

```ts
interface EffectiveDocument extends MapDocument {
  hidden?: Uint8Array;   // 1 = hidden by the patch; absent on an unpatched document
  patch?: {
    baseCount: number;   // the pinned document's object count, N
    baseSymbols: number; // the pinned document's symbol count, S
    added: string[];     // added[k] = the add id of object N + k
    symbols: string[];   // symbols[k] = the patch symbol key at index S + k
  };
}
```

- **Objects `0 … N-1` are the document's, at the same indices**, hidden
  ones included: every `(documentHash, objectIndex)` reference to the
  pinned document (`map-document-format.md` §6) still means the same
  object. Their `type`, `sourceIndex` and text are the document's; their
  geometry is the document's unless a `modify` sets it; their symbol is
  the document's unless a `resymbol` sets it.
- **Hide is a flag, not a removal**: `hidden[i] = 1`. Every reader skips
  flagged objects (§2.4).
- **Modify** replaces the object's coordinates and flags (its bbox is
  recomputed) and, when the op has one, its `angle`.
- **Resymbol** sets `attrs.symbolIdx[i]` to the referenced symbol's index
  in the combined table.
- **Added objects are appended at `N … N+M-1`, ordered by op id** (string
  code-unit order, which for UUIDv7 ids is creation order). Their
  `sourceIndex` is `ADDED_SOURCE_INDEX` (`0xFFFFFFFF`, which no source
  object has), with no text. An added object's identity is its add id;
  its `objectIndex` holds for one patch content only (adding an object
  with a smaller id moves it), so nothing outside the patch stores it.
- **The combined symbol table** (`header.symbols`) is the document's
  table followed by every patch symbol in key order, referenced or not
  (`patch.symbols` above gives the keys). `attrs.symbolIdx` is u16, so
  the table holds at most 65 536 entries; patch symbols beyond that are
  left out and the ops that reference them reported (§2.3).
- **`header.objects.count = N + M`**; `header.strings` and
  `header.bounds` are the document's. A correction does not move the
  map's extent, its previews or a layout; an added object outside the
  bounds is still drawn.
- The effective document lives in memory only: its `attrs.geomOffset`
  and `header.objects.sections` describe the pinned file's bytes and
  mean nothing for it, and it is never encoded or hashed here. (Promote,
  row G12, applies the patch at the import's store stage instead.)
- When the patch changes no geometry (hides and resymbols only), the
  effective document shares the pinned document's coordinate, flag,
  coordinate-start and bbox arrays; consumers treat a document's arrays
  as read-only.

### 2.3 Issues

An op that cannot be applied is skipped and reported in `issues`; the
other ops still apply. Each issue is `{ opId, code }` with a stable code:

| Code | When |
|---|---|
| `target-missing` | no object of the document has the op's `sourceIndex` |
| `symbol-missing` | `{ doc: i }` with `i` outside the document's table, or `{ patch: key }` not an own key of `symbols` |
| `kind-mismatch` | the referenced symbol's `kind` is not the object type's (point 1 → `point`, line 2 → `line`, area 3 → `area`, text 4–6 → `text`, rectangle 7 → `rectangle`) |
| `geometry-invalid` | a point without exactly one coordinate, a line with fewer than two, an area with fewer than three, a text object whose coordinate count changes (its anchor and box are positional) |
| `symbol-table-full` | the referenced patch symbol did not fit in the u16 symbol table |

Issues are in op-id order. The editor's *Corrections* list (row G6)
shows them; re-resolution (row G11) adds its own `unresolved` state to
ops that lost their target after the pin moved.

### 2.4 Consumers

- **The render bridge** (`documentRenderInput`, `map-document-format.md`
  §8) takes an effective document: an object with `hidden[i]` is skipped
  and counted in `stats.patchHidden` (apart from `stats.hidden`, the
  objects of hidden symbols). `docIdx` carries effective indices (`≥
  patch.baseCount` is an added object, `patch.added[i - baseCount]` its
  id); `only` takes effective indices. Patch symbols carry no match, so
  they are drawn from their `render`.
- **A patch symbol's `hidden`** is honoured like a document symbol's: its
  objects are skipped and counted in `stats.hidden`.
- **Cost**: each call indexes all N objects by `sourceIndex` and copies
  the attribute arrays, and with a modify or an add rebuilds every
  coordinate array — linear in the document, fine for print and for a
  patch change, not a per-frame operation; the viewer's incremental path
  (row G4) re-prepares only the touched buckets.
- **The viewer** (row G4, `map-rendering.md` §5.2 "Object identity and
  the patch"): the worker takes `{ document, patch }`. Its range tables
  key on the effective `objectIndex`; a hidden object is skipped through
  the range table (ids only, nothing re-prepared); modified, resymbolled
  and added objects are symbolised on their own and only the buckets
  whose content changed are re-prepared. A patch change redraws without
  reloading the document. Viewer, kiosk and editor all draw the
  effective document.
- **The course layer's cuts** (`course/cuts.ts` `cutFeaturesOfDocument`,
  G4) skip `hidden[i]` and read modified objects where they are; the
  viewer's worker recomputes them with every patch change. **Filter
  regions** act on the effective document in the viewer (G4).
- **The snap and pick indices** (`lib/editor/snap.ts`, `symbol-pick.ts`,
  G4) are built from the effective document: hidden objects neither snap
  nor are picked or counted, modified and added ones are where the patch
  puts them. An object drawn with a patch symbol is not picked by symbol
  (a filter region stores document symbol indices; Pending).
- **Every other reader of a document's objects** — the course checks
  (`course/checks.ts`), print, the API's event map objects — must skip
  `hidden[i]` when it starts receiving an effective document (row G14).

## 3. Storage and delivery

Row G3. One cloud-owned row per event, merged on the server per op id,
not journaled (slice G answer 1, `course-layer.md` §7). Implementation:
`packages/api/src/map-store/patches.ts` (storage and the delivery rule),
`routers/mapPatch.ts` (procedures), `map-store/routes.ts` (the REST
route).

### 3.1 Table

```sql
CREATE TABLE oxygen.map_patches (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id       BIGINT NOT NULL UNIQUE REFERENCES oxygen.events(id) ON DELETE CASCADE,
  document_hash  TEXT NOT NULL REFERENCES oxygen.map_documents(hash) ON DELETE RESTRICT,
  enabled        BOOLEAN NOT NULL DEFAULT true,          -- §1.4
  ops            JSONB NOT NULL DEFAULT '{}',            -- record keyed by op id (§1.2)
  symbols        JSONB NOT NULL DEFAULT '{}',            -- record keyed by library entry id (§1.3)
  version        BIGINT NOT NULL DEFAULT 0,              -- the token
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),     -- trigger
  CHECK (jsonb_typeof(ops) = 'object'), CHECK (jsonb_typeof(symbols) = 'object')
);
CREATE INDEX ON oxygen.map_patches (document_hash);
```

Migration `20261113120000_map_patches` (additive: a new table).

- **One row per event** (`UNIQUE (event_id)`). 08 §4.7 had
  `UNIQUE (event_id, document_hash)`; with keyed states and re-resolution
  re-keying the row in place (§4, row G11) a second row per document has
  no reader.
- **`document_hash`** is the document the ops are keyed onto. `RESTRICT`
  and the storage GC's reference (`map-storage.md` §8.1) keep that
  document while the row exists, even after the event's pin moved.
- **`version`** is the row's token, as `course_objects.version`
  (`course-layer.md` §7, §8.4): an HLC minted on every write that changes
  the row, `0` for a row never written. On the wire, a decimal string.
  It is the delivery's ETag, `course.mapMetadata.patchVersion` and the
  print cache's key (row G14).
- The JSON columns hold the shared schema's shapes as on the wire
  (`mapPatchSchema`), keys in sorted order (`mergePatch`). A row that does
  not parse (written by a newer image) reads as no patch, with a warning.

### 3.2 Writes

| Procedure | Input | Permission | Result |
|---|---|---|---|
| `mapPatch.get` | — | `courses.view` or the kiosk key | `{ version, patch }` (§3.3) |
| `mapPatch.applyChange` | `{ documentHash } ∧ patchChangeSchema` (`put`, `remove`, `putSymbols`) | `courses.edit` | `{ version, patch }` |
| `mapPatch.setEnabled` | `{ enabled: boolean }` | `courses.edit` | `{ version, patch }` |

Writes are not lease-guarded and not journaled: the patch is cloud-owned
non-critical data (08 §4.8). Each write is one transaction:

1. Read the event's pin (`map-storage.md` §4.6). No pin →
   `PRECONDITION_FAILED` `PATCH_NO_DOCUMENT`. For `applyChange`, a
   `documentHash` other than the pin → `PRECONDITION_FAILED`
   `PATCH_DOCUMENT_MISMATCH`: the client's ops are keyed onto another
   document than the one the server would key them onto.
2. Create the row if there is none (`INSERT … ON CONFLICT (event_id) DO
   NOTHING`, keyed to the pin), then lock it (`SELECT … FOR UPDATE`).
   Two first writers both end on the one row.
3. A row keyed to another document than the pin is **dormant** (below):
   `PRECONDITION_FAILED` `PATCH_STALE`. The pin is read again under the
   lock, so a pin that moved since step 1 refuses the write the same
   way. (A pin that moves after that read and before the commit is not
   excluded: the pin's writers do not take the patch lock. The write
   then lands on a row that is dormant from the next read on; nothing
   is lost. Re-resolution, row G11, re-keys under the lock.)
   A stored row that does not parse (written by a newer image) is not
   overwritten: `INTERNAL_SERVER_ERROR` `PATCH_UNREADABLE`.
4. `applyChange`: `mergePatch(row, change)` (§1.5). `setEnabled`: the new value.
   The stored `ops` + `symbols` JSON is capped at 4 MiB
   (`MAP_PATCH_MAX_BYTES`, `PAYLOAD_TOO_LARGE` `PATCH_TOO_LARGE`): a patch is kilobytes,
   and it travels inside the one JSON checkout snapshot.
5. A write that changes nothing (the same change again, the toggle at
   its value) writes nothing and keeps the version, so "twice equals
   once" holds for the token too. Otherwise the row is written with a
   new version.

The merge procedure is `applyChange`, not 08 §6's `apply`: tRPC
reserves `apply` (with `call`) as a router key.

`applyChange` takes no `baseVersion`: the merge is per op id, so two editors on
different objects both win, and two on the same op id are
last-writer-wins (§1.5). Ops are not checked against the document on
write: an op that cannot be applied is reported at application (§2.3),
and one that lost its target after a pin move must stay stored for
re-resolution. `setEnabled` with no row creates an empty one keyed to the
pin.

The errors carry their code as the message prefix (`PATCH_STALE: …`), as
the course-object refusals do.

**A dormant patch** (user 2026-11-13, G3 question): until re-resolution
lands (§4, row G11), a re-import, re-match, `finalise` or new upload that
moves the event's pin leaves the row keyed to the old document. Such a
row is kept (with its document, by `RESTRICT` and the GC reference), not
delivered (§3.3: `patch: null`, version `"0"`) and not writable
(`PATCH_STALE`). Nothing is lost; Map mode cannot edit that event until
G11 re-keys the row onto the new pin, which replaces the refusal. The
alternatives — re-key to the new pin with empty ops (discards the
corrections), or a row per document (`UNIQUE (event_id, document_hash)`,
contradicts answer 1) — were declined.

### 3.3 Delivery

The patch reaches whoever may read the event's document through the
event (`map-storage.md` §4.2's event clause): auth off, the event's kiosk
key, or `courses.view`.

```
GET /api/maps/:nameId/patch     → 200 application/json { version, patch }
                                  ETag: "<version>"   Cache-Control: private, no-cache
                                  304 on If-None-Match; 404 unknown event; 401 / 403
```

`mapPatch.get` answers the same body over tRPC.

- **Paired with its document**: `patch` is the row only when the row's
  `document_hash` is the event's pin (§2: the caller pairs the patch with
  the document; delivery guarantees it). No row, no pin, or a dormant row
  → `{ version: "0", patch: null }`, a 200 — null is the identity (§2.1),
  so a viewer passes what it receives to `applyPatch` unchanged. A row
  created by a write that changed nothing (an empty `applyChange`,
  `setEnabled(true)` on no row) keeps version `"0"` and is delivered as
  the empty patch it is — also the identity; `"0"` therefore means "no
  correction to draw", not "no row".
- **The descriptor**: `course.mapMetadata` gains `patchVersion` (the same
  version, `"0"` when nothing is delivered), so a client holding the
  document knows when to refetch the patch. It reads the row's
  `document_hash` and `version` only (`eventPatchVersion`), not the ops.
- The route revalidates on every use (`no-cache`); the ETag makes an
  unchanged patch a 304.
- A disabled patch is delivered as it is (`enabled: false`): the toggle
  is the consumer's to read, and Map mode shows the ops it keeps.
- **The web client** (row G4; `lib/map-document-cache.ts`): `useMapPatch(nameId,
  patchVersion)` asks the route with the kiosk key as a header (never in
  the query) and `If-None-Match` with the session's version, keeps the
  delivery per event for the session (`getMapPatch`, `setMapPatch`,
  `subscribeMapPatch`), and asks again when `mapMetadata.patchVersion`
  differs from it and when the page regains focus, becomes visible or
  comes back online — there is no live channel, since the patch is not
  journaled. One request per event at a time; a version change that
  joined a request already in flight and still got the old version asks
  once more (`refreshMapPatch`); a failure keeps the
  session's copy, else none (never an error to the viewer); a body whose
  `patch` does not parse is no patch, with a warning. The viewer pairs the
  delivery with its document by hash (`patchForDocument`) and does not
  wait for it. The route is not in Cache Storage: a device that starts
  offline draws the pinned document (Pending).

### 3.4 Venue

The patch travels in the checkout snapshot's `maps` part
(`map-storage.md` §7.2) as `maps.patch`: the row with its token as a
decimal string, carried only when its document is among the snapshot's
documents, and inserted on the box after the documents (the `RESTRICT`
FK). It is not in `SNAPSHOT_TABLES`: those rows are inserted before the
`maps` part, and their BigInt columns cross the HTTP snapshot as JSON
numbers. The box's route and `mapPatch.get` answer from its copy.

`mapPatch.` mutations are cloud-owned (`sync/ownership.ts`): a venue box
forwards them to the cloud, and answers the typed `PRECONDITION_FAILED`
("requires connectivity") offline. The box's own copy stays the
checkout's until a box follows the cloud's map rows (row G19).

### 3.5 Per-event dump

`GET /api/backup/event` carries a `map_patches` section directly after
`map_files` (all columns; a plain event-scoped section, restored with
`event_id` rewritten as the others, `docs/backup-restore.md`). The
`map_documents` and `map_sources` sections also carry the patch's
document and its source, so a dormant patch restores too.

### 3.6 Garbage collection

A `map_patches` row is a reference to its document
(`map-storage.md` §8.1): the collector neither deletes nor ages a
document only a patch points at, and touches its `last_referenced_at`.
`RESTRICT` is the belt.

## Pending in this chapter

- **A box follows the cloud's patch during a lease** (row G19): a
  forwarded write reaches the cloud, but the box serves the checkout's
  copy until then (§3.4).
- **An offline copy of the patch** (G4, decided overnight for review).
  The document is CacheFirst in the service worker; the patch route is
  not cached, so a device that starts offline (Field mode) draws the
  pinned document. A NetworkFirst runtime route (`vite.config.ts`) or an
  IndexedDB copy is a follow-up row (G17 or its own).
- **Patch symbols in the eyedropper** (G4, decided overnight for review;
  `map-rendering.md` §8): a
  filter region cannot select an object drawn with a patch symbol by
  symbol until the region props carry a stable symbol key.
- **§4 Re-resolution** (row G11): re-keying a patch when the event's pin
  moves (same source by `sourceIndex`; a new edition by position and
  symbol within 0.5 mm), the `unresolved` flag, symbol references
  `{ doc }` re-keyed with it; it wakes a dormant row (§3.2).
- **§5 Promote** (row G12): the patch applied at the import's store
  stage for a club version.
- **Print and checks** (row G14); the cuts read the effective document
  since G4 (§2.4).

## Tests

| Level | File | Covers |
|---|---|---|
| Unit (shared) | `packages/shared/src/map-document/__tests__/patch.test.ts` | schema: each op parses, a key that is not the op's id, a bad UUID, a non-integer or out-of-range coordinate, a text `add`, a patch symbol's `match` dropped, defaults; `patchChangeSchema` refusals; `mergePatch`: put replaces by id, remove, an absent remove, twice = once, two changes in either order deep-equal and the same JSON, input not mutated; `applyPatch`: identity (null, disabled, empty) returns the same document, hide flags the object found by `sourceIndex` (a fixture whose Hilbert order differs from source order), modify (coordinates, flags, bbox, `coordStart` of it and its neighbours, angle, type and text kept), resymbol to `{ doc }` and `{ patch }`, hide + modify + resymbol on one object, add (indices `≥ N` in op-id order, `ADDED_SOURCE_INDEX`, the combined table in key order), every base object unchanged, any insertion order of `ops` and `symbols` gives a deep-equal result, applying twice from the same input equals once, the input untouched, each issue code reported and the other ops still applied (a prototype-name patch key is `symbol-missing`), a rectangle's kind check, ops on an already-effective document throw while identity still returns it |
| Unit (shared) | `packages/shared/src/map-document/__tests__/render-bridge.test.ts` | over an effective document: a hidden object missing from `objects` and `docIdx` with `stats.patchHidden`, a modified one symbolised at its new place, an added one with a patch symbol symbolised and its `docIdx ≥ baseCount`, `only` with an added index, a patch symbol drawn from its own `render` (not rescaled by `documentFactor`), a disabled patch deep-equal to the unpatched document |
| Unit (api) | `packages/api/src/__tests__/map-patches.test.ts` | `patchOfRow` (sorted keys; an unparseable row → null with a warning), `deliveredPatch` (the pin's row with an exact decimal version above 2^53; disabled delivered as it is; no row / no pin / dormant → `{ "0", null }`), `samePatchContent` key-order blind, `assertPatchSize` (`PAYLOAD_TOO_LARGE` past 4 MiB), `patchEtag` |
| Unit (api) | `packages/api/src/__tests__/snapshot-maps.test.ts` | `snapshotPatchOf`: the row with an exact decimal token; nothing without a row or for a dormant one |
| Unit (api) | `packages/api/src/__tests__/venueForwarder.test.ts` | `mapPatch.applyChange` / `setEnabled` cloud-owned and forwarded, `mapPatch.get` served locally |
| Unit (api) | `packages/api/src/__tests__/backup.test.ts` | `map_patches` directly after `map_files`; the blob sections' filters include the patch's document and its source |
| Integration (api) | `packages/api/src/__tests__/integration/map-patches.test.ts` | no patch before a write; `applyChange` creates the row keyed to the pin and merges put / remove (an absent id a no-op) / putSymbols with sorted keys; twice = once and an empty change keep the version; six concurrent first writers on different ids → one row with all six ops; two writers on one id → one of the two states whole; refusals (duplicate id `BAD_REQUEST`, put + remove of one id, `PATCH_DOCUMENT_MISMATCH`, `PATCH_NO_DOCUMENT` for `applyChange` and `setEnabled`); `setEnabled` creates an empty row, advances only on a change, a disabled patch delivered as it is; a dormant row (pin moved) not delivered, `patchVersion` `"0"`, writes `PATCH_STALE`, row untouched, delivered again when the pin returns; an unreadable row: no patch delivered, writes `PATCH_UNREADABLE`, row untouched; the table (defaults, one row per event, `RESTRICT` on the document, cascade with the event, an array in `ops` refused); access (kiosk key and viewer read, cannot write; stranger `FORBIDDEN`; course setter writes); the route 200 with `ETag` / `Cache-Control`, 304, a stale ETag 200, header and `?k=` kiosk key, viewer 200, anonymous and wrong key 401, stranger 403, unknown event 404; `mapMetadata.patchVersion` equals the route's version |
| Integration (api) | `packages/api/src/__tests__/integration/lease.test.ts` | checkout carries the patch row verbatim (id, document, `enabled`, ops, token above 2^53 exact), `maps.patches` counted (0 from an exporter without the map part); the box's `mapPatch.get` and route (kiosk key) serve it with `ETag` = the token |
| Integration (api) | `packages/api/src/__tests__/integration/backup.test.ts` | the dump's `map_patches` section directly after `map_files` with the event's row; restored into another event with `event_id` rewritten, token and ops exact |
| Integration (api) | `packages/api/src/__tests__/integration/map-storage-gc.test.ts` | a document only a patch references is kept (dry run too) and touched; `RESTRICT` refuses its delete; collected once the patch is gone and a fresh grace passed |
| E2E | `e2e/map-documents.spec.ts` | after the UI upload: the patch route `{ "0", null }`, `mapPatch.applyChange` over tRPC, the route 200 with the op and the ETag, 304 on revalidation, anonymous 401 |
| Unit (shared) | `packages/shared/src/course/__tests__/cuts.test.ts` | G4: over an effective document a hidden boulder gives no cut feature, a modified one is at its new place |
| Unit (web) | `packages/web/src/map-gl/__tests__/worker-patch.test.ts`, `buckets.test.ts`, `engine.test.ts` | G4: the effective document in the viewer's worker and engine (`map-rendering.md` §5.2 Tests) |
| Unit (web) | `packages/web/src/lib/__tests__/map-document-cache.test.ts`, `vector-map.test.ts` | G4: the client's fetch, ETag revalidation, session store and failure rules; the pairing by hash |
| Unit (web) | `packages/web/src/lib/editor/__tests__/snap.test.ts`, `symbol-pick.test.ts` | G4: snapping and the eyedropper over the effective document |
| E2E | `e2e/map-vector-layer.spec.ts` | G4: a hidden object's pixels gone and an added one drawn after a change, with no reload; the toggle off restores both |
