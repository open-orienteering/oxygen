# Bugfix: Control description columns and column-C picker

## What was wrong

1. **Column layout drifted from the IOF 2018/2024 sheet.** Free-text
   dimensions (`s`) were drawn in column E with an `"m"` suffix. The
   spec puts appearance (8.x) / second feature in E and dimensions in F
   (plain number, no unit). Column H (other information, 12.x) was
   always empty even though the SVG glyphs existed.

2. **Column C ("which of similar features") was effectively unusable.**
   The picker offered eight unlabeled arrow icons identical in look to
   column G "side of" glyphs, with names only in hover `title=`
   tooltips — invisible on touch devices. Selecting Northern vs
   North-eastern was guesswork, especially on mobile.

3. **Autodetect never filled C, F (crossing/junction/bend), or E
   (second feature)** — by design in v1, but path crossings are the
   most common missed suggestion.

4. **The three-candidate suggestion menu was almost never useful** —
   the top hit is the one users want. Fresh placements still required a
   click to apply it.

## Fix

- Extended `ControlDescription` with `e` and `h`; shared
  `descriptionCells()` places size in F and appearance/second feature
  in E.
- Reworked `ControlDescriptionEditor`: labelled 3×3 compass for C,
  visible names under every option, live summary sentence, E/H
  sections, mobile bottom sheet.
- Autodetect now detects crossings, junctions, bends, free ends, and
  which-of-similar; `autoDescribe` on create fills the top candidate
  automatically. After a move of an already-described control the menu
  offers a single replacement if it differs.
- Crosshair cursor in editor mode + magnifier loupe while dragging.
- Course-level special/finish instruction rows (`description_instructions`).

## Follow-up (same day)

Field testing on a real club map surfaced four more problems:

1. **Finish row had no distance.** Only an explicit
   `finish.lengthM` was drawn. The sheet now measures the last control
   → finish leg from the control positions and the map scale
   (`buildDescriptionSheet({ finishLengthM })`); an explicit length
   still wins.
2. **Header looked wrong.** Grey-shaded header rows and no visual
   grouping. The sheet now follows the IOF layout rules: plain white,
   bold header text, thick rules around every header cell, a thick rule
   under the start row, "after every third description and on either
   side of any special instruction", and above the finish row; thick
   verticals after columns C and F (A B C | D E F | G H); thin rules
   elsewhere; alternate row shading kept (`hasThickRuleBelow`,
   `DESCRIPTION_THICK_COLUMNS`). The print block is the same model:
   `resolve-layout.ts` now feeds `renderDescriptionBlockSvg` the full
   sheet (header, start, specials, finish + measured finish distance)
   instead of bare control rows under a title.
3. **Header row 1 showed the course name** — the event name was never
   passed down. `MapPanel` now reads it from the dashboard query and
   hands it to `MapViewer` as `eventName`.
4. **Autodetect missed obvious things** on real maps:
   - *Side of boulder* was lost because the control was also *inside*
     open land, and "inside" ranked as distance 0. Extended areas now
     rank by depth-from-edge + 0.5 mm.
   - *Path junctions* were missed because (a) OCAD Bezier handles were
     used as vertices, so curved paths never met within tolerance,
     (b) the snap tolerance was 0.15 mm, (c) the junction only won when
     the control was nearer the intersection than the line itself.
     Beziers are now flattened, tolerance is 0.3 mm, and within 1.5 mm
     the junction replaces the plain line candidate.
   - Moving an auto-described control kept the old side. Moves now
     re-describe when the description is the untouched autodetect
     result.
   - New: edge / part / corner of extended areas, outside corner of
     buildings.

See `docs/course-editor.md` and `docs/control-descriptions-and-editor-geometry.md`.
