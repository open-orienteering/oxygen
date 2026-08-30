# Phase 8 — Course Editor: Inventory, Radio Controls, Cloning, Flag Cleanup

Depends on: phase 6 (club control series / allocation). Independent of
phases 7 and 9.

## Goal

Four editor improvements from the phase 4–6 review:

1. Show the club control-series inventory inside the editor so planners
   see which physical units are used/free while placing controls.
2. Flag a control as a radio control from the editor; when the current
   code has no SRR support, swap to a free SRR-capable code from the
   inventory.
3. Remove the rarely-used "first control as start" / "last control as
   finish" toggles from all UI (backend stays — legacy MeOS-migrated
   courses may have them set and geometry/export must keep honoring
   them). Decided with the user: UI-only removal.
4. Clone a course into a new course with another name, from the editor.

## Current state (verified)

- `controlSeries.allocation` returns
  `{ code, type: "normal" | "srr", seriesId, seriesName, borrowed }[]`
  (active only, priority order). `CourseEditorPage.tsx` already fetches
  it for code allocation and SRR badges.
- `control.list` returns per control `config.radioType`
  (`normal | internal_radio | public_radio`, persisted on the control
  row) via `aggregateConfig`; `control.upsertConfig({ controlIds,
  radioType })` sets it; `control.update` accepts `codes`.
- Flags: `Course.firstAsStart` / `lastAsFinish` columns; honored by
  `course-geometry.ts` (prepend/append legs) and `course-export.ts`;
  OCD/IOF import always writes `false`; seed builders never set them.
  UI write paths: editor checkboxes (`editor-toggle-first-start`,
  `editor-toggle-last-finish`, `toggleFlag` in `CourseEditorPage.tsx`),
  CoursesPage create-dialog + detail checkboxes, bulk edit options in
  `bulk-field-select`. Read paths: CoursesPage list badges,
  structured-search course anchors.
- Course rows: `name`, `lengthM`, `climbM`, `numberOfMaps`, `startName`
  (start assignment by name), `legs`, `firstAsStart`, `lastAsFinish`,
  `finishControlId` (uuid), `shorten`, `geometry`, `geometrySource`.
  Controls live in `course_controls (course_id, position, control_id)`.
  Helpers in `packages/api/src/routers/course.ts`: `getCourseBySeq`,
  `rebuildCourseGeometry(tx, eventId, courseIds, { updateLength })`,
  `emitCourseUpserted(tx, eventId, courseId)`.
- Editor sidebar: new-course input `editor-new-course-name` + button
  `editor-create-course` call `course.create.mutate({ name })` (not
  undoable by design). Contextual actions for a selected control are
  built in the `contextActions` memo (`EditorContextAction[]`).

## 8.1 Inventory panel

Pure logic first — extend `packages/web/src/lib/course-editor.ts`:

```ts
export interface InventorySeriesView {
  seriesId: string;
  seriesName: string;
  borrowed: boolean;
  codes: { code: number; type: "normal" | "srr"; used: boolean }[];
}

/** Group the flat allocation by series (allocation order preserved) and
 *  mark codes used anywhere in the event (multi-code strings parse the
 *  same way as nextFreeControlCode). */
export function buildInventoryView(
  allocation: SeriesAllocationEntry[],
  existingCodes: Iterable<string>,
): InventorySeriesView[]
```

`CourseEditorPage.tsx`: collapsible sidebar section "Inventory"
(`data-testid="editor-inventory-panel"`, collapsed by default, hidden
entirely when allocation is empty). Per series: name + "borrowed" badge +
free/total count; codes as compact chips
(`data-testid="editor-inventory-code-<code>"`) — used = filled/struck
style, free = outline, SRR = small badge on the chip. Data is purely
client-side (`allocation` × `control.list` codes); no API change.

## 8.2 Radio flag with SRR swap

Pure logic — extend `packages/web/src/lib/course-editor.ts`:

```ts
/** First unused SRR-capable code from the allocation, or null. */
export function nextFreeSrrCode(
  allocation: SeriesAllocationEntry[],
  existingCodes: Iterable<string>,
): SeriesAllocationEntry | null

/** Whether `codes` ("57" or "57;58") contains a code that the
 *  allocation lists as SRR. */
export function codesHaveSrr(
  codes: string,
  allocation: SeriesAllocationEntry[],
): boolean
```

`CourseEditorPage.tsx` — new contextual action on a selected placed
control (regular controls only, not start/finish):

- Control not radio (`config.radioType === "normal"`): action "Radio"
  (`courses:actionMakeRadio`, `data-testid="editor-action-radio"`):
  - `codesHaveSrr` true (or allocation empty — no inventory knowledge):
    `control.upsertConfig({ controlIds: [id], radioType: "internal_radio" })`.
  - Else if `nextFreeSrrCode` finds an entry: confirm inline
    ("Swap code 57 → 33 (SRR unit from <series>)?",
    `courses:radioSwapConfirm`) → `control.update({ id, codes:
    String(entry.code) })` then `upsertConfig` radio. Declining sets
    radio without swapping.
  - Else (inventory present but exhausted): set radio anyway and show a
    non-blocking notice `courses:noSrrAvailable`.
- Control already radio: action "Radio off" (`courses:actionRadioOff`)
  → `upsertConfig` with `radioType: "normal"`.
