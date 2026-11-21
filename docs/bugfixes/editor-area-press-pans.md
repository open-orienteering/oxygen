# Bug fix: a press inside a course area grabbed the area instead of panning

Row D12 of the vector map pipeline (user feedback 2026-11-04, items 1 and 3;
plan in `docs/research/vector-map-pipeline/feedback-2026-11-04.md`).

## Symptom

In the new course editor (`/course-editor` on the GL canvas), any press
inside a closed course object — an out-of-bounds area, a white-out, a
filter region and above all the **toner saver**, which surrounds every
control of the course — selected the object and started dragging it. With
a toner saver in place there was hardly any map left to pan by dragging.

A second, smaller complaint from the same session: while placing controls
with `K`, a thin dashed blue circle was drawn around the control just
placed, beside its purple circle.

## Cause

1. **Hit-testing.** `editorHitAt` (`packages/web/src/lib/editor/hit.ts`)
   hit-tests the course layer's symbolised shapes. The shared hit-test
   (`packages/shared/src/render/hit-test.ts`) answers distance 0 over a
   fill or hatch interior, and, with `closedStrokeInterior` (on for the
   control circles), over a closed stroke's interior — so an `oob_area` or a
   `whiteout` hit everywhere inside. The kinds the layer does not draw on
   screen (`toner_saver`, `filter_region`) were `UiArea`s hit with
   `insideRing(...) || ringDistance(...) <= tolerance`, i.e. also over
   their whole interior.
2. **The V binding.** `selectBinding.onPointerDown`
   (`pages/editor/tools/bindings.ts`) selects any `object` target and arms
   a drag; on the selected object a press on its body (the target) arms the
   move. The viewer (`components/MapViewer.tsx`) pans only when the tool and
   its own targets decline, so an area under the pointer meant no pan — by
   mouse and by touch alike.
3. **The blue ring.** Placing a control dispatches `placed`, which selects
   it (the chain's anchor, the inspector, `Ctrl+Z`), and the viewer draws
   `editor-selection-ring` (dashed `#2563eb`, 1.45 × the circle) around the
   selected control regardless of the armed tool. Confirmed by running the
   `K` E2E with the new gate disabled: it fails on the ring; the phantom,
   multi-selection rings and gap targets are not drawn while placing.

## Fix

- **Closed areas are hit only along their outline; their interior is the
  map** (`docs/course-editor.md` §5, §7). The viewer passes every closed
  kind (`vertexRule(kind).closed`: `oob_area`, `whiteout`, `toner_saver`,
  `filter_region`) as a `UiArea` with its sampled outline; `editorHitAt`
  passes over the layer's own passes for those ids (fill, hatch, border)
  and hits a `UiArea` only within the tolerance of its ring (6 CSS px, 12
  on touch). `insideRing` is gone. Lines are still hit by their stroke,
  texts by their glyphs, controls inside an area as if it were not there.
- `selectBinding` needed no logic change: its body press is "the target is
  this object, or an edge within 7 px", and the target no longer reports an
  interior. So a press inside a selected area declines too — a drag there
  pans and keeps the selection, a click there is a map click. The area
  moves by its edge or a vertex; D5b's gestures (vertex, grip, Alt,
  double-click insert, pinch) are unchanged.
- **No selection ring while an exclusive tool is armed** (§6.1): the
  viewer gates the ring on `showSelectionRing(editor)`
  (`lib/editor/state.ts`). The placed control stays selected; the ring
  comes back in `V`.

Trade-off: an area whose whole outline is off-screen cannot be selected
until zoomed out (`F` fits the course).

## Tests

- `packages/web/src/lib/editor/__tests__/hit.test.ts` — inside an
  `oob_area` / a white-out → null; on the edge → the object; a 709.b border
  does not grab the interior; a control and a leg inside a white-out still
  hit (this failed before: the white-out won); a `UiArea`'s interior → null.
- `packages/web/src/pages/editor/__tests__/bindings.test.ts` — for every
  closed kind, an interior press declines (selected or not), an edge press
  drags, a vertex still wins; a line's stroke press is the object's.
- `packages/web/src/lib/editor/__tests__/state.test.ts` — `showSelectionRing`.
- `e2e/course-editor.spec.ts` "tools" — a drag inside an `oob_area` moves
  the view and leaves the area; its outline selects it; a drag inside the
  selected area pans; its edge moves it; a click inside deselects it. The
  `K` ten-clicks test asserts no ring while armed and the ring back in `V`.
  The `oob_area` test re-selects its area by the outline.
- `e2e/field-mode.spec.ts` — a tap on an area's outline selects it, a tap
  inside deselects it.
