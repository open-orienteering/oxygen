# Map pipeline switch

Normative chapter for how an Oxygen instance chooses, per event, between
the legacy map pipeline (OCAD → tiles, `docs/map-tile-rendering.md`) and
the vector pipeline (map documents drawn by the GL renderer,
`docs/map-rendering.md` §5.4) while both exist. Research record:
`docs/research/vector-map-pipeline/09-migration.md` §3, §4 B, §10.
Slice B, row B5. Decisions taken while writing it are in the research
README's decision log (2026-10-22, "Slice B, per-event switch (B5)").

The rules in one line: **instance flags say what new events get and
whether `legacy` is still allowed; the event column says which pipeline
the event reads through; writes never fork.**

## 1. Instance flags

Three keys in `oxygen.settings` (`getSetting` / `setSetting`, `db.ts`):

| Key | Values | Absent / unknown | Meaning |
|-----|--------|------------------|---------|
| `map.pipeline.default` | `legacy` \| `vector` | `legacy` | The pipeline a newly created event gets |
| `map.pipeline.allowLegacy` | `true` \| `false` | `true` | Whether an event may be switched (back) to `legacy`, and whether tiles are a fallback (§3.3) |
| `map.editor.vector` | `true` \| `false` | `false` | Whether `/:nameId/course-editor` mounts the new editor for a `vector` event with a pinned document (§3.6). **Temporary**: slice D's gate while the editor is unproven (user decision 2026-10-31); removed in slice E |

- Parsing (`packages/api/src/map-pipeline.ts`): the default is `vector`
  only for the string `vector` (trimmed, any case); `allowLegacy` is false
  only for the string `false` (trimmed, any case); `map.editor.vector` is
  true only for the string `true` (trimmed, any case).
- `event.mapPipeline` (§2) carries the third flag as `editorVector` beside
  `pipeline` and `allowLegacy`; the client needs no other read.
- All three are read together through a per-process memo of **30 s**
  (`getMapPipelineFlags()`), so a flip reaches every instance within half
  a minute without a restart. `MAP_PIPELINE_FLAGS_TTL_MS` overrides the
  lifetime (a non-negative number; `0` reads on every call — the E2E
  stack uses it, §5).
- There is no UI for the flags in slice B. They are flipped with SQL on
  the instance's database, e.g.
  `INSERT INTO oxygen.settings (key, value) VALUES ('map.pipeline.default', 'vector') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`
  `map.pipeline.default` flips to `vector` in slice E, after the B-gate;
  `allowLegacy` becomes `false` only after every event has been migrated
  (09 §4 E).

## 2. Per-event switch

`events.map_pipeline` — Postgres ENUM `oxygen.map_pipeline`
(`legacy`, `vector`), `NOT NULL DEFAULT 'legacy'`; migration
`20261022120000_event_map_pipeline`, Prisma `Event.mapPipeline`.

- **Additive.** Existing events read `legacy`; an older image ignores the
  column (09 §2 principle 4). A row written without the field (seed
  builder, raw SQL) is `legacy`.
- **Creation.** Every path that creates an event sets the column from
  `map.pipeline.default` (`newEventMapPipeline()`): `event.create`,
  `eventor.importEvent`, the test lab's `createEvent`. A venue-box
  snapshot import (`importEventSnapshot`) copies the cloud row's value,
  and the lease's settings refresh copies later flips
  (`docs/map-storage.md` §7, "Coexistence"): the column is cloud-owned.
- **Read:** `event.mapPipeline` (kiosk or `event.view`) →
  `{ pipeline, allowLegacy, editorVector }`. Kiosk-readable because the kiosk map
  follows the switch.
- **Write:** `event.setMapPipeline({ pipeline })` (`courses.edit`, the
  capability of the event map and its upload). A switch to `vector` is
  always allowed; a switch to `legacy` is refused with
  `PRECONDITION_FAILED` once `allowLegacy` is false. Returns the same
  shape as the read.
