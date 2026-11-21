# Bugfix: Classes Page Layout Issues

## Summary

Three layout bugs in `ClassesPage.tsx` were fixed.

## Bug 1: Options column badge wrapping

**Symptom:** The "Alternativ" column in the classes table was too narrow (`w-32` = 128px), causing option badges like "Fri start" and "Direktanmälan" to wrap onto two lines.

**Fix:** Widened the column from `w-32` to `w-52` (208px), giving enough room for multiple badges on one line.

## Bug 2: White stripe to the right of the expanded row

**Symptom:** When a class row was expanded (at xl+ viewport widths where all columns are visible), a white vertical stripe appeared to the right of the runner panel. This was the Actions column showing through uncovered.

**Root cause:** The `colSpan` on the expanded detail row was hardcoded as `9` (drag handle visible) or `8` (no drag handle). At xl+ breakpoints all columns are visible — that is 10 columns with the drag handle (checkbox + drag + Name + Course + Runners + Fee + Sex + Type + Options + Actions) or 9 without. The `colSpan` was one short in both cases, leaving the Actions column (w-20 = 80px) outside the expanded td.

**Fix:** Changed to `colSpan={99}` — browsers clip colSpan to the actual column count, so this safely covers all columns at any viewport width without needing to track the responsive column count in JS.

## Bug 3: Inconsistent class settings layout

**Symptom:** The inline class settings panel (expanded row) used mixed grid layouts — a 3-column row for name/sex/sortIndex, a 4-column row mixing inputs with checkboxes, and then standalone single fields for fee and max time. The layout was visually inconsistent.

**Fix:** Reorganized into uniform 3-column rows throughout:

| Row | Col 1 | Col 2 | Col 3 |
|-----|-------|-------|-------|
| 1 | Name | Sex | Sort index |
| 2 | Min age | Max age | Entry fee |
| 3 | Free start | No timing | Allow quick entry |

Max time kept as a standalone field below (it is less commonly used and benefits from visual separation). Class type remains a read-only display shown only when set.

Checkbox fields now follow the same label-above pattern as text inputs, showing "Yes"/"No" next to the checkbox for consistent visual weight.
