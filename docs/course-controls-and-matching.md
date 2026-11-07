# Course Controls and Punch Matching

This document describes how Oxygen represents the control sequence on a
course, how it matches a runner's SI card punches against that sequence,
and how the two layers stay consistent when the user renumbers a control.

> **MeOS naming preserved.** The code paths and column names below use
> the MeOS-era spellings (`oCourse.Controls`, `oControl.Numbers`, etc.).
> Post-migration the same data lives in PostgreSQL tables `courses`,
> `controls`, `course_controls`, with snake_case columns — the logical
> model is unchanged, only the storage layer moved. The MeOS column
> citations in this doc are kept verbatim so the upstream MeOS source
> references still resolve.

## TL;DR

- Each `oControl` row carries two distinct identifiers: a stable
  `Id` (primary key, used by every foreign-key-style reference) and a
  user-editable `Numbers` field with one or more SI punch codes.
- `oCourse.Controls` stores a semicolon-separated list of `oControl.Id`
  values. It never stores punch codes directly. This matches MeOS upstream
  exactly (`oCourse::getControls` in `code/oCourse.cpp:137`).
- All read paths that need punch codes — punch matching, the Courses
  page UI, structured-search filters, offline matching — dereference
  each `Id` to its current `oControl.Numbers` at read time.
- Renumbering a control on the Controls page is a single-row update on
  `oControl.Numbers`. Every consumer picks up the new code on the next
  read; nothing in `oCourse.Controls` (or anywhere else) needs to change.

## Two identifiers on a control

| Field | Type | Mutable? | Role |
|-------|------|----------|------|
| `oControl.Id` | `INT PRIMARY KEY` | No (after creation) | Stable handle. Used by `oCourse.Controls`, `oRunner.Course`, `oMonitor`, etc. |
| `oControl.Numbers` | `VARCHAR(128)` | Yes | One or more SI punch codes, semicolon-separated. Read by punch matching and by the UI when displaying "the code on the cards". |

By default a freshly-imported control has `Numbers[0] = Id`
numerically (`oControl.cpp:263` in MeOS, mirrored in Oxygen's IOF/OCD
import: `parseInt(controlCode)` becomes the new `Id` and a single-token
`Numbers` string). That convention is why most setups never notice the
distinction. As soon as someone renumbers a control via the Controls
page, `Id` and `Numbers` diverge and the dereference layer below earns
its keep.

### Multi-code controls

A single physical control may carry several SI codes — typical for
butterfly loops or shared SI stations. Set `Numbers = "131;231"` and
both codes become acceptable at any course position that references
this control's `Id`. The UI surfaces the first code (`Numbers[0]`) for
display; the matcher accepts every code in the list (mirrors MeOS
`oCourse.cpp:472,483`).

## Storage: `oCourse.Controls`

```mermaid
flowchart LR
  CourseRow["oCourse row<br/>Controls = '31;32;33;'"]
  CtrlRowA["oControl row<br/>Id=31  Numbers='131'"]
  CtrlRowB["oControl row<br/>Id=32  Numbers='32'"]
  CtrlRowC["oControl row<br/>Id=33  Numbers='33;233'"]
  CourseRow -->|Id 31| CtrlRowA
  CourseRow -->|Id 32| CtrlRowB
  CourseRow -->|Id 33| CtrlRowC
```

The semicolon-separated string in `oCourse.Controls` is **always** an
`oControl.Id` list. Start and finish controls are not included — they
live on dedicated columns / records. The trailing semicolon is part of
the MeOS storage convention and is preserved on writes.

This is verified against MeOS upstream:

- `code/oCourse.cpp:137`: `sprintf_s(bf, 16, "%d;", controls[m]->Id);`
  writes the Id list.
- `code/oCourse.cpp:253-264`: `importControls` parses ints and resolves
  each via `oe->getControl(Id, …)`.
- `code/MeosSQL.cpp:748`: `Controls` column is `VARCHAR(512)` matching
  Oxygen's Prisma schema.

## Read paths

All four read paths converge on the same dereference logic, exposed
through helpers in `packages/api/src/routers/course.ts`.

