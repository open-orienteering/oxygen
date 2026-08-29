# Phase 6 — Club Control Series & Typed Controls

Depends on: phase 3 (auth for management procedures) and phase 5 (the
`/library` page gains its Controls tab here).

## Goal

The club defines its physical control inventory as prioritized series —
its own units first, borrowed units from other clubs after. The course
editor allocates punch codes from these series instead of the bare
"next free ≥ 31" heuristic, and SRR-capable units are flagged so placed
controls are immediately usable as radio controls.

## Current state (verified)

- Code allocation is purely client-side:
  `nextFreeControlCode(existingCodes)` in
  `packages/web/src/lib/course-editor.ts` — smallest unused integer ≥ 31,
  gap-filling, parsing `;`-separated code strings.
- `CourseEditorPage.tsx` `createControl` calls it with
  `controlList.data.map(c => c.codes)` then
  `client.control.create.mutate({ codes: String(code), status: 0, xpos, ypos })`.
  `control.create` has no radio field; radio is set later via
  `control.upsertConfig({ controlIds, radioType })` with enum
  `normal | internal_radio | public_radio`. SRR station programming keys
  off non-`normal` radioType (`control-station-config.ts`), and
  LiveResults treats non-`normal` as radio controls.
- No club-level control inventory exists anywhere.

## Data model

Migration `YYYYMMDDHHMMSS_club_control_series`:

```prisma
enum ClubControlType {
  normal
  srr

  @@map("club_control_type")
  @@schema("oxygen")
}

model ClubControlSeries {
  id        String   @id @default(dbgenerated("uuidv7()")) @db.Uuid
  name      String
  ownerName String   @default("") @map("owner_name") // lender club; empty = own club
  borrowed  Boolean  @default(false)
  priority  Int                                       // ascending allocation order
  notes     String   @default("")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  controls ClubSeriesControl[]
  @@map("club_control_series")
  @@schema("oxygen")
}

model ClubSeriesControl {
  id       String          @id @default(dbgenerated("uuidv7()")) @db.Uuid
  seriesId String          @map("series_id") @db.Uuid
  code     Int
  type     ClubControlType @default(normal)
  active   Boolean         @default(true)              // false = lost/broken/unavailable
  notes    String          @default("")

  series ClubControlSeries @relation(fields: [seriesId], references: [id], onDelete: Cascade)
  @@unique([seriesId, code])
  @@map("club_series_controls")
  @@schema("oxygen")
}
```

Codes are unique **per series only** — different clubs' physical units can
legitimately share codes; allocation resolves collisions by skipping codes
already used in the event. Attach `set_updated_at` trigger to
`club_control_series`.

## API — `controlSeriesRouter` (new, registered as `controlSeries`)

Management procedures are `authedProcedure` (global scope, same policy as
the map library):

| Procedure | Input | Behavior |
|-----------|-------|----------|
| `list` | — | Series ordered by `priority`, each with its controls ordered by `code`, plus per-series counts (total/active/srr) |
| `createSeries` | `{ name: min(1), ownerName?: string, borrowed?: boolean, notes?: string }` | `priority` = current max + 1 |
| `updateSeries` | `{ id: uuid, name?, ownerName?, borrowed?, notes? }` | |
| `moveSeries` | `{ id: uuid, direction: "up" \| "down" }` | Swap `priority` with neighbor (transaction) |
| `deleteSeries` | `{ id: uuid }` | Cascade deletes controls |
| `addControls` | `{ seriesId: uuid, from: int.min(1), to: int.max(1023), type?: ClubControlType }` | Bulk range insert (`to >= from`, range span ≤ 500 → else `BAD_REQUEST`); silently skip codes already in the series; return `{ added, skipped }` |
| `updateControl` | `{ id: uuid, type?, active?, notes? }` | |
| `deleteControl` | `{ id: uuid }` | |
| `allocation` | — (`eventProcedure` tier is NOT needed; keep authed-global) | Flattened allocation order for the editor: `{ code, type, seriesId, seriesName, borrowed }[]` — active controls only, ordered by series `priority` then `code` |

Shared types for the allocation entry and `ClubControlType` go in
`packages/shared/src/types.ts` (or the phase-4 `permissions.ts` sibling
`clubAssets.ts` — new file `packages/shared/src/clubAssets.ts`, re-exported).

## Web changes

### Allocation logic — extend `packages/web/src/lib/course-editor.ts`

