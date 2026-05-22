# Registration Trends

The **Registration Trends** page (`/{nameId}/registration-trends`) plots when runners signed up for the open competition, with optional overlay of comparable Eventor events for context. It's reachable from:

- the **More → Trends** tab in the competition shell,
- a **View registration trends** link on the **Event** page,
- a small preview card on the **Dashboard** (only shown when at least one runner has a recorded entry timestamp).

This document describes what data the page draws from, how comparison events are fetched and cached, and how to extend or troubleshoot the feature.

---

## Data sources

### Own competition

Per-runner registration timestamps live on `oxygen.runners`:

| Column         | Type | Meaning                                                              |
|----------------|------|----------------------------------------------------------------------|
| `entry_date`   | int  | YYYYMMDD as integer (carried over verbatim from the MeOS-era format).|
| `entry_time`   | int  | Deciseconds since midnight, local time.                              |
| `entry_source` | int  | `0` = manual, otherwise the Eventor event ID this runner came from. |

Both columns are populated automatically:

- **Eventor import / sync** — `fetchEntries` in [`packages/api/src/eventor.ts`](../packages/api/src/eventor.ts) parses the `<EntryDate><Date>` and `<Clock>` elements from `/api/entries` and writes them to MeOS-format ints (`dateToMeosInt` / `timeToMeosDs`). This was already happening before the trend feature shipped — every Eventor-imported competition has historical entries available.
- **Manual create** — `runner.create` in [`packages/api/src/routers/runner.ts`](../packages/api/src/routers/runner.ts) now stamps both columns to "now" (local time) so on-the-day registrations also appear on the chart. `EntrySource` stays at `0`, which the UI surfaces via an `isManual` flag.

The `registrationTrends.ownTimeline` tRPC procedure reads all rows where `EntryDate > 0`, decodes them via `meosEntryToDate` in [`packages/api/src/timeConvert.ts`](../packages/api/src/timeConvert.ts), and returns ISO timestamps + `classId` + `isManual`. The UI buckets these in the browser.

### Comparison events

Eventor's `/api/entries?eventIds=N` endpoint returns the same `<EntryDate>` element for *any* event the API key can read — not just events from the configured organisation. So as long as the user has an Eventor API key configured, comparison curves can be drawn for arbitrary historical Swedish competitions.

Three procedures drive comparison:

- **`registrationTrends.findComparableEvents`** — wraps `fetchEventsBroad` with a date window centred on the current competition's race date (default ±14 days, adjustable in the picker). Optional `classificationIds` filter restricts results to a competition tier (Championship / National / District / Local / Club / International). When `organisationIds` is omitted (the default), Eventor returns events from any organisation in the date range — that's the desired behaviour for finding *other* clubs' competitions to compare against. The currently-linked Eventor event is filtered out so users can't accidentally compare a competition with itself.
- **`registrationTrends.lookupEventorEvent`** — accepts a bare event ID or a full URL like `https://eventor.orientering.se/Events/Show/12345` and returns lightweight metadata (name, date, organiser) by calling `/api/event/{id}`. Useful as a shortcut when you already know the specific event you want to add; also a fallback path if the broad browse query fails for any reason.
- **`registrationTrends.fetchComparison`** — for each requested `eventId`, returns cached entries if available, otherwise calls `fetchEntries` and stores the result.

If `findComparableEvents` 403s (typically because the configured API key has expired or lost permissions), the procedure throws a `FORBIDDEN` TRPCError pointing the user at re-validating their key from the competition selector or using the paste-by-ID flow as a fallback.

#### Region / discovery limitations

- Eventor has **no lat/long radius** parameter on `/api/events` — the only "region" filter is `organisationIds`, which accepts club or district IDs. The picker doesn't yet expose this; it currently filters by date window and classification only.
- We do not currently maintain a club-to-coordinate map. If/when that's added, the picker UI can be extended to default to "events near my district".

---

## Cache layer

Two shared tables in the `oxygen` schema (declared in [`packages/api/prisma/schema.prisma`](../packages/api/prisma/schema.prisma) as `EventorEventMeta` and `EventorEntryHistory`):