### 1. Punch matching

```mermaid
flowchart LR
  Card["SI card<br/>punch type 131"] --> Match
  Stored["oCourse.Controls<br/>'31;32;33;'"] -->|"resolveCourseExpectedCodes()"| Expected["[[131], [32], [33;233]]"]
  Expected --> Match[matchPunchesToCourse]
  Match --> Result[ok / missing / extra]
```

The matcher (`packages/shared/src/readout.ts`) takes
`expectedCodes: number[][]` — a per-position list of acceptable SI codes.
A single-code position is `[31]`; a multi-code position is `[131, 231]`;
mixing both shapes on one course is fine. Any punch whose `type` matches
any code in the position's set counts as a hit. Mirrors MeOS
`oCourse::distance` (`oCourse.cpp:472-501`).

A backward-compatible normaliser (`normalizeExpectedCodes`) accepts the
legacy `number[]` shape (one code per position) and lifts it to the new
shape, so old test fixtures and any non-resolver call sites keep working.

Server consumers — `cardReadout.performReadout`, `eventor.ts` split-time
upload, `runner.ts` placement — call `resolveCourseExpectedCodes(client,
course.Controls)` once per course and pass the resulting `number[][]`
to the matcher.

### 2. Offline matching

The PWA caches `competition.dashboard` for offline use. Each `CourseInfo`
in that response carries `expectedCodes: number[][]` already resolved
by the server, so the offline `local-readout.ts` can match without a
live database connection. The cache is invalidated by tRPC's
`utils.competition.dashboard.invalidate()` whenever a control's
`Numbers` changes, so reconnecting clients pick up the new codes
automatically.

### 3. Courses page (display)

`course.detail` returns

```ts
controlCodes: { id: number; code: string }[]
```

derived from `resolveCourseControlsToCodes`. Each entry pairs the stable
`Id` (used internally and on save) with the live `code` (first code per
multi-code control, used everywhere a human reads the value). The chip
strip and the editable text input both consume `code`; the user never
sees the underlying Id.

### 4. Courses page (save)

The text input on the Courses page is parsed into a `string[]` of
trimmed punch codes and sent through `course.update({ controlCodes })`.
The server runs `resolveCodesToCourseControls`, which:

1. Matches each token against any `oControl.Numbers` entry first
   (handles renumbered and multi-code controls without surprises).
2. Falls back to `oControl.Id` if the token is not a current punch
   code (lets power users paste an Id list, and lets the MeOS-default
   `Id == Numbers[0]` case work without ceremony).
3. Throws `TRPCError({ code: "BAD_REQUEST", message: "Unknown control
   codes: …" })` listing every unresolved token in one message, so the
   form can render a single, complete error.

The resolved Id list is written back to `oCourse.Controls` in MeOS's
`Id;Id;Id;` shape — storage stays MeOS-compatible regardless of what
the user typed.

`course.create` exposes the same `controlCodes` input for newly-created
courses and obeys the same translation rules.

### 5. Structured-search filter (`control:<code>`)

The runner-list endpoint flattens each course's per-position acceptable
code list into a single `number[]` and ships it as
`runner.courseControlCodes`. The `control:<code>` filter then searches
for runners whose course visits a given live punch code. Multi-code
controls contribute every acceptable code, so `control:131` and
`control:231` both match a runner whose course visits a control with
`Numbers="131;231"`.

## Editing workflows

### Renumbering a single control

1. User opens the Controls page, edits the punch code from `31` to
   `131`. The Controls UI calls `control.update({ id, codes: "131" })`,
   which writes only `Numbers` (`Id` is the primary key, untouched).
2. Every read path immediately sees the new code:
   - The Courses page shows `131` in the chip strip and in the editable
     text.
   - A new card readout matches `131` punches at the corresponding
     position.
   - The structured-search `control:131` filter returns runners whose
     course visits this control.
3. No other tables need to change. `oCourse.Controls` continues to
   reference the unchanged `Id`; results already in `oRunner` /
   `oCard` keep their existing punch records.

### Replacing a control on a single course