```ts
export interface SeriesAllocationEntry {
  code: number; type: "normal" | "srr";
  seriesId: string; seriesName: string; borrowed: boolean;
}

export function nextSeriesControlCode(
  allocation: SeriesAllocationEntry[],
  existingCodes: Iterable<string>,
): { code: number; entry: SeriesAllocationEntry | null } 
```

- Build the used-code set exactly like `nextFreeControlCode` (reuse the
  parsing internally — extract `parseUsedCodes` helper).
- Return the first allocation entry whose `code` is unused (`entry` set).
- Empty allocation list, or all entries consumed → fall back to
  `nextFreeControlCode` result with `entry: null` (the heuristic must also
  skip codes present in the allocation-but-used set, which it does since
  those codes are in `existingCodes` only when placed — correct as-is).
- Keep `nextFreeControlCode` exported and untouched (other callers/tests).

### `CourseEditorPage.tsx`

- Fetch `trpc.controlSeries.allocation.useQuery` (staleTime ~60s).
- `createControl`: use `nextSeriesControlCode(allocation.data ?? [], ...)`.
  After `control.create`, when `entry?.type === "srr"`, call
  `client.control.upsertConfig.mutate({ controlIds: [created.id], radioType: "internal_radio" })`
  so SRR units are radio-ready immediately (user can change on
  ControlsPage; note the created id is the public control id returned by
  `control.create`).
- When the fallback path is used **and** allocation is non-empty (series
  exhausted), show a one-time toast/inline notice
  (`courses:seriesExhausted`) so the planner knows they're beyond the
  physical inventory.
- Editor control list / placed-control popover: show a small "SRR" badge
  when the control's code matches an SRR allocation entry, and the series
  name as tooltip (client-side join against allocation data; no API
  change).

### Library page — Controls tab (extends phase 5's `LibraryPage`)

- Series list ordered by priority: name, owner badge ("Borrowed from X"
  when `borrowed`), counts (n controls, n SRR, n inactive), up/down
  buttons, edit (name/owner/borrowed/notes modal), delete (confirm).
- Expanded series: table of codes — code, type toggle (normal/SRR), active
  toggle, notes, delete row; bulk-add form (from, to, type) showing the
  `{ added, skipped }` result.

### i18n

Extend the `library` namespace (both locales) with all series/controls
strings; add `seriesExhausted` to `courses` namespace.

## Tests (write first)

- **Unit** extend
  `packages/web/src/__tests__/course-editor.test.ts` (or wherever
  `nextFreeControlCode` is covered): allocation priority order across
  series; skips codes used in event (incl. `;`-multi-code strings); skips
  inactive entries (they never appear in allocation input — test the lib
  against realistic input); duplicate code across two series → second
  series' entry used once first is consumed; exhaustion → fallback ≥ 31
  gap-fill with `entry: null`; empty allocation → fallback; SRR entry
  passthrough.
- **Integration**
  `packages/api/src/__tests__/integration/control-series.test.ts`:
  series CRUD; `moveSeries` swaps priorities; `addControls` range insert +
  skip counts + span limit; `allocation` ordering (priority, code, active
  only, borrowed flag); cascade delete.
- **E2E** `e2e/control-series.spec.ts`: in `/library` create series
  "Own" (codes 31–33, code 33 toggled SRR) and borrowed series "Lent"
  (codes 40–41); on an `E2E_` event with a map, open the course editor and
  place five controls → created codes are 31, 32, 33, 40, 41 (assert via
  controls list); control 33 shows the radio badge on ControlsPage
  (`internal_radio` auto-set); place a sixth control → exhaustion notice
  visible and code falls back to 34. Call `await reseed()` per E2E hygiene
  if seed data is mutated; clean up series rows in afterAll (add a helper
  or delete via API).

## Documentation

Extend `docs/club-library.md` with the controls section (series model,
priority allocation, SRR semantics, borrowed inventory); update
`docs/features.md` and the course-editor section of
`docs/course-editor.md` (allocation now series-aware).

## Acceptance criteria

1. Course editor allocates own-club codes first, borrowed after, event-used
   codes skipped, with graceful fallback + notice past exhaustion.
2. SRR-flagged units yield controls with `radioType: internal_radio` on
   placement, visible as radio in ControlsPage and usable by LiveResults.
3. Library Controls tab manages series/codes/types/availability with both
   locales complete.
4. Existing course-editor behavior is unchanged when no series are defined.
5. Full §6 checklist passes.

## Out of scope

- Per-event reservation/checkout of physical units, date-based lending
  windows, `public_radio` distinction at inventory level (SRR maps to
  `internal_radio`; planners upgrade manually), syncing series to station
  programming.
