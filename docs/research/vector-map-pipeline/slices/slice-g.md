# SLICES — Slice G — Map mode (08 §8 phase 3) and offline print (09 §4 G)

The full rows of this slice, moved out of [SLICES.md](../SLICES.md) on 2026-11-21. Statuses reported `review` for PRs that merged on 2026-11-20 are corrected; everything else is as it was. New rows for this slice are added here; open rows are also listed in SLICES.md.

Split 2026-11-13 by the G0 planner (Fable) from 09 §4 G, §6 (rollback:
the patch toggle) and §8; 08 §4.1, §4.7, §4.8, §5.2–5.3 (Map mode
column), §5.5, §6, §7, §8 phase 3; 02 §7, §10; 03 §1; 04 §7; 05 §5.11;
06 §6; 07 §9, §15. The user's answers are below ("Answers (user
2026-11-13)"). Row ids start at G2: G1 is the concurrent-editing decision
gate (slice D). Three tracks; the first two share no code until G14:

- **Map mode** (G2–G12): an event-scoped patch on the pinned document
  (hide, modify, add, resymbol), applied before symbolisation so screen,
  print and the kiosk see one effective document (08 §4.1); the editor's
  fourth mode with select / nodes / draw / symbol picker; re-resolution
  when the pin moves; promote to a club map version.
- **Offline print** (G13–G19): the print pipeline made isomorphic end to
  end, a print-job descriptor, browser-side PDF in a Web Worker, the job
  cached for a device with no network, and venue printing through the
  checkout snapshot.
- **GPS tracks to map objects** (G20–G28; user 2026-11-13, for ski-O):
  the ISSkiOM 2019 ski symbols in the library and the importer; GPX files
  imported per event as a reference layer in Map mode, trimmed, split,
  several passes averaged, then converted into `add` ops with a track
  symbol, their ends snapped to the network. The converted line is an
  ordinary correction: screen, kiosk, print, promote.

The slice ships as **one release at the G-gate** (answer 6).

What the code already has (the planner's survey): `@oxygen/shared/print`
(composer, operators, writer) imports nothing from Node, but
`renderCoursePages`, `sheetForMapRow`, `resolveSheet`, `resolveMapLayout`,
`prepareDocument` / `objectsNear` and the font loader live in
`packages/api/src/course-maps/` and `render/`; SVG logos are rasterised
by resvg in the API (`course-print.md` §6.3). The print worker's message
(`{ document, rotationCorrectionDeg, sheets, graphics, mode, info }`) is
already structured-cloneable (§8.2) — it is the print job. The checkout
snapshot carries `course_objects` and the `maps` part (files, sources,
documents, decisions; `map-storage.md` §7.2) but no `course_maps`,
`map_templates` or `graphics`; `sync/ownership.ts` forwards only
`club.` / `eventor.` / `tracks.` / `liveresults.` mutations, so layout
and course-object writes made on a box run locally and never return
(G18 fixes it). For Map mode: `encodeMapDocument` / `decodeMapDocument`
and `documentRenderInput { only }` (shared), `hitTest(stream, …)`
(shared), `geometry-edit.ts` / `geometry-gestures.ts` (Bézier vertex
editing, F13 / F16 / F18), `symbol-groups.ts` and the swatch route (P3),
the snap index and `symbol-pick.ts` on the main thread, the shared undo
stack and `write-client.ts`. Missing, and named in `map-rendering.md` §8:
object identity across the bridge, hide / replace of a document object,
highlight through the dynamic bucket, a hit-test request over the
document stream. `url.ts` knows `mode=layout|field` only. There is no
`maps.*` permission.

Offline architecture: the phases D9c named were replaced in the July
2026 pivot; Steps 1–6 of `history/future-architecture.md` (journal completeness,
shipping, lease, venue packaging, station resilience) have all landed.
No G row waits on an offline phase; D9c is unblocked (answer 5).

**Order**

- **Wave 1**: G2 ∥ G13 ∥ V1 ∥ D9c ∥ G20 ∥ G22.
- **Wave 2**: G3 (after G2) ∥ G8 (after G2, G20) ∥ G15 (after G13) ∥
  G21 (after G20) ∥ G23 (after G22).
- **Wave 3**: G4 (after G3) ∥ G16 (after G15) ∥ G18 (after G3) ∥ G14
  (after G2, G3, G15).
- **Wave 4**: G5 (after G4) ∥ G17 (after G16) ∥ G19 (after G18) ∥ G24
  (after G3 and G18).
- **Wave 5**: G6 (after G5; not with D9c — `EditorPage.tsx`).
- **Wave 6**: G7 (after G6) ∥ G11 (after G6).
- **Wave 7**: G9 (after G7, G8).
- **Wave 8**: G12a (after G11, API only); G12b (after G9, G12a); then G10 (after G12b). Split by the user 2026-11-15.
- **Waves 9–12**: G25 (after G10) → G26 (the first usable ski-O flow)
  → G27 → G28, serial because each mounts in `MapMode.tsx`. None depends
  on G10 or G12, so the tail may move ahead of promote without
  re-planning. If the slice is shortened: drop G28, then G27; G10 stays
  droppable.
- **G29** (after G17, any wave: its files are no other row's): the
  preview-build smoke, required before the G-gate (the user, 2026-11-14).
- G-gate. The long pole is G2 → G3 → G4 → G5 → G6 → G7 → G9 → G12. G10
  is polish and the first row to drop if the slice is shortened; G12 is
  the largest row and its planner may split it (API half; UI and E2E
  smoke).

Rows that may never run together (shared files, beyond the Depends
column): G3 / G18 / G19 (`sync/lease.ts`, `sync/ownership.ts`); G14 /
G15 (`course-maps/routes.ts`, the print worker); G4 / G5 (`map-gl/`,
`MapViewer.tsx`); G6 / G7 / G9 / G10 / G12 (`modes/MapMode.tsx`,
`tools/bindings.ts`); G6 / D9c (`EditorPage.tsx`); G11 / G12
(`map-store/`); G16 / G17 (`packages/web/src/print/`,
`export-menu.ts`); F26, if it is ever started, with G4 / G5 / G14
(`map-gl/`, `print/compose.ts`); G20 / G8 (`symbol-library/index.ts`);
G22 / G23 (`gps-track/`); G24 / G3 / G18 (`sync/ownership.ts`, dump
files) and G24 / G12 (`prisma/`); G25 / G26 / G27 / G28 with each other
and with G6 / G7 / G9 / G10 / G12 (`modes/MapMode.tsx`,
`tools/bindings.ts`).

Decided in this split (planner, 2026-11-13, for user review unless an
answer below settles it; a row's planner may reopen any with a reason):

- **A new chapter `docs/map-patches.md`** holds the patch model,
  application, storage, re-resolution and promote; Map mode's UI is
  `course-editor.md` §13; the renderer hooks are `map-rendering.md` §5.2
  / §5.5.
- **Ops are keyed states, not a log** (`course-layer.md` §7, answer 1):
  one state per `(target, kind)` — `hide:<sourceIndex>`,
  `modify:<sourceIndex>`, `resymbol:<sourceIndex>`, `add:<uuid>`; editing
  an added object rewrites its `add` op. `mapPatch.apply { put, remove }` (`applyChange` since G3: tRPC reserves `apply`)
  merges per op id under the row lock, so two editors on different objects
  never clobber. One cloud-owned `map_patches` row per event, not
  journaled, in the checkout snapshot, forwarded from a venue.
- **The patch toggle** (09 §6) is `map_patches.enabled` per event, read
  by every consumer; the Map mode inspector's *Apply corrections* box.
- **Permissions**: `courses.edit` edits the patch (they are the setter's
  corrections); promote needs what the Club maps page's upload needs.
- **Map mode is desktop-only** (08 §5.5): the phone's mode switch omits
  it as it omits Layout.
- **No text creation and no symbol, colour or template editing** (08
  §4.7); an existing text moves and hides only.
- **A canonical symbol whose colours the document's stack lacks is not
  materialisable**: the palette shows it disabled with the reason; a
  patch never changes the colour stack.
- **New-edition tolerance** (06 §6 left it to 08, 08 did not set it): an
  op re-resolves to the nearest object of the same symbol fingerprint
  within 0.5 mm on paper, else it is unresolved.
- **Promote is offered only for a map pinned to a club version**; an
  event's own upload is first added to the library by the existing
  action.
- **Thumbnails and symbol swatches stay the unpatched document's**
  (`map_previews` is keyed by document hash).
- **The snapshot stays one JSON body** (07 §15): a patch is kilobytes;
  graphics travel by the ranged blob procedure the maps part uses.
- **The browser never rasterises SVG**: the print job carries each logo
  as the PNG the server rasterised (G15).
- **The browser composes the PDF whenever the device can** (answer 3):
  the bytes are identical to the server's (G16's test), so where it is
  made is invisible; the server composes when the device cannot (no
  module worker, or a job too large for the device — G16's planner sets
  the check) and for API callers.
- **A new chapter `docs/map-gps-tracks.md`** (storage, GPX, geometry,
  averaging, editing, conversion); the UI is `course-editor.md` §13 "GPS
  tracks"; ISSkiOM is `map-symbols.md` §12. The research decides none of
  this beyond 04 §7 (georeferenced inputs become paper-space overlays)
  and 03's "ISSkiOM later"; each row records its decisions as new.
- **GPS tracks are per event, in their own cloud-owned table** (answer
  10), stored in WGS 84 so a re-match or new edition does not move them;
  not in the patch, not in the checkout snapshot, kept after conversion
  until deleted. `routes` (runner routes for replay) and the legacy
  `tracks` table are not used; the router is `mapTrack.` (`tracks.` is
  taken).
- **The GPX is parsed in the browser**; the server stores points, not the
  file.
- **Converted lines are polylines** (smoothed, then Douglas–Peucker).
  Bézier fitting is later.
- **Averaging** (G23), in ground metres on the projected tracks: (1) the
  reference is the pass of median length, ties to the lexicographically
  smallest point list; (2) each other pass is reversed if that brings its
  ends nearer the reference's; (3) the reference is resampled every 2 m
  with a unit normal at each sample; (4) for each sample and pass, the
  nearest point on the pass no earlier along it than the previous
  sample's match and within 15 m gives that pass's vote, its offset along
  the normal; (5) the sample moves by the median of the votes (the mean
  for two passes) — a sample only the reference votes on stays, and its
  range is reported; (6) repeat once with the result as the reference;
  store the result in WGS 84.
  Refined by the user at G23's planning (2026-11-13; `docs/map-gps-tracks.md`
  §4 is normative): every pass is first turned to a canonical direction;
  an even count takes the upper median; other passes are orientated by
  which way more samples match (the ends rule breaks ties, for loops);
  a match is the nearest point in the first run of the pass within 15 m,
  and a pass's end point votes only within one step along the tangent;
  the single-pass ranges are stored with the average (G24 `single_pass`).
- **Junction snap moves only the new line's end** (1.5 mm, track-symbol
  lines only); it does not split or join the other line. G28 does not
  depend on G10.
