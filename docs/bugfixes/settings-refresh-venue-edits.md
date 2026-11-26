# Venue edits of event settings reverted every 5 minutes and never reached the cloud

Review findings MC-08 and MC-36 (main side), fix package 15, 2026-11-26.

## What happened

While a venue box holds an event's lease it refreshes its copy of the
cloud's event row every 5 minutes (`refreshCloudOwnedSettings`, driven by
the shipper). The refresh copied every column except the row identity and
the zero time and date. But several settings mutations run locally on the
box, because they are neither forwarded nor journaled:

- `event.setCardFee`, `event.regenerateKioskKey`,
  `event.setRegistrationConfig` (payment, Swish, receipt texts, org number,
  VAT), `event.setGoogleSheetsConfig`, `control.setAirPlusConfig`, and the
  time zone half of `event.setTimeSettings`;
- `event.updateType` and `course.setOverprintCuts`.

So an arena operator who raised the rental-card fee or regenerated the
kiosk key saw the change revert within 5 minutes. Kiosks holding the new key
then got 401, and receipts showed the old fee. Nothing shipped the row back
at checkin either, so even a change that survived was lost. The header of
`settingsRefresh.ts` and the offline architecture doc said these writes
were forwarded; they were not.

MC-36: `control.upsertConfig` (radio type, AIR+ override, station serial)
journals `control.upserted` but was a plain `coursesEditProcedure`, so the
cloud accepted it during a lease and journaled a control row the venue
would then pull over its own.

## The fix

The event row's columns now have owners during a lease
(`packages/api/src/sync/eventOwnership.ts`; table in
[offline-architecture.md, "The event row during a lease"](../system/offline-architecture.md#the-event-row-during-a-lease)):

- **Venue-owned** (kiosk key, card fee, the registration and receipt
  settings, AIR+ and awake hours, the Sheets webhook, the time zone; plus
  the zero time and date as before): their mutations are race procedures,
  so the cloud refuses them while another node holds the lease. The
  refresh skips them, and the box pushes them to the cloud through the new
  peer endpoint `lease.importSettings` before every refresh and once more
  in the checkin barrier. The cloud takes the push only from the active
  holder's node id, and only venue-owned columns.
- **Cloud-owned**: `event.updateType` (and its `competition.` alias) and
  `course.setOverprintCuts` are now in `CLOUD_OWNED_MUTATIONS`, so the box
  forwards them. After a forwarded event-row write the box refreshes the
  row at once.
- `control.upsertConfig` is a `coursesEditRaceProcedure`.

All other journal emitters on main were checked and were already behind the
lease guard (race procedures, `refreshDerivedCourses` via
`mayWriteEventData`, the Eventor sync refusal). The background climb and
leg-route jobs that API-15 and CRS-014 describe exist only in PR #254 and
are fix package 23.

### Defaults taken

The review left the per-field split to Marcus. Under the fix-package
authorization (2026-11-26) these defaults were taken: everything the arena
changes on the day is venue-owned, so the box keeps working offline and no
edit is lost. The cost is that a cloud admin cannot change those settings
while the event is checked out. `autoOverprintCuts` is forwarded, like the
other layout data (row G18).

## Tests

- `packages/api/src/__tests__/event-settings-ownership.test.ts` (unit): a
  source scan of the routers. Every procedure that writes the event row
  must be forwarded or a venue-owned race write, and a venue writer may set
  only venue-owned columns.
- `packages/api/src/__tests__/integration/lease.test.ts`: box edits survive
  the refresh and the push lands them on the cloud; `importSettings` takes
  only venue-owned columns from the holder; checkin pushes the settings, and
  a failed push keeps the lease; the cloud refuses the venue-owned
  mutations and `upsertConfig` during a lease and writes no journal row.
- `packages/api/src/__tests__/map-refresh.test.ts`: which forwarded paths
  refresh the event row.

No E2E: no E2E stack runs a peer pair (the same AGENTS.md §4 deviation as
[venue-shipping-and-lease.md](venue-shipping-and-lease.md)).

## Bring-up

No migration. Box and cloud must both run this release for the push to
land; a cloud that predates `lease.importSettings` answers NOT_FOUND, which
the box logs and skips.
