# Phase 9 — Club Class Presets & Simplified Event Bootstrap

Depends on: phase 5 (the `/library` page gains a Classes tab). Pairs
naturally with phase 8 but has no code dependency on it.

> **Amendment (post-implementation):** fee and maximum time were dropped
> from presets — they are race-specific and are set per event on the
> Classes page instead. References to `classFee`/`classFeeCents`/`maxTime`
> in the preset model and router below no longer apply.

## Goal

The club defines its recurring class catalogue once (H21, D21, U1, open
classes, …) with per-class settings. Setting up a new event becomes:
bulk-add the relevant classes from the catalogue, then create courses —
the editor suggests class names that still lack a course and links the
new course to the class automatically.

## Current state (verified)

- `Class` rows carry `name`, `longName`, `sex` (`""`/`"M"`/`"F"`),
  `lowAge`/`highAge` (0 = unbounded), `classType` (free-form label),
  `classFeeCents`, flags `noTiming`/`freeStart`/`allowQuickEntry`,
  `maxTime`, `sortIndex`, and `courseId` (uuid FK; public API speaks
  course **seq**).
- `class.create` input: `name`, `longName`, `courseId` (seq), `sortIndex`,
  `sex`, `lowAge`, `highAge`, `classFee`, `allowQuickEntry`,
  `firstStart`, `startInterval`, `maxTime`. **Missing:** `classType`,
  `noTiming`, `freeStart`.
- Known Zod gaps (bugs — UI already sends these and they are silently
  dropped): `freeStart` missing from `class.update`; `freeStart` and
  `noTiming` missing from `class.bulkUpdate` although the ClassesPage
  bulk bar offers both.
- `class.list` returns `ClassSummary` incl. `courseId` (seq, 0 = none)
  and `courseName` — enough for "classes without a course" client-side.
- Course creation sites: editor sidebar input
  (`editor-new-course-name` → `course.create.mutate({ name })` in
  `CourseEditorPage.tsx`) and the CoursesPage create dialog.
- Library page tabs so far: Maps, Controls, Groups
  (`packages/web/src/pages/LibraryPage.tsx` + `Library*Tab.tsx`).
- E2E reseed helper `e2e/helpers/reseed.ts` already clears library
  tables (`club_user_groups`, …) — presets must be added there.

## Data model

Migration `YYYYMMDDHHMMSS_club_class_presets`:

```prisma
model ClubClassPreset {
  id              String   @id @default(dbgenerated("uuidv7()")) @db.Uuid
  name            String   @unique
  sex             String   @default("")            // "" | "M" | "F"
  lowAge          Int      @default(0) @map("low_age")
  highAge         Int      @default(0) @map("high_age")
  classType       String   @default("") @map("class_type")
  classFeeCents   Int      @default(0) @map("class_fee_cents")
  noTiming        Boolean  @default(false) @map("no_timing")
  freeStart       Boolean  @default(false) @map("free_start")
  allowQuickEntry Boolean  @default(false) @map("allow_quick_entry")
  maxTime         Int      @default(0) @map("max_time") // deciseconds
  sortIndex       Int      @default(0) @map("sort_index")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("club_class_presets")
  @@schema("oxygen")
}
```

Attach the `set_updated_at` trigger. Shared type `ClubClassPreset` goes
in `packages/shared/src/clubAssets.ts` (re-exported from the package
index).

## API

### `classPresetRouter` (new, registered as `classPreset`)

Management is `authedProcedure` — same global-library policy as maps and
control series (any invited member curates; not admin-only):

| Procedure | Input | Behavior |
|-----------|-------|----------|
| `list` | — | Ordered by `sortIndex`, then `name` |
| `create` | `{ name: min(1), sex?, lowAge?, highAge?, classType?, classFee?, noTiming?, freeStart?, allowQuickEntry?, maxTime?, sortIndex? }` | Duplicate name → `CONFLICT`. `classFee` maps to `classFeeCents` (same convention as classRouter) |
| `update` | `{ id: uuid }` + all fields optional | Rename collision → `CONFLICT` |
| `delete` | `{ id: uuid }` | |

### `class.createFromPresets` (new, in `classRouter.ts`)

Same procedure tier as `class.create`. Input
`{ presetIds: z.array(z.string().uuid()).min(1) }`:

1. Load presets; unknown id → `NOT_FOUND`.
2. Load existing non-removed class names for the event.
3. One transaction: for each preset whose name is not yet taken, create
   the class copying every preset field (fee → `classFeeCents`), no
   course link; emit the same `class.upserted` journal entry as
   `class.create` per created row.
4. Return `{ created: number, skipped: string[] }` (names skipped as
   already present).

### Zod gap fixes (in the same phase, regression-tested)

- `class.create`: add `classType`, `noTiming`, `freeStart` (all
  optional, defaults `""`/false).
- `class.update`: add `freeStart: z.boolean().optional()`.
- `class.bulkUpdate`: add `freeStart` and `noTiming` (optional booleans).

### `course.create` — optional class link