The Courses-page edit input lets the user replace one code with another
(e.g. `31;32;33` → `131;42;33` to swap the second control). The save
path:

1. Splits the input on `; , <whitespace>`.
2. Sends `controlCodes: ["131", "42", "33"]` to `course.update`.
3. Server resolves each code: `131 → oControl.Id 31` (existing renamed
   control), `42 → oControl.Id 42`, `33 → oControl.Id 33`. If `42` does
   not exist as a punch code or Id, the save is rejected with
   `BAD_REQUEST`.
4. New `oCourse.Controls = "31;42;33;"` (Id list) is written.

### Multi-code control on a course

Define the multi-code value on the Controls page once
(`Numbers = "131;231"`). On any course referencing this control, the
chip strip displays `131` (first code), and matching accepts either
code at the relevant position. Editing the course's text input back to
`131;…` keeps the multi-code definition intact (the resolver matches
`131` to the existing control by its first `Numbers` entry).

## Test coverage

| Layer | Location |
|-------|----------|
| Pure helpers (`parseCourseControlIds`, `normalizeExpectedCodes`) | `packages/api/src/__tests__/courseHelpers.test.ts` |
| Matcher (`matchPunchesToCourse`, including multi-code, renumbered) | `packages/api/src/__tests__/cardReadout.test.ts` |
| End-to-end renumber → detail → readout → save → unknown-code error | `packages/api/src/__tests__/integration/course-controls-renumber.test.ts` |
| Existing E2E flows (no Id↔Numbers divergence) | `e2e/courses.spec.ts`, `e2e/kiosk-readout.spec.ts`, `e2e/webserial.spec.ts` |
| Variants: the pick and the dealing (`pickLeastPopulated`, `startOrderCompare`, `dealVariants`) | `packages/api/src/__tests__/variants.test.ts` |
| Variants: the pool rule, the invariant at every seam, `distributeVariants`, reads, readout on the runner's variant, events.push dealing | `packages/api/src/__tests__/integration/runner-variants.test.ts`, `eventor-reentry.test.ts` |
| Offline matching on the runner's course (`courseOf`, `computeCardReadout`) | `packages/web/src/lib/__tests__/local-readout.test.ts` |
| Variants on the Classes page, Distribute, the start list keys, the Variant select | `e2e/classes.spec.ts` |

## Status semantics

Each `oControl` has a `Status` value (MeOS enum). The values that affect
matching and time accounting are documented below; the special-control
statuses `Start` / `Finish` / `Check` / `Clear` are control-station
roles, not match-time decisions, and live on dedicated start/finish
records that are not stored in `oCourse.Controls`.

| Status (value) | UI label (en/sv) | Match | Time | Use case |
|---|---|---|---|---|
| `OK` (0) | OK / OK | required, missing → MP | leg counts | the default. |
| `Bad` (1) | Bad / Trasig | skipped — missing is fine; if punched, time is recorded for splits | leg counts normally | reactive: control broke during the race. |
| `Multiple` (2) | Multiple / Multipel | expanded into N any-order positions sharing the same code pool | each leg counts | butterflies / forking clusters; the runner must hit all listed codes in any order. |
| `NoTiming` (7) | No Timing / Utan tidtagning | required, missing → MP | leg into it is **deducted** from running time | transit zones, mandatory transitions, water stations. |
| `Optional` (8) | Optional / Valfri | identical to Bad | leg counts normally | by-design optional positions, e.g. relay bonus controls. |
| `BadNoTiming` (9) | Bad (No Timing) / Försvunnen | skipped (like Bad) **and** the leg into the next required position is deducted | follow-on leg deducted | a control vanished mid-race and runners wasted time hunting. |

The matcher implementation lives in `matchPunchesToCourse`
(`packages/shared/src/readout.ts`) and accepts a per-position
`ExpectedPosition[]`:

```ts
export interface ExpectedPosition {
  codes: number[];      // SI punch codes acceptable at this position
  skipMatching: boolean;// true → missing does NOT count as MP
  noTimingLeg: boolean; // true → leg INTO this position deducted from running time
}
```

