# Settings refresh and venue writes: follow-ups

Left out of fix package 15 ([settings-refresh-venue-edits.md](settings-refresh-venue-edits.md)), 2026-11-26.

1. **No error shown on the cloud.** The venue-owned settings mutations
   (card fee, kiosk key, receipts, Sheets, AIR+, time zone) and
   `control.upsertConfig` now answer `PRECONDITION_FAILED` on the cloud
   during a lease, but their callers in `EventPage.tsx`,
   `PermissionsPanel.tsx` and `ControlsPage.tsx` have no `onError`, so the
   edit just does not stick. There is no global mutation toast yet (see
   [runner-inline-editor-followups.md](runner-inline-editor-followups.md)).
   A "checked out to the venue" hint on these fields would fix both. The
   same goes for the editor's overprint-cuts toggle (`EditorPage.tsx`),
   which is now forwarded from a venue box and fails offline without a
   message.
2. **Unjournaled `control_units` writes on the box.** `control.recordProgramming`
   and the `stationSerial` part of `upsertConfig` write `control_units`
   without a journal entry, so what the box programs during a lease never
   reaches the cloud at checkin.
3. **Control coordinates on the cloud during a lease.**
   `synchronizePositionedControlCoordinates` (`event-map.ts`,
   `map-store/jobs.ts`, `map-store/patches.ts`) writes `controls.lat/lng`
   on the cloud while the box holds the lease, and the box's map refresh
   re-derives neither these nor course lengths (pairs with item 11 of
   [venue-shipping-and-lease.md](venue-shipping-and-lease.md)).
4. **Push lag.** The box pushes on the 5-minute settings cadence and at
   checkin. If the box dies, the cloud has the settings as of the last
   push; a forced takeover keeps those.
5. **Checkin after a takeover.** When the peer no longer lists the box as
   holder, the box's venue-owned settings are not pushed (the push is
   refused, the checkin goes on and reports `settingsNotTaken`), so the
   cloud keeps its own copy, although it does accept the same box's late
   journal backlog. One option for Marcus: accept a push from the last
   forced-out holder when the cloud's columns are unchanged since the
   takeover.
7. **Write and lease check are not atomic for five settings mutations.**
   `setCardFee`, `regenerateKioskKey`, `setRegistrationConfig`,
   `setGoogleSheetsConfig` and `setAirPlusConfig` pass the race guard and
   then write without the lease lock, so an edit that starts the instant a
   checkin begins can commit after the checkin push read the row and stay
   on the box copy only (millisecond window; same as other race
   procedures).
8. **Zero time on a checked-in box copy.** `setTimeSettings` refuses a time
   zone change on a box copy that was checked in, but its zero-time branch
   checks only for an active lease (pre-existing).
6. **PR #254.** The background climb and leg-route jobs (API-15, CRS-014,
   the PR half of MC-36, API-37n, D8's holder refresh) are fix package 23;
   they must call `mayWriteEventData` before writing.
