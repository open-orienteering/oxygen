# Settings refresh and venue writes: follow-ups

Left out of fix package 15 ([settings-refresh-venue-edits.md](settings-refresh-venue-edits.md)), 2026-11-26.

1. **No error shown on the cloud.** The venue-owned settings mutations
   (card fee, kiosk key, receipts, Sheets, AIR+, time zone) and
   `control.upsertConfig` now answer `PRECONDITION_FAILED` on the cloud
   during a lease, but their callers in `EventPage.tsx`,
   `PermissionsPanel.tsx` and `ControlsPage.tsx` have no `onError`, so the
   edit just does not stick. There is no global mutation toast yet (see
   [runner-inline-editor-followups.md](runner-inline-editor-followups.md)).
   A "checked out to the venue" hint on these fields would fix both.
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
   refused and the checkin goes on), so the cloud keeps its own copy.
6. **PR #254.** The background climb and leg-route jobs (API-15, CRS-014,
   the PR half of MC-36, API-37n, D8's holder refresh) are fix package 23;
   they must call `mayWriteEventData` before writing.
