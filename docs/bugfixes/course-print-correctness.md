# Course and print correctness (fix package 22)

Six findings from the review of courses, printing, Eventor and the web client (`reviews/09-courses-printing.md`, `07-eventor.md`, `10-web-client.md`): EVT-07, CRS-024, CRS-010, CRS-009, CRS-002 and WEB-09. The defaults for the open D5 questions were approved by the owner and are in the decision logs (`decisions/slice-c.md`, `slice-f.md`, `slice-j.md`). Follow-ups: [course-print-followups.md](course-print-followups.md).

## EVT-07: the `.ppen` export was not well-formed XML

**What happened.** The Purple Pen export wrote `restrict-to-page-size`, `left-to-right`, `scale-sizes-circle-gaps` and `blend-purple` as bare attributes (`<print-area restrict-to-page-size>`), which XML does not allow; a strict parser (and Purple Pen) rejects the file.

**Why.** `fast-xml-parser`'s builder drops the value of a boolean attribute unless `suppressBooleanAttributes: false`. The IOF export had the option, the `.ppen` builder did not, and its test only used `toContain`.

**Fix.** `ppen-course-export.ts` sets `suppressBooleanAttributes: false`. The test now validates the output with `XMLValidator` (also for an event without courses) and checks that no tag holds a bare attribute. Opening one export in real Purple Pen stays a manual check (followups).

## CRS-024: an unplaced control shifted the printed numbers

**What happened.** A course with a control at (0, 0) (not yet placed) printed 1, 2, 3, 4 where the description sheet said 1, 2, 4, 5: the number loop and the second part's first number counted placed controls only.

**Why.** `sequenceOf` in `derive.ts` dropped unplaced sites before counting, while the description sheet counts every control.

**Fix.** Each control-role item takes its number in `sequenceOf` (`SeqEntry.n`) whether placed or not; an unplaced one is not pushed, so legs, parts and sections are unchanged, and it draws nothing. `numberBase` is gone (the number is on the entry). A `numberHidden` visit still takes its number. Not changed: the all-variations numbers and the editor's predicate (followups).

## CRS-010: a missing graphic that hides a control printed the control bare

**What happened.** An image attached to a control with `hideControlCircle` / `hideControlNumber` whose graphic was missing (another event's, deleted, unfetchable) was skipped with a warning only the log shows, while the flags still hid the control's own circle and number: the control printed as nothing.

**Why.** The hides act on the object's flags, not on its bytes; the missing bytes were only a warning.

**Fix.** In shared `renderCoursePages`, before a page is written, an attached image with a hide flag that the page draws and whose graphic is not in the loaded set throws `PrintGraphicMissingError` (message names the sheet, the graphic and the control, with the SVG raster reason if any). The route answers 400; the device's worker answers `error` and the client falls back to the server, whose 400 is the export's error line. Any other missing graphic stays a warning. No protocol change.

## CRS-009: description sheets of a forked course printed one block for all variants

**What happened.** A class on a root course with variants printed one description block, from the root's own row, with every runner of the class as its copies.

**Why.** `selectDescriptionBlocks` looked up only the class's course and counted the whole class.

**Fix.** A class (or `courses=`) on a root with live variants prints one block per variant in key order, each on its own page, labelled `<class> <key>`. A variant's copies are the class's runners on it; vacancies and runners without a variant go one at a time to the variant with the fewest copies. `courses=<child>` is one variant on its root's classes. See `course-print.md` §6.4.

## CRS-002: a control added after generation was on no setter map

**What happened.** `layout.setterMaps` writes the groups once. A control created, or added to a course, afterwards was in no group; `maps.pdf?setter=1` printed the setter maps without it and nothing said so.

**Fix.** No silent auto-assign. `courseMap.list` / `resolveSheet` report `setter.unassigned` and a `setter_unassigned` issue; Layout mode and Field mode show a warning; `maps.pdf?setter=1` and `print-job?setter=1` answer 400 naming the controls. **Add to nearest setter map** (`layout.adoptToSetters`) puts each into the group with the nearest centroid. See `course-layout.md` §8.

## WEB-09: a class has one course, and changing it re-dealt finished runners

**What happened.** The Classes page offered a multi-select of courses but sent only the first id, so the "forked" badge saved nothing and the next refresh showed the old course. On the server a course change re-synced the pool even when the course had not changed, and cleared or re-dealt the variant of runners who had already finished.

**Fix.** The page has one single-select (`ClassCourseSelect`), does nothing when the course is unchanged, and confirms with the runner count when the class has runners (`lib/class-course.ts`); the multi-select and its strings are gone. On the server `class.update` / `bulkUpdate` re-sync the pool only when the course changes, and `reconcileClassVariants` leaves a runner who has raced (finish time or result status) on her variant, in or out of the new pool. See `course-controls-and-matching.md` "Forked courses and variants".
