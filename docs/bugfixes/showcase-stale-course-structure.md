# Bugfix: Demo Competition courses read no controls

## What happened

Every course of the committed Demo Competition fixture
(`docs/screenshots/fixtures/showcase.sql`) carried a `courses.structure`
jsonb whose `siteId`s were the **source** database's control ids. The
anonymiser (`scripts/anonymize-vinterserien.ts`) gives every control a fresh
UUID and rewrites the uuid columns that point at it, but `structure` is
jsonb, so its ids were copied unchanged. No control in the fixture had those
ids.

Readers prefer a parseable stored structure over `course_controls`
(`loadCourseSequences`, `courseSequenceOf`; `docs/course-layer.md` §6), so
each demo course resolved to no controls between start and finish. That
broke the course editor's sequence, and `rebuildCourseLengths` after any
editor move: with no legs, a course kept a stale length.

Found while planning E-demo-map, which moves the demo's controls onto a new
map and re-derives the course lengths.

## Fix

- The fixture writes `structure` NULL, the documented "not written yet"
  state. Readers fall back to `course_controls` and the start / finish rules,
  and the course editor writes a fresh structure on the next save.
  `scripts/showcase-controls.mjs apply` (`scripts/lib/showcase-controls.mjs`)
  does this along with the positions and the re-derived lengths.
- The anonymiser applies `docs/screenshots/fixtures/showcase-controls.json`
  after its dump, so a regenerated fixture is cleared the same way.

## Tests

- `packages/api/src/__tests__/integration/showcase-fixture.test.ts`: after
  loading, every course has `structure` NULL and reads start + its
  `course_controls` + finish. `rebuildCourseLengths` gives the lengths the
  fixture stores.
- `scripts/__tests__/showcase-controls.test.mjs`: `apply` clears a stale
  structure and is idempotent.