The resolver `resolveCourseExpectedPositions`
(`packages/api/src/routers/course.ts`) builds this shape from each
referenced `oControl`'s `Status` + `Numbers` and bakes in the special
behaviours:

- **Multiple expansion**: a single control with `Numbers="31;32;33"` and
  `Status=Multiple` becomes three positions, each accepting any of the
  three codes (`oCourse.cpp:467-477`).
- **BadNoTiming propagation**: the status emits a skipped position;
  when the next non-skipped position is emitted, its `noTimingLeg` is
  set so the leg from the last good control to that position is
  deducted (`oRunner.cpp:1772-1786`).

## Time accounting

`MatchResult.runningTimeAdjustment` carries the deciseconds to subtract
from the raw card duration:

```
canonicalRunningTime = max(0, finishTime - startTime - runningTimeAdjustment)
```

The adjustment is non-zero only when the runner traversed `NoTiming`
positions (or `BadNoTiming` positions whose follow-on leg got the
propagated `noTimingLeg=true`).

This canonical value is the running time everywhere in the system after
this PR:

- **Kiosk**: the big number on the kiosk uses the adjusted time. When
  `runningTimeAdjustment > 0` a small `raw 35:42` subtitle appears so
  the runner sees both numbers and understands why they differ.
- **Admin readout** (`PunchTable` consumed by `CardReadout` and
  `RunnerInlineDetail`): row-level icons distinguish `ok-skipped`,
  `missing-skipped`, and `ok-noTiming`. NoTiming legs render with
  strikethrough on the split time. The header shows
  `Time 32:14 · raw 35:42` whenever a deduction was applied.
- **Runner list / leaderboards**: `runner.list` runs the matcher per
  runner and feeds `runningTimeAdjustment` into `computeClassPlacements`
  and the `runningTime` field on `RunnerInfo`. Placements rank on the
  adjusted time; ties on adjusted time are broken the same way as
  before.
- **Results / start lists**: `lists.ts` (`resultList`) computes the
  adjustment per runner and feeds `computeClassPlacements`.
- **Eventor publication**: `eventor.ts` mirrors MeOS
  `oImportExport.cpp:2325`, exporting the adjusted total
  (`getRunningTime(true)` in MeOS terms) and emitting NoTiming positions
  with `time: undefined` so Eventor renders them as "no timing".
  Skipped (Bad / Optional / BadNoTiming) positions that the runner
  punched are reported with their recorded time; positions they did not
  punch are omitted.
- **Offline**: `competition.dashboard` ships full
  `ExpectedPosition[]` per course on `CourseInfo.expectedPositions`, so
  the offline readout in `local-readout.ts` applies the same evaluation
  rules without contacting the server.

## Inline help

The Controls page (`/controls`) shows a small "How do statuses affect
evaluation?" toggle below the status dropdown — both on the inline
detail view and on the New-Control panel. Expanding it lists every
status with the same coloured pill the page uses elsewhere, a
plain-language description, and a tiny visual showing how the matcher
behaves for that status. The component lives at
`packages/web/src/components/ControlStatusHelp.tsx` and follows the
same pattern as `DrawHelpVisuals.tsx` on the Start-Draw screen.

## Free-order courses

When `courses.order_mode = free_order`, the matcher switches from the
sequential scan above to set membership: every required position must
still be punched, but order does not matter. See
[free-order-courses.md](free-order-courses.md) for the full model,
rendering rules, and IOF `randomOrder` interop.

## Forked courses and variants

