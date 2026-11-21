# SLICES — Slice H — terrain: height sources and 3D draping (research 10)

The full rows of this slice, moved out of [SLICES.md](../SLICES.md) on 2026-11-21. Statuses reported `review` for PRs that merged on 2026-11-20 are corrected; everything else is as it was. New rows for this slice are added here; open rows are also listed in SLICES.md.

Split 2026-11-13 by the H0 planner (Fable) after spike T1 (10 §7), from
10 (all), 04 §6.11 (overview texture), 07 §6.1 / §9.2, `map-rendering.md`
§5.2 (one view matrix, render target) and §8 (perspective remainder),
`map-storage.md` §4.5 (stage 10 derive). The user's answers are below
("Answers (user 2026-11-13)").

**T1's result** (scripts, per-map JSON and images in `.local/t1/`, not
committed — the corpus is real club maps): the contour graph's **sign**
resolves on 85–95 % of contour length by direct evidence and propagation
(crop-a 94.8, crop-b 95.3, club-2026 87.0, club-full 85.4, sprint 81.9,
puit-de-laven 82.1; 94–99 % with flagged heuristics) — a marginal pass of
the ≥ 90 % exit on the full club maps; **levels** do not hold across a
large map (index contours on one level mod 5: 100 % on crop-a, 30 % on
club-full) because cliffs swallow contours and each wrong sign shifts what
lies behind it. The surface is right locally and drifts by multiples of
the interval globally; the user accepted the drape (answer 2). Tagged
cliffs were the largest single evidence source (10 §2.1 does not list
them); in ISOM 2017-2 the slope ticks are `101.b` / `103.b` (10 §2.1
says 104, the earth bank). Cost on the largest map: 18 s, 1.5 GB at
0.1 mm cells. Hence:

- **Contour-derived first** (H1–H8): every document gets a height field
  with no external request; it is what the drape uses.
- **DEM second, as anchor and as the surface for tracks** (T2, H9–H11):
  where an open DEM covers the map, each contour takes its level from the
  DEM and the sign question disappears; the DEM surface itself is a
  second artifact. Nothing in H1–H8 waits for it.

Three tracks: **height** (H1–H4, shared + API), **drape** (H5–H8, web),
**DEM** (T2, H9–H11). Two releases: H1–H8 at the H-gate, the DEM track
after (answer 10).

**Order**

- **Wave 1**: H1 ∥ T2 (T2 is manual: the downloads, answer 3).
- **Wave 2**: H2 (after H1).
- **Wave 3**: H3 (after H2) ∥ H9 (after H2 and T2).
- **Wave 4**: H4 (after H3) ∥ H5 (after H3; new files only).
- **Wave 5**: H6 (after H5, and after G5 has merged) ∥ H10 (after H4, T2).
- **Wave 6**: H7 (after H4, H6).
- **Wave 7**: H8 (after H7) ∥ H11 (after H7, H10).
- H-gate. The long pole is H1 → H2 → H3 → H5 → H6 → H7. If the slice is
  shortened: drop H11, then H10 and H9 (the DEM track), then H8.

Beside slice G (answer 9): H1, H2, H3, H5 and H9 touch only new
directories (`packages/shared/src/terrain/`, `packages/web/src/map-gl/terrain/`,
imported through the `@oxygen/shared/src/*` subpath, so neither
`index.ts` nor `package.json` changes) and may run beside any G wave.
The web rows H6–H8 start after G5 has merged. Rows that may never run
together with G rows: H4 / H10 with G11 / G12 (`map-store/`) and with
G3 / G12 / G24 (`prisma/`); H6 with G4 / G5 (`map-gl/renderer.ts`,
`engine.ts`, `worker.ts`); H7 / H8 / H11 with G4 / G5 (`MapViewer.tsx`).
Within H: H7 / H8 / H11 (`MapViewer.tsx`); H4 / H10 (`map-store/`).

