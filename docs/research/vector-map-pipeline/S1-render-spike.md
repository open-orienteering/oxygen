# S1 — Render spike report

**Question (09 §7):** do the 04 budgets hold for Sprint, Crop-B and
Club-full with the pilot symbol family through the real shared stage and
a WebGL2 backend — and if not, must 04's backend choice change before
slice B is committed?

**Answer:** the backend choice stands. Event maps meet every budget that
the spike could measure; club maps fail the whole-document first frame and
GPU-memory budgets by the margin 04 predicted, and the failure is in the
*amount of geometry drawn per frame*, which 04's bucket/visible-set layer
addresses — not in the GPU stack. None of 04's fallbacks (deck.gl,
simpler AA) would change the result. Two findings amend 04 (§4 below),
one budget could not be shown on this hardware (frame GPU on a phone) and
is carried as the one residual risk for slice B.

Branch `spike/render-harness`, commits `5d858db` (steps 1–3) and
`c9dcd28` (step 4). Spec drafted by the spike: `docs/map-rendering.md`
§1–4, §5.1–5.2, §6. Measurement scripts and raw JSON:
`.local/research/oxygen-measurements/gl/` (not committed).

## 1. What was built

| Step | Deliverable | Where |
|---|---|---|
| 1 | Harness: pass-stream types, canonical sort, JSON projection, fixture set, SVG serialiser → resvg reference raster, Playwright golden step | `packages/shared/src/render/{pass-stream,stream-json,reference-svg}.ts`, `packages/api/src/render/reference-raster.ts` |
| 2 | Shared stage for the pilot family (13 symbols: 101, 403, 407, 418, 502, 503, 505 OCAD+OMAP, 516, 529, 213, 704, 709, 714): arc length, OCAD/OMAP dash layout, glyphs on lines, borders, halos, fills with holes, pattern grids with the four clip modes, hatch, text shaping from a shared TrueType reader | `packages/shared/src/render/{measure,dash,placement,pattern,geometry,glyph-table,truetype,text,symbolise}.ts` |
| 3 | WebGL2 backend, one draw per pass: stencil even-odd fills, shader-extruded strokes, instanced glyphs and text, stencil pattern clip, procedural hatch, optional 2× supersample; seven golden scenes within 0.5 % of the oracle | `packages/web/src/map-gl/{prepare,renderer}.ts`, `e2e/map-gl-golden.spec.ts` |
| 4 | OCAD document loading (pilot / envelope modes), batching per colour run, GPU timer, whole-document dev page, corpus measurements | `packages/shared/src/render/ocad-objects.ts`, `packages/web/src/map-gl/batch.ts`, `/dev/map-gl-doc` |

Not built (04 Appendix B step 3 listed them; they were deferred to keep
the spike measuring the backend rather than the cache): buckets and the
visible-set index buffers, the arena, workers, MSDF text, LOD uniforms
beyond the hairline floor. The spike draws the **whole document every
frame**, which is the pessimistic case for every per-frame budget and the
honest case for first frame.

## 2. Numbers

Two load modes bracket the truth. **Pilot** draws only the 13 pilot
symbols — 11–18 % of the objects on every corpus map. **Envelope** draws
every unmatched object with a plain proxy symbol per kind, so pass and
vertex counts are an upper bound for a full library (proxy strokes are
140 µm solid, no dashes). A full ISOM library lands between the columns,
nearer the envelope.

Laptop (Alder Lake-P iGPU, GPU timer), 1280×800 @ 1×. "first frame" is
the browser's cold total including the `ocad2geojson` decode; "− read"
subtracts that decode, which the 02 document reader replaces (02 measured
< 10 ms for event maps). Full tables in `docs/map-rendering.md` §5.2.

