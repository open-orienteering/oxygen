# ZeroTime and time zone: follow-up review items left as they are

Package 8 ([zerotime-and-time-zone.md](zerotime-and-time-zone.md)) took the
short-term fix for the ZeroTime sentinel. These items were deliberately left
out, so they are decisions, not oversights.

## Left out

1. **Nullable time columns (the "proper" RES-04).** "No time" is still relative
   0. Making `start_time` / `finish_time` nullable touches about 330 lines in
   the API, 250 in the web client (70 in the offline layer), the journal format
   and raw SQL, and cannot ship in one release (AGENTS.md §7: the previous
   image must run on the new schema, and its Prisma client fails on NULL).
   It needs its own package with two releases and a backfill.
2. **Machine-written times exactly at ZeroTime (SI-33).** Card readout, journal
   replay and ROC convert without the check, so a punch at exactly ZeroTime.0
   is stored as "no time". Rare (one tenth of a second per event), and fixed by
   item 1.
3. **Changing ZeroTime after race data exists or under a lease.** That would
   need a shift of punches, `cards.punches_raw` and readouts as well. Refused
   instead.
4. **Runners already drawn at relative 0.** They cannot be told apart from
   undrawn ones; the organiser redraws them (the draw now refuses ZeroTime).
5. **Readout across midnight (RES-16, rest).** Running times are midnight-safe,
   but the matcher and the start screen order by stored time, and Eventor
   `StartTime` / `FinishTime` after midnight carry the event date.
6. **The relative-1 marker.** "Drawn, no time" (relative 1) collides with a
   real start ZeroTime + 0.1 s from `toRelativeWrapped`. Documented, unchanged.
7. **Eventor import without results** keeps the 09:00 default ZeroTime; the
   organiser sets it under Event Info before the draw. Eventor's event start
   clock is not read yet.
8. **Backup punches on a peer.** Rows a peer received through the journal
   before this release were stored as live `card` punches; the repair migration
   only fixes the node that imported them. Re-import on the peer if it matters.
   The web client's local projection still counts a `backup_memory` journal
   entry as a punch.
9. **Other device-local clocks.** Receipt timestamps, SI station clock
   programming and the runner search's running-time filter still use the
   device's own zone; at a venue the device is in the event's zone.
10. **SI-34 (negative `punches_raw` encoding)** and the Test Lab writing
    absolute `punches_raw` (area 01) are separate items.
