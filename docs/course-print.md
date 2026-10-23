# Course print

How a course map is printed from the vector pipeline: the PDF
operators, the colour stack on paper and the layout-editor preview.
Normative for slice C of the vector map pipeline (research:
`docs/research/vector-map-pipeline/` 05, 09 §4 C).

> Chapter skeleton created by C6. §1–3 (print operators, colour model,
> page composition) are written by C1 and C2; §4–9 are reserved for them.
> This file holds §10 only until those land.

## 10. Layout-editor preview (interim)

`GET /api/maps/:nameId/window.png` feeds `MapLayoutEditor` its map
sandwich (`docs/map-color-stack.md`: full → lower purple → ink →
whiteouts → upper purple). The URL, the query parameters, the 4096 px and
600 dpi caps, the cache headers and the 503 on a full render queue are
unchanged (`docs/course-maps.md` API).

### 10.1 Which path draws it

| Event | Path |
|---|---|
| `map_pipeline = vector` and the latest `map_files` row pins a document | the reference raster, §10.2 |
| `legacy`, or `vector` without a pin | the OCAD → SVG → resvg path, as before this slice |

`getBaseMapInfo(db, eventId)` makes the call and returns
`{ scale, meridianTiltDeg, version, document }`. With a pin, `document`
is `{ hash }`, `version` is the document hash, `scale` is the header's
`mapScale` and `meridianTiltDeg` is the report's
`north.meridian.medianTiltDeg` (0 when there is none) — the values the
A11 dual write puts into the `map_files` columns, so both branches agree
on the same map (integration-tested). On the legacy path `document` is
`null`. C2 and C3 read this one function.

### 10.2 The render

1. Window: `mapWindowForFrame(frame, {cx, cy}, scale, printScale, rot)`,
   unchanged. The axis-aligned `windowBoundingBox` of it is the raster's
   paper area (paper mm = document µm / 1000, y up; the legacy OCAD
   unit/100 is the same space).
2. Objects: those whose path extent comes within 20 mm of the bbox (the
   legacy crop's padding). The document is decoded once per hash
   (`prepareDocument`, the last two hashes kept in-process).
3. `documentRenderInput` → `symbolise` → (layer filter) →
   `rasterisePassStream` with explicit `bounds`, so the resvg off-frame
   guard of `map-rendering.md` §5.1 applies, at
   `pxPerMm = widthPx / window.width`.
4. Rotation is applied to the raster: the bbox image is rotated about its
   centre by `rot` (positive = clockwise on the page, as the legacy SVG's
   `rotate(rot, cx, cy)`) and cropped to the centre `widthPx × heightPx`.
5. The permit comes from `renderGate()` as for tiles and the legacy
   window; a full queue is a 503 with `Retry-After`.

Output is exactly `round(wMm/25.4·dpi) × round(hMm/25.4·dpi)` for both
layers, rotated or not.

### 10.3 Layers

- `layer=full`: the whole stack on opaque white.
- `layer=ink`: the passes whose colour index is **above** the stack index
  of palette id `purple-lower`, on transparent. The split is a colour
  index filter on the colour-sorted pass stream (05 §3); everything at
  or below that index is the "lower" part, which the editor draws itself
  (`course-overlay-lower`) and which is never served.
- A stack without a `purple-lower` row (only imports older than colour
  alignment lack it): the first entry with `purpleRole: "lower"` is the
  boundary; with none, the ink layer is a full-size transparent PNG and
  the server logs one warning per document hash (re-import fixes it).
  Decided in C6, 2026-10-23.

Which colours are ink is therefore the document's own stack order, not
the legacy regex classification (`map-color-stack.ts`): on an aligned ISOM
map black, blue and brown line / point colours are ink, as before; where
a map's source order differs from the IOF rewrite the split follows the
document.

### 10.4 Sanctioned differences from the legacy window

Decision 2026-10-23 (Slice C split): library-drawn symbols for matched
symbols; the shared naive CMYK → RGB conversion (`stackColour`) instead
of the legacy RGB; `colorOverrides` and `northLinesBelow` are not applied
on the vector path (the column values stay, unused); the document's stack
order decides the ink split (§10.3). Geometry — window, scale, rotation,
size — agrees; the integration tests compare against the legacy window
of the same map for that.

### 10.5 Cache

In-process PNG cache key `[eventId, version, cx, cy, wMm, hMm,
printScale, dpi, rot, layer]` with `version` = document hash, so a
re-pin or re-import is a new entry and a rotated window is its own.
ETag / 304 / `X-Cache` as before.

### 10.6 Interim

The preview exists because the editor composes raster layers
(05 §5.12). Slice D replaces the editor's sandwich with the vector layer
and retires `layer=ink`; the legacy branch stays until the legacy
pipeline is removed. The document branch is the second production job of
the reference raster (`map-rendering.md` §5.1).

### Tests

| Test | Covers |
|---|---|
| `packages/api/src/render/__tests__/window-raster.test.ts` | boundary choice and fallbacks; pass filter; object selection; full / ink probes; ink at a moved boundary; stack without lower purple; 90° rotation direction |
| `packages/api/src/__tests__/integration/course-maps.test.ts` "window.png under a pinned document" | `getBaseMapInfo` branch equality and the unpinned fallback; full size / colour / cache; ink transparency and empty window; rotated entry; agreement with the legacy window of the same map |

## Pending in this chapter

- §1–9: C1, C2, C3 (§11: C7). §10 is retired by slice D (§10.6).
- E2E: `e2e/course-maps.spec.ts` does not yet run under `vector`, so no
  Playwright project requests `window.png` from a pinned event; C3's
  dual-run of that spec (`map-pipeline-switch.md` §7) covers it.
