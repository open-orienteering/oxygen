# Bugfix: object drags accelerated away; the `A` menu sat under the inspector

Found by the user on the first hands-on with the new course editor (D5,
2026-11-02), fixed on `vector-map-pipeline` the same day.

## Dragged texts and areas ran away from the cursor

**Symptom.** Dragging a course object (a map text, an out-of-bounds area,
a single vertex) followed the cursor for a moment, then the object moved
faster and faster away from it.

**Cause.** `EditorPage` rebuilds the tool bindings on every render and
hands `selectBinding` the object list *with the current draft geometry
applied* (the draft is what the viewer draws mid-drag). The drag handler
looked the object up in that list and applied the whole pointer-down →
pointer offset to it — so from the second event on, the offset was added
to a geometry that already carried it: the movement compounded on every
event.

**Fix.** The object gesture captures the geometry at pointer-down
(`Gesture.base`) and every drag event derives the draft from that base.
`packages/web/src/pages/editor/__tests__/bindings.test.ts` rebuilds the
binding mid-drag with the draft applied and checks the offset stays the
pointer's.

## The area menu was hidden behind the inspector

**Symptom.** Pressing `A` (or the rail button) showed the menu of area
kinds with its top rows hidden behind the expanded inspector.

**Cause.** The menu was positioned absolutely inside the rail; the
inspector column is a later sibling in the overlay strip and painted
over it.

**Fix.** `ToolRail` renders the menu through a portal into `document.body`,
fixed at the `A` button's screen position with a top z-index. With the
menu reliably visible, the `A` chord was added (`docs/course-editor.md`
§6.4): `A` then `O` / `L` / `W` / `F` / `S` / `R` picks the kind from the
keyboard; the keys are shown in the menu.

## Two E2E hardenings on the same day (test-only)

- `legMidpoint` (`e2e/helpers/editor.ts`) read the leg mirror once right
  after a reorder undo, while the mirror still drew the previous
  sequence; it now waits for the leg it is asked for.
- "Shift-click selects several controls" clicked raw page points; the
  selection's action bar covered the next site about one run in two. The
  test now Shift-clicks the first candidates that `coveredBy` reports
  clear of the chrome, and waits for each multi-ring. A user in the same
  spot pans; the bar following the selection is by design (08 §5.2).
