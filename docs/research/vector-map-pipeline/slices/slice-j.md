# SLICES — Slice J — graphics: images and object transparency (split 2026-11-18; user 2026-11-18)

The full rows of this slice, moved out of [SLICES.md](../SLICES.md) on 2026-11-21. Statuses reported `review` for PRs that merged on 2026-11-20 are corrected; everything else is as it was. New rows for this slice are added here; open rows are also listed in SLICES.md.

Opacity, blend, rotation, flip and crop as properties of objects, and
images drawn by the map engine, so the canvas is the PDF in both modes.
The user's case is a club race (Lusseloppet) where every control sits in
an "opened advent-calendar door" PNG with a transparent middle and an
opaque or half-opaque frame; the features are generic. Split by the J0
planner (Fable) from `course-layout.md` §1–§3 and Pending,
`course-layer.md` §1, §3.6, §8, `course-print.md` §2, §4, §6.3,
`map-rendering.md` §3, §5, §8, `course-maps.md`, 05 §5.4 / §5.7,
08 §4.5 / §5.3, and the code.

**Verified starting point** (J0): `image` course objects are previewed on
no canvas; Layout page images are an SVG `<image>` in the UI layer,
uncropped, over everything; the PDF draws map-anchored images after the
whole map stream (`print/compose.ts`), above both purples; the stream and
every GL shader carry no alpha; the page oracle draws no images; the
graphic cap is 2 MB and a placed image is 30 × 30 mm whatever its
aspect; Course mode has no image tool; the editor has no duplicate or
clipboard keys; graphic bytes need `courses.view` while
`courseObject.list` is kiosk-readable.

### Answers (user 2026-11-18)

1. **All eight features are in scope**: opacity per object; images drawn
   by the engine; rotate / flip / crop / aspect lock / numeric fields;
   duplicate and copy / paste; attach an object to a control; Multiply
   blend; a graphics picker with thumbnails; a higher upload cap or
   downscale on upload. Plus an image tool in Course mode ("There is
   currently no I tool in course mode").
2. **Every object kind** where it makes sense, not only images.
3. **Purple above graphics**: "the purple should normally be above the
   graphics … there will be no order of the controls, so no lines.
   However, the circles should still be there, inside the lucka." Other
   orders are "a later experiment".
4. No deadline; printed on the club printer.

J0's questions, answered by the user 2026-11-18 ("hidden under opaque
parts makes sense to me. Show also in kiosk and viewer, yes. Translucent
corridor, yes."):

5. **Q1 — the white-out rule (A).** A map-anchored image sits above every
   map colour and lower purple, below upper purple: circles and legs show
   through transparent and semi-transparent pixels and are hidden under
   opaque ones; numbers are always on top. J14 (purple drawn again over
   images) is not needed.
6. **Q2 — yes.** The event's kiosk key reads graphic bytes, so the viewer
   and the kiosk map draw image course objects (J2, J6).
7. **Q3 — yes.** F26 (translucent corridor band) is folded in as J13.
8. **The row planners' 20 questions** (J1–J6 planners and a J7–J13
   sweep, Fable, 2026-11-18; the list with every recommendation is
   [slice-j-questions-2026-11-18.md](../slice-j-questions-2026-11-18.md)):
   all on the recommendation — the user: "all recommendations sound very
   sane, so let's proceed." Question 13 (JPEG upload) had no
   recommendation: not in slice J.

### Decided in this split

For the user's review; each goes into its spec section and
`decisions/slice-j.md` when its row lands.

- **Alpha is per pass**: `opacity?` (0–1) and `blend?: "multiply"` on
  every pass kind, set from the object; absent = opaque / normal, and a
  stream without them is bit-identical in all three backends and in the
  PDF (no ExtGState, no page `/Group`). No symbol or document format
  change.
- **Per pass, not per group**: a filled and stroked shape at 50 % shows
  the stroke's inner half over the fill. Group opacity is Pending.
- **On the canvas an alpha pass paints each pixel once per object**
  (stencil-then-cover), as the PDF and the raster do.
