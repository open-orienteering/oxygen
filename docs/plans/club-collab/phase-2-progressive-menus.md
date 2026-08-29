# Phase 2 — Progressive Shell Menus (content-driven tabs)

No dependencies. Touches `packages/web/src/pages/CompetitionShell.tsx`,
`packages/api/src/routers/event.ts`, `packages/shared/src/types.ts`.

## Goal

A fresh event should open with a stripped-down tab bar focused on
planning (classes, courses, map), and race-related tabs should surface
automatically as the event acquires content. Nothing is ever hidden —
irrelevant tabs collapse into the existing More overflow.

## Current state (verified)

- `CompetitionShell.tsx` declares a static `tabs` array with fixed
  `isOverflow` flags: primary = dashboard, runners, startlist, results,
  classes, courses, controls, cards, tracks; overflow = event,
  course-editor, registration-trends, clubs, race-group stations,
  test-lab. Active overflow tabs are promoted into the bar; overflow
  entries show group dots (`race` green, `dev` amber).
- `competition.dashboard` already computes: `classes[]`, `courses[]`,
  `totalRunners` (non-withdrawn), `totalControls`, `statusCounts`
  (incl. `resultCount`). It does **not** report whether a map exists.
- Tab badges already consume dashboard counts via `countKey`.

## API changes

Extend the `dashboard` response (and the `EventDashboard` shared type) with:

```ts
contentSignals: {
  hasMap: boolean;      // mapFile.count({ eventId }) > 0  (new query)
  hasClasses: boolean;  // classes.length > 0
  hasCourses: boolean;  // totalCourses > 0
  hasRunners: boolean;  // totalRunners > 0
  hasResults: boolean;  // statusCounts.resultCount > 0
}
```

All but `hasMap` are derived from data the procedure already loads; add one
cheap `mapFile.count`. Compute server-side (single source of truth for web +
future consumers).

## Web changes

### Pure logic — `packages/web/src/lib/shell-tabs.ts` (new, unit-tested)

Move the `tabs` declaration here. Replace `isOverflow: boolean` with a
relevance rule per tab; export:

```ts
computeTabLayout(signals: ContentSignals | null): { primary: TabDef[]; overflow: TabDef[] }
```

Relevance rules (tab is primary when the rule holds, otherwise overflow):

| Tab | Primary when |
|-----|--------------|
| dashboard, classes, courses, controls | always |
| course-editor | `!hasRunners` (planning focus) — overflow once entries exist (as today) |
| runners, startlist, cards | `hasRunners` |
| results | `hasResults` |
| tracks | `hasResults` |
| event, registration-trends, clubs, start-station, finish-station, card-readout, backup-punches, test-lab | never (always overflow, as today) |

`signals === null` (dashboard not yet loaded) → return today's static
layout (runners/startlist/results/cards/tracks primary) to avoid a
flash-reflow on every shell mount for mature events; fresh events get one
reflow when the dashboard lands, which is acceptable.

Keep: `countKey` badges, `group` dots, promotion of the active overflow
tab into the bar (that mechanism already exists and must keep working when
a user deep-links to e.g. `/x/runners` on a fresh event).

### `CompetitionShell.tsx`

- Consume `computeTabLayout(dashboard.data?.contentSignals ?? null)`.
- In the More menu, when at least one normally-primary tab is currently
  overflowed, show a one-line muted hint at the top:
  `nav:progressiveHint` ("More sections appear automatically as the event
  gets entries and results."). Group headers/dots unchanged.

### i18n

`nav` namespace, both locales: `progressiveHint`.

## Tests (write first)

- **Unit** `packages/web/src/__tests__/shell-tabs.test.ts`: empty event →
  primary is exactly dashboard/classes/courses/controls/course-editor;
  `hasRunners` promotes runners/startlist/cards and demotes course-editor;
  `hasResults` promotes results+tracks; null signals → legacy layout;
  never-primary tabs stay overflow in all combinations; every tab id
  appears in exactly one of primary/overflow for all signal combinations.
- **Unit (api)** extend the dashboard unit/integration coverage:
  `contentSignals` correct for an event with/without map, runners,
  results.
- **E2E** `e2e/progressive-menus.spec.ts`: create a fresh `E2E_` event via
  UI → assert tab bar shows only the planning set (assert `runners` tab
  button absent from bar, present in More menu); add a class + course via
  existing helpers, add a runner (registration or runner page via More) →
  reload → runners/startlist appear in the bar. Open seeded `itest` (has
  results) → full bar incl. results/tracks, course-editor in More.
  Existing specs that click tab buttons on fresh events must be swept for
  reliance on the old static layout (they can navigate via More or URL).

## Documentation

Update `docs/features.md`; add a short section to `docs/architecture.md`
(shell navigation) describing content signals.

## Acceptance criteria

1. Fresh event shows the stripped planning bar; tabs appear as content
   accumulates; nothing is unreachable at any time.
2. Deep links to overflowed tabs still work (promotion mechanism).
3. No layout flash on mature events (null-signal fallback).
4. Full §6 checklist passes, including the sweep of existing E2E specs.

## Interplay with phase 4

Phase 4 intersects this layout with per-user capabilities (capability
filtering hides tabs entirely; relevance only decides bar vs overflow).
Whichever phase lands second wires the composition in
`CompetitionShell`/`shell-tabs.ts` — keep `computeTabLayout` pure and let
capability filtering happen on its output.
