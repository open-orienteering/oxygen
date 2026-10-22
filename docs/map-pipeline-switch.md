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

Two keys in `oxygen.settings` (`getSetting` / `setSetting`, `db.ts`):

| Key | Values | Absent / unknown | Meaning |
|-----|--------|------------------|---------|
| `map.pipeline.default` | `legacy` \| `vector` | `legacy` | The pipeline a newly created event gets |
| `map.pipeline.allowLegacy` | `true` \| `false` | `true` | Whether an event may be switched (back) to `legacy`, and whether tiles are a fallback (§3.3) |

- Parsing (`packages/api/src/map-pipeline.ts`): the default is `vector`
  only for the string `vector` (trimmed, any case); `allowLegacy` is false
  only for the string `false` (trimmed, any case).
- Both are read together through a per-process memo of **30 s**
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
  `{ pipeline, allowLegacy }`. Kiosk-readable because the kiosk map
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

### 3.4 Not gated yet

09 §3 lists two more reads. Neither has a second path to switch to in
slice B, so the rule is recorded and nothing is routed:

- **Print path** (`maps.pdf`): stays on the legacy path for both values
  until slice C.
- **Editor**: the course editor (`CourseEditorPage` over `MapPanel` with
  `editor`) mounts for both values until slice D adds the new editor;
  under `vector` it edits over the vector base layer.
- **Replay** (`ReplayMapLayer`, TracksPage): row B11 moves it onto the
  paper view; until it merges, the replay draws tiles whatever the
  switch, and no event is switched to `vector` on a production instance.

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
  it, a refusal puts the old value back.
- i18n: `dashboard.mapEngineToggle`, `mapEngineHelp`, `mapEngineReport`,
  `mapEngineFallback` (en, sv).

## 5. E2E under both values

While both pipelines exist, an explicit list of specs runs once per
value (09 §3, §10). `playwright.config.ts`:

- `MAP_PIPELINE_SPECS` — `webserial.spec.ts` (post-readout map),
  `mobile-layout.spec.ts` (both named by the 09 §4 B gate),
  `map-viewer-gestures.spec.ts`.
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
  layer's first view and no tile image under `vector`).

## 6. Tests

| Test | Covers |
|------|--------|
| `packages/api/src/__tests__/map-pipeline.test.ts` | setting keys; default and `allowLegacy` parsing; both read through one reader; `canSwitchTo`; TTL override |
| `packages/api/src/__tests__/integration/map-pipeline.test.ts` | a row written without the field is `legacy`; new events take the default, existing ones keep theirs; `setMapPipeline` both ways; `PRECONDITION_FAILED` for `legacy` without `allowLegacy`, `vector` still allowed; Zod rejects other values |
| `packages/api/src/__tests__/integration/map-tiles.test.ts` "skips the pre-cache for a vector event" | the poll answers `{0,0,false}` and renders nothing; a requested tile is served; no background crawl to other zooms |
| `packages/web/src/lib/__tests__/map-pipeline.test.ts` | `resolveMapPipeline`: vector needs a document, unknown = legacy, WebGL2 fallback only while `allowLegacy` |
| `e2e/map-pipeline-switch.spec.ts` | toggle text and report line; on → vector layer, another page of the event draws vector with no tile request; off → tiles; without `allowLegacy` no toggle on a vector event and no report line on a legacy one; no WebGL2 → tiles + notice while allowed, the layer's message when not; a lost context → tiles + notice |
| `e2e/map-vector-layer.spec.ts` | the vector layer in the viewer, the event switched through the column; a legacy event stays on tiles |
| `e2e/webserial.spec.ts`, `mobile-layout.spec.ts`, `map-viewer-gestures.spec.ts` | the same flows under `map-legacy` and `map-vector` |

## 7. Pending in this chapter

- **Replay** follows the switch once B11 merges (§3.4); B5's branch
  rebases onto it and wires the replay's base to the same rule.
- **Print path and editor** gates (§3.4): slices C and D.
- **Admin UI for the instance flags**: none until slice E needs one.
- **Dual-run list** grows with the slices that touch maps: candidates
  `wide-screen-map-pane`, `kiosk-readout`, `map-control-circles`,
  `course-editor` (C/D). `scripts/e2e-sharded.mjs` weights do not yet
  count the second run of a dual spec.
- **Lost context recovery**: the panel falls back (or shows the message)
  and does not try the vector layer again until it remounts.