```sql
CREATE TABLE oxygen.eventor_event_meta (
  eventor_event_id  INT          PRIMARY KEY,
  name              TEXT         NOT NULL DEFAULT '',
  start_date        DATE         NOT NULL,
  classification_id INT          NOT NULL DEFAULT 0,
  organiser         TEXT         NOT NULL DEFAULT '',
  entry_count       INT          NOT NULL DEFAULT 0,
  fetched_at        TIMESTAMPTZ  NOT NULL
);
CREATE TABLE oxygen.eventor_entry_history (
  eventor_event_id INT         NOT NULL REFERENCES oxygen.eventor_event_meta ON DELETE CASCADE,
  row_seq          INT         NOT NULL,
  entry_class_id   INT         NOT NULL DEFAULT 0,
  entry_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (eventor_event_id, row_seq)
);
```

### Freshness rules

- **Past events** (start date < now): cached **indefinitely**. Eventor's entry list is finalised when registration closes; nothing changes after the event has happened.
- **Future events**: cached for **1 hour** (`FUTURE_CACHE_TTL_MS` in `registrationTrends.ts`). After that, the next `fetchComparison` call refetches.
- **Manual refresh**: the `Refresh` button on the comparison list calls `fetchComparison({ force: true, ... })` which bypasses the freshness check.

### Throttle

Eventor doesn't publish a hard rate limit but is empirically OK with ~1 request/second per API key. `fetchComparison` uses a process-wide `lastEventorFetchAt` clock and inserts a `setTimeout` between successive calls inside the same batch. Errors per event are caught and reported in the response so one failed lookup doesn't kill the whole batch.

---

## Frontend

The page lives at [`packages/web/src/pages/RegistrationTrendsPage.tsx`](../packages/web/src/pages/RegistrationTrendsPage.tsx). Pure shaping helpers (`buildSeries`, `daysBefore`, `daysToGo`, `entriesToday`) are in [`packages/web/src/lib/registration-trends.ts`](../packages/web/src/lib/registration-trends.ts) so they're unit-testable without a DOM.

The chart itself is rendered with **Recharts**. Each series is a `<Line>`; the own competition gets a solid heavier stroke, comparison events use dashed lighter strokes. A `<Brush>` at the bottom enables horizontal zoom without throwing away off-screen data.

### Axis modes

- **X-axis: Days before race** (default) — normalises every series to `(eventDate - entryDate) / 86400000`. This is what makes a 50-runner club race directly comparable to a 1200-runner championship from a different month.
- **X-axis: Calendar date** — useful for retroactive analysis, e.g. "did our entries spike right after the local newspaper coverage?"
- **Y-axis: Cumulative** (default) — running total. Visually answers "how does our growth curve look against historical similar events?"
- **Y-axis: Per day** — bucketed by local calendar day. Shows the spiky truth: most entries land on the deadline.

### URL state

Axis modes and selected comparison events are persisted in URL search params (`?x=daysBefore&y=cumulative&cmp=[…]`) so a particular view can be shared or bookmarked.

### i18n

A `trends` namespace ships with EN + SV translations (`packages/web/src/i18n/locales/{en,sv}/trends.json`). The nav tab uses `nav.trends`.

---

## Out of scope (today)

- **Real-time auto-refresh** during the countdown. The page refetches on focus and there's a manual refresh button, but it doesn't poll.
- **Geographic radius search**. Eventor doesn't expose it; we'd have to maintain our own club→coordinate map.
- **Original entry date for re-entered runners**. Eventor exposes only the *current* `EntryDate` — if a runner withdrew and re-entered, the original timestamp is gone.
- **Per-class comparison curves**. The class filter applies to the own series only; we don't request per-class breakdowns from Eventor's `/api/entries` because that would multiply the number of cache rows we keep around.

---

## Operational notes

- The page is fully read-only beyond the `runners` / `eventor_*` writes. It does **not** modify any Eventor data.
- Disabling Eventor (clearing the API key) leaves the **own** timeline intact; the comparison picker surfaces a "Connect an Eventor API key" message.
- Cached comparison data is shared across all events on the same Oxygen instance — pulling the same comparison event from event A's view of the chart will populate it for event B too.
