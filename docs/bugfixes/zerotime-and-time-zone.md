# A start at ZeroTime read as "no start", early starters vanished, and station clocks ran in UTC

Review package 8 (RES-04 with DB-05 and SI-33, RES-05, RES-06 with API-14,
SI-23 and CRS-041, RES-08 with DB-12, RES-13 with WEB-41, WEB-40, RES-16 with
CRS-040, BLD-14), 2026-11-26.

## What happened

Runner, class and punch times are stored relative to the event's ZeroTime, and
relative 0 doubles as "no time". Around that:

- **A start exactly at ZeroTime became "no start" (RES-04).** Nothing wrote
  `events.zero_time`, so every event had ZeroTime 09:00, and the draw panel
  proposed 09:00 as the first start. The first runner of each corridor (a whole
  class for a mass start) was stored as 0: "-" on the start list, missing from
  the start screen and LiveResults, no start at readout.
- **Early starters vanished (RES-05).** A start before ZeroTime is negative when
  stored, and the start screen, the in-forest counts, `hasStarted`,
  LiveResults, the Eventor placements and the receipt rank tested `> 0`.
- **Station clocks and "has started" used the server process's zone (RES-06).**
  Cloud Run and the Docker images ran in UTC, so in a Swedish summer the start
  station showed 08:00 at 10:00, and the stations froze without network
  (they showed the last polled value, or 00:00 before the first answer).
- **Backup-memory punches were stored as clock time (RES-08).** Every reader
  adds ZeroTime, so an imported punch read back 9 h late and a rescue push made
  a mispunch worse. Un-pushed backup rows also counted in the readout.
- **Time inputs (RES-13, WEB-41, WEB-40).** `parseMeosTime` read `10:30` as
  00:10:30, and anything with one part as 0; the runner editor saved 600 ms
  after every keystroke, so a pause at `1` cleared a finish. Class max time
  `2:30` was stored as 2 min 30 s.
- **Midnight (RES-16, CRS-040).** Running times were `finish - start`, so a run
  from 23:30 to 00:20 was 0, and the draw did not warn past 24:00.
- **Tests (BLD-14).** Every suite ran in UTC on both sides, so a process-zone
  mix-up could not fail CI.

## How it was fixed

- `event.create` takes the planned first start (the dialog defaults to 10:00)
  and sets ZeroTime one hour before it. New `event.getTimeSettings` /
  `event.setTimeSettings` and an Event Info card edit ZeroTime and the time
  zone; moving ZeroTime shifts stored starts so clock times stay, and is
  refused once timing data exists or while the event is checked out (the zone
  alone can always change). New events take the default zone.
- `toRelativeChecked` refuses a human-entered time exactly at ZeroTime
  (`ZERO_TIME_COLLISION`); the draw proposes ZeroTime + 1 h and refuses a start
  on ZeroTime or past midnight (`blockers` in the preview, Apply disabled).
- `hasTime()` / `{ not: 0 }` replace `> 0` on stored times;
  `computeClassPlacements` gets absolute times from the Eventor upload.
- New column `events.time_zone` (IANA, default `Europe/Stockholm`). Server
  "now" uses `eventNowDs` / `timeOfDayDs`; `race.serverTime` returns the zone.
  The stations use `useEventClock`, which syncs every 30 s and ticks locally.
  The images and compose files also set `TZ=Europe/Stockholm` for backup names
  and logs.
- Backup punches are stored relative, listed as clock time, and ignored by the
  readout, the Eventor upload and LiveResults until pushed. The journal entry
  of an import carries `backupRow: true` and of a push `pushedFrom`, so a peer
  keeps the import as evidence and stores the mirror as `manual`. A backup
  punch exactly at ZeroTime is stored as 1.
  Migration `20261126150100_fix_backup_punch_time_base` repairs existing rows
  and their mirrors on the node that imported them.
- Strict parsers in `@oxygen/shared`: `parseClockTime` (`H:MM`, `H:MM:SS`,
  `HH.MM.SS`, `HHMMSS`, else null) and `parseDuration` (bare minutes; two parts
  are `H:MM` for max time, `M:SS` for intervals). Runner start and finish save
  on blur or Enter only; invalid input is red and unsaved. The draw requires an
  interval of at least 1 s unless the class is a mass start.
- `runningTimeDs` (midnight-safe up to 12 h; a finish before a daytime start
  stays 0) for running times in the readout, result
  lists, the receipt rank, LiveResults and the Eventor upload. A runner with
  running time 0 is not ranked and does not count in the receipt total.
- Vitest pins `TZ` (API in UTC, shared and web in Europe/Stockholm); Playwright
  runs the browser in Europe/Stockholm and the API in UTC.

Left out: [zerotime-followups.md](zerotime-followups.md). Time model:
[system/registration-and-readout.md](../system/registration-and-readout.md), "Time model".
