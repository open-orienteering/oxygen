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
  unresolved?: Record<string, UnresolvedOp>; // ops that lost their object when the pin moved (§4.1, row G11)
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
(`map-symbols.md` §11.2) and materialises one on first use (row G9,
`course-editor.md` §13 "Drawing"): the client puts it with
`putSymbols` in the change whose op first references it, unless the
patch already holds the key.

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
  removeUnresolved?: string[];              // drop these unresolved entries (§4.3; absent keys are no-ops)
  putUnresolved?: Record<string, UnresolvedOp>; // put these entries back by key (G12b: the undo of a drop or an attach)
}
```

`patchChangeSchema` rejects a change that puts one id twice or both puts
and removes it, a `putUnresolved` key that is not its entry's
(`unresolvedKey(from, op)`, §4.1), and a key both put and removed. The
merge removes, then puts. `putUnresolved` is row G12b's undo of a drop
and of an attach (decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17). The result is a new patch (the input is not mutated) with
`ops`, `symbols` and `unresolved` keys in sorted order (an empty
`unresolved` omitted), so two merges reaching the same
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

Issues are in op-id order. The editor's *Corrections* list
(`course-editor.md` §13, row G6) shows them as `data-issue` on each row,
computed with the patch taken as enabled so a switched-off patch still
reports them. An op that lost its object after the pin moved is not an
issue: re-resolution moves it out of `ops` into `unresolved` (§4.1),
which *Corrections* lists apart.

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
- **The document hit-test and the edit part** (row G5, `map-rendering.md`
  §5.5 "Document objects"): the viewer's worker hit-tests the effective
  document — a hidden object is never hit, a modified one only where the
  patch draws it — and names a hit by `{ source }` or `{ added }` (§1.2),
  never by its effective index alone, which an add can shift. A draft
  (patch ops being edited, not written) is merged over the drawn patch
  with `mergePatch` and applied from the pinned document; its targets are
  drawn from the edit part and their static copies hidden by id.
- **The course layer's cuts** (`course/cuts.ts` `cutFeaturesOfDocument`,
  G4) skip `hidden[i]` and read modified objects where they are; the
  viewer's worker recomputes them with every patch change. **Filter
  regions** act on the effective document in the viewer (G4).
- **The snap and pick indices** (`lib/editor/snap.ts`, `symbol-pick.ts`,
  G4) are built from the effective document: hidden objects neither snap
  nor are picked or counted, modified and added ones are where the patch
  puts them. An object drawn with a patch symbol is not picked by symbol
  (a filter region stores document symbol indices; Pending).
- **The course checks and the API's event map objects** (G14):
  `checkObstaclesOfDocument` and `slimObjectsOfDocument` take an
  `EffectiveDocument` and skip `hidden[i]`. An added object counts like
  a document object, here and in the cuts: a patch symbol carries no
  match, so its `code` (the library entry's) decides, and its own
  `render` gives a cut feature's radius.
- **Print and the server's derivations** (G14) read the effective
  document:
  - `maps.pdf`, the server's print worker, the print job and the
    device's print worker (G16, `course-print.md` §8.6) compose it
    (`course-print.md` §4.3, §8.2, §8.5): `prepareDocument(hash, bytes,
    patch)` applies the patch, its cache keyed by hash + patch version;
    the job carries the patch inline (version 2). A skipped op is a
    `PATCH_ISSUE` warning in the log; the PDF is still served.
  - `course.checks`' obstacles, the server's cut features
    (`loadEventCutFeatures`) and the event map objects (description
    autodetect, `control.suggestDescription`, `DESCRIPTION_STALE`) are
    derived from the effective document, memoised per hash + patch
    version (`event-map-objects.ts`, `map-storage.md` §4.6).
  - The page raster (`render/page-raster.ts`) needed no change: it draws
    a composed page and decodes nothing, so a page composed from the
    effective document is drawn as such. It is the oracle the golden
    tier compares against, not a print path.
  - Document previews (`render/previews.ts`) stay unpatched: they are
    per document hash, not per event (§2.2).

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
  unresolved     JSONB NOT NULL DEFAULT '{}',            -- record keyed by origin + op id (§4.1, G11)
  version        BIGINT NOT NULL DEFAULT 0,              -- the token
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),     -- trigger
  CHECK (jsonb_typeof(ops) = 'object'), CHECK (jsonb_typeof(symbols) = 'object'),
  CHECK (jsonb_typeof(unresolved) = 'object')
);
CREATE INDEX ON oxygen.map_patches (document_hash);
```

Migration `20261113120000_map_patches` (additive: a new table);
`20261115130000_map_patches_unresolved` adds `unresolved` (additive: a
column with a default, G11).

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
  second half of the print cache's key and of the server derivations'
  memo (`<hash>:<version>`, G14; `course-print.md` §8.2).
- The JSON columns hold the shared schema's shapes as on the wire
  (`mapPatchSchema`), keys in sorted order (`mergePatch`). A row that does
  not parse (written by a newer image) reads as no patch, with a warning.

### 3.2 Writes

| Procedure | Input | Permission | Result |
|---|---|---|---|
| `mapPatch.get` | — | `courses.view` or the kiosk key | `{ version, patch }` (§3.3) |
| `mapPatch.applyChange` | `{ documentHash } ∧ patchChangeSchema` (`put`, `remove`, `putSymbols`, `removeUnresolved`, `putUnresolved`) | `courses.edit` | `{ version, patch }` |
| `mapPatch.attachUnresolved` | `{ documentHash, key, sourceIndex?, symbol? }` (§4.3; `symbol` a `{ doc } \| { patch }` reference, G12b) | `courses.edit` | `{ version, patch }` |
| `mapPatch.setEnabled` | `{ enabled: boolean }` | `courses.edit` | `{ version, patch }` |
| `mapPatch.promote` | `{ label }` (1–200 characters, trimmed) | `courses.edit`, signed in (§5) | `{ version, patch, clubMapVersion, job }` |
| `mapPatch.promoteStatus` | — | `courses.view` (not the kiosk key: the job's error text is the editor's) | the newest promote job `{ id, state, stage, progress, error }` or null (§5) |

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
   it is re-resolved onto the pin first (§4.4), and the write proceeds
   on the re-keyed row; when it cannot be (a document missing or not
   decodable), `PRECONDITION_FAILED` `PATCH_STALE`. The pin is read
   again under the lock, so a pin that moved since step 1 is treated the
   same way. (A pin that moves after that read and before the commit is
   not excluded: the pin's writers do not take the patch lock before
   their own writes. The write then lands on a row that the pin's
   re-resolution, which does take the lock, re-keys right after; nothing
   is lost.)
   A stored row that does not parse (written by a newer image) is not
   overwritten: `INTERNAL_SERVER_ERROR` `PATCH_UNREADABLE`. While the
   event's promote job is queued or running (§5), every write is
   refused `PRECONDITION_FAILED` `PATCH_PROMOTING`, read under the lock.
