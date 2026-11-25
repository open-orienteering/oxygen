# Venue shipping, checkout and the lease lost or duplicated data

Review package 4 of the 2026-11 full code review (findings MC-02, DB-02, SYNC-01, DB-01, SYNC-02, API-07, MC-09, SYNC-07, DB-18, SYNC-08, SYNC-18, MC-22, SYNC-22, MC-23, SYNC-17, MC-32 and their duplicates). Decision D10 (graphic id clash) was taken as recommended.

## What happened

A venue box and the cloud keep their journals converged through a shipper, and trade the per-event write lease through checkout and checkin ([offline-architecture.md](../system/offline-architecture.md)). Several of those paths silently lost or duplicated data:

- **A late entry was never shipped.** Both directions paged on `hlc > watermark`. An entry that arrived on a node late with an old HLC (a station outbox draining after the clock moved on) sorted below the watermark and was skipped for ever. Entries a node pulled were also pushed back once (no origin tracking). The node clock was not seeded from the journal after a restart.
- **Seq counters lagged.** `allocate_event_seq()` acted only on a NULL seq, so rows inserted with explicit seq values (a checkout snapshot, shipped venue rows) left `event_seqs` behind and the next create on that node collided. The snapshot import inserted counters over the trigger's own rows.
- **Checkout replaced the box's copy without asking.** Any signed-in user could check out; it replaced a copy that still held the lease, an event created on the box, or journal entries the cloud never received. The peer `acquire` sat outside the rollback `try`, the rollback failure was swallowed, `acquire` was not idempotent (a retry after a lost reply was a conflict), and the local lease and sync state were written after the import committed, so a crash in between left a half checkout. Readout backups of the old copy were dropped.
- **The snapshot was read in pieces** (the journal head last), so an entry committed mid-export could be in neither the snapshot nor the box's first pull.
- **Checkin could strand the box.** A lost reply to `release`, or a cloud that had already let go, made every retry fail. Race writes during the barrier landed after the count and never shipped.
- **A taken-over box kept writing.** After a force takeover the revived box still thought it held the lease and went on originating race data; the guard ignored the node role.
- **A newer cloud broke a checkout.** Peer rows were spread into Prisma verbatim, so one column the box's schema lacked failed the whole checkout or refresh.
- **A graphic of another event was overwritten silently** when the cloud's graphic id matched one that belonged to another event on the box.

## The fix

Steps 1-4 and 7 landed in the earlier commits of this branch, 5 and 6 in the last two.

1. **Delivery mark instead of a cursor** (`journal.ingest_seq`, `journal.pushed_at`; migration `20261125120000_venue_shipping_lease`). The shipper sends and pulls rows with a NULL mark in arrival order and marks the acked prefix. Peer procedures `events.unshipped` / `events.ackShipped` (`events.since` stays as the fallback against an older peer). Entries received from the peer are created marked, so nothing echoes. Only events with a sync-state row for the peer are shipped. The clock is seeded from the journal at startup. A cursor over `ingest_seq` was rejected: sequence values are allocated before commit, so a lower value can commit after a higher one was served. The migration marks everything delivered except for events with an active lease, which re-push once (deduplicated by id).
2. **`allocate_event_seq()` follows explicit seqs**, with a repair of lagging counters; the snapshot import merges counters with `GREATEST`.
3. **One consistent snapshot.** The cloud marks its existing journal delivered when it hands out the lease, then reads every part in one `REPEATABLE READ` transaction; an entry committed between the two reaches the box through its first pull (re-applying is a no-op).
4. **Checkout guard and restart safety.** Authorisation (`event.manage`, or instance admin for a new event); `CHECKOUT_LEASE_HELD`, `CHECKOUT_LOCAL_EVENT`, `CHECKOUT_UNSHIPPED` refusals (the last two overridable with `discardLocal`); acquire inside the rollback scope with the remedy logged; idempotent `acquire` and peer `release`; sync-state row and local lease written in the import transaction; readout backups kept; checkin tolerates a peer that already let go; the box refuses race writes while the barrier runs (`sync/leaseState.ts`).
5. **A box that is not the holder stops writing.** `mayWriteEventData` (`sync/lease.ts`) is the one guard (`held-elsewhere`, `checking-in`, and on a venue box `checked-in`), used by `raceProcedure` and `isRaceWritable`, and the helper any background writer of course data must call (the D8 helper; nothing on this branch needs it yet). A user `events.push` to a checked-in copy is refused whole, so a station keeps its outbox. The new peer query `lease.holder` lets each shipper cycle detect a takeover: the box releases its own lease (forced), logs an error and keeps shipping its backlog. Peer calls send `x-oxygen-node-id`; the cloud logs a `stale-holder entry` warning for every newly applied entry from a node whose lease ended in a force takeover. A checkin on a box that already let go answers `alreadyReleased` once nothing is pending.
6. **Version skew.** `sync/knownFields.ts` keeps only the columns of this schema's generated model in the snapshot tables and event row, the settings refresh and the map refresh (replaces `dropped-columns.ts`; logged once per name). The snapshot and `lease.holder` carry the newest migration name; a checkout from another schema warns and returns `peerSchema` / `localSchema`.
7. **D10, graphic id clash.** A graphic owned by another event on the box in a travelling id's place fails the checkout with `GRAPHIC_ID_CLASH`, before any bytes are fetched and with nothing written, unless the operator confirms `replaceClashingGraphics` (Venue panel confirmation). The lease-time refresh refuses the same way. A club-library row is replaced as before. Documented in [map-storage.md](../map-storage.md) §7.2; decision row in `docs/research/vector-map-pipeline/decisions/slice-g.md`.

