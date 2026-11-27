# Course import: what package 17 left out

Left out of fix package 17 ([course-import-safety.md](course-import-safety.md)), 2026-11-26.

1. **Runners on a removed course.** A runner whose own `course_id` names a
   course Replace all removes (not a variant) keeps pointing at it. The
   preview counts them ("N runners are on a removed course"), but the import
   does not clear them, and there is still no screen that restores a removed
   course.
2. **A course item naming a control the file lacks** is dropped silently
   (`controlIdMap` miss in the course loop). A preview blocker would be
   better.
3. **No rename detection.** A renamed course or a control whose code changed
   is new: the old one stays under Merge and is removed under Replace all.
   Only the preview's lines show it.
4. **An editor write racing the import.** The editor's version check can pass
   before the import commits and then write over it. This predates the
   package; the import now commits atomically, which narrows but does not
   close the window.
5. **No derived length** for a new course when the event has no map scale or
   the course is free order: it stays 0.
6. **`skipPositions` flips `length_source`.** The position-less path calls
   `rebuildCourseLengths(updateLength: false)` without `keepSource`, so an
   existing course's `length_source` becomes `derived` / `null` although its
   length is kept.
7. **Several races.** Refused today; a "which race?" picker in the dialog.
   A suggestion chip for substring class matches would also help.
8. **Import-time `differing` is `null`** (existing Pending item in §6.4).
9. **Timeouts.** The 60 s transaction was not measured against a slow remote
   database or a proxy timeout on a very large file.
10. **Parse errors are English only**; the preview's blockers are translated.
11. **Move the body.** After PR #254 (course elevation) merges, move the
    `importCourses` body to `course-import.ts` as a pure-move commit (kept in
    place now to keep that PR's conflicts small).
12. **Two file ids on one site** (`31` and `131` both in the file, one
    `31;131` site): both map to the site and the course sequences use it;
    the preview counts it once. Not refused.