- **ISSkiOM is an overlay library** (answer 9): ski symbols only, offered
  on and matched against any document; ISOM 2017-2 stays a ski-O map's
  base library. A canonical entry of another library than the
  document's is materialisable, scaled by `libraryFactor` (G8 amended).
- **The ski-O green is in every stack** (answer 8): the importer inserts
  `green-skio` at its palette position where a source lacks it (G21), so
  "a patch never changes the colour stack" holds and a ski track can be
  drawn on a summer map.

### Answers (user 2026-11-13)

1. **Patch shape and ownership**: the planner's default — keyed-state ops
   merged on the server per op id, one cloud-owned `map_patches` row per
   event, not journaled, in the snapshot, venue writes forwarded.
   `course-layer.md` §7 says so (written 2026-11-13). Deviates from 08
   §4.7–4.8's ordered `PatchOp[]`.
2. **A promoted version** keeps its source: `club_map_versions` gains a
   `patch JSONB`; the import applies it at the store stage, so the
   document is a function of source, importer, library, decisions and
   patch, and every re-match re-applies the corrections. Deviates from 08
   §4.7 "Promote" (encode the effective document without a source).
3. **Browser-side PDF whenever the device can, if the result is
   identical** (the user's choice over the planner's "server while it
   answers"): the device composes by default, byte-identical to the
   server; the server is the fallback.
4. **Venue printing**: the box prints from its own copy (sheets,
   templates and graphics in the snapshot); layout edits stay cloud-owned
   and are forwarded, with a typed error offline. Deviates from 08 §4.8's
   "layout and print stay cloud-only during a lease" for print reads.
5. **D9c unblocked now** (wave 1): its Depends is D9; the sentence in
   `course-editor.md` §9 was corrected 2026-11-13.
6. **One release at the G-gate** (the user's choice over two releases).
7. **V1**: the planner's scheme (`package.json` bumped by the release PR
   and checked against the tag by `release.yml`, `git describe` past a
   tag, one version in the footer, `Image:` only when it differs).
8. **Ski-O green on a map without it**: the importer adds it to every
   stack (G21); the patch still never changes the colour stack.
   Deviates from `map-symbols.md` §3 / §9.2 (a palette row ticked for
   ISSkiOM only is inserted into ISOM and ISSprOM stacks).
9. **ISSkiOM: the ski-only symbols** as an overlay library on any map
   (G20), not the whole spec. Deviates from 03 §6.4's one library per
   specification and the matcher's one library per document.
10. **GPS tracks per event** (G24), not per club map.
11. **Swedish names**: the G20 session looks for SOFT's Swedish ISSkiOM
    text and takes names from it; none if it is not found. (None was
    found; `map-symbols.md` §12.4.)

Answered in the G20 session (user 2026-11-13; `map-symbols.md` §12,
`decisions/slice-g.md`): the overlay is ISSkiOM Revision 4's 13 track
symbols plus 301.1, 301.2, 310.1; the track mask is a new palette row
`white-skio` below lower purple; `green100-area` is ticked for ISSkiOM
(808); answer 8 widens — G21 inserts every palette row the overlay uses.
Before these, the user decided (same day, before the G20–G28 split):
GPX file import only for now (recording in the app waits, see below);
ISSkiOM into the library; slice G's order kept; the track tools are
averaging passes, snapping ends to junctions, trim and split (not
shifting a whole track).

Slice H (terrain, research 10): spike T1 ran 2026-11-13 and slice H was
split the same day — see "Slice H" below; its first rows run beside G.

### Done

| Id | Sub-slice | Status |
|----|-----------|--------|
| G0 | **Split slice G** (planning only, Fable): the rows below, the two tracks, the waves and seven questions | done 2026-11-13 (answers above) |

### Remaining

| Id | Sub-slice | Spec home | Research | Depends on | Area (files a session may touch) | Status |
|----|-----------|-----------|----------|------------|----------------------------------|--------|
| G2 | **Patch model and application (shared).** `patchOpSchema` / `mapPatchSchema` (keyed states, answer 1; `symbols` appended after the document's table — as built, a record keyed by library entry id, referenced as `{ doc } | { patch }`: `map-patches.md` §1.3, user 2026-11-13); `applyPatch(doc, patch)` → the effective document: hidden objects skipped, modified geometry replaced, added objects appended with `objectIndex ≥ doc.count`, `resymbol` swapped, existing `(hash, objectIndex)` references unchanged; `documentRenderInput` over it; `enabled: false` = identity. Tests: unit — each op, index mapping, idempotence (twice = once), commutativity (any order), an op whose target is absent reported not thrown | new `docs/map-patches.md` §1–2; `map-document-format.md` cross-reference | 08 §4.1, §4.7; 02 §7, §10; 04 §7 "Appending objects" | — | `packages/shared/src/map-document/patch.ts` (new) + `render-bridge.ts`, `index.ts`, tests; docs | done (#178) |
| G3 | **`map_patches`: table, API, delivery, snapshot, dump, GC.** Migration (08 §4.7 columns + `version` token as `course_objects`, `enabled`); `mapPatch.get` / `mapPatch.apply { put, remove }` / `mapPatch.setEnabled`; the patch reaches whoever may read the event's document (`GET /api/maps/:nameId/patch`, ETag = version, the §4.2 predicate; the event's map descriptor gains `patchVersion`); `mapPatch` in `SNAPSHOT_TABLES` (08 §4.8), `mapPatch.` forwarded from a venue; the per-event dump carries it (07 §10); the GC counts the row as a reference to its document. Amended for G2 (user 2026-11-13): `symbols JSONB` defaults to `'{}'` (a record keyed by library entry id, `map-patches.md` §1.3), the body is `patchChangeSchema` (`put`, `remove`, `putSymbols`) and the server merges with the shared `mergePatch`. Tests: integration — apply merges per op, two writers, auth, snapshot round trip (08 §7), dump / restore, GC keeps a patched document | `docs/map-patches.md` §3; `map-storage.md` §7.2, §7.3, §8 | 08 §4.7, §4.8, §6; 07 §9.2, §10; `course-layer.md` §7 | G2 | `packages/api/prisma/` (migration), `routers/mapPatch.ts` (new), `routers/index.ts`, `map-store/{routes,event-document,gc}.ts`, `sync/{lease,ownership}.ts`, dump files, integration tests; docs | done (#181) |
| G4 | **The effective document on screen.** The viewer worker takes `{ document, patch }`: object identity across the bridge (stream `objectIdx` ↔ document `objectIndex`), hide through the range table, replace / append with only the touched buckets re-prepared; a patch change redraws without reloading the document; the course layer's cuts, the snap index, the eyedropper and filter regions read the effective document; viewer, kiosk and editor fetch the patch with the document (`useMapPatch`). Tests: unit (`map-gl`) hide / replace / append ranges; E2E `map-vector-layer.spec.ts` — a hidden object's pixels gone, an added one drawn, the toggle off restores both | `map-rendering.md` §5.2 (trims "object identity across the bridge"); `docs/map-patches.md` §2 | 04 §7; 08 §4.1 | G3 | `packages/web/src/map-gl/`, `lib/{vector-map,map-document-cache}.ts`, `lib/editor/{snap,symbol-pick}.ts`, `components/{VectorMapLayer,MapViewer}.tsx` (patch input only), `e2e/map-vector-layer.spec.ts`; docs | done (#189) |
| G5 | **Hit-test over the document and highlight through the dynamic bucket.** A worker request `hitDocument(x, y, tolerance)` → topmost-first document objects by the symbolised shape (`hitTest`, colour-stack order); the selected object's passes redrawn in a highlight colour in the dynamic bucket; an object under edit is drawn from the dynamic bucket and hidden in its static one. Tests: unit — hit order over fill / stroke / glyph / text; E2E — a click on the fixture's path reports its object, the highlight is in the frame | `map-rendering.md` §5.5 (trims "highlight through the dynamic bucket"), §5.2 "dynamic bucket" | 04 §7 | G4 | `packages/web/src/map-gl/`, `components/MapViewer.tsx` (`MapViewerEditorProps` only), `packages/shared/src/render/hit-test.ts`, tests; docs | done (#195) |
| G6 | **Map mode: the shell, select, hide, move.** `mode=map` (`url.ts`), the mode group's fourth entry (desktop; phone omits), `modes/MapMode.tsx`; `V` selects a map object (click, Tab), the inspector's *Map object* section (symbol number and name, swatch, *Hide* / *Restore*), Delete = hide, a drag moves it (`modify`), `H` hides the course overprint, `F` fits the map; the *Corrections* list (`modes/map/Corrections.tsx`: every op, click to locate, revert) with *Apply corrections* (`enabled`); every gesture one `mapPatch.applyChange` and one undo entry; course edits locked. Tests: unit bindings; E2E `map-mode.spec.ts` (new) — hide, undo, move, toggle, reload keeps it | `course-editor.md` §13 (new), §2, §4 (test ids) | 08 §5.2, §5.3 (Map mode column), §5.5 | G5 | `packages/web/src/pages/editor/{EditorPage,TopBar,ToolRail,Inspector}.tsx`, `modes/MapMode.tsx` + `modes/map/` (new), `tools/{bindings,rail}.ts`, `lib/editor/{url,write-client}.ts`, locales, `e2e/map-mode.spec.ts`; docs | done (#204) |
| G7 | **Node editing.** The nodes tool on a selected line or area: vertex drag, Bézier handles, insert (double-click), delete, corner / smooth (F18's convention), through `geometry-edit.ts` on the object's coordinates (curve flags, holes kept); node snapping to the snap index; live redraw from the dynamic bucket; one `modify` op per gesture. Tests: unit — coordinate ↔ path-vertex round trip with flags and holes; E2E — drag a node, insert, delete, undo | `course-editor.md` §13 "Nodes" | 08 §4.7 (scope), §5.3 | G6 | `modes/MapMode.tsx`, `modes/map/`, `tools/bindings.ts`, `lib/editor/geometry-edit.ts` (adapter only), `e2e/map-mode.spec.ts`; docs | done (#211) |
| G8 | **Symbol materialisation and the palette (shared).** `materialiseSymbol(doc, canonicalId)` → a source-symbol IR entry with colours aligned to the document's stack (deterministic; not materialisable when a colour is missing, decided above); `mapPalette(doc, patch)` — the document's source table presented through its matches plus the materialisable canonical entries, grouped as P3's list. Tests: unit — every library entry of both specifications materialises on the fixtures or reports the missing colour; same input, same bytes; palette grouping Amended for G20: `materialiseSymbol` takes a full entry id of any library; an entry of another library than the document's is scaled by `libraryFactor(library, mapScale, code) × symbolScale` (the entry's code picks ISSkiOM's track / other scale column, `map-symbols.md` §12.2); `mapPalette` adds the `ISSkiOM2019` group on every document whose stack has `green-skio`. Amended for G2 (user 2026-11-13): the result is a `patchSymbolSchema` entry (no `match`; drawn from its `render`) stored in the patch's `symbols` under its full entry id and referenced as `{ patch: id }` (`map-patches.md` §1.3). | `map-symbols.md` §11 (new: materialisation and palette) | 03 §1 (scope note), §6.3; 08 §4.7 | G2, G20 | `packages/shared/src/map-document/materialise.ts` (new), `map-document/render-bridge.ts` (`canonicalEntryRender`), `packages/shared/src/symbol-library/` (read; an export if needed), tests; docs | done (#184) |
| G9 | **Draw point / line / area; change symbol.** Map mode's point, line and area tools with the symbol picker (`mapPalette`, swatches), `add` ops with `symbols` materialised on first use; *Change symbol* on a selected object (`resymbol`, same object type only); point rotation where the symbol is orientable. Tests: unit tool reducers; E2E — add a path with a document symbol, add a boulder with a materialised symbol, change a symbol, each in the PDF's page raster | `course-editor.md` §13 "Drawing", "Symbol picker" | 08 §4.7, §5.2; 03 §1 | G7, G8 | `modes/MapMode.tsx`, `modes/map/`, `tools/` (new map tools, `bindings.ts`, `rail.ts`, `polygon.ts`), `lib/editor/geometry-edit.ts` (one kind), `e2e/map-mode.spec.ts`, `e2e/helpers/`, `integration/print-patch.test.ts`, locales; docs | done (#215) |
| G10 | **Join, split, reverse; holes.** On selected lines: join two ends, split at a node, reverse direction (dash and glyph phase follow); on an area: cut a hole, remove a hole — each a `modify` (join also hides one object). Tests: unit geometry; E2E one of each | `course-editor.md` §13 "Line and area operations" | 08 §4.7 (scope) | G12b | `modes/MapMode.tsx`, `modes/map/`, `tools/bindings.ts`, `e2e/map-mode.spec.ts`; docs | done (#220) |
| G11 | **Re-resolution when the pin moves; unresolved ops.** When an event's `document_hash` changes (finalise, re-match, update to the latest version) its patch is re-keyed onto the new document: same source → by `sourceIndex`, exactly; another edition → by position and symbol (tolerance decided above); what does not resolve stays in the patch flagged `unresolved`, drawn nowhere, listed in *Corrections* to fix or drop. Tests: unit `resolvePatch` (same source, new edition, nothing found); integration — a re-match keeps a hide, a new edition flags it | `docs/map-patches.md` §4; `map-storage.md` §6.4, §6.9; `course-editor.md` §13 "Corrections" | 02 §7; 06 §6; 08 §4.7 | G6 | `packages/shared/src/map-document/{patch-resolve,patch}.ts`, `packages/api/src/map-store/{patches,rematch,jobs}.ts`, `routers/mapPatch.ts`, `sync/{snapshotMaps,mapRefresh}.ts`, migration `20261115130000_map_patches_unresolved`, `modes/map/Corrections.tsx` + the editor locales, `e2e/map-patch-resolve.spec.ts`, tests; docs (as built: `documents.ts` and `event-document.ts` unchanged; the server part lives in `patches.ts`) | done (#210) |
| G12a | **Promote, the API half** (split by the user 2026-11-15, `map-patches.md` §5 answer 10). Migration: `club_map_versions.patch` (an ordered list of layers, §5 answer 3), `map_import_jobs.patch`, `map_documents.patch` (answer 1). The bake (shared, pure): an effective document made encodable — hidden objects dropped, added ones numbered `0x80000000 + n` in layer order, patch symbols in the table; the self-contained version patch (answer 2). The import worker applies the patch before encoding; dedup, staleness, `decide` / `finalise`, re-match and `course.useClubMap` are patch-aware; jobs pin a version by id and patch. `mapPatch.promote { label }`: a new version at `seq + 1`, the event repointed, the drawn ops removed from the event's patch under the row lock (answer 5), `PATCH_PROMOTING` while it runs (answer 4), forwarded from a box; delete of the latest promoted version (answer 7). Tests: unit — bake determinism and identity, layers; integration — promote creates the version and empties the patch (08 §7), a re-match of the promoted version keeps the corrections, a second promote stacks a layer, the per-event dump and GC hold, delete | `docs/map-patches.md` §5; `map-storage.md` §2, §6; `map-import.md` (store stage) | 08 §4.7 "Promote" (deviates, answer 2; widened by §5) ; 06 §6; 07 §4.2; 09 §6 | G11 | `packages/api/prisma/` (migration), `map-store/{import-worker,jobs,documents,review,rematch}.ts`, `packages/shared/src/` (the bake), `routers/{mapPatch,clubMap}.ts`, tests; docs. No web file (as built: also `map-store/{promote,patches}.ts`, `import/ocad.ts`, `event-map.ts`, `routers/course.ts` (`useClubMap`), `club-map-library.ts`, `sync/snapshotMaps.ts`, `scripts/restore-map-blobs.sql`, shared `import/{decisions,report,patch-warnings}.ts`; migration `20261116120000_map_version_patches`) | done (#216) |
| G12b | **Promote, the editor half** (`map-patches.md` §5; `course-editor.md` §13 "Promote"). `modes/map/Promote.tsx` in `MapMode.tsx`: *Save corrections to the club map*, offered when the pin is a club version, a confirm dialog with the label prefilled from the event (answer 6: not an undo entry; earlier Map-mode undo entries dropped), progress and read-only while it runs, errors. G11's leftovers: *Attach* and *Drop* as undo entries in the one-write interlock, a row click that centres on the entry's old place; and *Attach* of a `symbol`-reason entry, which G9 left drop-only (user 2026-11-15, G9 question 1): a symbol argument on `mapPatch.attachUnresolved` and shared `attachUnresolved`, the symbol picked in *Corrections* with G9's picker. Club maps page: version, label, corrections count, the original-file note on download (answer 8), delete of the latest promoted version. Tests: E2E map-mode smoke — hide an object, add a path, promote (08 §7); attach / drop undo in `e2e/map-patch-resolve.spec.ts` | `course-editor.md` §13 "Promote"; `docs/map-patches.md` §5; `map-storage.md` §6.5 | 08 §4.7 "Promote" | G9, G12a | `modes/MapMode.tsx` + `modes/map/{Promote,Corrections}.tsx`, `routers/mapPatch.ts` and `packages/shared/src/map-document/patch-resolve.ts` (the symbol argument of *Attach*), the Club maps page, locales, `e2e/map-mode.spec.ts`, `e2e/map-patch-resolve.spec.ts`; docs (as built: also `modes/map/{unresolved,promote}.ts`, `modes/map/PromoteDialog.tsx`, `lib/undo-stack.ts` (`remove`), `pages/editor/EditorPage.tsx` (`forget`), `lib/editor/write-client.ts`, shared `map-document/patch.ts` (`putUnresolved`), `map-store/patches.ts`, `club-map-library.ts`, `routers/{clubMap,course}.ts` (a promoted version's file name), `library.json` locales; no migration) | done (#218) |
| G13 | **The print pipeline in the shared package (no behaviour change).** `renderCoursePages`, `pageInputFor`, the row → sheet functions, `resolveSheet`, `resolveMapLayout`, `prepareDocument` / `objectsNear` move to `@oxygen/shared`; fonts and graphic bytes are inputs, not disk reads; the API keeps the database, the worker host and resvg. Tests: the existing print tests moved with the code; the worker's bytes and the golden tier unchanged; the import-list test (§1) covers the moved modules | `course-print.md` §1, §5, §8.2 (file map) | 05 §5.11; 05 §9 item 8 | — | `packages/api/src/course-maps/{pdf-page,resolve-sheet,resolve-layout,print-worker}.ts`, `render/{window-raster,fonts}.ts`, `packages/shared/src/print/` + `course-maps/`, tests; docs. As done, import lines only also in `course-maps/{routes,auto-sheets,descriptions-pdf,print-worker-host}.ts`, `routers/courseMap.ts`, and the helpers moved from `control-id.ts`, `course-structure.ts`, `course-objects.ts` to `packages/shared/src/{control-display.ts,course/sequence.ts,course/objects.ts}` | done (#180) |
| G14 | **The patch in print, cuts and checks (server).** `maps.pdf`, the page raster and the print job compose the effective document (the worker's cache keyed by hash + patch version); `course.checks` and the server's cut context read it. Tests: integration — a hidden object absent from the PDF, an added one present, `enabled = false` byte-identical to the unpatched PDF | `course-print.md` §4.3, §8.2; `docs/map-patches.md` §2 "Consumers" | 08 §4.1; 05 §5.1 | G2, G3, G15 | `packages/api/src/course-maps/{pdf-page,print-worker,print-worker-host,routes}.ts`, `render/page-raster.ts`, the shared print entry (patch input), tests; docs | done (#188) |
| G15 | **The print job.** `GET /api/maps/:nameId/print-job?<the maps.pdf query>` (`courses.view`, the same selection, order and caps) answers what the print worker gets: document hash, rotation correction, sheets, `info`, graphics by id; `GET /api/maps/:nameId/graphics/:id/print.png?w=&h=` (event-scoped: user 2026-11-13, G15 question 1) serves a logo as the PNG the server would embed (SVG rasterised at 600 dpi, §6.3). Tests: integration — composing the job in process (deterministic) gives `maps.pdf`'s bytes; auth; caps | `course-print.md` §8.5 (new); `course-maps.md` API | 05 §5.11 | G13 | `packages/api/src/course-maps/{routes,graphics}.ts`, integration tests; docs (widened: `packages/shared/src/print/{print-job,course-pages,index}.ts`, `course-maps/print-worker{,-host}.ts`, `e2e/course-maps.spec.ts`) | done (#186) |
| G16 | **Browser-side PDF, the default where the device can** (answer 3). A Web Worker (`packages/web/src/print/`) composes a print job with the shared pipeline: the document from the document cache, the PDF faces and the writer lazy-loaded. The Export menu and the Courses page's exports compose on the device when it can and on the server otherwise (the capability check — module worker, the job's size against the device — set by this row's planner and written in the spec); the bytes are the same either way. Tests: unit — the worker's bytes equal the server's for the fixture job (deterministic; the guarantee answer 3 rests on); E2E `course-maps.spec.ts` — the device path downloads a PDF with the server's page count and labels, and the fallback path still works; the lazy chunk's size recorded (07 §15) | `course-print.md` §8.6 (new); `course-layout.md` §7 | 05 §5.11 phase 2, §8; 07 §9.1 | G15 | `packages/web/src/print/` (new: `client.ts`, `capability.ts`, `protocol.ts`, `worker.ts`, `print-worker-entry.ts`, tests), `lib/download-api.ts`, `pages/editor/ExportMenu.tsx`, `hooks/useCourseMapsOverview.tsx`, `vite.config.ts`, `e2e/course-maps.spec.ts`; as done also `packages/shared/src/course-maps/{collate,resolve-layout,control-label-placement}.ts`, `print/{writer,description-sheet}.ts` (parameter properties), `print/__tests__/print-job-fixture.ts`, `packages/api/src/__tests__/print-device.test.ts`; `lib/editor/export-menu.ts` and the font assets unchanged; docs | done (#190) |
| G17 | **Offline print: the job kept on the device.** *Make maps available offline* (and opening Layout mode) stores the event's print jobs, their graphics, the faces and the document in Cache Storage from app code; offline, the exports compose from the stored job and say from when it is; the event's "offline ready" line with `navigator.storage.persisted()` and the document prefetch when an event opens (both Pending in `map-storage.md` §9). Tests: E2E — store, go offline (`context.setOffline`), export a PDF, notice shows the stored time | `course-print.md` §8.6; `map-storage.md` §7.1 (trims the prefetch and indicator items of §9) | 07 §9.1; 05 §5.11 | G16 | `packages/web/src/print/`, `lib/{map-document-cache,editor/export-menu}.ts`, `components/SyncStatusIndicator.tsx`, service-worker routes, locales, `e2e/course-maps.spec.ts`; docs. Widened in the row: `print/{offline-store,offline-prepare}.ts` (new), `hooks/useOfflineMaps.ts` (new), `lib/{download-api,trpc-links,map-fonts}.ts`, `pages/editor/ExportMenu.tsx`, `hooks/useCourseMapsOverview.tsx`, `pages/CoursesPage.tsx` (the export menu's entry), `pages/editor/modes/LayoutMode.tsx` (the silent refresh); `vite.config.ts` unchanged | done (#196) |
| G18 | **Venue printing: sheets, templates and graphics in the checkout snapshot** (answer 4). `SNAPSHOT_TABLES` gains `courseMap` and `mapTemplate`; the event's and the referenced club graphics travel (rows verbatim, bytes by the ranged blob procedure); the box's `maps.pdf`, `descriptions.pdf` and `print-job` answer from its copy; `courseMap.` / `mapTemplate.` / `layout.` / `graphics.` / `courseObject.` mutations are forwarded to the cloud from a venue (typed error offline), so nothing edited on a box is lost at checkin. Tests: integration `lease.test.ts` — checkout carries sheets, templates, graphics; the box prints the cloud's PDF bytes (deterministic); a layout write on the box forwards | `map-storage.md` §7.2; `system/offline-architecture.md` "Non-critical data" (print reads local, writes cloud); `course-print.md` §8 | 07 §9.2; 08 §4.8 (deviates, answer 4); 09 §4 G | G3 | `packages/api/src/sync/{lease,snapshotMaps,ownership}.ts`, `routers/lease.ts`, integration tests; docs. Widened in the row: `sync/{snapshotGraphics,venueForwarder}.ts`, `packages/shared/src/cloud-ownership.ts`, `packages/web/src/{main.tsx,lib/trpc.ts,lib/trpc-links.ts}`, `pages/editor/ExportMenu.tsx` and `hooks/useCourseMapsOverview.tsx` (G16's area: the best-effort ensure step), `e2e/course-maps.spec.ts` (one describe) | done (#187) |
| G19 | **A box follows the cloud's map data during a lease.** On the settings cadence, while online, the box re-pulls the cloud-owned map rows: sheets, templates, graphics, course objects, the patch, and a re-imported map's `map_files` row with its new document. Offline it keeps what it has. Tests: integration — a sheet edited and a map re-imported on the cloud reach the box at the next refresh; nothing race-critical is touched | `map-storage.md` §7.2 (trims §9's "refreshing a checked-out box's `map_files` row"); `system/offline-architecture.md` | 07 §9.2 "Map changes during a lease" | G18 | `packages/api/src/sync/{settingsRefresh,snapshotMaps,lease}.ts`, integration tests; docs. Widened in the row: `sync/{mapRefresh,shipper,snapshotGraphics,venueForwarder}.ts`, `routers/lease.ts` | done (#197) |
| G20 | **ISSkiOM 2019 in the symbol library: the ski-O symbols** (answer 9). A third library `ISSkiOM2019` holding what ISSkiOM adds to ISOM 2017-2: the track symbols (every width and state the spec lists) and its other ski-only symbols, authored as the other two were (`authoring.ts` helpers, dimensions from the IOF text only — the session fetches the IOF document, `map-symbols.md` §3 — palette ids, `names.ts`). Swedish names from SOFT's Swedish ISSkiOM text, which the session looks for (answer 11); absent if none is found. Not the whole spec: the base symbols of a ski-O map stay ISOM 2017-2's. The library's own scale rule (03 §6.6 `scaleRules`) exported as `libraryFactor(libraryId, mapScale)`. Tests: `palette.test.ts` tick count for the spec; `library.test.ts` (a)–(e) for the new library (hand-typed heading list and dimension table from the spec text); `names.test.ts`; contact sheet `e2e/__golden__/library/ISSkiOM2019/` and `library-golden.test.ts` | `map-symbols.md` §1, §3 (+ §3.1 counts), §6, new §12 "ISSkiOM 2019: an overlay library"; trims §10 | 03 §2.1 ("not inventoried"), §6.4, §6.6, Appendix B rows 4–5 | — | `packages/shared/src/symbol-library/` (`ISSkiOM2019/` new, `index.ts`, tests), `e2e/__golden__/library/ISSkiOM2019*`, `packages/api/src/render/__tests__/library-golden.test.ts`; docs | done (#176) |
| G21 | **The importer knows ski-O: track symbols matched, the ski-O green in every stack** (answer 8). (a) Matching: a source symbol with an 8xx code is matched against the `ISSkiOM2019` entries on any document (an overlay candidate set beside the document's library; canonical ids stay full ids, decisions and the review UI unchanged). (b) Colour alignment (stage 7): a source "Green for Ski-O" is identified as `green-skio` (name, else CMYK and position above black); where the source lacks it, it is inserted at its palette position, so every document can carry a ski track. Widened by the user at G20 (`map-symbols.md` §12.3): every palette row the overlay uses — `green-skio`, `orange-skio`, `white-skio`, `green100-area` — is inserted the same way; the overlay also holds 301.1 / 301.2 / 310.1 (§12.1), whose matching the G21 planner decides; the guards that accept any `SymbolLibraryId` as a document's library (`documentLibraryId` and its `isSymbolLibraryId` check in `decisions.ts`, `course/context.ts`) take `!isOverlayLibrary` (G20's §12: a document's library is never the overlay). `SYMBOL_LIBRARY_VERSION` bumped; the release's re-match pass picks up every pin. Tests: unit `matcher.test.ts` (8xx → ISSkiOM entry, ISOM codes unaffected), `colour-align` (identified, inserted, order vs black and upper purple, no duplicate); the corpus measure unchanged except the inserted colour; integration — an imported fixture's stack has `green-skio` | `map-symbols.md` §8.2, §9.2, §12; `map-import.md` (stage 7) | 03 §6.3, §6.5; 06 §5 | G20 | `packages/shared/src/import/{matcher,match-document,colour-align,colour-class,decisions}.ts`, tests, `scripts/measure-import.mjs`; docs | done (#183) |
| G22 | **GPX parsing and track geometry (shared, pure).** `parseGpx(text)` over `import/xml.ts`: `trk` / `trkseg` / `trkpt` (lat, lon, `ele`, `time`), `rte` as an untimed track, waypoints counted and ignored, typed errors (not GPX, no points), one track per segment. `projectTrack(frame, track)` → paper mm through `mapGeo.wgs84ToPaper` (typed "not georeferenced" without a CRS; points outside the map's bounds kept and counted). `smoothTrack` (resample by arc length at 2 m on the ground, weighted moving average over 10 m, ends pinned) and `simplifyTrack` (Douglas–Peucker, tolerance in paper mm, default 0.1). `trimTrack(range)` / `splitTrack(index)`. Tests: unit — GPX 1.0 / 1.1, several tracks and segments, missing time, malformed; projection against the fixture frame's round trip; smoothing of a noisy straight line and a corner, determinism; simplify tolerance bound | new `docs/map-gps-tracks.md` §2–3 | 04 §7 "Georeferenced inputs"; 06 §3.2 (GPX templates dropped at import) | — | `packages/shared/src/gps-track/` (new), `packages/shared/src/index.ts` (export), tests; docs | done (#179) |
| G23 | **Averaging several passes (shared, pure).** `averageTracks(passes, opts)` as "Decided in this split" specifies (reference = median-length pass, passes orientated to it, resampled every 2 m, monotone nearest-point match within 15 m, median of signed normal offsets — mean for two passes —, two iterations); result is a track plus the arc ranges only one pass supports. Tests: unit — two parallel passes → the centre line; three with one outlier → the outlier ignored; a reversed pass, any input order → identical output; a pass covering half → the single-pass range reported; a loop that passes itself does not cross-match | `docs/map-gps-tracks.md` §4 | — (the research has none; new, user 2026-11-13) | G22 | `packages/shared/src/gps-track/`, tests; docs | done (#182) |
| G24 | **`map_gps_tracks`: table and API** (per event, answer 10). Migration: one row per track segment, per event (`event_id` cascade, `id uuid`, `name`, `source_name`, `points JSONB` — lat / lng as 1e-7° integers, time, elevation, columnar —, `trim_start` / `trim_end`, `derived_from uuid[]` for an average, `single_pass JSONB NULL` — an average's single-pass ranges, `[start, end)` point-index pairs (G23; user 2026-11-13) —, `converted_op text NULL`, `created_by`, `created_at`, `version`). `mapTrack.list` (metadata), `mapTrack.get` (points), `import { tracks[] }` (parsed on the device; caps: 200 000 points a track, 200 tracks an event), `update` (name, trim), `split`, `remove`, `markConverted`; `courses.edit`. Cloud-owned: `mapTrack.` in `CLOUD_OWNED_MUTATION_PREFIXES`, not in the checkout snapshot, not journaled; in the per-event dump (07 §10); never delivered to the viewer or kiosk. Tests: integration — import / list / get, caps, split and trim, auth, cascade with the event, dump / restore | `docs/map-gps-tracks.md` §1; `map-storage.md` §7.2 (not in the snapshot), §7.3 | 07 §10; 08 §4.8 | G3 (and after G18 has merged: `sync/ownership.ts`) | `packages/api/prisma/` (migration), `routers/mapTrack.ts` (new), `routers/index.ts`, `packages/shared/src/cloud-ownership.ts` (one prefix; G18 moved the list there, `sync/ownership.ts` re-exports it), dump files, integration tests; docs | done (#198) |
| G25 | **GPS tracks in Map mode: import and the reference layer.** A *GPS tracks* panel (`modes/map/tracks/`): import one or many `.gpx` (file picker and drop; parsed in the browser, `mapTrack.import`), the list (name, date, length, points, colour, show / hide, rename, delete, "outside the map", "converted"); visible tracks drawn over the map in paper space as a UI-layer overlay (decimated to the pixel; never printed, never on the kiosk); disabled with the reason on a map without a georeference; a click in the list locates the track. Tests: unit — list state, decimation; E2E `map-gps-tracks.spec.ts` (new) — import a fixture GPX generated from the fixture map's frame, the track is drawn where expected, hide, delete, reload keeps it | `course-editor.md` §13 "GPS tracks"; `docs/map-gps-tracks.md` §5 | 04 §7; 08 §5.2, §5.5 | G6, G22, G24 (queued after G10: `MapMode.tsx`) | `modes/MapMode.tsx` (mount only), `modes/map/tracks/` (new), `tools/{bindings,rail}.ts`, `lib/editor/write-client.ts`, locales, `e2e/map-gps-tracks.spec.ts`, `e2e/fixtures/`; docs | done (#207) |
| G26 | **Convert a track into a map object.** On one or more selected tracks: *Convert to line* — the symbol picker (`mapPalette`, line symbols; the ISSkiOM track group first, last choice remembered), smoothing and simplification controls with a live preview in the chosen symbol (dynamic bucket), then one `add` op per track (line object in document units, symbol materialised on first use as G9 does), one `mapPatch.applyChange`, one undo entry; the track is marked converted and hidden from the layer (kept; *Show converted* brings it back). From then on it is an ordinary added object (G7 nodes, G9 change symbol, print, kiosk, promote). Tests: unit — track → `add` op (units, symbol, determinism); E2E — convert the fixture track with a ski-track symbol, the line is in the frame and in the PDF's page raster, undo removes it | `course-editor.md` §13 "GPS tracks: convert"; `docs/map-gps-tracks.md` §6 | 08 §4.7; 03 §1 | G9, G21, G25 | `modes/map/tracks/`, `modes/MapMode.tsx` (mount only), `e2e/map-gps-tracks.spec.ts`; docs | done (#217) |
| G27 | **Trim, split and average tracks.** A *Tracks* tool on a selected reference track: drag its end handles along the track (trim, restorable), split at a clicked point (cutting out a break or a wrong turn is split, split, delete); with two or more selected, *Average* makes a new track (G23), stored like an imported one with `derived_from`, its sources hidden; single-pass spans drawn dashed. Each gesture one undo entry. Tests: unit — handle ↔ point index, the tool reducer; E2E — trim, split and delete the middle, average two fixture passes | `course-editor.md` §13 "GPS tracks: editing"; `docs/map-gps-tracks.md` §4–5 | — (new, user 2026-11-13) | G23, G26 | `modes/map/tracks/`, `tools/` (the tracks tool, `bindings.ts`), `e2e/map-gps-tracks.spec.ts`; docs | done (#219) |
| G28 | **Snap a converted track's ends to the track network.** At conversion (and as *Snap ends* on an added line): each end within 1.5 mm on paper of a line object with a track symbol (the effective document, added lines included) is moved onto it — to that line's end vertex when one is within reach (the two then share a vertex; joining them is G10's *Join*), else to the nearest point on the line: an end that overshoots is cut at the crossing, one that falls short is extended straight. The other line is not changed. `nearestOnLines(doc, pt, maxMm, symbolFilter)` beside the snap index (it holds vertices only). On by default, a checkbox in the convert panel. Tests: unit — short, overshoot, end-to-end, nothing in reach, the symbol filter; E2E — a converted fixture track ends on the existing line | `course-editor.md` §6.2, §13 "GPS tracks: junctions"; `docs/map-gps-tracks.md` §6 | 08 §5.3 "Snapping" | G26 | `lib/editor/snap.ts`, `modes/map/tracks/`, `e2e/map-gps-tracks.spec.ts`; docs; as built also `modes/MapMode.tsx`, `map/ObjectSection.tsx`, `map/shape-ops.ts`, the `editor.json` locales, `e2e/helpers/` (`patch-symbol-cli.ts`, `event-map-pin.ts`) | done (#221) |
| G29 | **Preview-build smoke: offline print from the production bundle** (the user's answer to G17's planner, 2026-11-14: not in G17, required before the G-gate). A Playwright project on the production build served by Vite's preview server on its own port, with the service worker registered: the built `print-worker-entry-<hash>.js` constructed in its emitted format, the `print-worker`, `map-fonts` and `map-documents` routes and the `globIgnores` entry; store an event (*Make maps available offline*), reload, go offline (`context.setOffline`), export a PDF — composed from the stored job with the chunk and faces from the service worker's caches; wired into the sharded runner and CI | `course-print.md` §8.6 "Delivery", "Offline" (Pending: "The production print worker is checked by build inspection only"); `map-storage.md` §7.1, §9 | 07 §9.1; 05 §5.11 | G17 | the E2E config (a project), `scripts/e2e-sharded.mjs`, `.github/workflows/`, `e2e/` (a new spec); docs | done (#199) |
| G30 | **T shows a track's nodes and keeps splitting** (user 2026-11-20). While `T` is armed every selected visible track draws its splittable stored points as nodes (thinned to the screen, all of them round the pointer), the one a click would split at highlighted; a split keeps both parts selected, so each click splits again. | `docs/map-gps-tracks.md` §5.2; `course-editor.md` §13 "GPS tracks: editing" | — | G27 | `tools/tracks.ts`, `tools/bindings.ts`, `components/MapViewer.tsx` (`nodes` shape), `modes/map/tracks/`, the `editor.json` locales, `e2e/map-gps-tracks.spec.ts`; docs | done (#236) |
| G31 | **TCX import** (user 2026-11-20). `parseTcx` (Garmin Training Center XML v2: one track per activity, laps joined; a course as an untimed route) and `parseTrackFile` choosing GPX or TCX by the root element; the panel accepts `.tcx`. | `docs/map-gps-tracks.md` §2.4 | — | G22, G25 | `packages/shared/src/gps-track/`, `modes/map/tracks/`, the `editor.json` locales, `e2e/map-gps-tracks.spec.ts`; docs | done (#236) |
| G32 | **T splits map lines too** (user 2026-11-20, choice "Map lines and GPS tracks"). With `T` armed a click off every GPS track selects the map object under it; a selected single-part line draws its splittable nodes; a click on one is *Split at node* there. | `course-editor.md` §13 "Split tool" | — | G10, G30 | `tools/bindings.ts`, `tools/tracks.ts`, `modes/MapMode.tsx`, `modes/map/tracks/useMapTracks.ts`, the `editor.json` locales, `e2e/map-mode.spec.ts`; docs | done (#238) |
| G-gate | `map-mode.spec.ts`, `course-maps.spec.ts`, `map-vector-layer.spec.ts` and `map-gps-tracks.spec.ts` green; on the club's instance a real ski-O correction from GPX: at least two logged passes of one ski track imported, averaged, a break trimmed out, converted with an ISSkiOM track symbol on the club's ski-O base map, its ends snapped to the existing network, seen in the editor, on the kiosk and in the printed PDF, then promoted and re-matched with the track kept; an imported ISSkiOM-symbolled map's track symbols matched in the review; the corpus run (09 §8) with an empty patch byte-identical to before; on the club's instance: one real correction (a hidden object, a new path) drawn in the editor, on the kiosk and in the printed PDF, the toggle switched off and on (09 §6), then promoted and the club version re-matched with the correction kept; one event's maps exported on a laptop with the network off; one checked-out box prints with its uplink pulled; release notes naming the toggle and the rollback | 09 §4 G, §6, §8 | — | all G rows | user + club | manual |

Waiting on later slices, not G: print profiles and the test sheet
(`cmyk-offset`, 05 §5.5 — decision (2), 2026-10-23; with them the print
profile in the snapshot, 07 §9.2), the translucent corridor band (F26; landed as J13),
micro insets, climb from contours and OCAD course export (08 phase 4),
Map mode on touch, text creation, symbol editing, a patched thumbnail,
the documents-only dump (07 §10), terrain (topic 10); recording a GPS
track in the app (a browser loses its GPS watch when the screen is off,
so Field mode recording needs a packaged, native-wrapped app), shifting
or rubber-sheeting a whole track to fit the map, Bézier fitting of
converted tracks, the rest of ISSkiOM (its base-symbol deviations from
ISOM, per-scale course symbols) and ISMTBOM 2022, FIT / KML import,
keeping the original GPX file.