Add `linkClassId: z.number().int().optional()` (class **seq**). Inside
the existing transaction, when set: resolve via `getClassBySeq`; class
already linked to a course → `BAD_REQUEST`; otherwise set the class's
`courseId` to the new course uuid and emit the class journal upsert.
Course + link commit atomically.

## Web

### Library — Classes tab

New `packages/web/src/pages/LibraryClassesTab.tsx`, fourth tab on
`LibraryPage` (order: Maps, Controls, Classes, Groups). Table of presets
sorted like `list`; add-form and per-row edit (inline or small modal)
covering: name, sex select ("" open / M / F), low/high age, type (free
text), fee, checkboxes noTiming / freeStart / allowQuickEntry, max time
(`H:MM:SS`, reuse the ClassesPage parsing helper), sortIndex; delete with
confirm. Testids: `library-tab-classes`, `preset-add-name`,
`preset-add-submit`, `preset-row-<name>`, `preset-delete-<name>`.

### ClassesPage — bulk add from presets

Button "Add from club presets" (`data-testid="classes-add-presets"`,
shown when the user can edit classes and `classPreset.list` is
non-empty) opens a dialog:

- All presets with checkboxes (`preset-check-<name>`) + select-all
  (`preset-check-all`); presets whose name already exists among the
  event's classes are disabled with an "already added" note.
- Submit (`presets-apply`) calls `class.createFromPresets` with the
  checked ids, invalidates `class.list`, shows "{created} added,
  {skipped} skipped" feedback.

### Course creation autosuggest + auto-link

Shared pure helper in `packages/web/src/lib/course-editor.ts`:

```ts
/** Names of classes with no linked course, minus existing course names;
 *  case-insensitive exact matcher for the link decision. */
export function courselessClassNames(
  classes: { name: string; courseId: number }[],
  courseNames: Iterable<string>,
): string[]
export function matchCourselessClass(
  name: string,
  classes: { id: number; name: string; courseId: number }[],
): number | null   // class seq or null
```

- `CourseEditorPage.tsx`: fetch `trpc.class.list`; attach a `<datalist>`
  (`data-testid="editor-new-course-suggestions"`) with
  `courselessClassNames(...)` to the new-course input. On create, pass
  `linkClassId: matchCourselessClass(name, classes) ?? undefined`.
- `CoursesPage.tsx` create dialog: same datalist + link behavior on its
  name field.
- After a linked create, invalidate `class.list` too.

## i18n

`library` namespace: Classes-tab strings (tab label, column headers,
form labels, delete confirm). `classes` namespace: `addFromPresets`,
dialog title, `alreadyAdded`, `presetsResult` (`{{created}}`,
`{{skipped}}`), select-all. `courses` namespace: suggestion hint if any
visible text is added (datalist itself needs none). Both locales.

## Tests (write first)

- **Unit** (`packages/web/src/lib/__tests__/course-editor.test.ts`):
  `courselessClassNames` (excludes linked classes and names already used
  by courses), `matchCourselessClass` (case-insensitive exact, ignores
  linked classes, null on no match).
- **Integration**:
  - New `class-presets.test.ts`: preset CRUD + name-conflict; and via an
    event-scoped caller: `createFromPresets` creates classes with every
    field copied (spot-check sex/ages/fee/flags/maxTime/classType),
    skips existing names, returns counts, journal entries emitted;
    unknown preset id → NOT_FOUND.
  - `classRouter` regressions: `create` persists `classType`/`noTiming`/
    `freeStart`; `update` persists `freeStart`; `bulkUpdate` persists
    `freeStart`/`noTiming`.
  - `course.create` with `linkClassId`: links the class; linking an
    already-linked class → BAD_REQUEST and no course row is left behind
    (transaction rolls back).
- **E2E** — new `e2e/class-presets.spec.ts` (add `club_class_presets`
  cleanup to `e2e/helpers/reseed.ts` and to any afterAll like the other
  library specs): define two presets in `/library` Classes tab; on an
  `E2E_` event open Classes → "Add from club presets" → select-all →
  both classes appear with their settings; re-open dialog → both now
  disabled as already added; open the course editor → new-course input
  suggests the courseless class names; create a course with one of them
  → ClassesPage shows the class linked to the new course.

## Documentation

`docs/club-library.md`: Classes tab section (catalogue model, bulk add).
`docs/features.md`: class presets + simplified bootstrap workflow.
Course-editor doc: name suggestion / auto-link behavior.

## Acceptance criteria

1. Presets are manageable in the library with all listed fields, both
   locales complete.
2. Bulk add creates only missing classes, copies every preset field, and
   reports created/skipped.
3. `freeStart`/`noTiming` edits from ClassesPage actually persist
   (regression bugs fixed).
4. Creating a course with a suggested courseless class name links the
   class atomically; non-matching names create an unlinked course exactly
   as before.
5. Full §6 checklist passes.

## Out of scope

- Course presets / preset-to-course templates; per-preset start blocks,
  fees ladder or relay fields; syncing presets from Eventor; multi-course
  class pools in the bulk-add flow.