4. `applyChange`: `mergePatch(row, change)` (§1.5). `setEnabled`: the new value.
   `attachUnresolved`: the change `attachUnresolved` (§4.3) builds on the
   pinned document, merged; refused `BAD_REQUEST` `PATCH_ATTACH_REFUSED`
   with the reason, a no-op when the entry is gone (attaching twice
   equals once).
   The stored `ops` + `symbols` + `unresolved` JSON is capped at 4 MiB
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

**A dormant patch** (user 2026-11-13, G3 question; G11): a row keyed to
another document than the pin — between a pin move and its
re-resolution (§4.4), or when re-resolution failed — is kept (with its
document, by `RESTRICT` and the GC reference) and not delivered (§3.3:
`patch: null`, version `"0"`). A write re-resolves it (step 3) and is
refused `PATCH_STALE` only when that cannot run. Nothing is lost. The
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
- **Server consumers** (G14) read the patch with the pin they already
  hold, never through a second read of the pin: `eventPatchOnPin(db,
  eventId, hash)` is the delivery rule for that hash, and
  `eventPrintPatch` narrows it to the patch that changes the document
  (`livePrintPatch`: enabled, at least one op, keyed onto the hash) or
  null — print's input (`course-print.md` §8.2). A venue box applies its
  own copy of the row (§3.4) the same way.
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
(`map-storage.md` §7.2) as `maps.patch`: the row (`unresolved` included,
G11) with its token as a decimal string, carried only when its document is among the snapshot's
documents, and inserted on the box after the documents (the `RESTRICT`
FK). It is not in `SNAPSHOT_TABLES`: those rows are inserted before the
`maps` part, and their BigInt columns cross the HTTP snapshot as JSON
numbers (the layout rows' tokens travel exactly beside them in
`versions` since G18, `map-storage.md` §7.2). The box's route and
`mapPatch.get` answer from its copy.

`mapPatch.` mutations are cloud-owned (`sync/ownership.ts`): a venue box
forwards them to the cloud, and answers the typed `PRECONDITION_FAILED`
("requires connectivity") offline. The box's copy follows the cloud's
(row G19, `map-storage.md` §7.2 "Following the cloud during a lease"):
on the settings cadence and right after a forwarded `mapPatch.` write,
upserted verbatim with its exact token, or deleted when the cloud has
none or its patch is dormant. Offline the box keeps the copy it holds.

### 3.5 Per-event dump

`GET /api/backup/event` carries a `map_patches` section directly after
`map_files` (all columns; a plain event-scoped section, restored with
`event_id` rewritten as the others, `docs/ops/backup-restore.md`). The
`map_documents` and `map_sources` sections also carry the patch's
document and its source, so a dormant patch restores too.

### 3.6 Garbage collection

A `map_patches` row is a reference to its document
(`map-storage.md` §8.1): the collector neither deletes nor ages a
document only a patch points at, and touches its `last_referenced_at`.
`RESTRICT` is the belt.

## 4. Re-resolution

Row G11. When the event's pin moves — an upload of another file or of a
new edition (*Replace map*, *From club library*, which is also "update to
the latest version": `course.useClubMap` takes the series' latest
edition), a review's `finalise`, a re-match (`map-storage.md` §6.4, §6.9)
— the patch is **re-keyed onto the new document**: its ops follow their
objects, and what cannot follow is kept as **unresolved**, drawn nowhere,
and listed in *Corrections* to attach or drop (`course-editor.md` §13;
08 §4.7, 02 §7, 06 §6). Implementation:
`packages/shared/src/map-document/patch-resolve.ts` (`resolvePatch`,
`attachUnresolved`), `packages/api/src/map-store/patches.ts`
(`reresolveEventPatch`, `reresolveAfterPin`, `attachUnresolvedPatchOp`:
when it runs), `map-store/rematch.ts` (the sweep).

### 4.1 Unresolved entries

An op that lost its object or its symbol leaves `ops` and goes to the
patch's **`unresolved`** record (user 2026-11-15, G11 question 1). It is
not a flag on the op in `ops`: an op id is a `sourceIndex` of the
document the patch is keyed onto, so a flagged `hide:17` of the old
document would collide with, and be applied as, a hide of the new
document's object 17.

```ts
interface SymbolAnchor {           // a document symbol, as another document can find it
  code: string;                    // the source code ("206.0")
  name: string;
  kind: DocumentSymbol["kind"];
  canonicalId: string | null;      // the applied match's library entry, else null
  sourceIndex?: number;            // its position in the source symbol table
}

interface TargetAnchor {           // the object the op was keyed onto, in its origin document
  type: number;                    // OBJECT_TYPE
  symbol: SymbolAnchor;
  centreMm: [x: number, y: number];  // its bounding box's centre, paper mm (the document's own geometry)
  sizeMm: [w: number, h: number];    // its bounding box's size, paper mm
}

interface UnresolvedOp {
  op: PatchOp;                     // as it was keyed onto its origin document
  from: string;                    // the origin document's hash (64 hex)
  fromSource: string;              // the origin's source file hash (header.source.hash)
  unitsPerMm: number;              // the origin's unit: the op's coordinates are in it
  reason: "target" | "symbol";
  target?: TargetAnchor;           // hide / modify / resymbol
  symbol?: SymbolAnchor;           // the op's { doc } symbol (resymbol / add)
}

interface MapPatch {
  // … §1.2
  unresolved?: Record<string, UnresolvedOp>;   // key = `${from.slice(0, 16)}:${patchOpId(op)}`
}
```

- **The key** is the origin's first 16 hex digits and the op id, so two
  documents' `hide:17` are two entries. A key that is not its entry's is
  a schema error, as for `ops` (§1.2).
