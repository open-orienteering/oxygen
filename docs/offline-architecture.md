# Offline / Distributed Architecture — Portable Server + Per-Event Lease

> **Status: target architecture.** The phasing that implements this design
> lives in [`future-architecture.md`](future-architecture.md) (Steps 1–6).
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
(`start.adjusted`) — plus the class/course/control state that result
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
leased-out event is unsupported (it is a pre-race operation in practice).

### Consequence: checkin is cheap

Because non-journaled data is never written on the venue, **checkin is
just a journal-watermark barrier** (all venue entries shipped and acked
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
> (`SYNC_SETTINGS_REFRESH_MS`, default 5 min; closure fields excluded).

One row per checked-out event: `event_lease (event_id, holder_node_id,
acquired_at, released_at, forced)`.

- **`checkout`** — requires the venue to be fully shipped-up-to-date.
  The initial transfer is a snapshot import of the event (rows copied
  over, `seq` values preserved — explicit `seq` on insert is supported by
  the `allocate_event_seq()` trigger) plus journal-from-there. From this
  point the cloud rejects race-critical writes for the event.
- **`checkin`** — a barrier: all venue journal entries shipped and acked,
  then the lease is released and the cloud resumes writing. Nothing else
  to reconcile (see [ownership](#ownership-follows-the-journal)).
- **`forceTakeover`** — explicit operator confirmation for the
  venue-box-died case. Recovery point = last shipped watermark. A revived
  box's un-shipped entries drain through `events.push` with conflicts
  logged — a rare, loud path by design.
- **`status`** — powers the UI badge (lease holder, connection mode,
  shipping lag).

### `seq` allocation during a lease

Per-event `seq` values (the human-friendly URL ids) are minted by the
`allocate_event_seq()` trigger from `event_seqs`. **The leaseholder is the
only allocator while the lease is active.** The checkout snapshot carries
the `event_seqs` counters to the venue; the follower (cloud) applies
shipped entries with explicit `seq` values (the trigger honors supplied
values), so it never re-allocates and collisions cannot occur. At checkin
the counters travel back with the barrier.

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
- **`events.since`** — paginated pull in canonical `(hlc, id)` order,
  guarded by the shared secret (`peerProcedure`); stations never call it.
- **Shipper worker** (venue side): push local entries above the peer
  watermark to the peer's `events.push`; pull cloud-originated entries
  (e.g. ROC punches) via `events.since`; apply idempotently through the
  same `ingestJournalEntries` path the push endpoint uses.
  `journal_sync_state` stores per-peer `(hlc, id)` cursors for both
  directions.
- The **follower applies register entries verbatim** — the leaseholder
  already made every decision; the replica does not re-resolve conflicts.
  `runner.updated` replays its portable field patch through the same
  translation as the `runner.update` mutation, without re-running card
  conflict validation. Append-only types apply on any node via their
  dedupe keys (`punch.recorded` checks `(cardNo, controlCode, time)`
  before insert; `card.read` uses the ±60 s readout window).
- Watermarks advance only after contiguous application: entries are
  applied in HLC order per peer, so a watermark never skips past an
  unapplied entry. A permanently failing entry therefore **blocks its
  event's stream and logs loudly every cycle** — deliberate; quarantine
  tooling arrives with the lease UI (Step 4).
- Entries a node ingested from its peer are pushed back once as the
  watermark passes them (no origin tracking); the peer acks them by id
  without re-applying. One round of wasted bandwidth per entry, zero
  correctness cost.

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
- `computeLocalReadout` (the client-side readout fallback) remains for
  blip-mode card reads, with parity to the server path asserted by tests.

## Transport: Local Network Access (no TLS certificates)

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
excludes venue base URLs from caching so stale responses never shadow the
LAN node.

## Retention and compaction

Two long-lived nodes with explicit watermarks make retention simple:

| Store | Prune when |
|---|---|
| Station outbox | entry durably acked by its node (as today, 24h grace) |
| Venue journal | below the cloud-ack watermark, after checkin |
| Cloud journal | never during the event; archival policy after results are final (the journal is the audit log) |

Deferred until after venue packaging lands; mechanically it is
`DELETE … WHERE hlc < floor`.

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