- **PDF**: ExtGState `/ca` `/CA` `/BM /Multiply`, one per distinct pair
  per document; a page `/Group /S /Transparency` in the page's colour
  space only where used. Print-job version 2 → 3 (J5).
- **An image is a pass in a colour row** (`ImagePass`), not a side list;
  `layer.images` only lists the graphics to fetch. Canvas, oracle and PDF
  then agree by construction; hit-test and the 3D drape get images too.
- **Map-anchored images take one row, `course:graphics`**, directly above
  upper white: above every map colour, lower purple and white-outs;
  below upper purple, object text and the toner-saver white (Q1 = A). Page images keep the page layer's last row.
- **The canvas takes image bytes from `print.png`** for PNG and SVG
  alike (the browser never rasterises SVG).
- **Data model**: page objects gain optional `opacity`, `blend`,
  `rotationDeg` (text, rectangle, image), `flipH` / `flipV` (image) — no
  migration; course objects gain the same in `props` of `text`, `image`,
  `whiteout` — no migration, tokens untouched. Geometry stays the
  unrotated box; rotation clockwise about the box centre, flips first.
  Lines and paths store no angle (rotate and flip rewrite vertices). No
  opacity on the 7xx kinds or the toner saver. Opacity stored 0–1, shown
  in %. Aspect lock is editor state (on for images, Shift inverts).
- **Attachment**: one new column, `course_objects.attach JSONB NULL` =
  `{ controlId, at { x, y } }`, resolved at draw time — a control move
  writes nothing to the object. An attached object draws only where its
  control is drawn; a deleted control leaves it detached in place.
  Course objects only.
- **Graphics**: upload ≤ 16 MiB, stored ≤ 8 MiB, a PNG over 4096 px on
  its longer side resampled by `sharp` (alpha kept); `width_px` /
  `height_px` columns; thumbnails by endpoint, not stored.
- **Tools**: `I` is the image key in both modes and opens the picker. The
  clipboard is the app's own (memory + `localStorage`); a system-clipboard
  bitmap paste is Pending. Per-object "above the course" is Pending.

### Waves

- Wave 1: **J1 ∥ J2**. Wave 2: **J3 ∥ J4**. Wave 3: **J5** (may start
  while J3 is open).
- **Manual checkpoint after J5**: the user prints the `page-graphics`
  scene on the club printer (SMask, `/ca`, Multiply on a DeviceCMYK
  page), so a printer that flattens badly is found before the gate.
- Then J6 (needs J2, J3, J5) → J7 → J8 → (J9 ∥ J10) → J11 → J12.
- J13 any time after J6, never together with J10 (`course/layer.ts`).
  J14 closed (Q1 = A). J-gate after J12.

### Done

| Id | Sub-slice | Status |
|----|-----------|--------|
| J0 | **Plan and split** (Fable): the rows below, three questions to the user | done 2026-11-18 (answers 5–7 above) |

### Remaining