- **Absent equals empty**, and the canonical form (`mergePatch`, §1.5)
  omits an empty record, so a patch that never had one serialises as it
  did before G11. An older client's parse strips the field.
- **The anchors are taken from the origin document when the op is
  re-keyed**, so an entry never needs its origin again: that document may
  be collected (`map-storage.md` §8). `target` is the object's own
  geometry, not a `modify`'s; `symbol` is set for a `{ doc }` reference.
- **`reason`**: `target` — no object of the new document is the op's
  (§4.2); `symbol` — its object was found but its `{ doc }` symbol has no
  counterpart, or its patch symbol is no longer materialisable (an `add`
  is always `symbol`: it has no target).
- **Drawn nowhere**: `applyPatch` reads `ops` alone. Its result and its
  issues are the same with and without `unresolved` (§2), so every
  consumer — screen, print, kiosk, cuts, checks — is unchanged.
- The stored `ops` + `symbols` + `unresolved` JSON is under the 4 MiB cap
  (§3.2 step 4). Anchors make an entry larger than its op; a re-key that
  would pass the cap is not written (the row stays dormant, `PATCH_STALE`
  on a write, §4.4).

### 4.2 `resolvePatch`

`resolvePatch(from, to, patch, { toHash, toleranceMm = 0.5 })` →
`{ patch, resolved, unresolved }`: the patch re-keyed from `from` (the
decoded document whose hash is `patch.documentHash`) onto `to` (hash
`toHash`). Pure, deterministic (the result depends on the patch's
content, not on its records' insertion order), never throws on patch
content, never mutates its inputs. `toHash === patch.documentHash`
returns the patch itself.

Every op of `ops` is resolved in op-id order, then every entry of
`unresolved` in key order (§4.3):

1. **Target** (hide, modify, resymbol):
   - **Same source** (`from.header.source.hash === to.header.source.hash`:
     a re-import, a re-match, a review): the object of `to` with the op's
     `sourceIndex`, exactly; none → `target`.
   - **Another edition**: the object of `to` of the same `type` and the
     same symbol (below) whose bounding box's centre is within
     `toleranceMm` of the anchor's (Euclidean, paper mm) and whose width
     and height each differ by at most `toleranceMm`; the nearest centre
     wins, a tie the lowest `sourceIndex`. None → `target`. The tolerance
     is slice G's split decision ("the nearest object of the same symbol
     fingerprint within 0.5 mm on paper"); a point's box is its
     coordinate.
   - The op's id becomes the found object's: `hide:<its sourceIndex>`.
     When two ops reach the same id, the first in this order keeps it and
     the other is unresolved with `target`.
2. **Symbol** (resymbol, add):
   - `{ doc: i }` on the same source: the symbol of `to` with the same
     `sourceIndex` and kind; a symbol without one (`graphic`, `missing`)
     by `code` and kind. Another edition: the first symbol of `to`, in
     table order, that is the same symbol. None → `symbol`.
   - `{ patch: key }`: kept while the patch symbol is (below); else
     `symbol`.
   - **The same symbol** is the same `kind` and, when both carry an
     applied match (`isAppliedMatch`), the same `canonicalId`; otherwise
     the same source `code`. OCAD's synthesised `graphic` symbols (one per
     type, colour and width, all coded `graphic`, no `sourceIndex`) are
     therefore one symbol to this rule: a `{ doc }` reference to one
     re-keys to the first of its kind (Pending). (The import's geometry fingerprint,
     `import/fingerprint.ts`, scores similarity for the matcher; it is not
     an identity.)
3. **Coordinates** (modify, add) are rescaled by `to.unitsPerMm /
   unitsPerMm` and rounded (an OCAD edition is 100 units/mm, a Mapper one
   1000; both are paper coordinates, x right, y up, from the source's
   paper origin, `map-document-format.md` §5, so editions of one map
   share them, as 06 §6 says of course geometry). The flags byte is kept.
4. **Patch symbols** are materialised again for `to`
   (`materialiseSymbol(to, key)`, `map-symbols.md` §11.1): the factor and
   the colour stack may differ. One that is no longer materialisable is
   dropped from `symbols` and its ops become unresolved with `symbol`.

`resolved` and `unresolved` count the ops and entries that ended in each
place. `enabled` is kept.

### 4.3 Retry and attach