## Tests

- `integration/event-seq-counter.test.ts`: an explicit seq moves the counter for runners, classes, courses and controls.
- `integration/journal-shipping.test.ts`: a late entry ships in both directions, a failing entry still blocks those behind it, a pulled entry is not pushed back, an event without a sync-state row is not shipped, the legacy `events.since` fallback; `serverClock.test.ts` for the seeding.
- `integration/lease.test.ts`: the venue lifecycle with creates on both nodes before and after a checkin; the snapshot overlap exactly once; the checkout refusals and overrides; each injected failure (export, release, `afterImport`, lost checkin reply) recoverable; readout backups kept; D10; takeover detection (the box releases itself, still ships, refuses race writes on `NODE_ROLE=venue`, `lease.checkin` ok); a user push to a checked-in copy refused and the node-secret path open; `lease.holder`; the stale-holder warning; version skew (unknown columns in the snapshot, in a settings refresh, the schema difference reported).
- Unit: `lease-guard.test.ts` (the `mayWriteEventData` matrix), `known-fields.test.ts`.

## Left out

On purpose, to be decided or done elsewhere:

1. **Conflict resolution for a stale holder's backlog** (SYNC-08 "apply only if newer, or quarantine"). It needs a per-row last-write HLC or a subject key per entry type, a design decision. This package makes the box stop writing, release itself and name every stale entry in the cloud log, but the overwrite of a correction made after the takeover remains: SYNC-08 stays partly open.
2. **Request-path course emitters** (`applyUploadedMap`, `setMapRotation`, `useClubMap`, `control.upsertConfig`; MC-36) are review package 15.
3. **PR #254 (leg-route refresh)**: its job should call `mayWriteEventData` before each chunk and before the final climb refresh, and skip rather than throw; neither the job nor its columns are on `main`.
4. **Checkout still wipes `tracks`, `routes` and `event_permissions`** of the box's copy (SYNC-07 side note); only readout backups are kept.
5. **No "box older than cloud" banner** before a checkout: a warning in the log and the `peerSchema` / `localSchema` result fields only.
6. **No two-process HTTP test** (SYNC-41): the in-process harness (peer calls bound to a second database) was extended instead. The HTTP wiring of `unshipped`, `ackShipped`, `holder` and the `x-oxygen-node-id` header is exercised through the router callers only.
7. **A stable event UUID on the wire** (the MC-23 alternative): shipping is scoped by the sync-state row instead.
8. **No E2E spec.** The checkout confirmations and the pending line need a peer, which no E2E stack has (AGENTS.md §4 rule 5 deviation, covered by integration tests and the i18n and panel change).
