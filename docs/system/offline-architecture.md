# Offline / Distributed Architecture — Portable Server + Per-Event Lease

> **Status: target architecture.** The phasing that implements this design
> lives in [`history/future-architecture.md`](../history/future-architecture.md) (Steps 1–6).
> This document is the *what* and *why*; that one is the *how* and *when*.
> The decision record at the bottom explains why the previous client-replica
> design was abandoned.

Oxygen must work during internet outages — from brief drops to full-day
operation at forest venues with no connectivity. The design that delivers
that is deliberately boring: **make the server portable instead of making
every client a replica.** A venue box (operator laptop or Raspberry Pi) runs
the *same* Oxygen server image as the cloud; stations stay plain tRPC
clients and only swap their API base URL. The one distributed problem left
is syncing two long-lived server nodes (venue ↔ cloud), and conflicts are
engineered away with a **per-event single-writer lease** rather than
resolved with CRDT machinery.

## Node model

Two kinds of long-lived nodes, both running the same server image
(Fastify + tRPC + Prisma + Postgres):

```
                                ┌──── internet ────┐
   Off-LAN clients                                                       │
   (mobiles, remote admin) ───────────────────────────────── Cloud node  │
                                                             (Postgres)  │
                                                                 ▲       │
   Venue LAN:                                    journal shipping│       │
   Station PWA ──┐                               + write         │       │
   Station PWA ──┼── LAN (HTTP, LNA) ── Venue node ──────────────┘       │
   Station PWA ──┘                      (laptop/Pi, Postgres,            │
                                         same server image)              │
```

- **Cloud node** — the permanent home of every event. Runs the background
  services that need internet (Eventor sync, LiveResults pusher, ROC
  online-input puller — single-owner services, config-flagged so a venue
  copy never double-runs them).
- **Venue node** — a laptop or Pi running the same Docker images against
  its own local Postgres. Present only on race day, and only when the
  organizer wants LAN-local operation. Zero bespoke binaries: the venue
  stack is the existing `docker-compose` deployment.
