# Bugfix: `map-multicourse.spec.ts` left its imported courses behind

## What happened

On PR #200 (H5), CI's E2E shard 2/6 failed in
`e2e/rental-cards.spec.ts:270`, "should show rental card banner on kiosk
readout". The kiosk never showed the banner, on all three attempts. The
same test passed on the base branch and when run alone.

H5 added `e2e/map-terrain.spec.ts`. The sharded runner splits spec files
by weight (`scripts/e2e-weights.mjs`), so one new file moved others
between shards. Shard 2 gained `map-multicourse.spec.ts`, which runs
before `rental-cards.spec.ts`.

`map-multicourse.spec.ts` changes the seed event `itest`:

- it imports `e2e/test.ocd`'s courses A–E over the seed's three courses;
- it uploads the map;
- it reassigns classes.

It reseeded only in `beforeAll`. The test after it then saw 5 courses
instead of 3. The kiosk test inserts a card punching the seed's course 2
(`COURSE_2_CONTROLS`) for a runner in class "Öppen 2". On the changed
event the readout no longer resolved, so the kiosk showed no rental
banner.

Bisecting with `rental-cards.spec.ts` against each spec before it in
shard 2 isolated `map-multicourse.spec.ts`. Running the two together
reproduced the failure locally; the shard replay
(`E2E_SHARD_TOTAL=6 E2E_SHARD_INDEX=2`) did too.

## Fix

`map-multicourse.spec.ts` now also calls `test.afterAll(reseed)`. This is
what AGENTS.md §12 asks ("clean up after themselves") and what
`class-presets.spec.ts` already does. With it, the pair passes and the
shard-2 replay is green (52 passed).

## Not changed

Several other specs reseed only in `beforeAll`: `error-paths`,
`editor-top-bar`, `controls`, `courses`, `phase3`, `editor-url`,
`editor-space`, `editor-fullscreen`, `map-control-circles`,
`wide-screen-map-pane` and `registration-dialog`. Any of them can break a
seed-dependent spec that a future re-split places after it. They are left
as they are here; adding `afterAll(reseed)` to each, or a reseed in
seed-dependent specs, is a separate hygiene change.
