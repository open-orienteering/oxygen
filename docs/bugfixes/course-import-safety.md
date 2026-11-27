# An empty or wrong course file wiped the event's courses; re-import reset control settings

Fix package 17 of the 2026-11 full code review (findings CRS-005, EVT-05 with
API-05 / MC-38 / DB-16 / CRS-022, CRS-001, CRS-021, CRS-032, CRS-060), decision
D3. Spec: [`course-layer.md`](../course-layer.md) §6.4 "Import semantics".

## What happened

- **The default was the destructive mode.** The import dialog pre-selected
  "Replace all", and `course.importCourses` started with three bulk updates:
  every course and control soft-deleted, every class's course cleared. Nothing
  checked the file first, so a file with no courses (the map file picked by
  mistake, or an IOF file with two `RaceCourseData`, which the parser read as
  zero courses) left the event with no courses and no class assignments.
- **Not one transaction.** The wipe, the writes and the journal entry were
  separate statements. A crash after the wipe left the same empty event, and
  nothing was journaled for a peer.
- **Re-import reset what the organiser set.** A matched control got status OK,
  the file's single code and an empty name: a control marked Bad or Optional
  became required again (results change), and `31;131` became `31`.
- **Removed rows won matches.** Under Replace all the controls were read after
  the wipe, so every match was a removed row (counted as "created"), and a
  removed row could take a code a live control had.
- **A file without lengths set lengths to 0**, overwriting a stored length.
- **Duplicates were silently accepted**: a control or course listed twice, a
  class mapped to two courses (the last won), and course "D1" pre-selected
  class "D10" by substring.
- Parse errors were server errors (`INTERNAL_SERVER_ERROR`).

## The fix

- `course-import-tx.ts`: the import runs in one transaction (60 s, an
  event-scoped advisory lock serialises imports). The handler body stays in
  `routers/course.ts` with `ctx.db` swapped for the transaction.
- `course-import-plan.ts`: one plan for the preview and the import. It
  matches controls by code (a start / finish by name, a crossing point by name
  among crossing points), a live row before a removed one; courses by name. It
  lists the refusals and, per mode, the consequences.
- **Merge is the default.** Matched controls keep status, extra codes and name
  in both modes. Replace all removes only what the file does not carry and
  unassigns only the classes on a removed course. Merge leaves a local forked
  course alone.
- Lengths are written only when the file states one; a new course without one
  gets a derived length.
- Refusals before any write: no courses (always under Replace all), duplicate
  ids and names, a class mapped twice, a non-OCAD buffer, several races. Parse
  errors are `BAD_REQUEST`.
- The dialog shows the selected mode's consequence list ("Removes 3 courses",
  "2 classes lose their course", "1 control keeps its status or extra codes"),
  the refusals with Import disabled, and the class warnings. Substring class
  matches are marked but never pre-selected.

No migration.

Left out: [course-import-followups.md](course-import-followups.md).

## Tests

`packages/api/src/__tests__/course-import-plan.test.ts`,
`iof-course-parser.test.ts`, `ocd-course-parser.test.ts` (magic word),
`integration/course-import-safety.test.ts` (rollback after the wipe with an
injected journal failure), `integration/course-variants.test.ts` (Merge skips a
fork), `packages/web/src/lib/__tests__/course-import-consequences.test.ts`,
`e2e/course-import-safety.spec.ts`.