- With `allowLegacy` false an event whose column is still `legacy` keeps
  reading `legacy`: the column wins, the flag constrains only the toggle
  and the fallback. (Slice E's one-shot job moves every event with a
  document to `vector` before the flag is withdrawn.)

## 3. What the switch gates

The switch gates **reads only**. It never gates imports or writes: a
`legacy` event still gets a document on upload (slice A,
`docs/map-storage.md` §3), and nothing is deleted or regenerated when an
event is flipped either way. Rollback is a flip of the event (or of the
default), or an image tag; tiles still exist or regenerate on demand.

### 3.1 The viewer

Every map of the event reaches `MapViewer` through `MapPanel`
(`docs/map-rendering.md` §5.4 "Call sites"), which reads
`event.mapPipeline` once there is a pinned document and passes the
pipeline to draw:

```
draw = event == "vector" ∧ documentHash ≠ null ∧ (webgl2 ∨ ¬allowLegacy) ? "vector" : "legacy"
```

(`resolveMapPipeline`, `packages/web/src/lib/map-pipeline.ts`.)

- `documentHash` is `course.mapMetadata.documentHash`; a map without a
  pinned document (before the backfill) stays on tiles.
- An unanswered or failed `event.mapPipeline` is `legacy`.
- `MapPanel` holds the viewer in its loading state until the answer is
  in, so a `vector` event never mounts the tile layer first: **under
  `vector` the viewer requests no `/api/map-tile*` and polls no
  `/api/map-tile-progress`.**
- The viewer remounts when the drawn pipeline changes (part of its
  `key`), so the two viewport models never hand over a live view.
- The viewer exposes the result as `data-map-pipeline` on `map-viewer`.

There is no per-browser override: B4's `localStorage["oxygen-map-pipeline"]`
is gone. Development of the GL path itself uses `/dev/map-gl-doc`.

### 3.2 Tile pre-cache

A `vector` event's tiles are rendered on demand only
(`packages/api/src/map-tiles.ts`):

- `maybePreCache` (the background loop a tile request kicks off) returns
  without rendering for a `vector` event, and unmarks the render key so a
  later switch back to `legacy` resumes on the next tile request.
- `/api/map-tile-progress` answers `{ total: 0, done: 0, rendering: false }`
  for a `vector` event and renders no chunk — the poll is the pre-cache's
  engine, and a stale legacy tab must not keep it spinning.
- `/api/map-tile/:nameId/:z/:x/:y` still serves a `vector` event's tiles
  when asked (a fallback browser, §3.3; a tab opened before the flip).

### 3.3 Fallback without WebGL2