- Indicator: a radio badge (`data-testid="editor-radio-badge"`) beside
  the existing SRR badge wherever the editor lists the control (sequence
  rows / selection popover) when `config.radioType !== "normal"`.
- Invalidate `control.list` after both mutations. Undo integration: none
  (config changes are not journal-undoable today; matches ControlsPage
  behavior).

## 8.3 Remove first/last flag UI

Remove write affordances, keep backend + read-only legacy display:

- `CourseEditorPage.tsx`: delete the two checkboxes
  (`editor-toggle-first-start`, `editor-toggle-last-finish`) and the
  `toggleFlag` callback; `applySequence`/`course.update` calls simply
  stop passing the flags (they are optional — untouched values persist).
- `CoursesPage.tsx`: remove the flag checkboxes from the create dialog
  and the detail editor, and both options from the bulk-edit
  `bulk-field-select`. Keep the list badge, rendered only when a legacy
  course has a flag `true`, restyled as read-only (no toggle).
- Do **not** touch: `course.create/update/bulkUpdate` Zod (API stays
  compatible), `course-geometry.ts`, `course-export.ts`,
  structured-search anchors (still queryable for legacy data), i18n badge
  labels. Remove only i18n keys that become unreferenced (checkbox
  labels), from both locales, and fix any E2E specs that used the
  removed testids.

## 8.4 Clone course

### API — `course.clone` (new, in `packages/api/src/routers/course.ts`)

`coursesEditRaceProcedure`, input
`{ id: z.number().int(), name: z.string().min(1) }`:

1. `getCourseBySeq(ctx.db, ctx.event.id, input.id)`.
2. Trimmed name equal to an existing non-removed course name in the
   event → `CONFLICT`.
3. Transaction: create the new course copying `climbM`, `numberOfMaps`,
   `startName`, `legs`, `firstAsStart`, `lastAsFinish`,
   `finishControlId`, `shorten` (fresh uuid/seq; `lengthM` recomputed);
   `createMany` the source's `course_controls` with the same positions;
   `rebuildCourseGeometry(tx, ctx.event.id, [newId], { updateLength: true })`;
   `emitCourseUpserted(tx, ctx.event.id, newId)`.
4. Return `{ id: newSeq, name }`.

No class links are copied (a class points at one course).

### Web

Editor sidebar, next to the course selector when a course is selected:
"Clone" button (`data-testid="editor-clone-course"`) → inline name input
prefilled `"<name> (copy)"` (`data-testid="editor-clone-name"`) + confirm
(`editor-clone-confirm`). On success select the new course
(`dispatch({ type: "select-course", id })`). Not undoable — same policy
and comment as course create.

## i18n

`courses` namespace, both locales: `actionMakeRadio`, `actionRadioOff`,
`radioSwapConfirm` (with `{{from}}`/`{{to}}`/`{{series}}`),
`noSrrAvailable`, `editor.inventory`, `editor.inventoryFree`
(`{{free}}/{{total}}`), `editor.clone`, `editor.clonePlaceholder`,
`editor.cloneConfirm`, badge label for read-only legacy flags if the
existing key text implies toggling. Remove orphaned checkbox-label keys.

## Tests (write first)

- **Unit** (`packages/web/src/lib/__tests__/course-editor.test.ts`):
  `buildInventoryView` grouping/order/used-marking (incl. `;`-multi-code
  strings and duplicate codes across series); `nextFreeSrrCode` skips
  used and normal-type codes, null on exhaustion/empty;
  `codesHaveSrr` for single and multi-code strings.
- **Integration**
  (`packages/api/src/__tests__/integration/control-editor.test.ts` or a
  new `course-clone.test.ts`): clone copies control sequence order,
  `startName`/`finishControlId`, rebuilds geometry and length; name
  conflict → CONFLICT; clone of a course with legacy `firstAsStart: true`
  preserves the flag; source course untouched.
- **E2E** (`e2e/courses.spec.ts` + `e2e/control-series.spec.ts` or a new
  spec): inventory panel lists series codes with used/free state after
  placing controls; radio action on a non-SRR control offers and performs
  the code swap (control code changes, ControlsPage shows
  `internal_radio`); radio off reverts; clone from the editor produces a
  selectable course with the same sequence length; flag checkboxes are
  gone from editor and CoursesPage (assert testids absent); legacy badge
  still renders (seed one flagged course via API in the test).

## Documentation

`docs/course-editor.md`: inventory panel, radio flow (incl. swap
semantics), clone, note that first/last-as-flags are legacy-only
(read-only badge, still honored by geometry/export).
`docs/club-library.md`: cross-reference from series to the editor
inventory panel. `docs/features.md`: update course editor bullet.

## Acceptance criteria

1. Planners see per-series used/free codes (SRR marked) in the editor.
2. Radio flagging works one-click when the code is SRR-capable, offers a
   swap when it is not, and degrades gracefully with no/exhausted
   inventory.
3. No UI can set `firstAsStart`/`lastAsFinish` anymore; legacy courses
   keep their behavior and show a read-only badge.
4. Cloning duplicates sequence, start/finish assignment and geometry
   under a new name.
5. Full §6 checklist passes.

## Out of scope

- Reserving/checking-out physical units per event; `public_radio` from
  the editor (ControlsPage still offers it); dropping the flag columns
  or their geometry/export handling; clone across events.
