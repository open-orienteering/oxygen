# Bugfix: course editor undo looked like a no-op for moves

## Symptom

In the course editor, undoing a control move (Ctrl+Z or the ⟲ toolbar
button) appeared to do nothing: the control stayed at the dragged
position on the map. Redo appeared equally dead. Undo of other
operations (append, reorder, delete) worked — but a move is the first
thing anyone tries, so the whole undo system looked broken.

## Cause

The data layer was fine — the undo entry ran `control.update` with the
prior coordinates and the refetch returned them. The bug was in
`MapViewer`'s anti-snap-back bridge (`pendingMoves`): after a drag, the
viewer remembers `{from, to}` and renders the control at `to` for as
long as the `controls` prop still reports `from`, hiding the stale
position during the mutation + refetch round-trip.

That rule can't distinguish "data is stale" from "the move was undone":
an undo puts the data back at exactly `from`, so the bridge stayed
active and kept rendering `to` — indefinitely, because entries were only
garbage-collected on the *next* drag end.

## Fix

Two complementary changes in `MapViewer.tsx`:

1. **Bridges expire on catch-up.** An effect watches the `controls`
   prop and deletes any entry whose control now reports the `to`
   position (or disappeared). After the move's own refetch lands the
   bridge is gone, so a later refetch reporting `from` — the undo —
   renders truthfully.
2. **`editor.moveEpoch`.** The page increments this counter whenever
   undo/redo runs; the viewer clears *all* bridges on change. This
   covers the race where undo fires before the move's refetch has
   landed (the bridge would still be live at that instant).

## Regression test

`e2e/course-editor.spec.ts` (place/move/persist/delete test): after
dragging the new control, click the toolbar undo button and assert the
control's hit target visibly returns to the placement position (±5 px),
then redo and assert it returns to the drop position. Before the fix the
map kept showing the drop position after undo even though the stored
coordinates had reverted.
