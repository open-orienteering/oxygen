# Course import: class suggestions from course names

## Why

The course-import preview maps each imported course to the event's
classes. Both supported formats carry explicit class→course
assignments:

- **IOF 3.0 CourseData XML** — `<ClassCourseAssignment>` elements.
- **OCAD `.ocd`** — string-parameter records of type 3
  (`ClassName\tc<CourseName>\tr<runners>`), written only when the
  Course Setting project has classes defined under *Courses → Classes*.

In practice many course setters never fill in OCAD's class table — they
just name each course directly after its class ("D10", "H14", "U1",
"inskolning"). Such files parse fine but contain zero assignments, so
the preview used to show **None** in the *XML Class* column for every
course, with no mapping dropdown at all: the user could not assign
classes from the dialog, period. (Real-world example:
`Banor Alla klasser.ocd` from Ungdomsserien, regionfinal SO — 13
courses named after classes, no type-3 records.)

## What happens now

When a parsed file has **at least one course and zero class
assignments**, `course.previewImport` synthesizes one assignment per
course with the course name as the class name, and runs it through the
same auto-matcher as real assignments (`findBestClassMatch`: exact →
normalized → substring). The response carries
`classNamesFromCourseNames: true`, and the import dialog shows an amber
banner explaining that the suggestions came from course names.

Consequences in the preview table:

- Courses whose names match a class exactly are pre-mapped (and hidden
  by the "Hide exact matches" toggle like any other exact match).
- Heuristic matches get the usual amber marker; misses get the rose
  tint — but every course now has a working class dropdown, so the
  user can fix the mapping by hand before importing.
- Files that do contain assignments are completely unaffected: the
  fallback only kicks in when the parsed assignment list is empty.

The commit path (`course.importCourses`) is unchanged — it already
takes the UI's `classMapping` keyed by course name.

## Code

- `deriveClassAssignments()` in `packages/api/src/routers/course.ts`
  (exported for unit tests) — the fallback decision.
- Banner in `packages/web/src/components/CourseImportDialog.tsx`,
  i18n key `courses:classesFromCourseNamesHint` (en + sv).

## Tests

- Unit: `packages/api/src/__tests__/courseHelpers.test.ts`
  (`deriveClassAssignments`).
- Integration:
  `packages/api/src/__tests__/integration/course-import-class-fallback.test.ts`
  — OCD without class records (the `e2e/test.ocd` fixture has courses
  A–E and no type-3 records), IOF XML with and without
  `ClassCourseAssignment`, and a commit round-trip from a fallback
  suggestion.
- E2E: the OCD import test in `e2e/courses.spec.ts` asserts the banner,
  the fallback dropdowns, and resets a heuristic suggestion to Skip via
  the dropdown.