| Map | Mode | Objects | Passes → draws | GPU MB | first frame | − read | GPU ms avg |
|---|---|---:|---:|---:|---:|---:|---:|
| Sprint | pilot | 1 275 | 2 241 → 325 | 5.0 | 168 | 48 | 3.7 |
| Sprint | envelope | 10 680 | 11 644 → 328 | 19.4 | 349 | 142 | 6.9 |
| Crop-A | pilot | 639 | 844 → 22 | 8.3 | 140 | 54 | 2.0 |
| Crop-A | envelope | 4 983 | 5 188 → 47 | 19.8 | 258 | 107 | 4.9 |
| Crop-B | pilot | 342 | 451 → 14 | 6.0 | 113 | 40 | 1.6 |
| Crop-B | envelope | 3 073 | 3 182 → 75 | 16.5 | 235 | 99 | 3.9 |
| Club-2026 | pilot | 7 980 | 12 097 → 114 | 70 | 837 | 360 | 9.5 |
| Club-2026 | envelope | 45 884 | 50 001 → 235 | 154 | 1 784 | 860 | 10.8 |
| Club-full | pilot | 17 550 | 28 756 → 192 | 157 | 1 915 | 807 | 10.2 |
| Club-full | envelope | 101 727 | 112 933 → 345 | 338 | 4 197 | 2 163 | 21.5 |

Phone proxy — same machine, 412×915 @ 2.625× (2.6 M canvas pixels), CDP
CPU throttle 4×:

| Map | Mode | first frame | − read | GPU ms avg |
|---|---|---:|---:|---:|
| Sprint | pilot / envelope | 555 / 1 235 | 187 / 552 | 4.0 / 7.1 |
| Crop-A | pilot / envelope | 510 / 936 | 235 / 412 | 2.1 / 5.1 |
| Crop-B | pilot / envelope | 386 / 847 | 154 / 363 | 1.8 / 4.4 |
| Club-2026 | pilot / envelope | 3 079 / 6 111 | 1 525 / 3 027 | 6.7 / 12.0 |
| Club-full | pilot / envelope | 6 876 / 14 265 | 3 393 / 7 380 | 10.0 / 20.9 |

Stage split, throttled, Sprint envelope: symbolise 101 ms, prepare
266 ms, batch + upload 164 ms. Club-full envelope: 2 236 / 3 600 / 1 373.
`prepare` (flatten + extrude) dominates everywhere once the decode is
removed.

Frame loop: 60 fps (vsync-bound, frame p95 ≈ 17 ms) in every run, render
CPU 0.4–1.6 ms per frame including the throttled runs. GPU time did not
move between the 1 M- and 2.6 M-pixel canvases, so the draw is
vertex-bound, not fill-bound.

## 3. Verdict per budget

| Budget (04 §9 / 09 §7) | Event maps | Club maps | Verdict |
|---|---|---|---|
| Symbolise whole document ≤ 100 / 800 ms | 8–28 ms; 35–101 throttled | 225–654 ms; 1 105–2 236 throttled | **Pass**; club at 4× throttle needs the worker 04 already prescribes |
| Draw calls ≤ 300 | 14–328 | 114–345 | **Pass** with two exceptions: Sprint (115 distinct glyph meshes in one colour run) and Club-full envelope. Both fall under 300 when glyph meshes of one colour share an atlas buffer — one more merge in `batch.ts` |
| Frame CPU ≤ 4 ms | 0.4–1.0 ms | 0.6–1.6 ms | **Pass** with margin |
| Frame GPU ≤ 8 ms, mid-range phone, 2× DPR | 1.6–3.9 pilot / 3.9–7.8 envelope on the iGPU | 10–23 on the iGPU | **Not shown.** A mid-range phone GPU is 2–4× slower than this iGPU, so the whole-document envelope would land at 8–30 ms. The visible set per bucket (04 §6.8) is what brings vertices down to the view; it was not built, so this budget is unmeasured, not failed |
| First frame ≤ 500 ms event / ≤ 2.5 s Club-full (09 S1, after download) | 40–142 ms laptop, 154–552 throttled (− read) | 0.4–2.2 s laptop, 1.5–7.4 s throttled (− read) | **Pass** for event maps; **fail** for the whole club document at 4× throttle, as 04 §6.11 anticipated: club maps need zoom-gated preparation. Pilot Club-full on the laptop (807 ms) is inside the budget |
| Resident GPU ≤ 30 / 150 MB | 5–20 MB | 70–338 MB | **Pass** / **fail for the whole document**; zoom gating and the stroke-strip change (§4.1) are both required for club maps |
| 60 fps pan/zoom (09 S1) | yes | yes | **Pass** on the laptop; see frame GPU for the phone caveat |
| Golden diff ≤ 0.5 % beyond AA tolerance | 7 scenes, all ≤ 0.5 % | — | **Pass** |

## 4. Amendments to 04 (carried into slice B's spec)