- **Every re-resolution retries the unresolved entries**, from their
  anchors: on a document of the entry's `fromSource` by `sourceIndex`,
  on any other by position and symbol. An entry that resolves leaves
  `unresolved` for `ops` (unless its op id is taken, then it stays); one
  that does not is kept exactly as it was (same key, same anchors). So a
  pin that returns to the first edition gets its corrections back. When
  a live op and a pending entry fail onto the same key (the pin left the
  entry's origin again), the live op's entry is kept: it is the later
  state.
- **Attach** (*Corrections*' fix, user 2026-11-15, G11 question 2):
  `attachUnresolved(patch, key, doc, sourceIndex?, symbol?)` returns the
  change that puts the entry's op onto `doc` (replacing an op of that
  id) and removes the entry, with the patch symbol it needs materialised
  unless the patch holds it:
  - a **`target` entry** (a `hide`, `modify` or `resymbol` whose object
    was not found) goes onto the document object the user selected,
    `sourceIndex` (required). A `modify` keeps its coordinates
    (rescaled), so the corrected shape stays where it was drawn;
  - a **`symbol` entry** — a `resymbol` whose `{ doc }` symbol has no
    counterpart, or any `add` — takes the `symbol` the user picked (row
    G12b; user 2026-11-15, G9 question 1): a `{ doc }` index into `doc`'s
    table or a `{ patch: <library entry id> }` key, materialised for
    `doc` (the argument's shape and the optional `sourceIndex`: decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17).
    An add keeps its coordinates (rescaled) and takes no object; a
    resymbol's object is found as re-resolution finds it (§4.2: on the
    entry's source by `sourceIndex`, else by its anchor) unless
    `sourceIndex` is given. A `target` entry's `resymbol` may take a
    `symbol` too, which replaces its own (decided overnight on the
    user's standing instruction (2026-11-13), confirmed by the user 2026-11-17).
  - Refused (`{ ok: false, reason }`, the API's `PATCH_ATTACH_REFUSED:
    <reason>`): `no-entry`; `drop-only` — a `symbol` entry or an add
    without a `symbol` (what an older client sends, so it reads as
    before); `bad-argument` — a `target` entry without `sourceIndex`, a
    `sourceIndex` for an add, a `symbol` for a hide or modify;
    `no-object` — no object with that `sourceIndex` (or none found for a
    resymbol); `type-mismatch` — a `modify` or `resymbol` onto an object
    of another `type`; `symbol` — the picked or the op's symbol is not in
    `doc`'s table or not materialisable; `kind-mismatch` — the picked
    symbol is not of the object's kind (an add's `type`, a resymbol's
    object's).
- **Drop** is `applyChange { removeUnresolved: [key] }` (§1.5); its undo
  is `applyChange { putUnresolved: { [key]: entry } }`, the entry as it
  was (row G12b). Like every patch write it is refused while a promote
  runs (`PATCH_PROMOTING`). An API image from before G12b strips the
  unknown field, so there the undo of a drop changes nothing (the web and
  the API ship together).

### 4.4 When it runs (server)

`reresolveEventPatch(db, eventId)`: under the patch row's lock, when the
row is keyed to another document than the event's pin, both documents
are decoded (`decodedDocument`), `resolvePatch` runs, and the row is
written with the new `document_hash` and a new version — always, also
for a row without ops, so `course.mapMetadata.patchVersion` changes and
every client refetches (§3.3). In the caller's transaction when it has
one, else in its own. No row, no pin, or the row already on the pin →
nothing.

- **After every pin**: `applyJobResult` with an event target runs it
  after the pin's writes (`map-storage.md` §6.4) — an import or a
  dedup hit, `finalise`, the re-match pass. A failure (a document missing
  or not decodable) never fails the job or the pin: it is logged and the
  row stays dormant. Replacing the map first unpins the event
  (`applyEventMap`, the new row has no document until its job pins it);
  the row is keyed to the old document meanwhile and remembers it, so the
  job's pin re-keys it.
- **On a write to a dormant row** (§3.2 step 3): the write re-resolves
  first and then proceeds; `PATCH_STALE` is left only for a row that
  cannot be re-resolved (a document missing or not decodable).
- **The re-match pass** (`map-storage.md` §6.9) ends with a sweep that
  re-keys every live event's dormant row (`--event`: that event's;
  `--dry-run` lists them and writes nothing): the safety net for a row
  a failed hook left behind.
- **Reads never re-resolve**: `mapPatch.get`, the route and the server
  consumers deliver a dormant row as nothing (§3.3), as before.
- On a venue box the hook runs as on the cloud; the box's copy follows
  the cloud's row on the next refresh (§3.4).

## 5. Promote (G12): decided with the user (2026-11-15)

Row G12's planner asked; the user took every recommendation. These
widen answer 2 (the source kept, the patch re-applied at the store
stage; deviates from 08 §4.7 "Promote"). §5.1–5.6 below are row G12a's.

1. **The patch travels with every document built from it.** Besides
   `club_map_versions.patch`, the import job carries a patch snapshot
   (`map_import_jobs.patch`, like `decisions`) and the stored document
   records the patch it was built with (`map_documents.patch JSONB
   NULL`). Every re-import (re-match, `decide` / `finalise`, a restored
   per-event dump, `course.useClubMap`) takes the patch from the document
   it replaces; dedup and staleness compare it. Jobs pin a club version
   by id and patch, not by `(clubMapId, sourceHash)` (`map-storage.md`
   §6.4).
2. **The stored patch is self-contained**: targets by `sourceIndex`,
   each referenced document symbol as G11's `SymbolAnchor`, coordinates
   with their `unitsPerMm`. No base document is kept alive for it.
3. **Promotes stack as layers.** `club_map_versions.patch` is an ordered
   list; each promote appends one immutable layer and the import applies
   them in order. A baked added object gets `sourceIndex = 0x80000000 +
   n` in layer order, so numbers never shift (widens
   `map-document-format.md` §2.4).
4. **No edits while a promote runs**: `mapPatch` writes are refused with
   `PATCH_PROMOTING` while the event's promote job runs; Map mode shows
   progress and is read-only.
5. **Only what is drawn is promoted.** Promote is refused while *Apply
   corrections* is off or the patch has no applicable op. Skipped ops and
   unresolved entries are not promoted; they stay in the event's patch
   (G11 re-resolves them), so "empty patch" means "no promoted op left".
6. **Promote is not an undo entry**: it asks to confirm, and Map mode's
   undo entries from before it are dropped.
7. **The latest promoted version can be deleted** (uploader or admin, as
   `clubMap.remove`); events on it keep their document.
8. **Download stays the original file**, and the card says so
   ("original file; n corrections applied by Oxygen").
9. **Who promotes**: `courses.edit` on the event and signed in, as the
   Club maps page's upload.
10. **Split**: G12a (API: migration, the bake, jobs, `mapPatch.promote`,
    re-match) and G12b (the editor's Promote, G11's Attach / Drop as undo
    entries, the Club maps page, E2E).

Defaults taken with them: hidden objects are dropped from the promoted
document; an op that no longer applies at a re-import is skipped with a
`PATCH_ISSUE` warning and the job succeeds; no document-format change;
the label dialog is prefilled with the event's name and date, and
`uploaded_by` is the promoter; other events on the base version are
untouched; a box forwards `mapPatch.promote`; thumbnails and swatches come
from the patched document; `symbol`-reason unresolved entries stay
drop-only (superseded by row G12b, which attaches them with a picked
symbol, §4.3); promote does not touch `map_gps_tracks.converted_op`; filter
regions' symbol indices are not re-keyed (Pending, as at any re-match).

The API half is row G12a (the rest of this section); the editor's *Save
corrections to the club map* (`course-editor.md` §13 "Promote"), the Club
maps card (`map-storage.md` §6.5) and the end-to-end smoke are row G12b.
Implementation:
`packages/shared/src/map-document/patch-bake.ts` (the layer and the bake),
`packages/api/src/map-store/promote.ts` (the procedure),
`map-store/patches.ts` (`PATCH_PROMOTING`, `completePromote`,
`abandonPromote`), `map-store/jobs.ts` (the job's patch, dedup, pins).

### 5.1 The version patch

`club_map_versions.patch`, `map_import_jobs.patch` and
`map_documents.patch` hold one value, a **version patch**: a JSON list of
**layers**, oldest first (`versionPatchSchema`). Migration
`20261116120000_map_version_patches` (additive): the first two `JSONB NOT
NULL DEFAULT '[]'` with a `jsonb_typeof = 'array'` check, the document's
`JSONB NULL` — null for a document built without corrections, never
`[]` (a check). Every comparison takes null and `[]` as equal
(`sameVersionPatch`, key order ignored); `parseVersionPatch` reads a
stored value with each layer's ops in op-id order (JSONB reorders keys)
and takes an unparseable one as none.

A layer (`versionPatchLayerSchema`) is one promote's ops, self-contained
(answer 2):

```
{ unitsPerMm,                         the coordinates' native unit
  ops: { <event op id>: op },          hide / modify / resymbol / add, as §1.2
  symbols: [<library entry id>, …] }   the patch symbols the ops use, sorted
```

An op is the event's op with every `{ doc: <index> }` symbol reference
replaced by `{ doc: <SymbolAnchor> }` (§4.1) — the index is only
meaningful in the document it was keyed onto — and `{ patch: <key> }`
kept, the key being the library entry id the symbol was materialised
from (§1.3). Targets stay `sourceIndex`; coordinates stay in
`unitsPerMm`. The keys are the event's op ids, so completion removes
exactly the promoted ones from the event's patch.

`versionLayerOfPatch(doc, patch)` builds it from the event's patch and
its pinned document: the patch applied as if enabled (`applyPatch`), the
ops without an issue (§2.3) taken, the rest reported as `skipped`;
unresolved entries are not ops and are never taken. Null when nothing
applies.

### 5.2 The bake

`bakeVersionPatch(input, layers)` is the import's store-stage step
between match and encode (`map-import.md` §1): the matched
`MapDocumentInput` with the layers applied, before the encoder computes
bounds, Hilbert order and the hash. No layers returns the input object
itself, so an unpatched import is byte-identical to before. Per layer, in
order, its ops in op-id order against the objects the earlier layers
left:

- **hide** marks the object; marked objects are dropped at the layer's
  end (hidden objects are not in the promoted document, §5 defaults), so
  a hide and a modify of one object in a layer both apply;
- **modify** replaces the coordinates (rescaled by `input.unitsPerMm /
  layer.unitsPerMm`, rounded) and, when given, the angle;
- **resymbol** sets the symbol; **add** appends an object with
  `sourceIndex = BAKED_SOURCE_INDEX_BASE + n` (`0x80000000 + n`): `n`
  counts the add ops of every layer, in layer order then op-id order, a
  skipped add included, so a number is never reused or shifted (answer 3;
  `map-document-format.md` §2.4);
- a `{ doc }` anchor resolves by the same-source rule (§4.2): the table
  entry with the anchor's source position and kind; an anchor without a
  source position (a baked patch symbol of an earlier layer) by code,
  name and kind among entries without one; else the first of the same
  code and kind;
- a layer's patch symbols are materialised again for the input's header
  (`materialiseSymbol`, as re-resolution does: factor and stack may
  differ after a library release) and appended to the symbol table once
  per key across layers. A baked patch symbol has `origin: "source"`, no
  `match` and no `sourceIndex`, so it draws from its own `render` exactly
  as the event's patch drew it (§1.3); in a matched document such an entry
  is no review row and has no decision fingerprint
  (`import/decisions.ts`, `map-symbols.md` §8.5).

The checks are §2.3's (target, symbol, kind, geometry, a full table); an
op that fails is skipped and returned as an issue (`{ layer, opId, code
}`), the rest still apply. The import turns issues into a
`PATCH_ISSUE` warning with one `warningDetails` entry each and records
`report.corrections` `{ layers, ops, issues }`; the job succeeds (§5
defaults). Neither is part of the document bytes, which are a function of
the source, the importer, the library release, the decisions and the
layers (`map-import.md` §6).

The effective document the event drew and the baked document draw the
same (`patch-bake.test.ts`: per object, `documentRenderInput` over
`applyPatch(doc, patch)` and over the decoded bake are equal, keyed by
`sourceIndex` and add rank), with the hidden objects absent instead of
flagged.

### 5.3 The procedure

`mapPatch.promote { label }` (`courses.edit`; with auth on, a signed-in
user, else `UNAUTHORIZED` — answer 9; cloud-owned like every `mapPatch.`
mutation, so a box forwards it, §3.4):

1. The pin decoded outside the lock (none, or unreadable:
   `PATCH_NO_DOCUMENT`).
2. In one transaction, the patch row locked as any write (§3.2 steps
   1–3, so `PATCH_PROMOTING`, `PATCH_STALE` and a dormant row's
   re-resolution apply), then:
   - *Apply corrections* off → `PATCH_NOTHING_TO_PROMOTE` (answer 5);
   - the event's `map_files` row pinning that document must name a club
     version (`club_map_version_id`) of the same source whose patch is
     the document's → else `PATCH_NOT_CLUB_MAP` (promote is for a
     club-pinned map; slice G split);
   - that version must be the series' latest → else `PATCH_NOT_LATEST`
     (G12a's question 1, confirmed by the user 2026-11-17);
   - `versionLayerOfPatch` null → `PATCH_NOTHING_TO_PROMOTE`;
   - the new `club_map_versions` row: `seq` = latest + 1, the label,
     the source, `uploaded_by` = the promoter, `patch` = the base
     version's layers plus the new one, `document_hash` = the base's
     document until the job moves it (§6.4 of `map-storage.md`). A
     concurrent promote onto the same `seq` fails the unique constraint:
     `CONFLICT` `PATCH_NOT_LATEST`;
   - the job: `map_import_jobs` with both `event_id` and `club_map_id`,
     the version's source, the decision snapshot for its kind and the new
     `patch` — a *promote job*. While it is `queued` or `running` the
     event's writes are refused `PATCH_PROMOTING` (answer 4).
3. The job is kicked and held like an upload's (30 s); the answer is the
   delivered patch, `clubMapVersion { id, clubMapId, seq, label }` and
   `job { id, state, stage, progress, error }`. `mapPatch.promoteStatus`
   answers the event's newest promote job for a client that did not
   start it (G12b: Map mode read-only while it runs).

Refusals are `PRECONDITION_FAILED` message prefixes (§3.2) unless named.

### 5.4 Completion and failure

The job runs the ordinary import (`map-storage.md` §6.1) with its patch.
`applyJobResult` (§6.4 there) first moves the version — found by series,
source and patch — onto the baked document, then `completePromote`, in
one transaction under the patch row lock: if the event's rows of the
source still name the base version, the last layer's op ids are removed
from the event's patch (a new version when that changes it) — except
those the bake skipped on the fresh import (the document report's
`corrections.issues` of that layer: the event's document and the fresh
import may disagree, e.g. a patch symbol no longer materialisable), which
stay as any op that did not apply (answer 5) — and the rows are pinned to
the baked document and to the new version. Then the pin's
quick-access columns, the controls' positions and the re-resolution of
what is left (§4.4: ops that did not apply and unresolved entries
re-keyed onto the new document by `sourceIndex`; an op whose object the
bake dropped becomes unresolved). If the event's map moved meanwhile, the
version stands and the event is left as it is (logged). The other events
on the base version are untouched (§5 defaults).

The steps after the pin are logged, never thrown, so a job cannot fail
once its event is on the version. A job that fails deletes its pending
version (`abandonPromote`: the series' version of that source and patch,
only while no `map_files` row names it — a re-claimed run that failed
after an earlier run's completion keeps it) and the event's patch, which
promote does not touch before completion, stays whole. The client sees
the job `failed` with its error. Promote and `clubMap.removeVersion` lock
the `club_maps` row, so a delete and a promote of one series never
interleave.

### 5.5 Every re-import keeps the corrections

The patch travels with the document (answer 1):

| Re-import | Patch it bakes |
|---|---|
| re-match (`map-storage.md` §6.9) | a club item: its version's; an event item: the document it replaces; an `unpinned` row: its club version's |
| `mapImport.decide` (§6.8 there) | the reviewed document's |
| `mapImport.finalise` | — (pins a stored document); the target must be of the document's patch, else `source-mismatch` |
| `course.useClubMap` | the latest version's (so its dedup finds the version's document) |
| a restored per-event dump | the dump carries `map_documents.patch` (`map-storage.md` §7.3); a re-match of the restored event takes it from the pinned document |

Dedup (`currentDocumentFor`) and the club pin compare the patch; a
version is its file *and* its patch. The re-match pass has no "patch"
staleness reason: a version is re-imported only for the technical and
decision reasons of §6.9 (decision log, G12a's question 2, confirmed by
the user 2026-11-17).

### 5.6 Delete of the latest promoted version

`clubMap.removeVersion { id, versionId }` (answer 7): the version's
`uploaded_by` or an instance admin (`AUTH_MODE=off` allows); only the
series' latest (`VERSION_NOT_LATEST`), only a promoted one
(`VERSION_NOT_PROMOTED`: version 1 goes with the series, `clubMap.remove`),
not while its promote job runs (`PATCH_PROMOTING`). Events on it keep
their document; their `club_map_version_id` is set null by the foreign key,
so they can no longer promote until they take a version from the library
again. The document is left to the GC (`map-storage.md` §8), which counts
it while any pin, version or job references it.

`clubMap.list` shows a version's `layers` and `corrections` (ops over
every layer); `clubMap.download` stays the original source file (answer
8), named by the source's file name, not by the promote's free-text label
(row G12b; `map-storage.md` §6.5). The Club maps card shows the version's
number, a promoted version's label, the note "original file; n
corrections applied by Oxygen" and, for its uploader or an admin, *Delete
version n* with a confirm (row G12b).

## Pending in this chapter

- **An offline copy of the patch** (G4, decided overnight for review).
  The document is CacheFirst in the service worker; the patch route is
  not cached, so a device that starts offline (Field mode) draws the
  pinned document. A NetworkFirst runtime route (`vite.config.ts`) or an
  IndexedDB copy is a follow-up row (G17 or its own).
- **Patch symbols in the eyedropper** (G4, decided overnight for review;
  `map-rendering.md` §8): a
  filter region cannot select an object drawn with a patch symbol by
  symbol until the region props carry a stable symbol key.
- **Graphic symbols at re-resolution** (G11, §4.2): OCAD's synthesised
  `graphic` symbols are indistinguishable to the same-symbol rule, so a
  `{ doc }` reference to one re-keys to the first graphic symbol of its
  kind, and another edition's graphic object of that kind within 0.5 mm
  is a target. Telling them apart needs their render (colour, width) in
  the anchor.
- **The `unresolved` column through checkout and dump** is covered by the
  unit `snapshotPatchOf` test and the dump's `SELECT *`; `lease.test.ts`
  and `backup.test.ts` do not assert it.
- **Promote on a venue box** (G12b, decided overnight on the user's
  standing instruction (2026-11-13), confirmed by the user 2026-11-17): the API forwards
  `mapPatch.promote` (§5 defaults), but `promoteStatus` is served
  locally and the job runs in the cloud, so a box could not follow it
  after the hold; the editor does not offer it on a venue node ("open
  the event in the cloud"). Forwarding `promoteStatus` would lift it.
- **A promote's running state in the E2E** (G12b; decided overnight on
  the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17): a real job
  on the fixture finishes inside the 30 s hold, so the E2E answers
  `promoteStatus` as running through a routed response
  (`editor-map-promoting`, the button `running`, the toggle and the
  drawing tools disabled); the remaining gates (hide, nodes, revert,
  attach, drop, the convert) follow the same `canPatch` and are not each
  driven while running, and no real job is held in `queued` / `running`.
- **A no-op layer** (G12a, §5.5): a layer whose ops change nothing the
  encoder sees bakes the base's bytes; the content-addressed row keeps
  the patch it was first stored with, so dedup misses for that version
  and each re-import runs the worker again (correct, slower).

## Tests

| Level | File | Covers |
|---|---|---|
| Unit (shared) | `packages/shared/src/map-document/__tests__/patch.test.ts` | schema: each op parses, a key that is not the op's id, a bad UUID, a non-integer or out-of-range coordinate, a text `add`, a patch symbol's `match` dropped, defaults; `patchChangeSchema` refusals; `mergePatch`: put replaces by id, remove, an absent remove, twice = once, two changes in either order deep-equal and the same JSON, input not mutated; `applyPatch`: identity (null, disabled, empty) returns the same document, hide flags the object found by `sourceIndex` (a fixture whose Hilbert order differs from source order), modify (coordinates, flags, bbox, `coordStart` of it and its neighbours, angle, type and text kept), resymbol to `{ doc }` and `{ patch }`, hide + modify + resymbol on one object, add (indices `≥ N` in op-id order, `ADDED_SOURCE_INDEX`, the combined table in key order), every base object unchanged, any insertion order of `ops` and `symbols` gives a deep-equal result, applying twice from the same input equals once, the input untouched, each issue code reported and the other ops still applied (a prototype-name patch key is `symbol-missing`), a rectangle's kind check, ops on an already-effective document throw while identity still returns it |
| Unit (shared) | `packages/shared/src/map-document/__tests__/render-bridge.test.ts` | over an effective document: a hidden object missing from `objects` and `docIdx` with `stats.patchHidden`, a modified one symbolised at its new place, an added one with a patch symbol symbolised and its `docIdx ≥ baseCount`, `only` with an added index, a patch symbol drawn from its own `render` (not rescaled by `documentFactor`), a disabled patch deep-equal to the unpatched document |
| Unit (shared) | `packages/shared/src/map-document/__tests__/patch.test.ts` (G11 part) | §4.1 (G11) |
| Unit (shared) | `packages/shared/src/map-document/__tests__/patch-resolve.test.ts` | §4.2–4.3 |
| Unit (api) | `packages/api/src/__tests__/map-patches.test.ts` | `patchOfRow` (sorted keys; the `unresolved` column sorted, empty omitted, a wrong key unparseable; an unparseable row → null with a warning), `deliveredPatch` (the pin's row with an exact decimal version above 2^53; disabled delivered as it is; no row / no pin / dormant → `{ "0", null }`), `samePatchContent` key-order blind, `assertPatchSize` (`PAYLOAD_TOO_LARGE` past 4 MiB, the unresolved entries counted), `patchEtag` |
| Unit (api) | `packages/api/src/__tests__/snapshot-maps.test.ts` | `snapshotPatchOf`: the row (its unresolved entries too) with an exact decimal token; nothing without a row or for a dormant one |
| Unit (api) | `packages/api/src/__tests__/venueForwarder.test.ts` | `mapPatch.applyChange` / `setEnabled` cloud-owned and forwarded, `mapPatch.get` served locally |
| Unit (api) | `packages/api/src/__tests__/backup.test.ts` | `map_patches` directly after `map_files`; the blob sections' filters include the patch's document and its source |
| Integration (api) | `packages/api/src/__tests__/integration/map-patches.test.ts` | no patch before a write; `applyChange` creates the row keyed to the pin and merges put / remove (an absent id a no-op) / putSymbols with sorted keys; twice = once and an empty change keep the version; six concurrent first writers on different ids → one row with all six ops; two writers on one id → one of the two states whole; refusals (duplicate id `BAD_REQUEST`, put + remove of one id, `PATCH_DOCUMENT_MISMATCH`, `PATCH_NO_DOCUMENT` for `applyChange` and `setEnabled`); `setEnabled` creates an empty row, advances only on a change, a disabled patch delivered as it is; a dormant row (pin moved to a document that cannot be read) not delivered, `patchVersion` `"0"`, writes `PATCH_STALE`, row untouched, delivered again when the pin returns; **re-resolution (G11)**: a new edition (`test.xmap` over `test.ocd`, through `applyEventMap` and the job's pin) flags a hide — the patch delivered on the new pin with a new version and `patchVersion`, no ops, the entry with its origin and anchor — and the pin back on the first edition resolves it to the same op id; a write (`setEnabled`) wakes a row made dormant by hand and lands on the re-keyed row; `attachUnresolved` refused for a missing object (`PATCH_ATTACH_REFUSED: no-object`) and another document (`PATCH_DOCUMENT_MISMATCH`), puts the hide on the chosen object, a second attach of the gone entry changes nothing; `applyChange { removeUnresolved }` drops the last (the column `{}`); an unreadable row: no patch delivered, writes `PATCH_UNREADABLE`, row untouched; the table (defaults, one row per event, `RESTRICT` on the document, cascade with the event, an array in `ops` refused); access (kiosk key and viewer read, cannot write or attach; stranger `FORBIDDEN`; course setter writes); the route 200 with `ETag` / `Cache-Control`, 304, a stale ETag 200, header and `?k=` kiosk key, viewer 200, anonymous and wrong key 401, stranger 403, unknown event 404; `mapMetadata.patchVersion` equals the route's version |
| Integration (api) | `packages/api/src/__tests__/integration/map-rematch.test.ts` (G11 part) | §4.4 |
| Unit (shared) | `packages/shared/src/map-document/__tests__/patch-bake.test.ts` | §5.1–5.2 (G12a) |
| Unit (api) | `packages/api/src/__tests__/club-map-library.test.ts`, `snapshot-maps.test.ts`, `venueForwarder.test.ts` (G12a part) | a version's `layers` / `corrections` (none for an upload); `canRemoveClubMapVersion`; `snapshotDocumentPatch`; `mapPatch.promote` cloud-owned and forwarded, `promoteStatus` served locally |
| Integration (api) | `packages/api/src/__tests__/integration/map-promote.test.ts` | §5, §7, §5.4 (G12a) |
| Integration (api) | `packages/api/src/__tests__/integration/backup.test.ts` (G12a part) | a `map_documents` section written before the `patch` column still loads |
| E2E | `e2e/map-patch-resolve.spec.ts` | `course-editor.md` §13 "Unresolved": two hides on `itest`'s `test.ocd`, the map replaced by `test.xmap` through the upload route; Map mode lists both under *Not carried over* (`data-key`, `data-op`, `data-reason`), the ops count 0, attach disabled without a selection; a row click centres the view on the entry's target (within 0.5 mm, G12b); *Drop* one (one `applyChange` with `removeUnresolved`), Ctrl+Z puts it back (one `applyChange` with `putUnresolved`, the column as before), Ctrl+Shift+Z drops it again, gone after a reload; a document object selected on the fitted map, *Attach* the other (the `hide:<n>` row, the object hidden, the block gone), Ctrl+Z (the hide removed and the entry back in one `applyChange`), Ctrl+Shift+Z (one `attachUnresolved`); a `symbol` entry's add planted with `putUnresolved`: *Attach* opens the point palette under its row, a pick is one `attachUnresolved` with `symbol` and no `sourceIndex`, the `add:<id>` row, Ctrl+Z puts the entry back; reseeded before and after |
| Unit (shared) | `packages/shared/src/map-document/__tests__/patch.test.ts`, `patch-resolve.test.ts` (G12b part) | `putUnresolved`: merged by key after removes, sorted, twice = once, a drop and its inverse the patch as it was; refused for a wrong key, a key both put and removed, a bad entry. `attachUnresolved` with a symbol: an add with a document symbol (rescaled) and with a library symbol (materialised, `putSymbols` unless held), `kind-mismatch`, `symbol`, `bad-argument` for an object on an add; a symbol entry's resymbol found by its source or forced, `drop-only` without a symbol; a target entry without an object and a hide with a symbol `bad-argument`; a target resymbol's own symbol replaced |
| Integration (api) | `packages/api/src/__tests__/integration/map-patches.test.ts` (G12b part) | the dropped entry put back with `putUnresolved` (twice keeps the version, a wrong key `BAD_REQUEST`); a planted add entry: without a symbol `drop-only`, a target entry without an object `bad-argument`, with `{ patch: "ISOM2017-2:204" }` the add, the symbol stored, the entry gone |
| Unit (web) | `packages/web/src/pages/editor/__tests__/map-model.test.ts`, `map-unresolved.test.ts`, `map-promote.test.ts`, `packages/web/src/lib/__tests__/undo-stack.test.ts`, `packages/web/src/lib/editor/__tests__/write-client.test.ts` (G12b) | the inverse of a drop (`putUnresolved`), of its undo, of an attach onto a free and a held id; `changes` for unresolved-only changes; attach kind, palette kind, locate centre (anchor, an add's box), labels and row order; promote's offer and block order, running states, the label (event name and date, 200), refusal keys; `UndoStack.remove`; `attachUnresolvedPatch`'s input |
| E2E | `e2e/map-mode.spec.ts` (G12b part) | §7 |
| Integration (api) | `packages/api/src/__tests__/integration/lease.test.ts` | checkout carries the patch row verbatim (id, document, `enabled`, ops, token above 2^53 exact), `maps.patches` counted (0 from an exporter without the map part); the box's `mapPatch.get` and route (kiosk key) serve it with `ETag` = the token |
| Integration (api) | `packages/api/src/__tests__/integration/backup.test.ts` | the dump's `map_patches` section directly after `map_files` with the event's row; restored into another event with `event_id` rewritten, token and ops exact |
| Integration (api) | `packages/api/src/__tests__/integration/map-storage-gc.test.ts` | a document only a patch references is kept (dry run too) and touched; `RESTRICT` refuses its delete; collected once the patch is gone and a fresh grace passed |
| Unit (shared) | `packages/shared/src/course/__tests__/cuts.test.ts`, `checks.test.ts` (G14) | over an effective document: a hidden cut feature / obstacle is skipped; an added point of a document symbol and one of a patch symbol (radius from its own render) are cut features; an added line of a wall symbol is an obstacle |
| Unit (shared) | `packages/shared/src/print/__tests__/prepared-document.test.ts`, `print-job.test.ts` (G14) | `course-print.md` §9.1: the prepared document and the job with a patch |
| Unit (api) | `packages/api/src/__tests__/map-patches.test.ts` (G14 part) | `eventPrintPatch`: the delivered patch with its version when it has ops; null without a pin, without a row, dormant, disabled, op-less |
| Unit (api) | `packages/api/src/__tests__/event-document.test.ts`, `event-map-objects.test.ts` (G14 part) | the server derivations over a stub db with a patch row: a hidden cut feature drops out of cuts and objects, an added one is a cut feature, a disabled and a dormant patch give the unpatched answer, each version answered fresh; `slimObjectsOfDocument` skips a hidden object and keeps an added one |
| Unit (api) | `packages/api/src/__tests__/print-worker.test.ts` (G14 part) | `course-print.md` §9.1: the worker keyed by hash + patch version |
| Integration (api) | `packages/api/src/__tests__/integration/print-patch.test.ts` (G14) | `course-print.md` §9.1, `course-editor.md` §13 "Drawing", `map-gps-tracks.md` §6.5 (G9, G26) |
| Integration (api) | `packages/api/src/__tests__/integration/overprint-cuts.test.ts`, `course-checks.test.ts` (G14 part) | through `mapPatch.applyChange`: the boulder hidden → a leg over it has no gap, an added boulder gaps another leg, the print's `cutFeatures` likewise, disabled → the pinned document's cuts; the building hidden → no `LEG_THROUGH_UNCROSSABLE`, an added building across the leg → the check at its edge, disabled → the pinned building's |
| E2E | `e2e/course-maps.spec.ts` (G14 part) | the print job carries no patch, then the patch at the write's version after a hide, and the device's export equals the patched `maps.pdf`; none after the op is removed |
| Unit (api, web) | `packages/api/src/__tests__/print-device.test.ts`, `packages/web/src/print/__tests__/worker.test.ts` (G14 part) | the device's print worker applies the job's patch: the server worker's bytes, `renderPrintJob`'s in process (`course-print.md` §9.1) |
| E2E | `e2e/map-documents.spec.ts` | after the UI upload: the patch route `{ "0", null }`, `mapPatch.applyChange` over tRPC, the route 200 with the op and the ETag, 304 on revalidation, anonymous 401 |
| Unit (shared) | `packages/shared/src/course/__tests__/cuts.test.ts` | G4: over an effective document a hidden boulder gives no cut feature, a modified one is at its new place |
| Unit (web) | `packages/web/src/map-gl/__tests__/worker-patch.test.ts`, `buckets.test.ts`, `engine.test.ts` | G4: the effective document in the viewer's worker and engine (`map-rendering.md` §5.2 Tests) |
| Unit (web) | `packages/web/src/lib/__tests__/map-document-cache.test.ts`, `vector-map.test.ts` | G4: the client's fetch, ETag revalidation, session store and failure rules; the pairing by hash |
| Unit (web) | `packages/web/src/lib/editor/__tests__/snap.test.ts`, `symbol-pick.test.ts` | G4: snapping and the eyedropper over the effective document |
| E2E | `e2e/map-vector-layer.spec.ts` | G4: a hidden object's pixels gone and an added one drawn after a change, with no reload; the toggle off restores both |