Decided in this split (planner, 2026-11-13, for user review unless an
answer below settles it; a row's planner may reopen any with a reason):

- **A new chapter `docs/map-terrain.md`** holds the contour graph, the
  solve, the height field format, the artifact and the DEM; the drape is
  `map-rendering.md` §5.6 (new); the viewer's 3D mode is §5.4.
- **The method is T1's band form** of 10 §2.1: contours joined into
  chains (a join must continue the line), barriers rasterised, regions as
  bands, one uphill side per chain.
- **Evidence order**: contour ticks, tagged cliffs (tag side from the
  symbol definition), lakes, innermost closed contour = top; then
  two-contour slope propagation, index counting, cycle closure; form-line
  ticks only where those leave a chain open (80–85 % reliable in T1);
  band heuristics last and flagged.
- **Cliffs are multi-step**: a chain whose sides differ by more than one
  level is legal; index contours (mod 5) set the step (H2 — T1 did not
  build this and measured the drift it causes).
- **The height field is a paper-space raster**, int16 in 1/8 interval,
  cell 0.2 mm on paper (H3 confirms against T1's 0.1 mm), with a no-data
  value outside the mapped area and a per-cell confidence bit. Relative
  heights: level 0 is the lowest region; the header carries the interval
  (answer 8) and, when anchored, the absolute offset.
- **It is a stage 10 derive artifact** keyed by document hash and terrain
  version, pure cache, computed in the import worker and on first request
  for older documents (as the thumbnail); not in the checkout snapshot or
  the per-event dump — a box derives its own.
- **A terrain report** travels with it (share of length by evidence,
  undecided, leaky, conflicts, index consistency); below 80 % decided the
  viewer does not offer 3D for that document (answer 7), and the import
  review shows the report.
- **The drape renders the map to a texture with the existing pipeline in
  an orthographic view** (10 §5) and shades a terrain mesh with it. The
  §8 perspective remainder of `map-rendering.md` (cell selection from the
  camera footprint, per-vertex density) is needed only for true 3D
  strokes and stays pending, outside H.
- **3D is a viewer mode** (answer 6): the viewer and the Tracks page, not
  the editor, not the kiosk.
- **The patch (slice G) is not an input**: terrain is derived from the
  pinned document; a correction that adds a contour changes the drape
  only after promote.

### Answers (user 2026-11-13)

All eleven take the planner's recommendation.

1. **Both sources**: contour-derived first (H1–H8), the DEM as anchor and
   as the surface for tracks (T2, H9–H11).
2. **The drape is good enough** to build on (T1's images); the level
   drift is recorded and H2 corrects it.
3. **T2's downloads are approved**: the Copernicus GLO-30 tile N59 E018
   (open, AWS, no account; plus N43 E003 for puit-de-laven) and
   Lantmäteriet's Markhöjdmodell Nedladdning grid 1+ for the club-2026
   extent only — the user signs in to Geotorget themself; the session
   never handles the credential.
4. **H10's providers are decided after T2** (expectation: Lantmäteriet
   first, GLO-30 as the fallback outside Sweden only if T2 shows it
   anchors).
5. **One server-side Geotorget account per instance**, tiles fetched by
   the API and cached; the secret lives where the instance's other
   secrets live (Secret Manager on Cloud Run).
6. **3D is viewer-only**: the viewer and the Tracks page.
7. **3D is offered from 80 %** of contour length decided; the report is
   shown in the import review.
8. **Interval assumed** 5 m (2.5 m for ISSprOM); a per-map override is
   later; H9 measures it.
9. **H starts beside G**: H1 → H2 → H3, H5, H9 and T2 now; H6–H8 after
   G5 has merged.
10. **Two releases**: H1–H8 at the H-gate, the DEM track (H9–H11) after.
11. **Climb from the height field stays out of H**.

**T2's result and answers (user 2026-11-13, every recommendation).** T2
ran against Lantmäteriet's 1 m model (tiles `m657_67`, `m657_68`, the
user's download; they cover all five corpus maps) and GLO-30 (scripts and
images in `.local/t2/`). T1's true sign accuracy is 96.3–96.6 % on the
full club maps and 99–99.5 % on the crops and sprint; ticks, lakes and
cliffs are practically never wrong, closure (80–83 %) and band-upper
(79–81 %) carry the errors. The interval is 5 m (2.5 m sprint) but one
map holds two ladders (club-2026: +2.6 m mod 5 in most of it, +0.1 m in
the west). Drift is block-wise (±1–3 intervals on club-2026, ±6–8 on
club-full); the LM median along a chain is precise on 95–99.9 % of
length and, anchored, puts index contours on one residue 94.5 % of the
time (T1: 62.8 %). GLO-30 reads 3.5–5.7 m high in forest (canopy) and
gets the right level only about 70 % of the time even with its bias
removed. A typical contour lies 1.4–1.8 m sideways from the ground's
iso-line (p90 7–10 m), which justifies two surfaces (H11).

12. **H9 does not snap globally**: a chain's height is the unsnapped DEM
    median (spread half-IQR ≤ 0.3 I, coverage ≥ 90 %); an integer level
    only where the local ladder is clear (phase estimated per
    neighbourhood, never per map; |residual| ≤ 0.3 I), else "DEM,
    unsnapped". Per-chain absolute heights replace the header's single
    offset. Deviates from the row as first written.
13. **GLO-30 is a fallback in a reduced role** outside LM coverage: side
    evidence into H2, a drift bound (±1 interval), one absolute offset per
    component, the coarse ground surface for tracks (flagged as a 30 m
    surface model); never per-chain levels unless its own interval
    concentration R(I) ≥ 0.6. Lantmäteriet is H10's only anchor-grade
    provider; other national 1 m models are later.
14. **The DEM's side enters H2's solve** as the strongest evidence class
    when a DEM exists (where |left − right| ≥ 0.4 m at ±8 m on the 5 m-
    smoothed model and ≥ 65 % of samples agree), so the field is
    re-solved, not patched; a disagreement with a tick, cliff or lake is
    reported, not overridden.
15. **Closure is demoted to a flagged heuristic in H2** (80–83 % true).
16. **Licence**: Lantmäteriet's height data is CC BY 4.0 (© Lantmäteriet),
    not CC0 as 10 §3 says; H10 corrects the spec and stores and shows the
    attribution.
17. **H10 reads the COG's 2 m overview** (22 MB for club-2026 against
    75 MB at 1 m) once it has confirmed the anchor spread holds at 2 m and
    that the download service serves HTTP range requests.