A course with variation groups (a root) has one child course per variant
(`course-layer.md` §12): an ordinary course with its own
`course_controls`, length and legs, so punch matching, results and the
Eventor upload read a variant exactly as any course — through
`runner.courseId ?? class.courseId`. The class keeps the root as its
course; its stage-0 `class_course_pools` rows are the root's variants
(the class's **pool**).

**A runner's variant is pre-set before the race** (user answer 3,
2026-11-07): `runner.courseId` is the runner's variant, set by the desk,
dealt per class, or picked automatically — **never by the readout**. A
runner is validated against her own variant only, so a run of another
variant is a mispunch like any other (the red-exit accept of another
variant is F6c's, by hand at the desk). Implementation:
`packages/api/src/variants.ts`.

**The pool rule.** `runner.create` / `runner.update` accept `courseId`
(a course seq): valid only when it is one of the runner's (new) class's
pooled variants, else `PRECONDITION_FAILED` `VARIANT_NOT_IN_POOL` — a
class without a pool takes no `courseId` at all. A class change clears
the variant and deals one of the new class's pool; `courseId: null` on a
pooled class asks for a new deal (the Variant select offers no "none").
`runner.updated.fields` carries the resulting `courseId` (seq or null),
so a peer replays the pick and never re-picks.

**The invariant: every runner in a pooled class has a variant.** The
pick is `assignVariant` — the least-populated variant of the pool among
the class's non-removed runners (withdrawn ones count), ties the first
key. Where it runs:

| Seam | Call |
|------|------|
| `runner.create` without `courseId` (the Registration dialog sends none) | `assignVariant`, journaled in `runner.registered.courseId` |
| `runner.update` / `bulkUpdate { classId }` (a class change) | clear + `assignVariant` |
| `class.create` / `update` / `bulkUpdate { courseId }`, `course.importCourses`' class mapping | `syncClassPool` → `reconcileClassVariants` (deals a fresh pool in start order, balanced; clears a runner left on a variant when the class has no pool) |
| A variant vanishing under re-materialisation (`syncVariants`, `clearRemovedVariants`) | its runners are nulled, then reconciled: dealt one of the remaining pool, null only when the class has none |
| `events.push` of a station `runner.registered` without `courseId`, or a station `runner.updated { classId }` without `courseId` | the writing node (no lease, or the leaseholder) deals one and journals `runner.updated { courseId }` **after** the ingested entry; a follower deals nothing and waits for the leaseholder's entry (single-allocator rule, `offline-architecture.md`) |
| Eventor `sync` (re-entry: new entries, class moves) | `reconcileVariants` over the event's classes, once at the end (not journaled, as the sync's runner writes are not) |
| Test Lab `registerFictionalRunners` / `registerRunners` | `reconcileVariants` |

Pool changes journal in the order `course.upserted` (root, children) →
`class.upserted` → `runner.updated` per runner (`course-layer.md`
§12.4).

**Dealing.** `class.distributeVariants { classId, mode: "startOrder" |
"random", onlyUnassigned, seed? }` (`manageRaceProcedure`) deals the pool
round-robin in key order over the class's runners in start order (start
time ascending, none last; then start number, none last; then name), so
consecutive starters get different variants; `random` shuffles that
order first (seeded Fisher–Yates — a seed reproduces the deal).
`onlyUnassigned` (the default) keeps every runner already on a pooled
variant and gives each other runner, in start order, the
least-populated variant. A runner who **has raced** — a finish time, or
a result status (OK, MP, DNF, DQ, over max time, no timing, out of
competition) — is never re-dealt (`skipped` in the response); the desk
changes her variant by hand. One journaled `runner.updated { courseId }`
per changed runner; the class row is untouched. A class without a pool
is refused (`CLASS_NOT_POOLED`). The draw does not deal variants: run
*Distribute variants* after the draw.