- **Stations** — the PWA on operator devices. Always a plain tRPC client
  of exactly one node. No station-side journal merging, no HLC resolution,
  no relay logic. A station's offline resilience is request queuing (see
  [Station resilience](#station-resilience)), not replication.

The PWA itself is always loaded over HTTPS from the cloud (which keeps the
service worker, WebSerial and installability working); only its **API base
URL** points at the venue box when one is reachable.

## Ownership follows the journal

Every competition-scoped endpoint belongs to exactly one of two classes,
and each class has exactly one owner at any moment. The proxying rule for
each class points at its owner.

### Race-critical (journaled) data — owned by the leaseholder

The journaled set is small and closed: punches (`punch.recorded`), card
reads (`card.read`), starts, finishes (`finish.recorded` / `finish.adjusted`),
applied results (`result.applied`), runner create/update/delete
(`runner.registered` / `runner.updated` / `runner.deleted`), draw start times
(`start.adjusted`, which carries the start number as an optional `startNo`;
replay applies it when present) — plus the class/course/control state that result
computation depends on. This is the **dependency closure of live results**:
state that must survive to the cloud and be visible there while the venue is
the intermittently-connected writer.

> **Implementation status (2026-07-15).** The journaled set is complete:
> every mutation in the closure emits its journal entry in the same
> transaction as the table write (`appendJournal`) — the runner-state /
> punch / readout surface (Step 2b), punch edits and backup replay, and the
> class/course/control reference mutations — see
> [Reference data during a lease](#reference-data-during-a-lease).
> `punch.recorded` entries carry their punch row UUID so edits address the
> same row on every node.

- No lease: the cloud is the writer, as today.
- Lease active: the **venue node is the single writer**. Stations on the
  LAN write to it directly. The journal ships every write to the cloud
  continuously (see [Journal shipping](#journal-shipping)), so cloud reads
  — live results, remote admins watching — keep working from the replica.
- Writes arriving at the cloud for a leased-out event get a typed
  `PRECONDITION_FAILED` error: *"checked out to venue."* A reverse-tunnel
  proxy that would forward such writes to the venue over a persistent
  venue→cloud WebSocket was designed and **deferred** — it is the most
  speculative piece of machinery, and the typed error is acceptable until
  real usage proves otherwise.

**Exception: append-only streams are multi-master everywhere, always.**
`punch.recorded` (ROC/radio punches arrive at the cloud even during a
lease) and `card.read` are commutative inserts with dedupe keys
(`(eventId, cardNo, controlCode, time)` for punches; `(eventId, cardNo,
readAt ± 60s)` for readouts). Any node applies them immediately and ships
them to the peer; the dedupe key makes the merge conflict-free by
construction. The lease governs only mutable registers.

### Non-critical (non-journaled) data — owned by the cloud, always

Everything else — event settings not in the closure, club directory,
Eventor administration, reports/exports, map uploads, user/admin — is pure
tRPC, never journaled, and **cloud-owned even during a lease**:

- A cloud-side user hits the cloud directly. It just works; no proxying.
- The same write arriving at the venue node is **forwarded up** to the
  cloud as an ordinary outbound HTTPS tRPC call and executed there. When
  the venue has no internet, the venue returns a typed error: *"requires
  connectivity."* (Venue-side users offline mid-race have no business
  editing report templates; this is the cheap path by design.)
- The venue keeps a **checkout-time copy** of cloud-owned data for local
  reads, refreshed periodically while online. Staleness is acceptable
  because of the boundary rule below.
- **The event's map patch** (`map_patches`, `docs/map-patches.md` §3.4)
  is cloud-owned the same way: it travels in the checkout snapshot's
  `maps` part for the venue's map, and `mapPatch.` writes are forwarded.
- **The event's GPS tracks** (`map_gps_tracks`, `docs/map-gps-tracks.md`
  §1.3) are cloud-owned and not journaled, and they are **not** in the
  checkout snapshot: `mapTrack.` writes are forwarded, and a box's
  `mapTrack.list` answers empty during a lease (mapping is not a venue
  task; user 2026-11-14).
- **Layout and print data** (row G18, slice G answer 4): sheets
  (`course_maps`), templates, course objects and the graphics they draw
  travel in the checkout snapshot (`docs/map-storage.md` §7.2), so the box
  prints from its copy with the uplink down (`docs/course-print.md`
  §8.7): **print reads local, writes go to the cloud**. `courseMap.`,
  `mapTemplate.`, `layout.`, `graphics.` and `courseObject.` mutations are
  forwarded; offline they answer the typed error, so nothing edited on a
  box is lost at checkin. The box follows the cloud's copy (row G19,
  `docs/map-storage.md` §7.2 "Following the cloud during a lease"): on
  the settings cadence it mirrors the event's map files and documents,
  the patch, sheets, templates, course objects, graphics and the classes'
  print overrides, and it refreshes once more right after a layout or
  patch write it forwarded, so an editor on the box reads its own write.
  Offline it keeps what it has.
- **Batches.** The forwarder forwards a tRPC batch only when every
  procedure in it is cloud-owned. A batch that mixes cloud-owned and
  local mutations is refused whole with the typed error (`data.reason:
  "MIXED_BATCH"`; nothing runs), since running it locally would write the
  cloud-owned part on the box — before G18 it ran locally. The web since
  G18 never produces one (a tab on an older bundle can, and is refused):
  both of its tRPC clients send cloud-owned mutations
  through a batch link of their own (`packages/web/src/lib/trpc-links.ts`;
  the list is `@oxygen/shared`'s `cloud-ownership.ts`). The offline error
  carries `data.reason: "CLOUD_UNREACHABLE"`, which the export menu reads
  to skip its sheet-ensuring step and print the box's copy.
- **Global tables** (`runner_directory`, `club_directory`,
  `eventor_event_meta`, `oxygen_settings`) are cloud-owned by definition —
  they are not event-scoped and never participate in a lease.

### The boundary rule (load-bearing)

> **Anything the venue needs to compute results must be in the journaled,
> venue-owned closure.** Zero time, classes, courses, controls, course
> assignments, runner state. The cloud-owned set may never contain data
> that affects result computation.

This is what makes venue-side read staleness of cloud-owned data harmless:
nothing in that set feeds `performReadout`, `matchPunchesToCourse` or
status derivation. When adding a new endpoint, test it against this rule.
New endpoints default to the cheap non-journaled path; journaling is
opt-in for race-critical writes only.

### Reference data during a lease

Classes, courses, controls and their links (course→course-controls,
class→course, control codes/status) are inside the results closure and are
**venue-owned during a lease**, and since 2026-07-15 their mutations
**journal like everything else**:

- Each edit emits a full-row LWW upsert keyed by the row UUID
  (`class.upserted` / `course.upserted` / `control.upserted`), with child
  link tables travelling inside the parent's payload and replaced wholesale
  on apply. Deletes are upserts with `removed: true`.
- The OCAD/IOF course import emits one bulk `reference.imported` entry with
  the complete post-import state; `replaceAll` mirrors the import's wipe on
  the applying node. Course `geometry` blobs stay out of the journal — they
  are derived artifacts that travel with the checkout snapshot.
- Emission re-reads the post-write row inside the mutating transaction, so
  the entry is exactly what landed. One documented exception:
  `importCourses` emits after its (non-transactional) import completes — a
  crash in between loses only the ship, and re-running the operator-driven
  import re-emits.

The remaining non-journaled reference writer is the Eventor entry sync,
which is cloud-owned and forwarded from venues; running it against a
leased-out event is refused (`EVENT_CHECKED_OUT`, any active lease: the
cloud is then not the writer and the sync is not journaled). It is a
pre-race operation in practice; see [eventor-sync.md](eventor-sync.md).

### Consequence: checkin is cheap

Because non-journaled data is never written on the venue, **checkin is
just a delivery barrier** (every venue journal entry shipped and acked
before the cloud resumes writing). There is no snapshot-export step, no
reconciliation, no diffing. See [The lease](#the-lease).

## The journal

The journal is the **ship and audit log — not the read path**. Each node
keeps the normal relational tables as its live, authoritative read model;
state is never reconstructed by replaying the journal.

- **`emitAndApply`:** the journal append happens in the *same Postgres
  transaction* as the table write. A journaled mutation that commits has
  its entry; a rolled-back one doesn't. This makes journal completeness a
  structural property instead of a discipline.
- Entries are stamped with a **hybrid logical clock**
  (`(physical_ms : 48 bits) || (logical : 16 bits)` as an 8-byte
  `BIGINT`), giving a total order across nodes whose wall clocks disagree.
  Each server node keeps a monotonic HLC: tick on emit, fold on receive.
  UUIDv7 entry ids stay the idempotency key; HLC is the sort key.
- Entry shape: `id` (UUIDv7), `type`, `eventId`, `stationId` (origin
  node/device), `actorId` (nullable until the permissions system lands —
  kept from day one so the audit log gains user attribution
  retroactively), `hlc`, `clientTimestamp`, `payload` (JSONB),
  `schemaVersion`.
- The wire format is the existing `events.push` contract — the same
  endpoint stations' outboxes already drain into. Node-to-node shipping
  reuses it unchanged.

### Ingest (`ingestJournalEntries`)

The one path every incoming entry takes (`events.push` for stations and a
peer's shipper, the pull side of the shipper):

- **One transaction per entry.** The journal row is inserted first, then the
  table writes, then the follow-up the apply decided on (a station
  registration's variant deal and its own `runner.updated` entry). Any
  failure rolls all of it back, so a retry re-runs the whole entry; before
  this, a lost follow-up was never repeated because the retry hit the
  idempotency check. The journal row going in first makes two concurrent
  ingests of one id serialize on the primary key: the loser sees the winner's
  row and reports `synced`. Post-commit effects (the Google Sheets push of a
  `card.read`) run after the commit, on the singleton client.
- **Idempotency is per event.** An id already journaled under the same event
  is `synced`; under another event it is refused as `ENTRY_IN_OTHER_EVENT`.
  Row ids inside payloads follow the same rule: a `tempId` or punch `id` that
  belongs to another event is `ROW_IN_OTHER_EVENT`, never a "duplicate".
- **Stop at the first apply failure.** An exception while applying puts that
  entry in `failed[]` with a stable code (`INVALID_PAYLOAD`,
  `ROW_IN_OTHER_EVENT` or `APPLY_FAILED`; the exception text stays in the
  server log) and ends the batch: the entries after it are in neither list.
  Several types are last-write-wins, so applying the later ones now and the
  failed one on a retry would flip their order. The sender keeps the rest
  pending and sends them next round (the shipper marks delivery over a
  contiguous prefix). The batch-stopping codes are `JOURNAL_BATCH_STOPPING_CODES`
  in `@oxygen/shared` (`APPLY_FAILED`, `INVALID_PAYLOAD`,
  `ROW_IN_OTHER_EVENT`), read by the server and the station drain alike.
  Refusals decided before an entry is touched (`FORBIDDEN`,
  `COMPETITION_MISMATCH`, `ENTRY_IN_OTHER_EVENT`) never stop the batch. The
  station-side consequences are under "The station drain" below.
- **Gate, then apply.** `events.push` hands the ingest a per-entry gate: the
  entry's `competitionId` must be the request's event, and on the user path
  the entry's capability must be held (table in
  [authentication.md](authentication.md#journal-push)). The shipper's pull
  path passes no gate.
- **Reference upserts** (`class` / `course` / `control.upserted`,
  `reference.imported`) are untrusted input: a row id that exists in another
  event is refused; `fields` passes a per-entity allow-list shared with the
  emitter (`REFERENCE_ENTITIES` in `referenceJournal.ts`, never `id`,
  `eventId`, `seq`, timestamps); **a key outside the list is dropped and
  logged once**, not an error, so a newer node with an extra column still
  syncs with an older one (the column itself does not travel until both run
  the new code); decimal-string BigInts (`version`, a class's `eventorId`) are
  converted back; every row the payload points at (course controls, pool
  courses, finish control, parent course, a class's course) must belong to
  the event (`INVALID_PAYLOAD`). Child link rows are replaced on the entry's
  transaction, so a failing insert no longer leaves a course without
  controls, and `reference.imported` is atomic as a whole.

### Clock-skew detection

On every successful push, the server returns `serverTimeMs`; the client
compares it against its own wall clock and raises a persistent banner when
the gap exceeds 30 seconds (*"This device's clock appears to be off by
~Ns"*). Station clocks feed HLC physical components, so surfacing skew
early keeps the ordering honest.

## The lease

> **Implementation status (pivot Step 4, 2026-07-15).** Landed:
> `event_lease` table (partial unique index — at most one active lease per
> event), the `raceProcedure` guard, the `lease` tRPC router
> (status / acquire / release / exportSnapshot / checkout / checkin /
> forceTakeover), the checkout snapshot import (UUIDs, `seq` values and
> `event_seqs` counters preserved; `runner.registered` entries now carry
> their `seq` so the follower applies with explicit values), the venue
> forwarder for cloud-owned mutations, and the shell badge + EventPage
> panel. The venue additionally refreshes its copy of cloud-owned event
> settings on a slow cadence while a lease is held
> (`SYNC_SETTINGS_REFRESH_MS`, default 5 min; closure fields excluded),
> and on the same cadence its copy of the event's cloud-owned map rows
> (`lease.exportMapRows`, row G19, `docs/map-storage.md` §7.2).

One row per checked-out event: `event_lease (event_id, holder_node_id,
acquired_at, released_at, forced)`.

- **`checkout`** — run on the box. The initial transfer is a snapshot
  import of the event (rows copied over, `seq` values preserved) plus
  journal-from-there. From this point the cloud rejects race-critical writes
  for the event. The snapshot also carries the event's pinned map — its
  `map_files` row and the source and document blobs by hash, fetched in
  slices through `lease.exportBlob` and checked against their SHA-256 — so
  the box serves `/api/map-documents/:hash` to its kiosk and stations
  ([map-storage.md](../map-storage.md) §7.2). Details below.
- **`checkin`** — a barrier: all venue journal entries shipped and acked,
  then the lease is released on both nodes and the cloud resumes writing.
  Nothing else to reconcile (see [ownership](#ownership-follows-the-journal)).
  Details below.
- **`forceTakeover`** — explicit operator confirmation for the
  venue-box-died case, run on the node that wants control back. Recovery
  point = the last entry the box delivered. A revived box notices the
  takeover and stops writing (see [Takeover detection](#takeover-detection)).
- **`status`** — powers the UI badge (lease holder, connection mode,
  shipping lag; the pending count is shown also when the box holds no
  lease but still has undelivered entries).

#### Checkout: what it refuses, and how it survives a restart

Checkout replaces the box's copy of the event, so it refuses before it
touches anything (message prefix = code, the way `PATCH_STALE` is):

- **Who:** with login on, `event.manage` on the box's existing copy of the
  event, or an instance admin when the box does not hold the event yet.
- `CHECKOUT_LEASE_HELD` — this box still holds the lease: check in first.
- `CHECKOUT_LOCAL_EVENT` — the event was created on this box and never
  checked out from the cloud (no `journal_sync_state` row for the peer).
- `CHECKOUT_UNSHIPPED` — journal entries of the box's copy are not on the
  cloud. A final ship cycle runs first (a network error is tolerated), so a
  healthy link leaves nothing behind.
- `GRAPHIC_ID_CLASH` — a graphic id of the snapshot is held by another event
  on the box ([map-storage.md](../map-storage.md) §7.2). Checked right after
  the snapshot is exported, before any blob is fetched.

The two data-loss refusals take `discardLocal: true` and the clash takes
`replaceClashingGraphics: true`; the Venue panel asks the operator to
confirm and re-calls with the flag (a discard is logged with its count).
Nothing is written before every check passed.

The sequence is restart-safe. The peer lease is taken inside the rollback
scope, so any later failure releases it; if even that release fails the log
names the remedy (retry the checkout — `acquire` is idempotent for the same
holder — or force a takeover on the cloud). The sync-state row that scopes
the shipper to the event and the local lease are written **in the import
transaction**, so a crash leaves the whole checkout or none of it. The
box's readout backups (`card_readout_backups`, the only copy of what a
station's flash held) are carried over a re-checkout; tracks, routes and
event permissions are not.

**Snapshot consistency.** On `acquire` the cloud marks every journal entry
it already holds as delivered (their effects are in the snapshot, so the box
must not pull them), then reads the whole snapshot — tables, counters,
journal head, maps, graphics — in one `REPEATABLE READ` transaction. An
entry committed between the mark and the read stays unmarked: the box's
first pull delivers it even when the snapshot already holds its effect, and
applying it a second time is a no-op (`runner.registered` and
`punch.recorded` skip a row they already have).

#### Checkin, restart-safe

While the barrier runs an in-memory marker (`sync/leaseState.ts`) makes the
box refuse race writes for the event: a write landing after the count would
never reach the cloud. Peer `release` is idempotent for the holder that
already released (the first reply was lost), and a peer that no longer lists
this box as holder (taken over, or the lease moved on) does not strand the
box: every entry is delivered, so it releases locally, marked forced, and
answers `peerAlreadyReleased`. A checkin on a box that already let go (it
released itself after a takeover) ships what is left and answers
`alreadyReleased`; it refuses while entries are still pending.

#### Takeover detection

A box that was taken over while it was dead or offline must not keep acting
as the writer. On every shipper cycle, for each event where the box holds
the local lease, it asks the cloud `lease.holder`. When the answer is another
node, or nobody, the box releases its own lease (forced), logs an error, and
**keeps shipping its backlog**. From then on `mayWriteEventData` refuses
race writes on the box (below). A cloud that cannot be reached, or one older
than `lease.holder`, changes nothing.

On the cloud, peer calls carry the caller's `NODE_ID` (`x-oxygen-node-id`).
When a node whose lease ended in a force takeover pushes entries later, the
cloud still applies them (the journal is the record) but logs one
`[lease] stale-holder entry …` warning per newly applied entry. It does
**not** resolve conflicts: an old value from that backlog can overwrite a
correction made on the cloud after the takeover (see the bugfix note's
"Left out").

#### Who may write an event's race and course data

One guard answers it: `mayWriteEventData(db, eventId)` in `sync/lease.ts`.
It is the guard behind `raceProcedure` (`assertRaceWritable`) and
`isRaceWritable`, and **any background writer of race or course data must
call it** rather than re-deriving the rule (a job that emits course
entries asks before each chunk and skips, not throws, when it may not
write). It refuses with:

| Reason | When |
|---|---|
| `held-elsewhere` | another node holds the active lease |
| `checking-in` | this process's checkin barrier is running for the event |
| `checked-in` | on a **venue** box: the event has lease history but this box does not hold the active lease (checked in, or taken over) |

The cloud with no lease, and any event without lease rows (a box-local
event), stay writable ("no lease: the node you talk to is the writer").

Background writers that call it today: the derived-course refresh after a
map change on the cloud (`event-map.ts`, `refreshDerivedCourses`). While a
venue box holds the lease it neither re-derives nor journals the course
rows (info log, no error): the map change itself stays cloud-owned and goes
ahead, and the holder re-derives lengths with its next course write. The
other request-path course emitters (MC-36) are still review package 15.
`events.push` with a user (a station draining its outbox) is refused for the
whole request with `PRECONDITION_FAILED` when the answer is `checked-in` or
`checking-in`, so the station keeps its outbox and drains to the cloud once
repointed; it is still accepted when the lease is `held-elsewhere` (the
sink must take entries on every node), and the node-secret path is never
guarded.

### `seq` allocation during a lease

Per-event `seq` values (the human-friendly URL ids) are minted by the
`allocate_event_seq()` trigger from `event_seqs`. **The leaseholder is the
only allocator while the lease is active.** The checkout snapshot carries
the `event_seqs` counters to the venue (merged with `GREATEST` into what
the insert trigger already set); the follower (cloud) applies shipped
entries with explicit `seq` values (the trigger honors supplied values), so
it never re-allocates and collisions cannot occur. Counters do not travel
back at checkin: `allocate_event_seq()` itself advances `event_seqs` past
any explicit `seq` it sees, so after the shipped venue rows land the cloud's
next create takes the next free number. The migration repaired counters that
lagged behind their rows.

### Single-copy durability window

While the venue holds the lease, un-shipped journal entries exist **only
on the venue box**. Shipping lag therefore is a data-loss exposure if the
box dies. Mitigations, in order of importance:

1. The shipper runs continuously; lag under normal connectivity is
   seconds.
2. The lease/status badge shows *"venue last shipped N s ago"* — loud and
   always visible to the operator.
3. Stations' own outboxes retain entries until acked, so station-emitted
   writes survive a venue-box death independently.
4. `forceTakeover` + revived-box drain covers the rest.

## Journal shipping

> **Implementation status (pivot Step 3, 2026-07-14).** Landed:
> `sync/nodeIdentity.ts`, `journal_sync_state`, secret-guarded
> `events.since`, and `sync/shipper.ts`. The venue dials the cloud; the
> shipper is enabled by setting `SYNC_PEER_URL` + `SYNC_SHARED_SECRET`.

- **Node identity:** `NODE_ID` / `NODE_ROLE` (`cloud` | `venue`), peer
  URL, and a shared secret via env config (`SYNC_PEER_URL`,
  `SYNC_SHARED_SECRET`, `SYNC_INTERVAL_MS`).
- **Delivery mark.** `journal.pushed_at` is NULL until the entry has been
  delivered to the other node; `journal.ingest_seq` is the local arrival
  order. Shipping works on the mark, not on a position in the HLC order,
  because an entry can reach a node late with an old HLC (a station outbox
  draining after the clock moved on), and an HLC watermark skips it for
  good. Entries a node ingested *from* its peer are created already marked,
  so nothing is echoed back. The mark is one bit per entry, not per peer,
  so only the **holder of the event's active lease** may consume the other
  node's entries: `events.unshipped` serves, and `events.ackShipped`
  accepts, only a caller whose `x-oxygen-node-id` is that holder (an empty
  page, or `FORBIDDEN`, otherwise; with no active lease nobody is served),
  and the box's `shipAllOnce` pulls only for events it holds the local
  lease on. A powered-on copy that was checked in or taken over only pushes
  its backlog. A caller that sends no node id is refused the same way
  (`unshipped` and `ackShipped` are as new as the header; an older box
  pulls through the read-only `events.since`), and a refused pull is warned
  once per event and node. A peer's `events.push` marks its entries
  delivered only when the pusher is the active holder (or nobody holds the
  event): a stale box that drains its backlog to the cloud leaves them
  unmarked, so the current holder pulls them.
  The migration backfills the mark by one rule (see the SQL comment): an
  entry received before the acquire time of the event's latest lease is
  delivered, everything after it stays NULL and ships once (a redundant
  push or pull is harmless, a wrong "delivered" mark loses entries); an
  event without leases starts clean, a cloud whose leases are all released
  is all delivered.
- **`events.unshipped`** and **`events.ackShipped`** (shared secret,
  `peerProcedure`; stations never call them) — the peer's next page of
  entries it has not delivered, in arrival order, and the confirmation that
  marks them. **`events.since`** (paginated pull in `(hlc, id)` order)
  remains for a peer that predates them: the shipper falls back to it on
  `NOT_FOUND` and logs one warning per process.
- **`events.push`** accepts the same secret as the peer's credential: a node
  presenting `x-oxygen-sync-secret` needs no user (the cloud behind an
  invite-only proxy accepts the box's push even when its service account is
  not a member), a wrong secret is `UNAUTHORIZED`, a secret sent to a node
  without `SYNC_SHARED_SECRET` is `PRECONDITION_FAILED`. The secret is
  compared in constant time. The push is still checked per entry for its
  competition (`COMPETITION_MISMATCH`); only the capability check is skipped,
  because the origin node already authorised the write. Without a secret the
  caller is a station and the capability table applies
  ([authentication.md](authentication.md#journal-push)).
- **Shipper worker** (venue side): push local unmarked entries, oldest
  arrival first, to the peer's `events.push`, and mark the acked prefix;
  pull cloud-originated entries (e.g. ROC punches) via `events.unshipped`,
  apply them idempotently through the same `ingestJournalEntries` path the
  push endpoint uses, then `ackShipped`. It ships only events that have a
  `journal_sync_state` row for the peer (written by checkout), so an event
  created on the box is never offered to the cloud. The `(hlc, id)` cursors
  in `journal_sync_state` are legacy, used only against a peer without
  `events.unshipped`. At startup the node clock is raised to the highest
  journal HLC, so a restart cannot issue an entry that sorts behind what the
  node already holds.
- The **follower applies register entries verbatim** — the leaseholder
  already made every decision; the replica does not re-resolve conflicts.
  `runner.updated` replays its portable field patch through the same
  translation as the `runner.update` mutation, without re-running card
  conflict validation. Append-only types apply on any node via their
  dedupe keys (`punch.recorded` checks `(cardNo, controlCode, time)`
  before insert; `card.read` uses the ±60 s readout window).
- The mark advances only over a **contiguous prefix**: a page is walked in
  order and stops at the first entry the peer did not ack, so a failed entry
  is retried every cycle and nothing behind it is skipped. A permanently
  failing entry therefore **blocks its event's stream and logs loudly every
  cycle** — deliberate; quarantine tooling arrives with the lease UI
  (Step 4). A page that marked nothing ends the loop.
- **Version skew.** A row from the peer keeps only the columns this schema
  has (`sync/knownFields.ts`, from the generated Prisma model): in the
  checkout snapshot's tables and event row, the settings refresh and the map
  refresh. The dropped names are logged once. The snapshot and `lease.holder`
  carry the newest migration name; a checkout from a peer on another schema
  warns and returns `peerSchema` / `localSchema`.

## Write routing summary

| Writer | Data class | Lease active | Route |
|---|---|---|---|
| LAN station | race-critical | yes | venue node, directly (LNA) |
| LAN station | non-critical | yes | venue node → forwarded to cloud (typed error if venue offline) |
| Off-LAN client | race-critical | yes | cloud → typed "checked out to venue" error (tunnel deferred) |
| Off-LAN client | non-critical | yes | cloud, directly |
| anyone | anything | no | cloud, directly (as today) |
| ROC / radio punches | append-only | either | whichever node receives them; dedupe merges |

## Station resilience

Stations are clients, not replicas. When a station loses its node
(venue Wi-Fi blip, or cloud drop in cloud-direct mode):

- **Writes** queue in the existing Dexie outbox and drain idempotently
  into the single writer on reconnect — request queuing into one applier,
  no convergence machinery. Drain rejections (`failed` entries) surface in
  the station UI; no silently dropped finishes.
- **Reads** come from a snapshot cache (persisted tRPC snapshots of
  runners/classes/courses) plus a **thin own-writes overlay**: the
  station's *own* pending outbox entries replayed in order on top of the
  snapshot. Sequential self-replay needs no conflict logic — a station's
  writes never conflict with themselves. Add-then-edit-the-same-runner
  survives a blip and a page reload.
- A station never merges foreign entries, runs no HLC resolution, and has
  no relay role. Prolonged fully-standalone CRUD is not a station's job —
  that's the venue node.
- **The query cache belongs to one event** (`lib/offline/cache-scope.ts`):
  one persisted blob per event, an owner marker in the cache, flushed and
  swapped on every event switch. Offline reads never mix events, and a
  readout computed locally is only queued against the event whose cache it
  was computed from. See `registration-and-readout.md` §2c.
- **The kiosk route drains its own outbox** and queues `card.read` (and, when
  the device may write results, `result.applied`) under the event in the URL.
  Queue writes are awaited: a failed IndexedDB write is never reported as
  saved. The standalone kiosk and the Finish Station show a notice; the admin
  shell logs it (a visible notice there is a follow-up).
- `computeLocalReadout` (the client-side readout fallback) remains for
  blip-mode card reads, with parity to the server path asserted by tests.

**With the node unreachable for the whole outage** (review package 9;
`docs/bugfixes/station-outage-resilience.md`). The usual arena failure is
"Wi-Fi up, node unreachable": `navigator.onLine` stays true, so nothing
may wait for an `offline` event.

- **The service worker does not cache tRPC** (SYNC-16). It used to answer
  `/trpc/*` GETs NetworkFirst with a 3 s timeout from a 24 h cache, as an
  ordinary 200: a readout after the race could get the pre-start answer.
  The `trpc-api` and `api-misc` runtime routes are gone and their caches
  are deleted at start (`lib/legacy-caches.ts`). Offline reads come only
  from the persisted per-event query cache, and a request with no answer
  fails as a network error. The readout lookup after a store has its own
  8 s timeout (`DeviceManager`), after which the card resolves locally.
- **The shell opens from cache** (WEB-03, `lib/shell-entry.ts`). When the
  event's cached dashboard exists, the shell opens from it at once and
  `competition.select` runs in the background (`networkMode: "always"`, so
  it settles after an `offline` event too). Only `NOT_FOUND` or a refusal
  (`UNAUTHORIZED` / `FORBIDDEN`) closes it. Any other failure keeps it
  open in cached mode (`data-connection="cached"` on the shell, an amber
  "Offline: showing saved data" pill in the header) and retries: 2 s
  doubling to 30 s, at once on `online` and when the page becomes
  visible. On success it turns live and refetches everything. With no
  cache it shows "Cannot reach the server" with Retry, the same backoff,
  and Reload; never a dead end. The kiosk and start screen run from the
  event's cache as soon as it is claimed, whether or not `select` answered.
  Cached capabilities keep deciding after a failed refetch (they no longer
  fail open).
- **A failing `users.me` keeps the app mounted** (WEB-04,
  `lib/current-user-state.ts`, `lib/session-probe.ts`). The last known
  identity (from the query, or from `localStorage` after a reload) is
  used while it fails; the access gate spins only when nothing is known.
  `users.me` is retried every 15 s while failing. Each network-class
  failure runs a probe that does not follow redirects: `unreachable`
  never reloads; `expired` (an IAP redirect or login page) shows a
  "sign-in expired" banner with Reload over a page in use, and reloads by
  itself only when nothing can be shown: no identity was ever known on
  this device, or the shell has no cached data for the event. That reload
  is bounded (at most two per five minutes per tab). The remembered
  identity is used only while `users.me` gets no answer (also a 502/504
  from the bundled nginx); any answer replaces it. With a venue node
  active there is no probe: the box has no IAP.
- **Per-card lookups are not persisted** (WEB-02). `runner.findByCard`,
  `cardReadout.readout` and `race.finishReceipt` are keyed by card number
  or runner id only; restored on another day they answer a re-read card
  with an earlier runner first. They stay in memory, and the kiosk prints
  a receipt by itself only from answers fetched after its readout screen
  opened and answered successfully (`isFreshSince`, not
  `isFetchedAfterMount`, which a failed refetch also sets;
  `lib/kiosk-print.ts`), once per read. So the kiosk prints no
  receipt from cached rows: with the server unreachable it prints none
  (the Finish Station's local receipt is unaffected).
- **A page that throws stays inside the page** (WEB-15). The shell's routed
  pages have their own error boundary, reset when the first route segment
  changes, so the header, tabs, card notifications and an open
  registration stay. The kiosk readout screen (keyed by the read), the
  kiosk and start-screen routes (which try again by themselves after 30 s,
  as nobody may be at an unattended screen), and the providers (outermost)
  have their own. A failed lazy chunk offers Reload (at most two per five minutes per
  tab), since React keeps a failed import and "Try again" would fail again.

**The course editor's Field-mode outbox** (row D9c; `course-editor.md` §9
"Offline") is a second Dexie table beside `events`, `controlWrites` in the
same `oxygen-offline` database (version 4, additive). It holds the
setter's control moves (`control.update { xpos, ypos }`) and check-offs
(`control.check`) made without a connection, and replays them as the
tRPC mutations themselves — not through `events.push` — in order, through
the editor's write client, each move with the version token it was queued
with. Controls are journaled reference data written on the node the client
talks to ("Reference data during a lease"), not cloud-owned: `events.push`
would apply them as full-row last-writer-wins `control.upserted` entries
keyed by the row UUID, which the web holds neither of, and without the
token neither the field-move rebase nor "Moved by X" (`course-editor.md`
§3) could happen. A refusal (a leased event's "checked out to venue", a
deleted control) is kept as a failed entry with Retry / Discard; nothing
is dropped silently. Its own-writes overlay patches the editor's query
cache (`course.controlCoordinates`, `control.list`) rather than a
projection table, because the canvas reads the cache.

### The station drain (client side of `events.push`)

`lib/offline/sync.ts` empties the `events` outbox into `events.push`.

- **The header comes from the entries, not the URL.** Pending entries are
  grouped by `competitionId`, and each group goes through
  `trpcClientForEvent(competitionId)` (`lib/trpc.ts`): its
  `x-competition-id` header and `?event=` cache scope are that event's,
  whatever page is open. Switching event mid-drain, or draining an event's
  entries from another event's page, can no longer file them under the wrong
  event. The auto-drain (`useEventQueue`) therefore drains every event's
  pending entries, not only the open event's.
- **One lock per competition.** A drain of event A never makes a drain of
  event B return early. A second drain request for the same event starts
  nothing of its own: it asks the running drain for one more pass and waits
  for it (so a Discard or Retry that hits the lock during the last iteration
  is not lost).
- **When the auto-drain starts.** On an enqueue signal (`emitEvent` and
  `retryFailedEvent` bump a module-level sequence and notify
  `subscribeEnqueue` listeners in `lib/offline/events.ts`; `createAutoDrain`
  in `auto-drain.ts` listens), when the device goes online, and when the open
  competition changes; never while a drain runs (work arriving meanwhile gets
  one more pass). The polled pending count is not the trigger, since an entry
  queued while the previous one drains leaves it unchanged; growth of it still
  starts a drain (another tab queued entries), and entries stuck behind an
  `auth` or `event` block raise no signal, so they never retrigger it.
- **Retry after a failed drain** (SYNC-11). A drain that ended on no answer
  (network-class, including the push's 60 s timeout) or a `server` block
  is retried by itself: 2 s doubling to 30 s while the device is online and
  entries are pending; only a clean drain resets the delay, and a new entry
  meanwhile drains at once without resetting it. The tab becoming visible
  again or another node becoming active retries at once. `auth` and
  `event` blocks wait for an operator (a timer would only repeat the
  refusal).
- **Order and the hold rule.** Entries go out ordered by HLC (`compareHlc`;
  the wall-clock `timestamp` only for an entry without an `hlc`), so a clock
  stepped back does not reorder them. A failed entry whose code is batch-
  stopping (`APPLY_FAILED`, `INVALID_PAYLOAD`, `ROW_IN_OTHER_EVENT`) ends that
  competition's pass when the server answers it, and holds every pending entry
  ordered behind it until it is retried (it goes first again) or discarded;
  both drain at once. `FORBIDDEN`, `COMPETITION_MISMATCH` and
  `ENTRY_IN_OTHER_EVENT` hold nothing. An entry that failed as a schema 400
  (`INVALID_PAYLOAD` with `rejectedBySchema: true` on the row) was never
  applied and can never succeed, so it holds nothing either. While entries are
  held the sync panel says "N waiting behind a failed entry".
- **Three blocked reasons**, shown as a "Sync blocked" line in the Sync
  Status panel while entries wait (`getDrainBlockedReason(competitionId)`, kept per competition): `auth`
  (the whole request was `UNAUTHORIZED` / `FORBIDDEN`: sign in), `event`
  (the batch was `BAD_REQUEST` and an empty probe push under the same header
  was refused too: the server does not know this event), `server`
  (5xx, or an HTML answer from a proxy). Entries stay `pending` in all
  three. No response at all (offline) shows no reason. A `BAD_REQUEST` whose
  probe passes means one entry is malformed: the batch is resent one entry
  at a time and only the bad one is marked `failed` (`INVALID_PAYLOAD`).
- **Refusals.** A node answers a refused entry as `{ id, error, capability? }`
  in `failed`, with `error` a `JournalRefusalCode` (`@oxygen/shared`). The
  code and `capability` are stored on the outbox row and shown translated in
  the rejected panel ("Missing permission: Race crew" for `FORBIDDEN`). Text
  from an older server that is not a known code is shown as sent.
- **Retry all** (`sync-retry-all`) requeues every failed entry of the open
  event and drains again, for the case where a role was granted after a
  refusal and the whole queue is red. Per-entry Retry and Discard remain.

## Transport: Local Network Access (no TLS certificates)

> **Implementation status (pivot Step 5, 2026-07-16).** Landed:
> `packages/web/src/lib/node-discovery.ts` (pinned URL probes, cloud
> fallback, climb-back, `venueAwareFetch` with the LNA annotation),
> `docker-compose.venue.yml`, `CORS_ORIGINS` on the API, the sync-panel
> venue-URL input + connection-mode line, and the same-origin restriction
> on the service worker's tRPC cache (the cache itself was removed in
> review package 9, SYNC-16; see "Station resilience"). Ops guide:
> [`ops/venue-runbook.md`](../ops/venue-runbook.md).

An HTTPS-served PWA calling `http://` on the LAN is normally blocked as
mixed content. Chrome 142+ ships **Local Network Access (LNA)**: local
network requests from secure contexts are gated behind a user permission,
and once granted, **mixed-content blocking is lifted** for requests Chrome
knows target the local network — private-IP literals (`http://192.168.x.y`),
`.local` hostnames, or `fetch()` calls annotated with
`targetAddressSpace: "local"`. So the venue box serves **plain HTTP and
needs no TLS certificate**.

- The tRPC client's custom `fetch` (via the `httpBatchLink` fetch option)
  sets `targetAddressSpace: "local"` when the base URL is a venue node.
- The venue server emits ordinary CORS headers for the PWA's HTTPS origin.
  (The `Access-Control-Allow-Private-Network` preflight header belonged to
  the superseded Private Network Access design and is **not** part of
  shipped LNA — LNA is a permission prompt, not a preflight protocol.)
- Operators grant a one-time per-site "connect to local devices"
  permission per device. Venue stations are Chrome 142+ computers, which
  is the fleet we have.
- WebSerial keeps working because the PWA itself is still served over
  HTTPS from the cloud; only the API base URL is swapped.
- **iOS / non-Chrome clients have no LAN path** (no LNA). They connect
  cloud-direct, accepting the extra round-trip. On a fully-offline venue
  they are read-only spectators of the venue via nothing — i.e.
  unsupported as stations; venue stations are Chrome computers.

## Discovery

Base-URL selection, run at boot and on every health-check failure:

1. Pinned URL in `localStorage` (admin override) — used directly if set.
2. Static IP/hostname list from the event's config, probed in parallel;
   first `/health` 200 wins.
3. Cloud fallback (`VITE_API_BASE_URL`).

A background re-probe runs while connected cloud-direct so stations
*climb back* to the venue node when it recovers. The connection mode
(`venue` / `cloud` / `offline`) is surfaced as a badge. The service worker
caches no tRPC answers at all (SYNC-16), so no stale response can shadow
the LAN node or the cloud.

## Retention and compaction

Two long-lived nodes with explicit delivery marks make retention simple:

| Store | Prune when |
|---|---|
| Station outbox | entry durably acked by its node (as today, 24h grace) |
| Venue journal | entries marked delivered (`pushed_at`), after checkin |
| Cloud journal | never during the event; archival policy after results are final (the journal is the audit log) |

Deferred until after venue packaging lands; mechanically it is
`DELETE … WHERE pushed_at IS NOT NULL AND hlc < floor`.

## Known traps

- **Time units at the SI boundary.** SI hardware and the WebSerial mock
  speak seconds-since-midnight; the API contract is absolute deciseconds.
  Every emit path — online mutation *and* offline outbox payload — must
  convert. (A missed conversion in the offline `card.read` path was one of
  the latent bugs that motivated this redesign.)
- **Single-owner background services.** `liveResultsPusher`,
  `onlineInputPuller`, Eventor sync run on the cloud only (config flag).
  A venue copy must never double-push.
- **Large/streaming endpoints** (map tiles, 50 MB uploads) are cloud-owned
  non-critical endpoints; they are simply unavailable at an offline venue.
- **Venue box sleep.** A laptop venue node must not sleep mid-race; the
  ops runbook covers OS sleep settings and the UI badge shows node
  liveness.
- **Lease discipline.** Forgetting to check in leaves the cloud rejecting
  race-critical writes for an event whose venue box is powered off.
  Mitigations: the lease badge, a *"venue last seen N ago"* indicator, and
  `forceTakeover`.
- **Checkout/checkin barrier correctness** (in-flight entries during
  transfer) is the trickiest logic in the design — build it as an explicit
  state machine with tests before wiring any UI.

---

## Decision record: why the client-replica design was abandoned

*(June–July 2026. The abandoned design is preserved in git history; its
Phase 1 shipped and its keepers — journal schema, HLC, dedupe helpers,
outbox, clock-skew banner — carry forward into this architecture.)*

The previous target (2026-04 → 2026-06) made **every PWA a database
replica**: an append-only journal + HLC on every device, a shared CRDT
reducer (`applyEvent`) folding entries into a Dexie projection, station
pages reading from the projection, and an optional LAN relay binary
gossiping entries between stations and up to the cloud. Internally
coherent — and wrong for this project:

1. **Three hand-synchronized conflict implementations.** The shared
   reducer was dead code; the cloud's `events.push` resolved conflicts
   with its own arrival-order guards; the web projection overlay
   re-implemented those guards by hand ("mirror cloud guard" was a
   literal code comment). The design's central promise — *one reducer,
   convergence by construction* — was false in the code, and every future
   domain rule would have carried a permanent three-way commutativity
   burden.
2. **Domain logic duplicated into the client by construction.**
   `computeLocalReadout` shadowing `performReadout` was only the start;
   every feature touching race state would have needed a client twin.
3. **The journal was incomplete by construction.** Online writes
   (`recordFinish`, `storeReadout`, `applyResult`, runner CRUD, draw,
   Eventor, online input) bypassed it entirely, while the relay phase
   structurally required completeness — a cutover the phasing never
   scheduled. The fallback-only offline path was the least-tested code at
   the highest-stakes moment; a review found three latent bugs in it
   (missing `card.read` apply case in the cloud, a seconds-vs-deciseconds
   drift in the offline readout payload, and a cardless lookup key that
   could never match).
4. **The relay binary was a fourth implementation surface** (SQLite
   storage adapter, its own replication worker) for a project maintained
   by a very small team.

The pivot keeps the genuinely good parts — the journal substrate, HLC
stamps, dedupe-key multi-master for append-only streams, the outbox — and
moves the replication boundary from *N stations* to *two servers*, where
the single-writer lease makes convergence trivial. Multi-master merge for
mutable registers remains a documented per-type growth path on the same
journal substrate — not a rearchitecture — if a real need ever surfaces.

Also considered and rejected:

- **Postgres logical replication** venue↔cloud: operationally fragile
  over intermittent venue links, no audit log, no per-type semantics.
- **PowerSync / ElectricSQL / Replicache**: bundle size, WebSocket
  assumptions unfit for forest venues, and the dataset is small (<5 MB).
- **General-purpose CRDT documents (Yjs/Automerge)**: heavyweight
  document model, awkward fit with relational FKs. The append-only
  streams keep hand-built CRDT set semantics (dedupe keys) — it is the
  library/document model that was rejected, not the principles.
- **WebRTC mesh between PWAs**: only earns its keep when an entire event
  runs on mobiles, where cloud-only suffices anyway.
