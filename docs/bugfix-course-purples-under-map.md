# Bug fix: course purples under the map on a table with misplaced purples

User report 2026-11-14 (row C15). Fixed in importer `ocad-18` / `omap-11`.
Spec: `docs/map-symbols.md` §9.2 step 4 ("Course purples are placed by
rule").

## What happened

On the event "Testkarta" (map `Nackareservatet 2023-03-29.ocd`, the
corpus file `club-full.ocd`) control circles and legs were drawn under
every yellow and green area, and the control numbers under the whole map.

The map's colour table holds six full purples, none where the course
belongs:

| Index | Name | Read as |
|---|---|---|
| 0 | Övre violett för banpåtryck | upper (name), the most used |
| 2 | Övre violett för banpåtryck | upper (name) |
| 23 | Upper Purple for Course Overprint | upper (name) |
| 25 | Violett | lower (position: below the top black) |
| 79 | Upper Purple for Course Overprint | upper (name) |
| 80 | Violett | upper (position: on top) |

`ocad-17` took a source purple as the course purple wherever it stood
(03 §6.3 step 4): the only lower candidate, index 25, with 28 used area
colours above it (`COLOUR_AREA_ABOVE_LOWER_PURPLE` ×28), and of five upper
candidates the most used one, index 0 — the bottom of the stack. C14's
area-group rule (`docs/bugfix-lower-purple-under-areas.md`) only ran for
an *inserted* lower purple, so it never applied here.

## Fix

A map file holds no course, so a source purple's place says nothing about
where the course belongs (user decision 2026-11-14). On every import:

- lower purple goes into the C14 gap, computed over the source stack with
  every purple candidate taking no side;
- upper purple goes above every used colour;
- a source purple carries the role only when it already stands there;
  otherwise a row is inserted there with the map's purple ink;
- every other candidate stays at its index as an ordinary source colour
  (no `paletteIds`, no `purpleRole`), so map objects drawn in it are
  unchanged, and is listed in `colourStack.purplesDisplaced`.

The map's colour order is not changed (a full canonical order is slice I).

## Corpus, before (`ocad-17`) and after (`ocad-18`)

`node scripts/measure-import.mjs .local/corpus`; matching is identical on
all five maps, only the purple rows and the colour-stack warnings move.

| Map | Before | After |
|---|---|---|
| `club-full.ocd` | lower = source "Violett" at 26, 28 areas above; upper = index 0; 24 conflicts | lower inserted at 62 (above "Brun gc-vägar nära hus", below "Brown 100% - Line Feature"), 1 area above (a text mask above black); upper = the top "Violett", reused; 5 displaced; 19 conflicts |
| `club-2026.ocd` | lower inserted at 47; upper = a source purple with used colours above it | lower unchanged; upper inserted on top; 2 displaced |
| `crop-a.ocd` | lower = source "Violett (för banptryck/transpar" at 140; upper = a source purple below used colours; 18 conflicts | lower inserted at 102 (as on `crop-b.ocd`, the same map family), 1 area above; upper = the top purple, reused; 4 displaced; 14 conflicts |
| `crop-b.ocd` | lower inserted at 102; upper = a source purple with a used colour above it | lower unchanged; upper inserted on top; 3 displaced |
| `sprint.ocd` | lower = source "Undre Violett för banpåtryck" at 30, 1 area above; upper = a source purple below the top | lower inserted at 32, 0 areas above; upper = the top purple, reused; 2 displaced |

## Tests

`packages/shared/src/import/__tests__/colour-align.test.ts` "course
purples placed by rule" (Nackareservatet 2023's colour table as a fixture
in `club-colour-tables.ts`: names, CMYK, order and usage only),
`match-document.test.ts`, `report.test.ts`,
`scripts/__tests__/measure-import.test.mjs`; `docs/map-symbols.md` §9.2
lists them.

## After merge

Re-match dev (`backfill.sh --rematch` or the re-match CLI) so Testkarta's
pinned document is rebuilt with `ocad-18`; production with the next
release.
