# E2E flakes in `course-editor-legs.spec.ts`: presence chips moved the map, an apex on another leg

Measured 2026-11-13 on `vector-map-pipeline`: running
`scripts/with-verify-lock.sh pnpm test:e2e e2e/course-editor-legs.spec.ts --repeat-each=5`
(50 runs) failed one or two tests a run, a different one each time. Each failing test
passed when run alone. The failures were the same on `cc155119` (before wave 1) and on
the head, so they were not new. Neither cause is a product bug in what the tests check.
The test side is fixed: `e2e/helpers/editor.ts` `hideOthersPresence`, and F21's apex search.

Failures seen:

| Test | Error |
|---|---|
| F23 "a finger drags the bend lifted 48 px …" | the loupe's bottom 35 px off `finger.y − 48 − 16` |
| F21 "a held bend drag redraws the course live …" | `no line where the handle goes`: 3 purple pixels, expected 0 |
| F21 (other runs) | failed mid-gesture |
| F16 "Add bend here is smooth …" | failed mid-gesture |

## Cause 1: other tests' presence chips wrapped the top bar and moved the map viewer

Every editor page sends the `course.presence` heartbeat every 5 s while a course is
open (D11). The server keeps a row live for 30 s after its last beat, so a test's page
stays "present" for up to 30 s after the test has closed it. The next tests' pages get
those rows back in their heartbeat answers and show them as chips in the top bar
("e2e-admin · F16 corner 60328 · Course").

The top bar is `flex-wrap`. When the chips no longer fit beside the toolbar, they move to
a second row, the bar grows by 36 px, and the map viewer below it moves down 36 px and
gets 36 px shorter. A probe confirmed this at the tablet's 1024 px width: one chip moved
the viewer from y = 157 to y = 193 and its height from 550 to 514. At 1280 px (desktop)
it takes two chips. The F21 failure screenshot shows two, with the viewer at y ≈ 193.

The chips appear and go on the heartbeat, at any moment of a test. The tests compute
page points from the viewer's box (`toPage`: the box, plus the paper view's centre and
zoom), then press, drag or measure. When the row comes or goes in between, two things
can break:

- **A press lands 36 px off.** It misses the handle, grip or leg it aimed at. The
  "drag" then pans the map, and the write the test waits for never comes (F16, F21).
- **A box read after the shift disagrees with a position computed before it.** F23 took
  the finger's page point, dragged, then compared the loupe's box with it. The loupe hangs
  off the finger in the viewer's own coordinates, so it moved with the viewer: it was 35 px
  from where the old box put it.

`viewSettled` does not catch this: it waits for the paper view (centre, zoom, rotation)
to stop changing, and the paper view does not change when the viewer's box moves.

Why only intermittently and only in a run of many tests: the chips are the rows of the
tests that ran in the last 30 s. A test run alone sees none. Whether a row expires during
a gesture, and whether there are enough chips to wrap the bar, depends on how long the
earlier tests took.

**Fix.** `hideOthersPresence(page)` (`e2e/helpers/editor.ts`) routes the page's
`course.presence` calls (alone or in a batch) and returns their answers with
`others: []`, so the page shows no chips and the top bar stays one row. The legs spec
calls it in a file-level `beforeEach`, before the page opens the editor. Nothing in that
spec tests presence. Presence has its own spec (`course-presence.spec.ts`, with two
contexts), which is unchanged.

## Cause 2: F21's apex lay on one of the course's other legs

F21 picks an apex for the held bend drag. It must be at least `2h + 12 mm` off the chord,
clear of the sites and of the held loupe, and over map. Then it asserts there is no purple
on the leg's line at the apex before the drag (`no line where the handle goes`) and after
the undo. The search never checked the course's own other purple. The course is
start → a → b → finish, with a and b picked from what earlier tests left. In the failing
run a → b was nearly vertical, and the apex beside it lay on the leg start → a. That leg
put 3 purple pixels in the probe before anything moved.

**Fix.** The apex's line must be at least 1.5 mm from every other leg of the course
(`legPieces`, minus the leg a → b), and at least 5 mm from every drawn number
(`course-label`). As the last check before a candidate is accepted, the canvas must
show no purple on the line. That also covers purple drawn by anything else.

## Cause 3: F16's leg was too short on screen for its grip to clear the bend's handle

Found during the verification runs, after the fixes above (1 of 100 runs). F16 presses
the grip of a smooth bend. The grip sits a sixth of the chord from the bend, and the test
first checks that it is more than 16 px from the bend's handle (`the grip clear of the
bend's handle`). Otherwise the press may take the handle. `twoControlCourse` accepted any
b that was clear of the course's other legs. In the failing run a → b was 88 px long on
screen, which put the grip 14.6 px from the handle.

**Fix.** `twoControlCourse(page, prefix, { minChordPx })` treats a b whose leg is shorter
on screen than `minChordPx` the same way as one whose leg is not clear: it undoes it and
tries another. F16 asks for 120 px, which puts the grip 20 px from the handle.

## Verification

- Before: the spec ×5 (50 runs), 1 failure (F21, cause 2). The coordinator's earlier
  ×5 runs had 1–2 failures each (F23, F21, F16).
- With the fixes for causes 1 and 2 only: ×10 twice. The first run passed 100/100. The
  second passed 99/100, failing F16 on cause 3.
- After all three fixes: the spec `--repeat-each=10` (100 runs), twice under the verify
  lock, 0 failures both times; then the full sharded E2E once.

## Not changed: the app's top bar

The same thing happens to a person using the editor. When a collaborator opens or closes
the editor and the chips wrap, the map moves 36 px under the cursor, also in the middle
of a drag. That is a layout matter for `docs/course-editor.md` §2 and §11, which say
nothing about it. It is reported as a follow-up and not changed here. Other editor specs
(`course-editor*.spec.ts`) are exposed to cause 1 too. They can call
`hideOthersPresence` the same way if they flake like this.