1. **Strokes as indexed strips.** 95 % of the resident bytes are extruded
   strokes stored as a non-indexed triangle list: 16 B per vertex, 48 B
   per triangle, 2.7 M triangles for Club-full pilot. Two vertices per
   polyline point and an index buffer cut this ~3×; zoom-gated flattening
   tolerance (10 µm everywhere today) cuts it again. 04 §6.2 described the
   extrusion but not the layout; the arena must use the strip.
2. **Fills are earcut when batched.** Step 3 used stencil-then-cover per
   pass (exact even-odd, no triangulation); step 4 had to triangulate
   because overlapping fills of one colour XOR under the parity trick. 04
   §10 point 3 already named earcut as the default and stencil as the
   exception; S1 confirms the split and fixes where the exception applies:
   pattern clip and single hatch areas only.
3. **Visible-set indices are required, not an optimisation.** The
   frame-GPU budget on a phone cannot be met by drawing the whole document
   (§3); 04 §6.8 point 2 is on the critical path for slice B.
4. **Depth-buffer fills (04 §6.8 point 3, §11): dropped.** With batched
   earcut fills a colour run is already one draw; the depth trick would
   save draws that no longer exist and complicate the stencil clip.
   Revisit only if a profile shows overdraw on fills, which the
   vertex-bound result makes unlikely.
5. **Cell size and large-object threshold (04 §6.11): untested**, as they
   need the bucket layer. 04's 50 mm / 2 × 2-cell choices stay as the
   starting point; slice B measures them with the same dev page.
6. **Pattern inclusion is a scanline**, not a per-cell test (82 → 1.5 ms
   on Sprint's 213 areas). Same predicates; `docs/map-rendering.md` §4.8
   records it.

## 5. Other 04 §11 open questions

- **Reference raster engine** — decided in step 1: resvg via an SVG
  serialisation of the pass stream. The serialiser has no symbolisation
  in it; it reuses a dependency the API already has; seven golden scenes
  agree with the GL backend within the tolerance.
- **MSDF atlas ranges** — measured on the corpus's text objects
  (`text-chars.mjs`): Sprint 0 text objects; Crop-A/B 3 each, ASCII only;
  Club-2026 247 objects / 2 179 characters; Club-full 693 / 6 250
  characters, longest 309. Non-ASCII seen: `ÄÅÖäåéö` only (Latin-1,
  7–9 % of characters). Fonts named: Arial, Arial Narrow, Segoe UI. **Decision:**
  atlas = Liberation Sans + Narrow, ASCII + Latin-1 Supplement + Latin
  Extended-A (covers Nordic and Baltic club maps at ~400 glyphs per face);
  Cyrillic on demand via a second atlas page, generated only when a
  document's header lists such characters. Glyph size 32 px MSDF, sized
  from a 3 mm digit at 2.625× DPR.
- **PDF writer** (04 Appendix B step 5, 05 §9): nothing S1 did disturbs
  05's one-to-one mapping of pass kinds to operators. Béziers survive in
  the stream (only the backends flatten), dashes are slices, halos are
  own-colour passes, hatch is `(width, spacing, offset, angle)` on an
  area path, text is shaped glyph ids plus positions from the shared
  TrueType reader — each is a direct PDF construct. The envelope mode's
  proxy symbols are a dev-page device and do not enter documents. 05's
  choice of `@cantoo/pdf-lib` low-level operators stands; slice C builds
  the backend against `render.PassStream` as drafted.

## 6. Residual risk and what slice B does first

- **No physical phone was measured.** Chromium's 4× CPU throttle is a
  reasonable CPU proxy; the GPU column is the laptop's. The dev page runs
  on a device today (`pnpm --filter @oxygen/web dev -- --host 0.0.0.0`,
  open `/dev/map-gl-doc?mode=envelope`, pick the `.ocd`, bench). A
  Pixel-class run on Sprint envelope and Club-2026 pilot is the first
  task of slice B, before the bucket layer, so the visible-set work has a
  real baseline.
- **The pilot family is 11–18 % of real objects.** Slice B's library
  authoring (03) will multiply the pilot column by 5–9 towards the
  envelope column; the budgets above were judged against the envelope for
  that reason.
- Build order for B that the numbers support: indexed stroke strips →
  visible-set indices per (colour, kind) → worker for symbolise/prepare →
  zoom-gated buckets → MSDF text. Each step has a number here to beat.