| Id | Sub-slice | Spec home | Research | Depends on | Area (files a session may touch) | Status |
|----|-----------|-----------|----------|------------|----------------------------------|--------|
| J1 | **Alpha and blend in the stream, the reference raster and the PDF.** `opacity?` (0–1, absent = 1) and `blend?: "multiply"` on every pass kind, set from the symbolise input object (document objects never set one); order, JSON projection and determinism unchanged; a stream without them bit-identical everywhere. Raster: `opacity` / `mix-blend-mode` (the layered page oracle moved to J4, deviation (d)). PDF: `OperatorResources` hands out ExtGStates (`/ca` `/CA` `/BM`), one per distinct pair per document; page `/Group` in the page's colour space only when used; `qpdf --check`. New stream fixtures (`alpha-passes`, `alpha-text`, `blend-multiply`; the `page-alpha` scene moved to J4). No GL, no object model. Tests: unit per file, PDF golden tier | `map-rendering.md` §3, §3.7, §5.1, §5.3, §6, §8; `course-print.md` §2, §9 | 05 §5.4, §5.8; F26's design | — | `packages/shared/src/render/{pass-stream,symbolise,stream-json,reference-svg}.ts` + fixtures, `packages/shared/src/print/{operators,writer}.ts` + `__fixtures__/pages.ts`, `packages/api/src/render/{page-raster,reference-raster,golden,pdf-golden}.ts`, `e2e/__golden__/map-gl/`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`, slice J overnight PR)) |
| J2 | **Graphics library: cap, pixel size, thumbnails, picker.** Upload up to 16 MiB; a PNG wider than 4096 px on its longer side resampled to it by `sharp`, alpha kept; the stored row at most 8 MiB. `graphics.width_px` / `height_px` (additive, nullable, filled at upload and by a backfill). `GET …/graphics/:id/thumb.png` (≤ 256 px, immutable cache). The graphic routes also answer the event's kiosk key (Q2). `graphics.list` gains the size. `GraphicPicker` (thumbnails, event then club, upload, save to club, delete) replaces the Layout inspector's list. A graphic over 4 MiB through `lease.exportBlob`'s slices, tested. en and sv. Tests: unit, integration (new `graphics.test.ts`, `venue-print.test.ts`), E2E | `course-maps.md` (Data model, API); `map-storage.md` §7.2; `course-print.md` §8.5; `features.md` | 05 §5.7 | — | `packages/api/prisma/`, `packages/api/src/routers/graphics.ts`, `packages/api/src/course-maps/{graphics,routes}.ts`, `packages/api/src/sync/snapshotGraphics.ts`, new `packages/web/src/components/GraphicPicker.tsx`, `packages/web/src/pages/editor/layout/LayoutInspector.tsx` (`GraphicsSection` only), `packages/web/src/print/offline-*.ts`, locales, `e2e/course-editor-layout.spec.ts` (the graphics test), docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`, slice J overnight PR)) |
| J3 | **GL alpha and blend.** The arena path draws passes with opacity or blend as their own draw layers in row order: stencil-then-cover so each object paints a pixel once; Multiply as `DST_COLOR` blending with the alpha folded into the source; prepare, buckets and worker carry the state; opaque streams draw as today, draw calls unchanged. GL goldens of J1's fixtures within budget; the drape and the loupe follow | `map-rendering.md` §5.2, §5.5 (highlight note), §6.2, §8 | 04 §6; F26 | J1 | `packages/web/src/map-gl/{renderer,prepare,buckets,arena,worker,engine}.ts` + tests, `packages/web/src/pages/dev/`, `e2e/map-gl-golden.spec.ts`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`, slice J overnight PR)) |
| J4 | **The object model: opacity, blend, rotation, flip.** Layout schema: `opacity?`, `blend?` on every kind; `rotationDeg?` on text, rectangle, image; `flipH?` / `flipV?` on image. Course objects: `opacity?`, `blend?` on `text`, `image`, `whiteout`; `rotationDeg?` on `text`, `image`; flips on `image`. Builders: opacity and blend onto the render objects, a rotated rectangle as its turned path, a text's angle; rotated bounds in validation; images still through `layer.images` until J5, carrying the new fields. Print and raster follow by construction. The page oracle composites the page layer over the map so Multiply crosses layers, drawn onto the sheet so far when the page layer has a Multiply pass, `page-objects-alpha` the cross-layer scene (both moved from J1, deviation (d); no separate `page-alpha` scene, decision J4 (8)). Tests: `objects.test.ts`, `layer.test.ts`, `page-layer.test.ts`, `compose.test.ts`, a `page-objects-alpha` golden, `page-raster.test.ts` (the layered case) | `course-layer.md` §3.6, §8.1; `course-maps.md` Data model, Validation; `course-print.md` §6.1 | 08 §4.5 (white-out opacity), §5.3 (rotate) | J1 | `packages/shared/src/course-maps/{schema,validate,geometry}.ts`, `packages/shared/src/course/{objects,types,page-layer}.ts`, `packages/shared/src/print/{page,compose}.ts` + `__fixtures__/pages.ts`, `packages/api/src/render/{page-raster,pdf-golden}.ts`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`, slice J overnight PR; area also `packages/api/src/render/reference-raster.ts` for the layered oracle's backdrop, `e2e/__golden__/map-gl/page-objects-alpha.png`)) |
| J5 | **Images as passes: layer, PDF, reference raster.** `ImagePass` (row, graphic id, the unit square's affine, crop, opacity, blend) emitted by `symbolise` from an image symbol; the course layer's `course:graphics` row (placement: Q1 = A, above upper white, below upper purple) and the page layer's `page:graphics` row; `layer.images` / `ComposedPage.images` become the list of graphics to fetch; operators draw `Do` in row order with crop clip, affine and ExtGState; `/SMask` asserted; the raster draws images; hit-test by the quad; print-job version 3. Scene `page-graphics`: a PNG with a transparent middle and a half-opaque frame over map and course, one rotated and cropped, one Multiply. Tests: unit, `print-job.test.ts`, `venue-print.test.ts`, web print worker tests, PDF golden tier | `map-rendering.md` §3, §3.6, §5.1, §5.3; `course-layer.md` §1, §8.1, §8.3; `course-print.md` §4.3, §4.4, §6.3, §8.5 | 05 §5.1, §5.7 | J4 | `packages/shared/src/render/{pass-stream,symbol,symbolise,stream-json,reference-svg,hit-test}.ts`, `packages/shared/src/course/{objects,layer,page-layer,colour-stack,types}.ts`, `packages/shared/src/print/{compose,operators,writer,page,course-pages,print-job}.ts`, `packages/api/src/render/`, `packages/api/src/course-maps/graphics.ts` (`sheetGraphicIds`), `packages/web/src/print/`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`; no image symbol: the object carries the graphic, an area symbol the row — decision log "J5"; golden `e2e/__golden__/map-gl/page-graphics.png`, ready for the manual print checkpoint)) |
| J6 | **GL-drawn images.** Graphic textures (bytes from `print.png`, so the browser rasterises no SVG; decoded unpremultiplied; a byte budget; an outline until loaded; released with the part); `ImagePass` drawn in row order with affine, crop, alpha, Multiply; Layout mode's UI-layer `<image>` and its `ToolShape` removed; `image` course objects previewed in Course, Layout and Class view, the viewer and the kiosk; offline Layout from the stored graphics. E2E: pixel probes (transparent middle shows map and circle; an opaque frame hides the map; the crop previewed), goldens | `course-layout.md` §1, Pending; `map-rendering.md` §5.2, §5.4, §5.5; `course-layer.md` §8.3, Pending | 05 §5.12; 04 §6 | J2, J3, J5 | `packages/web/src/map-gl/`, new `packages/web/src/lib/graphic-textures.ts`, `packages/web/src/components/{MapViewer,MapPanel}.tsx`, `packages/web/src/lib/course-layer-request.ts`, `packages/web/src/pages/editor/layout/bindings.ts` (`imageShape` only), `e2e/{map-gl-golden,course-editor-layout,course-editor-tools}.spec.ts`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review 2026-11-18 (branch `claude/project-thread-myidtr`)) |
| J7 | **Course mode: the `I` tool and the object inspector.** `I` opens the picker; a click places an `image` course object at the graphic's aspect (30 mm on its longer side at print size, `{ all: true }`), selected. Selected by its quad, moved by its body, resized by its corners. Inspector for `image` / `text` / `whiteout`: opacity %, blend, rotation, flip, width and height with aspect lock, crop fields and reset (new shared `StyleFields`). en and sv. Tests: unit (`bindings.test.ts`, `state.test.ts`), E2E `course-editor-tools.spec.ts` | `course-editor.md` §6 (table), §7, §5; `features.md` | 08 §4.5, §5.2 | J6 | `packages/web/src/pages/editor/{EditorPage,ToolRail}.tsx`, `tools/{rail,bindings}.ts`, `modes/ObjectSection.tsx`, new `pages/editor/StyleFields.tsx`, `packages/web/src/lib/editor/{state,hit}.ts`, locales, `e2e/course-editor-tools.spec.ts`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review 2026-11-19 (branch `claude/project-thread-myidtr`; 30 mm is map-scale mm, decision J7 (2); area widened: `MapViewer.tsx` one line, `lib/editor/{image-box,style-fields}.ts`, `rail.test.ts`)) |
| J8 | **Layout mode: inspector fields.** `StyleFields` on every page object: opacity, blend (hidden for white-outs), rotation (text, rectangle, image), flip and crop (image), size with aspect lock; `I` opens the picker; a placed image takes its aspect. Tests: `layout-model.test.ts`, E2E `course-editor-layout.spec.ts` (a 50 % rectangle and a Multiply image: canvas probe and the PDF's `gs` operators) | `course-layout.md` §2 (Keys, Inspector), §3; `features.md` | 08 §5.3 | J7 | `packages/web/src/pages/editor/layout/{LayoutInspector,LayoutRail,model,fields}.tsx`, `modes/LayoutMode.tsx`, `packages/web/src/lib/map-layout-editor.ts`, locales, `e2e/course-editor-layout.spec.ts`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`; area widened: `layout/bindings.ts`, `pages/editor/StyleFields.tsx`, `lib/__tests__/map-layout-editor.test.ts`, `pages/editor/__tests__/layout-{model,bindings}.test.ts`)) |
| J9 | **Transform handles, shared module and Layout mode.** New `lib/editor/transform-gestures.ts` (pure, in the caller's units, as `geometry-gestures.ts`): a rotate handle above the box (Shift snaps to 15°); resize in the object's own frame; aspect lock (on for images, Shift inverts); **crop mode** (double-click an image or the inspector's *Crop*: drag the four edges, the content stays put; reset; Escape leaves); flip buttons; for lines and paths, rotate and flip bake into the vertices. Each gesture one write, previewed live, Escape cancels | `course-layout.md` §3, Pending ("rotation") | 08 §5.3 | J8 | new `packages/web/src/lib/editor/transform-gestures.ts` + test, `packages/web/src/lib/editor/layout.ts`, `packages/web/src/pages/editor/layout/bindings.ts`, `packages/web/src/lib/map-layout-editor.ts`, `e2e/course-editor-layout.spec.ts`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`; area widened: `components/MapViewer.tsx`, `lib/editor/{image-box,layout}.ts`, `tools/bindings.ts`, `pages/editor/{StyleFields,TransformButtons}.tsx`, `layout/{LayoutInspector,model}`, `modes/LayoutMode.tsx`, locales)) |
| J10 | **Attach a course object to a control.** `course_objects.attach JSONB NULL` = `{ controlId (uuid), at { x, y } }`; on the wire the public control id. Drawn translated by the control's position minus `at`, and only where its control is drawn; resolved inside `courseLayer` from `sites`. A control move writes nothing to the object. Moving the object by hand rewrites geometry and `at`. A deleted control leaves it detached where it was. Inspector: *Attach to control* (the nearest, or a click on one), *Centre on control*, *Detach*. Snapshot, dump and `mapRefresh` carry the column. Tests: unit, integration (`course-objects.test.ts`, `venue-print.test.ts`), E2E (drag the control, the object follows; the PDF agrees) | `course-layer.md` §8.1–§8.5; `course-editor.md` §7; `map-storage.md` §7.2 | 08 §4.5 | J7 | `packages/api/prisma/`, `packages/api/src/course-objects.ts`, `packages/api/src/routers/courseObject.ts`, `packages/api/src/sync/{lease,mapRefresh}.ts`, `packages/shared/src/course/{objects,layer,types,checks}.ts`, `packages/shared/src/course-maps/sheet-rows.ts`, `packages/web/src/pages/editor/modes/ObjectSection.tsx`, `EditorPage.tsx` (the attach gesture), `lib/editor/{attach,write-client}.ts`, `components/MapViewer.tsx` (hit rings), locales, tests, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`)) |
| J11 | **Transform handles in Course mode.** J9's module on a selected `image` / `text` course object in paper mm: rotate, resize, crop mode, flip; `whiteout` and the line kinds get rotate and flip baked into their vertices. An attached object's handles act on the drawn position | `course-editor.md` §7 ("Editing geometry") | 08 §5.3 | J9, J10 | `packages/web/src/pages/editor/tools/bindings.ts`, `EditorPage.tsx`, `packages/web/src/lib/editor/transform-gestures.ts`, `e2e/course-editor-tools.spec.ts`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`; area widened: `modes/ObjectSection.tsx`, `TransformButtons` reused, the two unit test files, locales (`styleCropMode` renamed), `features.md`, `course-layout.md`)) |
| J12 | **Duplicate, copy, cut, paste.** `Ctrl+D` duplicates the selected object 3 mm down-right, selected; `Ctrl+C` / `Ctrl+X` / `Ctrl+V` through an app clipboard (memory and `localStorage`, so across sheets, templates, events and tabs). Page objects paste as page objects, course objects as course objects, at the pointer or the view centre. With controls selected (multi-selection included), paste places one copy per control, attached at the copied offset. A graphic that is neither the event's nor the club's is refused with a message. One write and one undo entry per paste (per control: one entry for the batch). en and sv | `course-editor.md` §6.5, §7; `course-layout.md` §2 (Keys) | 08 §5.3 | J11 | new `packages/web/src/lib/editor/clipboard.ts` + test, `EditorPage.tsx`, `modes/LayoutMode.tsx`, `layout/model.ts`, `lib/editor/write-client.ts`, locales, `e2e/{course-editor-tools,course-editor-layout}.spec.ts`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`)) |
| J13 | **Translucent corridor band (F26, folded in by the user's Q3).** F26's row as written, on J1 / J3's alpha: `whiteOpacity` < 1 is a white fill with alpha in a corridor-white row above the map colours and below lower purple instead of the clip; 1 keeps the clip, bit-identical; mixed opacities, the minimum wins; scene `course-corridor-translucent`; the Leg section's field returns | `course-layer.md` §10.2, Pending; `map-rendering.md` §8; `course-editor.md` §6.7 | 08 §4.3; F2, F25, F26 | J3, J5 | `packages/shared/src/course/{layer,corridor}.ts`, fixtures, `packages/web/src/pages/editor/modes/LegSection.tsx`, locales, goldens, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review (branch `claude/project-thread-myidtr`; area widened: `course/{derive,types}.ts`, `render/__fixtures__/course/index.ts`, the api migration and its integration test, `e2e/map-gl-golden.spec.ts`)) |
| J14 | **Purple over graphics** (only if Q1 = B; it is A). The course's lower-purple symbols drawn again above the graphics row, clipped to the image quads: an "inside" mask sense in the stream and the three backends | `map-rendering.md` §3.8, §4.11; `course-layer.md` §1 | — | J6 | `packages/shared/src/render/`, `packages/shared/src/course/layer.ts`, `packages/shared/src/print/operators.ts`, `packages/web/src/map-gl/` | closed 2026-11-18, not needed (user: Q1 = A); no code |
| J15 | **Cut out graphics below (knockout), user 2026-11-19.** An optional `knockout: true` on an `image` (course object and page object): its footprint — the box after crop and rotation, not its pixels, inset ~0.05 mm — masks every **image** below it in the same layer (map or page; `z`, `seq` order), so a big overlay (an advent calendar over the whole map) is cut away under each lucka and heals when the lucka moves. White-outs and course purple are not cut. Attached objects cut where they are drawn; one not drawn in a course (its control absent) cuts nothing. Reuses the filter-region mask path (stencil on screen, `W*` clip in the PDF); an inspector checkbox "Cut out graphics below" in Course and Layout mode; duplicate and paste carry it | `course-layer.md` §3.6 "Knockout images"; `map-rendering.md` §3.8, §3.10, §4.11 "Knockout footprints", §5.2, §6.2, §6.3, §8; `course-print.md` §6.3, §8.5, §8.6; `course-editor.md` §7; `course-layout.md` §3; `course-maps.md` | — | J6, J10, J12 | `packages/shared/src/{course/objects.ts,course-maps/schema.ts,render/filter-region.ts,render/symbolise.ts,print/print-job.ts}`, `packages/web/src/map-gl/worker.ts`, `packages/web/src/print/client.ts`, the inspector (`StyleFields`, `ObjectSection`, `layout/model.ts`, `style-fields.ts`), locales, the `course-knockout` golden, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review: claude/project-thread-myidtr (PR #233)) |
| J16 | **Multi-select course objects (user 2026-11-19).** In `V`, Ctrl/Cmd- or Shift-click toggles a course object into an object multi-selection (`objectMulti`, exclusive with control selections; Escape drops it). A drag on a member moves all (one batch write, one undo entry); `Delete` and `Ctrl+D` act on the set; the multi inspector shows the count and, for one styled kind, the shared style fields (one field set on all). Clipboard, lasso, handles and Layout mode stay single-object | `course-editor.md` §7 "Multi-selection" | — | J7, J11, J12 | `packages/web/src/lib/editor/{state,write-client,style-fields}.ts`, `packages/web/src/pages/editor/{EditorPage.tsx,tools/bindings.ts,modes/ObjectSection.tsx}`, `components/MapViewer.tsx` (Ctrl on `ToolPointer`), locales, `e2e/course-editor-tools.spec.ts`, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review: claude/project-thread-myidtr (PR #233)) |
| J17 | **Graphics turned with the map's north lines** (user 2026-11-19: deferred — "I'd rather do a bigger slice at some point to be able to reorient the north lines correctly and then apply some central fix"). Today an image's rotation is in the paper frame. A later slice first makes the north lines correct (re-orienting them), then applies one central rule (images, texts, symbols) for north-relative rotation | to be planned | — | — | — | deferred (user 2026-11-19) |
| J18 | **Hide the attached control's circle and number (user 2026-11-19).** `hideControlCircle?` / `hideControlNumber?` on an `image` act while it is attached: the derivation leaves the number unplaced, the layer skips the circle; legs, cuts and the hit target stay. Two checkboxes in the inspector's attach block, attached images only | `course-layer.md` §8.1 "Hiding the attached control"; `course-editor.md` §7 "Attached objects" | — | J10 | `packages/shared/src/course/{objects,derive,layer}.ts`, `ObjectSection.tsx`, `style-fields.ts`, locales, tests, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review: claude/project-thread-myidtr (PR #233)) |
| J19 | **Cut along the hatch outline (user 2026-11-19, decision card).** A knockout course image cuts by its graphic's traced outline instead of its box: `render.traceOutline` (alpha ≥ 50 % at 512 px, holes filled, ≤ 8 rings × 200 vertices), stored in `graphics.outline` (traced lazily at load), carried read-only on knockout image objects, mapped through crop and quad into the J15 masks. Page images keep the box. `PRINT_JOB_VERSION` 6 → 7 (with J18) | `map-rendering.md` §4.11 "Knockout footprints", §8; `course-layer.md` §3.6, §8.1 "Graphic outline"; `course-maps.md` "Data model"; `course-print.md` §8.5, §8.6 | — | J15 | `packages/shared/src/render/{trace-outline,filter-region,symbolise}.ts`, `course/objects.ts`, `print/print-job.ts`, `packages/api/{prisma,src/course-objects.ts,src/course-maps/graphics.ts}`, `packages/web/src/print/client.ts`, tests, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review: claude/project-thread-myidtr (PR #233)) |
| J20 | **Upload several graphics at once (user 2026-11-20).** The graphics picker's file input takes several files; they upload one after another (`uploadEach`), the button counts them, a failed file is named while the rest still upload | `course-layout.md` §2 (picker) | — | J2 | `packages/web/src/components/GraphicPicker.tsx`, `lib/graphics-picker.ts`, locales, tests, docs | done 2026-11-20 (#233, merged at `be8dc65d`; was: review: claude/project-thread-myidtr (PR #233)) |
| J-gate | The specs above green. On the club's instance: two or three door PNGs in the club library; one placed on a control, attached, copied onto every control of a course; a control moved, its door follows; frame opacity changed and Multiply tried; the sheet printed on the club printer — the middle shows the map at full strength, circles and numbers show, canvas and paper agree. A photo beside a control. A rotated, cropped logo on a template. An old event's `maps.pdf` byte-identical to before the slice. Release notes | `course-layout.md`, `course-print.md` | — | J1–J12 (J13 may follow) | user + club | manual |