While `allowLegacy` is true, a browser that cannot draw the vector layer
draws tiles for a `vector` event, and the map panel says so in one line
under the map (`data-testid="map-engine-fallback"`: "This browser cannot
draw the new map engine; showing the classic map."). The event stays
`vector`. Two triggers:

- **No WebGL2**: `hasWebGL2()` probes a throwaway canvas once per page,
  before anything mounts.
- **Lost context**: `VectorMapLayer` reports `webglcontextlost` (and a
  renderer that fails to construct) through `onUnavailable`; the panel
  remembers it for its lifetime and remounts the viewer on tiles.

With `allowLegacy` false there is no fallback: the layer shows its
"cannot draw the map" message (`data-status="webgl"`).

### 3.4 Print path

`GET /api/maps/:nameId/maps.pdf` (C3) and the layout-editor preview
`GET /api/maps/:nameId/window.png` (C6) read the switch on the server,
through `getBaseMapInfo` (`course-print.md` §10.1):

```
print = event == "vector" ∧ latest map_files row pins a document ? "vector" : "legacy"
```

- `vector`: `maps.pdf` composes the pages from the pinned document
  (`course-print.md` §8.2, CMYK, no `rsvg-convert`); `window.png` draws
  the document window with the reference raster (`course-print.md`
  §10.2).
- `legacy`, or `vector` without a pin: the OCAD → SVG path, `rsvg-convert`
  for the PDF — unchanged.
- A pinned document whose colour stack is not aligned
  (`course.CourseStackError`) prints through the legacy path with a
  logged warning (`course-print.md` §8.1).
- `maps.pdf` names the path in `X-Print-Pipeline: vector | legacy |
  legacy-fallback`.
- Both paths read the same template, course-map, course, control and
  graphics rows and write nothing: rollback is flipping the event back.
  There is no WebGL2 condition — the server draws — and `allowLegacy`
  does not enter: a `vector` event without a pin has no document to
  print from.
- `rsvg-convert` and `fonts-liberation` stay in the image until slice E
  removes the legacy path (09 §9 step 5).

### 3.5 Not gated yet

09 §3 lists two more reads. Neither has a second path to switch to yet,
so the rule is recorded and nothing is routed:

- **Editor**: the course editor (`CourseEditorPage` over `MapPanel` with
  `editor`) mounts for both values until slice D adds the new editor;
  under `vector` it edits over the vector base layer.
- **Replay** (`ReplayViewer` / `ReplayMapLayer`): mounted nowhere, so
  there is nothing to route (B11 closed as moot, user decision
  2026-10-22; `docs/map-rendering.md` §8). `TracksPage`'s GPS routes go
  through `MapPanel` and follow the switch like every other map. A future
  replay feature reads the same rule.

## 4. The toggle

**Use new map engine** sits in the course editor's map-info row
(`MapPanel` with `showMapInfo`, next to *Open review* and the colour
profile; `MapEngineToggle.tsx`, `data-testid="map-engine-toggle"`) — the
event's map controls live there; the Event page has no map panel (user
decision 2026-10-22).

- Shown when the event map has a pinned document, the user has
  `courses.edit`, and the switch can move: hidden for a `vector` event
  once `allowLegacy` is false.
- A checkbox (checked = `vector`) with the one-line explanation "Draws
  every map of this event from the map document instead of image
  tiles."
- While `allowLegacy`: the line "Something wrong with the map? Tell your
  instance maintainer." (`data-testid="map-engine-report"`). There is no
  in-app report channel (user decision 2026-10-22).
- The change is optimistic: the query cache takes the new value at once
  (every map panel of the event follows), the server's answer replaces
  it, a refusal puts the old value back and shows "Could not switch the
  map engine." with the server's message (`data-testid="map-engine-error"`).
- i18n: `dashboard.mapEngineToggle`, `mapEngineHelp`, `mapEngineReport`,
  `mapEngineFallback`, `mapEngineSwitchFailed` (en, sv).

## 5. E2E under both values

While both pipelines exist, an explicit list of specs runs once per
value (09 §3, §10). `playwright.config.ts`:

- `MAP_PIPELINE_SPECS` — `webserial.spec.ts` (post-readout map),
  `mobile-layout.spec.ts` (both named by the 09 §4 B gate),
  `map-viewer-gestures.spec.ts`, `map-control-circles.spec.ts` and
  `map-multicourse.spec.ts` (the course overlay, C4), `course-maps.spec.ts`
  (the print path and the layout editor's `window.png`, C3; it uploads
  the map through `course.uploadMap` so both projects have a pinned
  document).
- Projects `map-legacy` and `map-vector` match exactly those files with
  `use: { mapPipeline }`; `chromium` ignores them and runs everything
  else once.