### Done

| Id | Sub-slice | Status |
|----|-----------|--------|
| H0 | **Spike T1 and the split of slice H** (Fable): T1 per 10 §7 on the five corpus maps and the CC0 demo map (scripts and images in `.local/t1/`), the rows below, eleven questions | done 2026-11-13 (answers above) |

### Remaining

| Id | Sub-slice | Spec home | Research | Depends on | Area (files a session may touch) | Status |
|----|-----------|-----------|----------|------------|----------------------------------|--------|
| H1 | **Contour chains and the band graph (shared, pure).** `contourInputs(doc)` — contours, index contours, form lines, ticks, cliffs (tagged or not), water by canonical id; Bézier flattening; `joinChains` (snap, continuation rule, gap bridging in ground metres, end classes frame / merge / cliff / dangling); the mapped-area mask; barrier raster and region labelling; chain ↔ region incidence with leaky chains flagged. Tests: unit on synthetic documents — nested rings, open chains cut by the edge, a gap, three ends meeting at a cliff, a dangling end; determinism; the corpus counts of T1 reproduced by a `.local` script | new `docs/map-terrain.md` §1–2 | 10 §2.1 step 1, §7 (T1) | — | `packages/shared/src/terrain/graph/` (new), tests; docs | done (#177) |
| H2 | **Uphill side and levels (shared, pure).** Evidence gathering (order decided above), staged application, slope propagation, index counting, closure, flagged heuristics; levels by weighted union-find with multi-step chains; **index contours set the step across cliffs and correct a flipped subtree** (the part T1 left out); the `TerrainReport`; confidence per component. Tests: unit per evidence class and rule; a cliff hiding two contours recovered from the index contours; hold-out accuracy and index consistency on the corpus reported by the `.local` script (targets: T1's sign shares or better, index consistency ≥ 90 % on club-2026) Amended after T2 (answers 14, 15): closure is a flagged heuristic, not strict; with a DEM, its side is the strongest evidence class (H9 passes it in); the index-contour target is per ladder area (≥ 90 % on one residue), not per map, since one map can hold two ladders. **The index target moved to H9** (user 2026-11-14, `map-terrain.md` §3.0, 4): H2 reaches 85.5 % on club-2026's main index ladder from the map alone. | `docs/map-terrain.md` §3 | 10 §2.1 steps 2–4, §7 | H1 | `packages/shared/src/terrain/solve/` (new), tests; docs | done (#191) |
| H3 | **The height field: interpolation and format (shared).** Geodesic interpolation inside each band, form lines at half an interval, tops and pits, smoothing; `HeightField` (header, int16 grid, no-data, confidence), `encodeHeightField` / `decodeHeightField`, `sampleHeight(field, paperMm)` (bilinear), normals; `deriveTerrain(doc)` = H1 → H2 → H3 with a cell budget. Tests: unit — a cone and a slope within tolerance, round trip, sampler; time and memory on the corpus recorded in the spec (T1: 18 s / 1.5 GB at 0.1 mm on the largest map — the row sets cell size and budget) | `docs/map-terrain.md` §4–5 | 10 §2.2, §4 | H2 | `packages/shared/src/terrain/field/` (new), `terrain/index.ts`, tests; docs | done (#192) |
| H4 | **The artifact: derived, stored, served.** Stage 10 `derive` computes the height field after the thumbnail (cap by cells; failure logged, never fails the import); a `map_heightfields` row keyed `(document_hash, source, version)` cascading with the document; `GET /api/map-documents/:hash/height.bin` (immutable, the §4.2 predicate, lazy derive on a miss) and the terrain report in the document's descriptor and the import review; GC. Tests: integration — import writes the row, the route serves and authorises, lazy derive, cascade | `map-storage.md` §4.7 (new), §6.1, §8 | 10 §4; 07 §6.1 | H3 | `packages/api/src/map-store/{heightfield.ts,heightfield-routes.ts,jobs.ts,gc.ts}`, `prisma/`, the import review's report line, tests; docs | done (#201) |
| H5 | **Terrain mesh, perspective camera and shading (web, new files).** A regular-grid mesh from a `HeightField` with level of detail by distance, a perspective orbit camera (`terrainCamera` → one `mat4`), a program that textures the mesh and lights it from the normal map with vertical exaggeration; a dev page drawing a synthetic field with a checker texture. Tests: unit — camera matrices, mesh indices, ray ↔ terrain pick; E2E on the dev page (pixel check of a lit cone) | `map-rendering.md` §5.6 (new) | 10 §5 step 2, §8 (lighting) | H3 | `packages/web/src/map-gl/terrain/` (new), a new dev page file, `e2e/map-terrain.spec.ts`; docs | done (#200) |
| H6 | **The map as the drape's texture.** The renderer draws the document (static and dynamic buckets, so the course layer too) into a framebuffer texture over the camera's ground footprint in an orthographic view, re-rendered when the camera settles, capped by the memory budget; the terrain program samples it; one frame = map-to-texture + mesh. Tests: unit — footprint → view; E2E — the fixture draped, the course visible on it; frame time and memory on the bench harness, desktop and the phone profile | `map-rendering.md` §5.6, §8 trimmed | 10 §5 steps 1 and 3, §6; 04 §6.11 | H5; G5 merged (shared `map-gl/` files) | `packages/web/src/map-gl/{renderer.ts,engine.ts,worker.ts}`, `map-gl/terrain/`, e2e; docs | done (#203) |
| H7 | **3D mode in the viewer.** `useHeightField(hash)` (fetched and cached like the document); a 2D / 3D switch in `MapViewer` when the document's report allows it (≥ 80 %, answer 7); tilt and orbit gestures (mouse and touch), exaggeration control, north-up reset; screen-space UI (control labels, GPS dot) projected through the camera; falls back to 2D with the reason. Tests: unit — gesture reducer, projection; E2E — switch to 3D on the fixture and the demo map, screenshot for the showcase | `map-rendering.md` §5.4 "3D mode"; `docs/features.md` | 10 §5 step 3, §8 | H4, H6 | `packages/web/src/components/{MapViewer.tsx,VectorMapLayer.tsx}`, `hooks/useHeightField.ts`, e2e; docs (widened: `components/{Map3d,MapPanel}.tsx`, `pages/KioskPage.tsx`, `lib/map-3d*.ts`, i18n, `scripts/e2e-weights.mjs`) | done (#205) |
| H8 | **GPS tracks and replay on the terrain.** `gpsRoutes`, the GPS position and replay tails become 3D polylines: paper mm through `mapGeo`, height from `sampleHeight`, lifted a constant above the surface, depth-tested against the mesh. Tests: unit — polyline lifting; E2E — a route drawn in 3D on the fixture | `map-rendering.md` §5.4 "3D mode" | 10 §5 step 3 | H7 | `MapViewer.tsx` (route overlay), `map-gl/terrain/lines.ts`, `pages/TracksPage.tsx`, e2e; docs (widened: `map-gl/{renderer,engine}.ts`, `map-gl/terrain/{program,index,camera}.ts`, `components/VectorMapLayer.tsx`, `pages/dev/terrainDoc.ts`, `e2e/helpers/gps-route.ts`) | done (#208) |
| T2 | **Spike: the corpus against a DEM** (`.local/t2/`, nothing committed). Downloads approved (answer 3): the GLO-30 tile N59 E018 (and N43 E003 for puit-de-laven) without an account; Lantmäteriet grid 1+ for the club-2026 extent, fetched after the user has signed in to Geotorget themself — the session never handles the credential. Per contour, the DEM's median height along it against the solved level (true sign accuracy, level offsets, the interval); how far the mapper's contours lie from the DEM's; whether a 30 m model is enough to anchor levels; artifact sizes. Exit: a recommendation for H9–H11 and the provider choice (answer 4) | 10 §7 (the DEM half), §3 | 10 §3, §7 | — | `.local/t2/` | done 2026-11-13 (result and answers 12–17 under "Answers"; `.local/t2/`) |
| H9 | **DEM anchor (shared, pure)** (answers 12–14). `anchorLevels(graph, sampleDem)`: each chain sampled every ≤ 2 m — median and half-IQR; the DEM side (median of left − right at ±8 m on the 5 m-smoothed model; decided at ≥ 0.4 m and ≥ 65 % agreement) handed to H2 as evidence; a chain accepted at half-IQR ≤ 0.3 I and coverage ≥ 90 % takes the unsnapped DEM median as its height; the ladder phase estimated per neighbourhood (T2: a 1.1 km window mis-phases ~12 % of index length at ladder borders — build a better estimator), an integer level only where \|residual\| ≤ 0.3 I, else "DEM, unsnapped"; chains failing the spread test stay with H2, bounded by anchored neighbours; per-chain absolute heights; the report carries the measured interval (R at I and I/2), the ladder phases, the shares decided and snapped. GLO-30 in its reduced role only (answer 13). No band-neighbour step propagation (T2: worse). Tests: unit with a synthetic DEM — shifted, noisy, two ladders; the `.local` corpus script against T2's numbers (index contours ≥ 94 % on one residue per ladder area on club-2026). **Carries H2's index target** (user 2026-11-14, `map-terrain.md` §3.0): ladder area = index phase (index contours' DEM median mod 25 m — club-2026 has four); H2's map-only solve reaches 85.5 % on the main one; H9 passes its side to `solveTerrain` as `external` (§3.2) | `docs/map-terrain.md` §6 | 10 §2.1 (anchor), §3 | H2, T2 | `packages/shared/src/terrain/anchor/` (new), tests; docs | done (#193) |
| H10 | **DEM fetch and its artifact (API).** A provider interface; Lantmäteriet's height STAC (`api.lantmateriet.se/stac-hojd/v1`, collection `dtm-cog`, 10 km COG tiles, Basic auth) as the anchor-grade provider and Copernicus GLO-30 as the fallback in its reduced role (answers 4, 13); reading the COG's 2 m overview by HTTP range after confirming the anchor spread holds at 2 m and range requests are served (answer 17); licence CC BY 4.0 with "© Lantmäteriet" stored and shown, correcting 10 §3 in the spec (answer 16); one server-side Geotorget account per instance, its secret in the instance's secret store (answer 5); the document's extent through `mapGeo`; resampled to the paper grid of H3; a second `map_heightfields` row keyed `(document hash, provider, resolution)`; a background job with failure states; licence and attribution stored and shown; the anchored contour field re-derived when a DEM arrives. Tests: integration against a recorded tile fixture; no network in tests | `docs/map-terrain.md` §7; `map-storage.md` §4.7; `ops/deploy-gcp-cloud-run.md` (the secret) | 10 §3, §4 | H4, T2 | `packages/api/src/map-store/{dem*.ts,instance.ts,heightfield.ts,heightfield-routes.ts,jobs.ts,gc.ts}`, `packages/api/src/{index.ts,routers/course.ts}` (startup, the descriptor call), `packages/shared/src/terrain/{field/,index.ts}` (§4.9, user 2026-11-14), `prisma/`, `scripts/gcp/` (secret wiring), tests; docs | done (#202) |
| H11 | **Choosing the surface.** The viewer's 3D mode offers "the map's terrain" (contour field) and "ground" (DEM) where both exist; tracks default to the DEM. Shows the DEM provider's attribution (`terrain.dem.provider.attribution`, "© Lantmäteriet", CC BY 4.0 — answer 16) whenever a DEM surface or field is drawn (H10 stores and exposes it). Tests: E2E switch | `map-rendering.md` §5.4 | 10 §1, §3 (blending is later) | H7, H10 | `MapViewer.tsx`, `hooks/useHeightField.ts`, e2e; docs | done (#209) |
| H12 | **DEM settings in the app: Settings → Height data.** An admin tab `/settings?tab=terrain` beside *Eventor*: an explanation in en and sv (what the height model is for, the two providers, how to get a Geotorget account and order *Markhöjdmodell Nedladdning*, the attribution); providers on / off; the Geotorget account, write-only and encrypted at rest; the resolution; *Test connection* (the §7.6 live check on a chosen club map, result stored and shown); each club map's DEM state with a retry. Saved values override the `MAP_DEM_*` environment; saving the account queues `failed: auth` maps. Tests: unit — settings over environment, the encryption round trip, nothing secret in a response; integration — save, read back without the password, a queued retry, the live check against the recorded fixture; E2E — the tab, save, clear, the state list | `map-terrain.md` §7.0b; `docs/ops/deploy-gcp-cloud-run.md` "Height data" | — (user 2026-11-15) | H10 | `packages/api/src/map-store/{dem-providers,dem-live-check}.ts`, a DEM settings store and router (new), `packages/api/src/db.ts` (settings), `pages/SettingsPage.tsx` (the tab), a `HeightDataPanel` (new), locales, `e2e/settings-height-data.spec.ts` (new); docs. **Area widened** (H12): `map-store/{dem-registry,dem-jobs,heightfield}.ts` (the registry read at runtime), `secret-box.ts`, `map-store/dem-settings{,-store,-service}.ts`, `map-store/dem-live-check-worker.ts`, `routers/{demSettings,index}.ts`, `index.ts`, `playwright.config.ts` (`MAP_DEM_OFFLINE`), `scripts/gcp/deploy.sh` (comment) | done (#212) |
| H13 | **Maps over the DEM window cap read the next coarser overview** (§7.0c answer 12). When the window at the chosen level is over §7.2's 64 M cells, `fetchDemMosaic` reads one coarser overview (4 m from 2 m, 2 m from 1 m) from the same tiles; still over → `unavailable: over-cap`. The level read is stored with the DEM artifact and shown in the Height data tab's state list; maps that ended `unavailable: over-cap` are queued again once; an `over-cap` ending stores which cap it hit (tiles, window cells, STAC pages) in the job's error and the tab names it. Tests: unit — the step on the synthetic COG (2 m over, 4 m fits; both over; 1 m → 2 m), the error names the cap; integration — an over-cap job re-queued once and completing at 4 m against the recorded fixture, the level in the state list; E2E — the state list's level and the named cap | `map-terrain.md` §7.0c, §7.2, §7.8 | — (user 2026-11-15) | H12 | `packages/api/src/map-store/{dem-cog,dem,dem-jobs,dem-settings-service}.ts`, the DEM artifact's metadata, `components/HeightDataPanel.tsx`, `locales/{en,sv}/heightData.json`, the DEM tests, `e2e/settings-height-data.spec.ts`; docs. **Area widened (H13):** `map-store/{dem-providers,dem-live-check,heightfield}.ts` (the caps named, the check not stepping, the descriptor's ready provider) and the `HeightFieldProvider` comment in `packages/shared/src/terrain/field/types.ts` | done (#214) |
| H-gate | `map-terrain.spec.ts` and `map-viewer-3d.spec.ts` green; the corpus run (09 §8) extended with the terrain report per map, diffed against the previous run; on the club's instance: the club's own map opened in 3D on a laptop and on a phone, recognised by a club member; one event's course and one logged GPS track seen on the terrain; frame time on the S1 phone within 04 §9's budget; release notes. The DEM track (H9–H11) gets its own check and release after (answer 10) | 10 §7; 09 §8 | — | H1–H8 | user + club | manual |

Waiting on later slices, not H: blending DEM and contours (10 §3); true
3D strokes and the perspective remainder of `map-rendering.md` §8; climb
from the height field (08 phase 4, answer 11 — it needs H2's level
correction or the DEM anchor first); knolls, depressions and earth banks
as relief; the interval as a per-map setting; 3D in the editor or on the
kiosk.
