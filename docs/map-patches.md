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

### 1.4 The toggle

`enabled: false` turns the patch off without losing it (09 §6, the
rollback; Map mode's *Apply corrections* box): every consumer then draws
the pinned document unchanged.

### 1.5 Merging

`mergePatch(patch, change)` is the per-op-id merge the server runs under
the row lock (`mapPatch.apply`, row G3) and a client runs for its
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
| `symbol-missing` | `{ doc: i }` with `i` outside the document's table, or `{ patch: key }` not in `symbols` |
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
- **Every other reader of a document's objects** — the course layer's
  cuts and checks (`course/cuts.ts`, `course/checks.ts`), the snap and
  pick indices (`lib/editor/snap.ts`, `symbol-pick.ts`), the API's event
  map objects — must skip `hidden[i]` when it starts receiving an
  effective document (rows G4, G14).

## Pending in this chapter

- **§3 Storage and delivery** (row G3): the `map_patches` table,
  `mapPatch.get` / `apply` / `setEnabled`, delivery with the document,
  the checkout snapshot, the per-event dump, the GC reference.
- **The effective document on screen** (row G4): the viewer worker takes
  `{ document, patch }`; the readers named in §2.4 skip hidden objects.
- **Symbol materialisation and the palette** (row G8): what fills
  `symbols` (§1.3).
- **§4 Re-resolution** (row G11): re-keying a patch when the event's pin
  moves (same source by `sourceIndex`; a new edition by position and
  symbol within 0.5 mm), the `unresolved` flag, symbol references
  `{ doc }` re-keyed with it.
- **§5 Promote** (row G12): the patch applied at the import's store
  stage for a club version.
- **Print, cuts and checks** (row G14).

## Tests

| Level | File | Covers |
|---|---|---|
| Unit (shared) | `packages/shared/src/map-document/__tests__/patch.test.ts` | schema: each op parses, a key that is not the op's id, a bad UUID, a non-integer or out-of-range coordinate, a text `add`, a patch symbol's `match` dropped, defaults; `patchChangeSchema` refusals; `mergePatch`: put replaces by id, remove, an absent remove, twice = once, two changes in either order deep-equal and the same JSON, input not mutated; `applyPatch`: identity (null, disabled, empty) returns the same document, hide flags the object found by `sourceIndex` (a fixture whose Hilbert order differs from source order), modify (coordinates, flags, bbox, `coordStart` of it and its neighbours, angle, type and text kept), resymbol to `{ doc }` and `{ patch }`, hide + modify + resymbol on one object, add (indices `≥ N` in op-id order, `ADDED_SOURCE_INDEX`, the combined table in key order), every base object unchanged, any insertion order of `ops` and `symbols` gives a deep-equal result, applying twice from the same input equals once, the input untouched, each issue code reported and the other ops still applied |
| Unit (shared) | `packages/shared/src/map-document/__tests__/render-bridge.test.ts` | over an effective document: a hidden object missing from `objects` and `docIdx` with `stats.patchHidden`, a modified one symbolised at its new place, an added one with a patch symbol symbolised and its `docIdx ≥ baseCount`, `only` with an added index, a patch symbol drawn from its own `render` (not rescaled by `documentFactor`), a disabled patch deep-equal to the unpatched document |