- Those specs import `test` / `expect` from `e2e/helpers/map-pipeline.ts`.
  Its auto fixture writes the project's value to every event's
  `map_pipeline` and to `map.pipeline.default` before each test (after
  the spec's `beforeAll(reseed)`), and resets both to `legacy` after it.
- The E2E API runs with `MAP_PIPELINE_FLAGS_TTL_MS=0`, so an event a test
  creates through the UI gets the project's value and a flag a spec
  writes applies at once.
- A spec that is about one value sets it itself with
  `setMapPipeline(value, nameId?)` / `setAllowLegacy(...)` from the same
  helper (`map-vector-layer.spec.ts`, `map-pipeline-switch.spec.ts`).
  `reseed()` deletes the `map.pipeline.*` settings.
- A dual-run spec that asserts on tiles branches on the `mapPipeline`
  fixture (`mobile-layout.spec.ts` "switching events resets viewport and
  tile state": tiles of the current event under `legacy`, the vector
  layer's first view and no tile image under `vector`). One that reads
  the course overlay's control numbers takes them from
  `e2e/helpers/course-labels.ts`: SVG text under `legacy`, the GL course
  layer's `course-label` mirror under `vector` (`map-rendering.md` §5.4
  "Overlay").

## 6. Tests

| Test | Covers |
|------|--------|
| `packages/api/src/__tests__/map-pipeline.test.ts` | setting keys; default and `allowLegacy` parsing; both read through one reader; `canSwitchTo`; TTL override |
| `packages/api/src/__tests__/integration/map-pipeline.test.ts` | a row written without the field is `legacy`; new events take the default, existing ones keep theirs; `setMapPipeline` both ways; `PRECONDITION_FAILED` for `legacy` without `allowLegacy`, `vector` still allowed; Zod rejects other values |
| `packages/api/src/__tests__/integration/lease.test.ts` "refreshes cloud-owned settings…" | a flip on the cloud reaches the leased venue copy (the column is not in `EXCLUDED_FIELDS`) |
| `packages/api/src/__tests__/integration/map-tiles.test.ts` "skips the pre-cache for a vector event" | the poll answers `{0,0,false}` and renders nothing; a requested tile is served; no background crawl to other zooms |
| `packages/web/src/lib/__tests__/map-pipeline.test.ts` | `resolveMapPipeline`: vector needs a document, unknown = legacy, WebGL2 fallback only while `allowLegacy` |
| `packages/api/src/__tests__/integration/course-maps.test.ts` "window.png under a pinned document" | the editor preview reads the document only for `vector` + pin; unpinned stays legacy |
| `packages/api/src/__tests__/integration/course-maps.test.ts` "maps.pdf route switch" | `vector` + pin prints through the composer (`X-Print-Pipeline: vector`, no rsvg); `legacy`, unpinned and flipped-back events through rsvg; `CourseStackError` falls back |
| `e2e/course-maps.spec.ts` | under `map-legacy` and `map-vector`: the maps page's PDF downloads (page count, A4 size) and `X-Print-Pipeline` equal to the project's value |
| `e2e/map-pipeline-switch.spec.ts` | toggle text and report line; on → vector layer, another page of the event draws vector with no tile request; off → tiles; without `allowLegacy` no toggle on a vector event and no report line on a legacy one; no WebGL2 → tiles + notice while allowed, the layer's message when not; a lost context → tiles + notice |
| `e2e/map-vector-layer.spec.ts` | the vector layer in the viewer, the event switched through the column; a legacy event stays on tiles |
| `e2e/map-control-circles.spec.ts`, `map-multicourse.spec.ts` | under `map-legacy` and `map-vector`: the selected course's code labels, sequence numbers for one course, codes for several, class pills and the sheet; `data-map-pipeline` and `data-course-layer` |
| `e2e/webserial.spec.ts`, `mobile-layout.spec.ts`, `map-viewer-gestures.spec.ts` | the same flows under `map-legacy` and `map-vector`; each asserts `data-map-pipeline` equals the project's value; `webserial` "post-readout map" uploads the map, reads a card and checks the readout map (vector layer ready and no tile image under `vector`, tiles under `legacy`) |

## 7. Pending in this chapter

- **Editor** gate (§3.5): slice D.
- **Admin UI for the instance flags**: none until slice E needs one.
- **Dual-run list** grows with the slices that touch maps: candidates
  `wide-screen-map-pane`, `kiosk-readout`, `course-editor` (D).
  `scripts/e2e-sharded.mjs` weights do not yet count the second run of a
  dual spec.
- **Lost context recovery**: the panel falls back (or shows the message)
  and does not try the vector layer again until it remounts.
