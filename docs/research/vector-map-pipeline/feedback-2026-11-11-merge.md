# Feedback before the branch merges (2026-11-11) and its rows

Recorded by the coordinator after F27 (#166) and the flake fixes (#167)
merged (`dbdd8e5a`; full E2E 390/390). The user wants these fixed before
`vector-map-pipeline` merges to `main`.

## The request (user, 2026-11-11, with a screenshot at about 1840 × 1090)

1. **The editor wastes laptop space.** Outside fullscreen the editor's map
   panel has a maximum size: the page's max width, and a height of
   `calc(100dvh - 200px)`. In the screenshot it leaves wide white margins
   left and right, and about 80 px of empty space under it. Relax both
   horizontally and vertically.
2. **The top bar wraps** at that width (the info icon lands on a second
   row). Where there isn't room, buttons should drop their text and show
   only their icon.
3. **Dragging a control number shows the loupe** (F24), and that isn't
   useful. Take it off number drags.
4. **Canonical URLs** for the editor's key modes, so the URL follows the
   mode the editor is in.

## The plan (Fable `slice-planner`, 2026-11-11)

- **Width** comes from the shell: `CompetitionShell.tsx` `PaneContainer`
  is `max-w-7xl` unless the viewport is at least 2200 px wide. **Height**
  is the editor's own: `calc(100dvh - 200px)` against about 104 px of
  chrome.
- **The top bar** is `MapPanel`'s `map-toolbar`, with `TopBar.tsx`
  (`flex-wrap`) inside it.
- **The number loupe** hangs on `MapViewer.tsx`'s `setDragCursor` for a
  label drag and on `editorLabelDragPos` in `loupeAt`.
- **The editor's URL** is read once and never written: `?mode=layout&sheet=`
  / `template=` and `?course=&control=`.
- Rows F28–F31 in `SLICES.md` carry the detail. Each row's session runs
  `slice-planner` first.

## Answers (user, 2026-11-11)

1. **URL history: `replace` throughout.** The URL follows `course`, `mode`,
   `view` (with `class` / `variant`) and Layout's `sheet` / `template` in
   place. Back leaves the editor in one step, and a reload or a shared link
   restores the state.
2. **The selection is not in the URL.** `?control=` stays an inbound link
   (the Controls page) and is removed once used. The tool, the selection and
   the preferences are never written.
3. **The mode switch gets icons.** Labels go first: Hide other controls,
   Auto slits, Hide descriptions, Export and the "Course" word. When the row
   is still too short, Course / Layout / Field show their icons alone, and
   the tooltip and `aria-label` keep the word. The view group stays text.
   This is a CSS container query on `map-toolbar`; `flex-wrap` stays as the
   last resort.