**Reads.** `runner.list` (`courseId`, 0 = the class's), `runner.getById`
(`courseId`, `variantKey`), `lists.startList` (`variantKey`, shown as
`H21 · AC`), `course.variantList` (`runnerCount`, every class on the
root), `class.detail` (`variants: [{ variantKey, courseId, runnerCount
}]`, this class's runners, `[]` without a pool). Matching:
`performReadout` and the results / Eventor paths already read
`runner.courseId ?? class.courseId`; `storeReadout`'s relevance score
(read path 1) and the offline `local-readout.ts` (read path 2,
`courseOf`) read the runner's course before the class's. The dashboard's
`courses` include the variants, and `runner.list` carries `courseId`, so
offline matching uses the runner's variant; a runner registered offline
has none until the writing node deals one on sync, and is matched
against the root meanwhile.

**UI.** The Classes page's class detail lists the variants with this
class's runner counts (`class-variants`, `class-variant-<key>`) and a
**Distribute variants…** action (mode select; *Only runners without a
variant*, on by default; a confirm when it is off). The Runners page's
expanded row has a **Variant** select (`runner-variant`) when the class
has a pool. The start list shows the key after the class.

Out of scope here: relay leg / team variant schemes (`stage` > 0,
teams), a draw-panel option that deals, per-runner named map pages.

## Course length

`courses.length_m` is the course's length in metres; `courses.legs` the
per-leg lengths (`"1200;900;"`). Who wrote them is
`courses.length_source` (TEXT NULL, CHECK `file` | `derived`; migration
`20261106130000_course_length_source`, slice E row E6):

| `length_source` | Written by | Export (IOF / Purple Pen) | Eventor sync |
|---|---|---|---|
| `file` | `course.importCourses` with positions (OCD, IOF, Purple Pen): the file's published length, which may include detours, marked routes or extra distance | the stored length (the derived one when it is 0) | overwritten by the start list's class length when every class of the course agrees |
| `derived` | every re-derivation of an edited course with at least one positioned control (`rebuildCourseLengths`: create, update, sequence edits, control moves, copy, map upload, rotation, a position-less import) | recomputed from the controls' current positions and the map scale (the per-leg rounded sum), the stored length when that is 0 | never overwritten |
| NULL | a course without positioned controls; rows written before E6 without geometry | as `file` | as `file` |

It replaced what `courses.geometry_source = 'editor'` meant to these two
readers: the E6 migration backfilled it 1:1 (`editor` → `derived`,
`ocd` / `xml` → `file`, `''` → NULL) and the writers set it beside
`geometry_source` until E5 dropped that column with the GeoJSON one, so
no exported or synced length changed. It is not in the
`course.upserted` journal payload; it travels with the checkout
snapshot.

Stored lengths of an edited course come from the course layer's derived
legs (`course-layer.md` §4.1): centre to centre between consecutive
positioned controls of the sequence `courseSequenceOf` reads (§6.2
there), **along the leg's bends** when the stored structure has any
(`LegProps.bends`, `course-layer.md` §10.1, F1), each leg
`Math.round(mm × scale / 1000)`, the total rounded once; a leg's style
(`line`, `marked_route`, `none`) and its corridor never change it;
free-order courses keep the length the organiser typed.

The export's `derived` recompute ("recomputed from the controls' current
positions" above) stays straight, centre to centre (user, 2026-11-07): a
course with bent legs exports a shorter `LegLength` / `Length` than it
stores until the IOF / Purple Pen export row (F9) reads the layer's
lengths. Nothing can author bends before the leg inspector (F3).

| Test | Covers |
|---|---|
| `packages/api/src/__tests__/integration/course-export.test.ts` "derives editor-course lengths…", "exports the published length of a 'file' or NULL…" | `derived` recomputes; `file` and NULL export the stored length; 0 falls back to the derived one |
| `packages/api/src/__tests__/integration/eventor-reentry.test.ts` "overwrites a 'file'…", "does not overwrite an editor-owned course…" | the sync's guard on `length_source` |
| `packages/api/src/__tests__/integration/control-editor.test.ts` "course geometry regeneration", "course.clone" | `derived` on create, sequence edits, control moves and copy (the E6 migration's backfill test went with `geometry_source` in E5) |
| `packages/api/src/__tests__/course-geometry.test.ts` "legDistancesMm (from the course layer, E6)" | layer-derived leg lengths = the pre-E6 formula bit for bit |
| `packages/api/src/__tests__/course-geometry.test.ts` "legs along their bends", `integration/control-editor.test.ts` "course.setStructure with bends" | lengths along the bends; style and corridor change nothing (F1) |

## Description autodetect: map source

Suggested descriptions (`control.create` / `update` autofill,
`control.suggestDescription`, the `DESCRIPTION_STALE` check) read the
terrain objects of the event's **pinned map document**, never the
uploaded OCAD file (slice E1, `docs/map-storage.md` §4.6): non-hidden
point / line / area objects whose symbol code — the applied match's
canonical code, else the source code — has an ISOM description entry.
Without a pinned document (no map, or its import has not finished) there
are no suggestions and no stale-description check.

### Matching rules

(Moved here from the legacy editor chapter when E4b deleted it; the
course editor sends the same `autoDescribe` writes, `course-editor.md`
§4.)

Placing a control with `autoDescribe: true` fills the top map-based
suggestion in the same `control.create` write — no menu click needed.
The editor always sends `autoDescribe: true` on a **move** too; the
server then re-describes the control *only if* its current description
is exactly what the autodetect produced for the old position (i.e. the
user never touched it). "N side of boulder" therefore follows the
control to "W side of boulder", and a control dragged into featureless
terrain loses its stale auto description. A hand-edited description is
never overwritten — for those the action bar may offer a single
*Suggested: …* row if the new spot's top candidate differs; applying it
is a normal undoable `control.update`. Undo of a move restores both
position and the previous description.

The pipeline:

```
control.create / update { autoDescribe, xpos, ypos }
  → loadEventMapObjects → suggestDescriptions → store top candidate
    (update: only when no description, or old description ==
     suggestDescriptions(old position))

control.suggestDescription { x, y }   (menu after move)
  → [{ d, c?, e?, f?, g?, isom, distanceMm }] ≤ 3
```

- **`event-map-objects.ts`** — slim objects of the event's pinned map
  document (memoised per document hash; no pin → no suggestions),
  filtered to non-hidden symbols whose code — the applied match's, else
  the source's — is in `ISOM_DESCRIPTION_MAP` (`map-storage.md` §4.6;
  slice E1 moved this off the OCAD parse). Bezier segments are flattened onto the drawn
  curve (8 steps per cubic) — with the raw handles kept as vertices, a
  curved path whose end sits on another path would miss the junction
  tolerance by a millimetre.
- **`isom-description-map.ts`** — ISOM → `{ d, kind, g? }` with
  canonical OCAD codes.
- **`description-autodetect.ts`** — nearest feature per column-D code,
  plus geometric enrichments:
  - **Crossing / junction** (`f=10.001` / `10.002`) when two lines meet
    within 1.5 mm of the control; a line ending up to 0.3 mm short of
    (or past) the other still counts as a junction. The nearer line goes
    in `d`, the other in `e` — also when both are the same kind, since
    the IOF sheet writes "path · path · junction". Within that radius
    the junction always replaces the plain "path" candidate — nobody
    hits the intersection point exactly.
  - **Bend** (`f=11.001`) at a ≥45° polyline vertex.
  - **End** (`g=11.70x`) beside a free polyline endpoint.
  - **Side of** (`g=11.10x`) for point features and compact areas
    (buildings, ruins) from the feature centre; **outside corner**
    (`g=11.50x`) when the control sits at a ≥60° corner of a compact
    area.
  - **Extended areas** (open land, marsh, thicket, …) get a location
    too: **edge** (`g=11.20x`) when within 1 mm of the outline (inside
    or outside), **part** (`g=11.30x`) when well inside a large area and
    ≥2 mm off its centroid, **inside / outside corner** (`11.40x` /
    `11.50x`) at a sharp boundary vertex. Direction is the bearing from
    the area's centroid. A small area (control < 0.8 mm off centre)
    says nothing.
  - **Which of similar** (`c=0.20x`) when another point/compact-area of
    the same D sits within the control circle.
  - **Ranking**: candidates sort by distance, but an extended area ranks
    by *depth from its edge* + 0.5 mm — being inside a clearing is not
    the same as being at it, so a boulder half a millimetre away beats
    the open land it stands in. (`distanceMm` in the response still
    reports 0 for "inside".)

Still out of scope: upper/lower column C (needs contours), between-
features, free-text dimensions, text/rectangle OCAD objects.

## Out of scope

- **Rogaining / score-O** (points, time limit, penalty) and
  CommonControl matching — separate, larger feature. The
  `course_order_mode` enum is designed to grow a `score` value; see
  [free-order-courses.md](free-order-courses.md).
