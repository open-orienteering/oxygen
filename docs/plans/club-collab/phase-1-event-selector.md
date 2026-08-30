# Phase 1 — Event Selector Revamp (list, search, type filter)

No dependencies. Touches `packages/web/src/pages/CompetitionSelector.tsx`,
`packages/api/src/routers/event.ts`, `packages/shared/src/types.ts`.

## Goal

Make the landing page scale to many events: a denser, grouped, date-ordered
list with client-side search and a competition-type filter. Clean out the
dead legacy MySQL fields from the create form. Lay out the page so a future
calendar view can slot in (no calendar in this phase).

## Current state (verified)

- `competition.list` (`eventRouter.list`) returns `EventInfo[]`
  (`id, name, annotation, date, nameId, eventorEnv?, eventorEventId?`),
  ordered `date desc`, no filtering/search.
- `Event.kind` (string, default `"competition"`) exists but is not returned.
- Eventor classification lives in the global `EventorEventMeta` cache
  (`classificationId`: 1 Championship, 2 National, 3 District, 4 Local,
  5 Club, 6 International; 0 unknown) keyed by `eventorEventId` — no Prisma
  FK from `Event`, join manually.
- `CompetitionSelector.tsx` renders a centered `max-w-lg` card; rows are
  `Link`s with name/date/nameId/annotation + test-Eventor badge + hover
  delete. `CreateCompetitionForm` still renders dead legacy fields (dbName,
  useRemoteDb, host/port/user/password — values are `void`ed) behind
  Show advanced.
- i18n namespace `event` holds all selector strings.

## API changes

- Extend `EventInfo` in `packages/shared/src/types.ts` with
  `kind: string` and `classificationId?: number`.
- `eventRouter.list`: after fetching events, batch-fetch
  `eventorEventMeta.findMany({ where: { eventorEventId: { in: [...] } } })`
  for the linked ids and map `classificationId` onto the result (omit when
  no meta). Include `kind` from the row. Keep `date desc` ordering.
- No new procedures. Search/filter/grouping is client-side (the list is
  small enough; server-side search is future work if clubs accumulate
  hundreds of events).

## Web changes

### Pure logic — `packages/web/src/lib/event-list.ts` (new, unit-tested)

- `groupEvents(events, todayIso)` → `{ upcoming: EventInfo[], past: EventInfo[] }`.
  Upcoming = `date >= today`, sorted ascending (soonest first); past sorted
  descending (most recent first).
- `filterEvents(events, { query, classificationId })` — case-insensitive
  substring match on `name`, `nameId`, `annotation`; classification filter
  matches `classificationId` exactly, with a special `unclassified` bucket
  for events without one.
- `CLASSIFICATION_LABEL_KEYS: Record<number, string>` mapping 1–6 to i18n
  keys (labels translated in the `event` namespace).

### `CompetitionSelector.tsx`

- Widen the card (`max-w-2xl`), keep the existing header/logo/language
  selector and footer (version, purge).
- Above the list: search input (`data-testid="event-search"`) and a
  classification `<select>` (`data-testid="event-type-filter"`, options:
  all + 6 classifications + unclassified; hide the select entirely when no
  listed event has a `classificationId` — pure-local clubs shouldn't see a
  useless filter).
- Grouped rendering: "Upcoming" section then "Past" section with sticky
  small headers; row layout slightly denser than today (single line name +
  date right-aligned, second line nameId/annotation/badges). Add a
  classification badge on rows that have one. Keep hover-delete + confirm
  modal exactly as is.
- Empty states: no events at all (existing key), no matches for
  search/filter (new key + clear-filters button).
- `CreateCompetitionForm`: delete the advanced section (dbName,
  useRemoteDb, host, port, username, password, `remoteMeosWarning`,
  showAdvanced/hideAdvanced toggle) and the `void` statements. Remove the
  now-unused keys from both `event` locale files (verify each key is
  unused elsewhere before removing; `databaseName`, `useSeparateDb*`,
  `remoteMeosWarning`, `showAdvanced`, `hideAdvanced` are the candidates).
  Keep name + date + submit.
- View-toggle affordance: render the list inside a subcomponent
  (`EventList`) so a calendar sibling can be added later. Do **not** add a
  visible toggle yet.

### i18n

New keys in `event` (en + sv): `searchPlaceholder`, `upcoming`, `past`,
`noMatches`, `clearFilters`, `typeFilterAll`, `typeUnclassified`,
`classification1`…`classification6` (Championship/Nationell,
National/Nationell — use proper Swedish orienteering terms:
1 Mästerskap, 2 Nationell, 3 Distrikt, 4 Närtävling, 5 Klubbtävling,
6 Internationell).

## Tests (write first)

- **Unit** `packages/web/src/__tests__/event-list.test.ts`: grouping
  boundary (today counts as upcoming), sort directions, query matching
  (name/nameId/annotation, case), classification filter incl. unclassified
  bucket, combined query+filter.
- **Integration** extend the existing event router integration suite:
  `list` returns `kind`; event linked to a seeded `eventorEventMeta` row
  returns its `classificationId`; unlinked event omits it.
- **E2E** `e2e/event-selector.spec.ts` (new or extend existing selector
  coverage): seed events visible under correct group headers; typing in
  search narrows the list; filter select hidden when no classifications;
  create-form advanced section gone (assert testid absent); create + open
  flow still works. Check existing specs for reliance on removed
  advanced-form testids and update.

## Documentation

Update `docs/features.md` (selector section). No new doc page needed.

## Acceptance criteria

1. Selector shows Upcoming/Past groups, search and (conditional) type
   filter work together.
2. Legacy MySQL fields are gone from UI, code, and both locale files with
   no dangling i18n keys (typed keys compile).
3. `EventInfo.kind`/`classificationId` flow through shared types with no
   `any`.
4. Full §6 checklist passes.
