# 10 — Height sources and 3D draping

Status: research opened 2026-10-21; **not decided**. Scheduled after slice
D (09 §4) or as its own slice H; the only parts that act now are the
three readiness constraints in §6, placed on B2 and B4 so that the viewer
does not have to be rebuilt for this topic.
Depends on: 02 (document, georeferencing), 04 (render core), 08 (course
layer as document objects). Feeds: the viewer (B4), tracks and replay.

## The question

The map is drawn in paper space on a flat canvas. The user wants to see
the terrain it describes — the map draped over relief, in the same viewer,
with the course and GPS tracks on it. Where does the height come from,
how is it attached to a document, and what does the renderer need so that
this is an addition rather than a second renderer?

## 1. Two height sources, two purposes

| Source | Where it exists | What it is good for | What it is not |
|---|---|---|---|
| **External DEM** | Sweden: Lantmäteriet's open height grid (1–2 m). Norway (hoydedata), Finland (NLS), Denmark (DHM) have open equivalents; Copernicus GLO-30 (30 m) covers everything else | True ground: GPS tracks on the slope, run-time and climb analysis, comparing map against reality | Not the map's own picture: a mapper generalises, smooths and shifts contours for legibility, so draped contours float off ridges and form lines sit on nothing |
| **Contour-derived** | Every map, anywhere, offline: the document already holds 101 contours, 102 index contours, 103 form lines, 104 slope lines and depressions as geometry with their symbol | Self-consistent by construction: every feature sits where the map says it is; works for a map whose area has no open DEM | Nothing between the contour bands; relative heights unless anchored; wrong where the contour graph is ambiguous |

They are not alternatives. The contour-derived surface is the baseline
that works for every document; the DEM is the upgrade where open data
exists, and the more honest one for tracks.

## 2. Contour-derived surface

Two parts of very different difficulty.

### 2.1 Assigning elevations (hard)

OCAD contours carry no height, and O-maps rarely label them. The
interval is known from the scale (5 m; 2.5 m sprint; the map may say
otherwise in its notes). The work:

1. Build the contour adjacency graph: which contour neighbours which,
   from nesting (a closed contour inside another) and proximity along
   the band between them (sample normals, find the nearest contour of a
   different identity on each side).
2. Propagate ±1 interval from a seed along the graph.
3. Decide the sign. Evidence, in order of strength: 104 slope lines
   (tags point downhill), depressions, lakes and water (same height along
   the whole shoreline, lower than their surroundings), index contours
   every fifth (constrains the count across a band), a spot height or a
   text label when present, and the convention that an innermost closed
   contour is a top unless tagged.
4. Resolve the rest heuristically and flag it: contours that end (the
   mapper stopped drawing), merge, or run into a cliff (201/202 replace
   several contours; the cliff's height is the missing contours' sum),
   and form lines, which have no height of their own (half an interval
   above the contour below, by convention — not a rule).

The result is a height per contour vertex plus a confidence per
connected component. Relative heights are enough for looking at terrain;
absolute heights need one anchor per component (a DEM sample, a spot
height, or the user).

### 2.2 Interpolating the surface (easy)

- TIN with the contours as breaklines, plus medial-axis points at the
  intermediate height between two contours of the same height, which
  removes the flat triangles on ridges and in valleys (the classic
  contour-to-TIN fix); or
- a raster by gradient-direction interpolation: for each cell, the two
  nearest contours of different height along the local gradient, linear
  between them.

At a 5 m interval either gives a plausible drape at 2–5 m cells. Neither
recovers detail inside a band; that is what the DEM is for.

## 3. External DEM

Fetched per document extent through 02's georeferencing and `mapGeo`
(`docs/map-import.md` §3.8): the paper bounds project to a grid extent,
the tiles come from the provider, and the heights are resampled onto the
same paper-space grid as §2.2's raster so that the renderer sees one
shape for both sources. Blending (DEM where it exists, contours
elsewhere; or contours corrected towards the DEM at the contour lines
only) is a later refinement.

Provider access, licence and attribution per provider are part of the
decision; Lantmäteriet's grid is open data (CC0) since 2023.

## 4. Where the height lives: a derived artifact of the document

A height field is derived from the document and nothing else (plus,
optionally, a DEM for the same extent), so it is a **stage 10 derive**
artifact keyed by the document hash, like the thumbnail
(`docs/map-storage.md` §4.5): computed once, stored as a small raster or
TIN, invalidated with the document, served immutably by hash. The
contour-derived field needs no external request and can run in the
import worker; the DEM variant is a separate artifact keyed by (document
hash, provider, resolution) because it can appear later or fail.

## 5. Rendering: drape a texture, do not project the vectors

The 2D map is drawn in painter's colour order with stencil tricks (04 §6);
that does not survive a depth test against a terrain mesh. The standard
answer is:

1. Render the 2D map **to a texture** (an FBO at the view's resolution,
   or per bucket) with the existing pipeline, unchanged.
2. Drape the texture on a terrain mesh built from the height field, with
   a perspective camera, lighting from the normal map, optional vertical
   exaggeration.
3. The course layer is document objects (08), so it drapes with the map.
   UI layers (handles, selection) stay screen-space; GPS tracks and replay
   become 3D polylines through `mapGeo` + the height field.

04 §6.11's "overview texture" is the same mechanism, so the drape and the
low-zoom fallback share code. Projecting the vectors themselves onto the
terrain (true 3D strokes) stays open as the alternative; the constraints
below keep it possible but it is not the baseline.

## 6. Readiness constraints placed now (B2, B4)

So that none of the above needs a second renderer:

1. **One view matrix.** The vertex projection is a single `mat4` uniform
   (model → clip), not a centre and a px/µm scale; a perspective camera is
   then a different matrix, nothing else. (B2, with the float32
   document-relative positions decided 2026-10-21.)
2. **Explicit render target.** Every draw takes a framebuffer and a size;
   the canvas is the default, a texture is the other case. (B2.)
3. **One transform.** Paper ↔ projected ↔ WGS 84 goes through `mapGeo`
   only; the viewport (B4) builds on it and introduces no second
   paper-to-geo path.

Each is recorded in `docs/map-rendering.md` §5.2 / B4's section when the
row lands.

## 7. Spike T1 — does the contour graph resolve on the corpus?

Before the topic is decided: run §2.1 over the five corpus maps and the
OOM samples. Measure per map: connected components, share of contours
with an unambiguous sign, number of ends/merges/cliff gaps, and the
height range against the DEM where it exists (Lantmäteriet covers the
whole corpus). Exit: ≥ 90 % of contour length with a determined sign on
club maps, and a drape that a club member recognises. If the graph does
not resolve on real maps, the contour-derived source is demoted to
"with a DEM anchor only" and the topic decides for DEM-first.

## 8. Open questions

- Vertical exaggeration and lighting conventions for O-maps (the map's
  own colours already encode vegetation; relief shading must not fight
  the yellow/green).
- Mobile budgets: a terrain mesh plus the 2D render-to-texture on a
  phone, against 04 §9.
- Offline: the venue box and the PWA cache hold the document; the height
  artifact is the same size class as a thumbnail and can travel with it
  (07 §9.2).
- Whether the course editor ever edits in 3D (no, by 08's model: edit in
  paper space, view in 3D).

## 9. Recommendation

None yet. Write the readiness constraints into B2/B4 now (§6), run T1
when B1/B2 have merged (the contour geometry and the render-to-texture
path exist then), decide the topic after slice D.
