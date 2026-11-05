# E2E flakes: course presence and multi-course leg labels

Seen in the full sharded E2E run of slice E1 on top of E2 (2026-11-06,
`vector` the E2E default). Neither is a product bug.

## `course-presence.spec.ts`: the click selected a leg

**What happened.** Both tests pick a control to click with the spec's
`clearCodes` (inside the viewer, clear of the inspector). On the seed
event's course A a leg runs right across the centre of some other
controls; when the view settled so that the picked control was one of
them, the click selected the leg ("Insert into course") instead of the
control, and `select` retried the same point for 20 s. Reproduced locally
with `--repeat-each` (1 in 8).

**Fix.** `clearCodes` also skips controls covered by editor chrome
(`coveredBy`) and controls with a drawn leg within 6 px of their centre
(a leg ends at its own circle's rim, so such a leg crosses someone else's
circle). 12 of 12 with `--repeat-each=6`.

## `map-multicourse.spec.ts`: the leg pill vanished after the viewport switch

**What happened.** After the switch to the wide viewport, the inline map
unmounts and the pane's `MapPanel` re-fits once its geometry loads.
`zoomUntilLegLabels` stopped clicking as soon as a pill was *counted* —
on the outgoing panel, or on the new one before its re-fit dropped the
zoom below the pill threshold — then asserted visibility and failed.

**Fix.** The loop is a `toPass` that clicks zoom-in only while no pill is
counted and ends only once a pill is visible (1 s per round, 45 s in all).
