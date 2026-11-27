# Bugfix: two course writes in flight sent one token, and the stale one was a 500

Found 2026-11-15 on `vector-map-pipeline` at `4d943463`. `course-editor.spec.ts` ›
"F7: variations and loops › Create variation here, … Loop, export, undo" had failed
once in each of the last three full E2E runs. Alone it passed (10/10). File-in-order
it passed (60/60), and it also passed one full run (441/441). The main cause was
in the app, fixed in `packages/web/src/lib/editor/write-client.ts` and
`packages/api/src/course-structure.ts`. A second cause was in the test's leg
click (see the section on it below).

## What happened

The test's last part undoes three steps with Ctrl+Z: the loop, the placement
into B, and the group. Between the presses it waits for the result. After the
first press it polls `course.variantList` through its own API request until the
server shows `["A", "B"]`. Then it presses Ctrl+Z again and waits for B's row to
go. In the failing run (reproduced under CPU load: 20 busy loops beside the
test, 1 failure in 15) the row stayed, and the test timed out after 15 s.

The trace shows the two undo writes:

| | sent (ms) | answered (ms) | `baseVersion` | status |
|---|---|---|---|---|
| undo of Loop | 476046 | 476239 | `…6206855168` | 200 |
| undo of the placement | 476542 | 476910 | `…6206855168` | **500** |

The second write carried the **same token** as the first. The server log
showed the 500:

```
course.setStructure: PrismaClientKnownRequestError: Invalid `db.control.findMany()` invocation
  at publicIdsOf (course-structure.ts) ← assertCourseVersion
  Invalid input value: invalid input syntax for type uuid: "v1"
```

## Why

**Client: a write did not wait for its predecessor.** `EditorWrites` reads the
row's token from the `VersionBook` when it sends, and a write's result seeds the
next token. That only holds if the next write is sent after the result has
been handled. The test's poll asks the server directly, so it saw the first
undo committed before the browser had handled the reply. Under load, the
browser ran Ctrl+Z's keydown first. The second undo read the old token, and
two writes to one course were in flight with one `baseVersion`. The server
correctly refused the second as stale. A user who presses Ctrl+Z twice faster
than a reply comes back gets the same refusal.

**Server: a stale write on a course with a variation group was a 500, not a
`CONFLICT`.** On a token mismatch `assertCourseVersion` builds `differing`
with `structureDiff`. That names a changed variation group by its own id
(`"v1"`, course-layer.md §7: "a group by its id"). It then passed every id to
`publicIdsOf`, a lookup on the uuid column `controls.id`. Postgres refused
`"v1"`, so the client got an internal error instead of the conflict payload.

## The fix

- `EditorWrites.serial` (`write-client.ts`) queues writes per row (`kind:id`).
  A write starts only when every earlier write to the same row has settled.
  Reading the token, sending the write and seeding the result happen inside
  that slot. So back-to-back writes really do send their predecessor's token
  (docs/course-editor.md §3 "Tokens").
  - `setStructure`, `setInstructions` and `setLabelOffset` share the course's
    queue. A label offset takes no token, but it advances the course's.
  - `updateControl` queues per control, and `updateObject` / `deleteObject`
    per object.
  - A refused write does not block the queue: the next write sends the token
    the refusal seeded. Writes to different rows still run side by side.
- `publicIdsOf` (`course-structure.ts`) looks up only ids that are uuids. A
  group's id has no row, so the conflict's `differing` keeps it as it is, as
  §7 specifies.

## A second cause in the same test: the leg click took another leg

After the fix, one load run (1 failure in 15) failed earlier in the test. Under
**Variant ▾ B**, x was numbered 3, not 2. The trace shows **Create variation
here** wrote `[start, a, b, group, finish]`: the group came after b, not
between a and b. The test clicked the plain midpoint of a → b and accepted any
selected leg. Its a and b lay in one row with the finish, so the leg b → finish
ran back over a → b, and the leg drawn on top won the hit-test. The legs spec
had already met this (the F21 flake "Leg 72 → Mål 1", the same control 72). Its
`twoControlCourse` picks a b whose leg a → b has a point clear of the course's
other legs, and `selectLeg` clicks there until the Leg section names `a → b`.

Those helpers (and `legClickPoint`) moved from `course-editor-legs.spec.ts` to
`e2e/helpers/course-editor-spec.ts`. F7 and F15 ("All variations numbers …",
the same Create-variation-here start) now build their course and select their
leg with them.

## Tests

- `packages/web/src/lib/editor/__tests__/write-client.test.ts`: a second write
  (and a label offset) made while the first is in flight is sent only after it,
  with its token. A refused predecessor passes its token on. Different rows do
  not wait for each other. The first two fail on the old code.
- `packages/api/src/__tests__/integration/course-structure.test.ts`: a stale
  `setStructure` on a course with a variation group is a `CONFLICT` with
  `differing: ["v1"]`. On the old code it fails with the uuid error above.
- E2E: the F7 test under the same CPU load, 20× alone, and a full run (see the
  PR).

## Later

Package 24 of the 2026-11 review extended this queue to structure edits
(built only after the previous one settled), undo / redo, Layout's sheet
and template writes and Map mode's patch writes, and added the D6 undo
guard: [editor-concurrent-undo-and-writes.md](editor-concurrent-undo-and-writes.md).
