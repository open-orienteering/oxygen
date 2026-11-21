# Bugfix: a second, thinner circle on the armed tool's ghost

**Reported:** 2026-11-07 (feedback after slice P, item 1; row P4, which
corrects P1).
**Area:** course editor, armed placing tools (`S`, `K`, `M`):
`packages/web/src/pages/editor/tools/bindings.ts`,
`packages/web/src/lib/course-layer-request.ts`,
`packages/web/src/pages/editor/EditorPage.tsx`; the reducer
(`lib/course-editor.ts`, `lib/editor/state.ts`) and the viewer prop for
the revert.

## What happened

With `K` armed over a course, a thin violet circle exactly the size of
the purple control circle sat on top of it, following the pointer. The
user reported it on 2026-11-04 (item 3: placing a control "still draws a
thin blue circle besides the purple one"). D12 hid the selection ring
while a tool is armed; P1 (PR #124) read it as `V`'s dashed blue selection ring
(`editor-selection-ring`, `#2563eb`) and hid that ring on a control just
placed from the phantom's *Add control* (a `placed` flag in the reducer,
`selectionPlaced` on the viewer prop). The thin circle stayed, and the
dashed ring the user wanted after placing (it carries the action bar's
contextual actions) was gone.

The thin circle was the UI layer's ghost circle: `placeBinding` pushes a
`circle` shape (`editor-ghost`, violet-600 `#7c3aed` at 1.5 px, radius =
the layer's control radius). Since D5a the GL layer draws the armed
tool's **provisional visit** itself: `courseLayerRequest` adds a site at
the cursor and splices it into the highlighted course, so the layer
draws the real purple circle there, with its legs and number. Two
concentric circles of the same radius showed, the UI layer's thinner one
on top.

## The fix

- `provisionalDrawn(v)` in `lib/course-layer-request.ts` is the layer's
  own predicate — a visit and not a reuse (a reuse splices an existing
  site and adds none). `courseLayerRequest` uses it for the site push.
- `PlaceOptions.provisionalDrawn` tells `placeBinding` that the layer
  draws the circle; it then draws only the label, the description and
  the leg-length label. `EditorPage` passes
  `provisionalDrawn(provisional)` gated on Course / Class view with a
  selected course (the layer draws the visit only under the highlighted
  course).
- The circle stays where the layer draws none: no course selected, the
  All-controls view, and hovering an existing control of the tool's kind
  (the ghost sits on it and reads *Add ‹code›*).
- P1's `placed` flag and `selectionPlaced` prop are removed;
  `showSelectionRing` is D12's `!tool.exclusive` again. *Add control* in
  `V` selects the new control with its dashed ring and the action bar;
  with a tool armed there is still no ring.

## Tests

- `pages/editor/__tests__/bindings.test.ts`: with `provisionalDrawn` no
  circle shape, the label, description and leg length present; without
  it the `editor-ghost` circle at the radius, a finish's two circles.
- `lib/__tests__/course-layer-request.test.ts`: `provisionalDrawn` for
  none / a visit / a reuse, and the `provisional` site is pushed exactly
  when it is true.
- `lib/editor/__tests__/state.test.ts`: no `placed` key after a
  `placed` action, the ring in `V`, `select` of the selected control is a
  no-op.
- `e2e/course-editor.spec.ts` "P4: …": no `editor-ghost` with a course
  (hover and after a click), the circle without a course and on a reuse
  hover, *Add control* in `V` gives one `editor-selection-ring` and the
  action bar. The "the ghost is there" anchors in the "tools" describe,
  P1's describe and `editor-fullscreen.spec.ts` move to
  `editor-ghost-label`.

## Lesson

P1 searched for the colour it was told ("blue") and found the one blue
circle. A report about a circle should be reproduced on screen and the
shape identified by its test id and radius before anything is removed;
the decision log now records the supersession.
