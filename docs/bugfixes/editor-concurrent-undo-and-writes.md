# Undo and quick edits reverted another editor's work; queued writes reached another event

Review package 24 (2026-11 full review: CRS-016, CRS-018, CRS-049, CRS-050, CRS-053, CRS-065, MAP-8, MC-17 / CRS-015). Spec: [course-editor.md](../course-editor.md) §3 "Tokens", "Structure edits", "Own chain", "Undo after another editor's change", "A notice stays until it is answered", "One event per editor"; [course-layout.md](../course-layout.md) §2.

## What happened

Two setters, one course, the course editor polling every 5 s:

- **Undo reverted the other setter** (CRS-016). Each undo entry held the whole course as it was before my edit, and undo wrote it back on the newest token the tab had seen — the other setter's. A placed control 45 undone after Anna's reorder and bend took her reorder and bend with it, with no notice. The same for sheets in Layout mode and course objects.
- **A second structure edit in flight reverted the first** (CRS-018). An edit was built from the course structure when the click happened. A second click inside the first's round trip (slow arena Wi-Fi) was built from the structure before the first, and sent behind it on the first's token: the server took it.
- **Structure sent on the list's newer token** (CRS-049). The structure came from `course.detail`, the token from the book, which `course.list` may already have raised to someone else's write; the edit then overwrote it.
- **Undo / redo not serialised** (CRS-050). A held Ctrl+Z ran two entries at once; a short one settled first and the redo order came out scrambled.
- **Layout writes not serialised** (CRS-053). A scale field committed by a canvas click and a block drag inside one round trip sent the same token; the second got a false "changed elsewhere" and was lost.
- **Any successful write cleared a conflict notice** (CRS-065), taking its Keep mine / Keep theirs with it.
- **Map-mode patch writes not serialised** (MAP-8): an older reply could replace a newer patch on screen.
- **Queued writes went to whichever event the URL named** (MC-17, CRS-015): the editor's client took the competition header from `window.location` at send time, so a Field-mode outbox draining after the setter switched to the sister event marked the sister event's controls.

## How it was fixed

- `EditorWrites` keeps an **own chain** per row: every write links the token it was sent on to the token it produced (`noteOwn`, `chainEnd`, `stillMine`). Each gesture's rows and tokens are collected (`collect`) and stored on its undo entry.
- **D6** (user 2026-11-24): `EditorWrites.guarded` runs an undo or redo only while each row is at the entry's token or one this client reached from it; a write is sent on that token and a refusal is `UndoSkipped`, never a rebase. Controls: the server decides, and a move undo still goes through when the other side changed only other fields (their description kept). A skipped undo drops every entry of that row and shows "Lång was changed by Anna at 14:02; undo skipped".
- `UndoStack` runs undo / redo on one queue; the entry is picked when its turn comes.
- A write gate (`WriteGate`): ordinary writes side by side, an undo / redo step alone, so the guard sees only the step's writes and a structure edit is never built on a structure an undo is replacing.
- Own writes through other procedures are linked too (`adoptOwn`): a kind change's re-mirrored courses, `applyToCourses`'s and the setter procedures' sheets. Control undos are decided field by field, so an own radio toggle or restore never blocks them.
- A positional structure edit (a row's index, a leg's path) queued behind another is refused with "do it again" when the structure changed; an edit of a course no longer selected is dropped.
- Layout keeps the newest gesture's optimistic snapshot until its own reply.
- Structure edits run on one queue in the page (`queueStructure`) and are sent on the token of the structure they were built from (`setStructure(…, { since })`).
- Layout mode's book is the editor's; sheet and template writes go through `EditorWrites.writeRow` (one per row in flight).
- `run` clears a notice only when the write was about the notice's row (`clearsNotice`).
- Patch writes go through `serialRow("patch", 0, …)`; `setMapPatch` drops a lower version of the same document's patch.
- The editor's writes use `trpcClientForEvent(nameId)`; `CourseEditorRoute` keys the page on the event; the outbox drain takes `active` and stops before the next entry once the editor left the event or closed (the rest stay pending).

## Tests

- `packages/web/src/lib/editor/__tests__/write-client.test.ts`: the chain, own → foreign → own, `since` against a newer list token, `collect`, the D6 pre-check, refusal, own-chain undo of A and B, the control description rule, objects never rebased, Layout `writeRow` order and refusal, patch writes in order.
- `packages/web/src/lib/__tests__/undo-stack.test.ts`: overlapping undos in press order, a refused entry not blocking, `allow`, rows renewed by the step runner.
- `packages/web/src/lib/__tests__/map-document-cache.test.ts`: an older delivery dropped, a new document / no patch accepted, a late read keeping the newer copy.
- `packages/web/src/lib/__tests__/control-outbox.test.ts`: a drain stops when `active` turns false; the rest stay pending.
- `packages/web/src/lib/editor/__tests__/undo-guard.test.ts`: which notice a write clears; which entries a skipped undo drops.
- `packages/web/src/lib/editor/__tests__/write-gate.test.ts`: the gate's order, the structure queue composing two edits, `queuedEditAction`.
- E2E `e2e/course-presence.spec.ts`: an undo after another editor's reorder is skipped and keeps their order.

## Left out

See course-editor.md "Pending in this chapter", "D6 edges": token-less writes guarded by the client's pre-check only (tokens on `setControlLabelOffset`, `control.delete` / `restore` / `check` are the follow-up), rows collected by time when two gestures overlap, a multi-row entry the server refuses half way, no D6 for Map-mode patch ops and Field-mode queued entries, reads still on the page's event (MC-04). CRS-052 (Class view's variant) and CRS-056 (Field mode write-ahead) are not in this package.
