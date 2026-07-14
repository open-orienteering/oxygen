# Future Architecture — Implementation Plan

This document tracks longer-term architectural work past the MeOS-compatibility drop. Pieces move from "Planned" to "Landed" as they ship.

## Landed

### Database: PostgreSQL ✓ landed (May 2026)

The PostgreSQL 18 cutover replaced the MeOS-compatible MySQL layout with:

- Proper schema with foreign keys, constraints, enums
- JSONB for flexible event payloads
- LISTEN/NOTIFY hooks reserved for real-time push (currently still using `oCounter`-style polling)
- Logical replication path open for future server↔server sync
- Hybrid `UUIDv7` + per-event `seq` keys (no auto-increment conflicts across stations, human-friendly URLs)
- Timestamps always UTC with timezone

See [`migrations/2026-drop-meos.md`](migrations/2026-drop-meos.md) for the migration details and the cutover steps.

### Offline Phase 1: journal substrate ✓ landed (2026-06-01)

Shipped under the previous (client-replica) direction and carried forward into the current one:

- `event_log → journal` rename with `hlc` / `schema_version` / `actor_id` columns.
- `@oxygen/shared/{hlc,journal}.ts` — the pure HLC and the conflict-decision / dedupe helpers, fully unit-tested.
- `runners.card_no` made nullable with a **partial** unique index `(event_id, card_no) WHERE removed = false` (one card per event; soft-deletes free the card; cardless runners use `NULL`).
- `events.push` rewritten to resolve race-state by `(eventId, cardNo)`, persist the new columns, accept optional `hlc`/`schemaVersion`/`actorId` wire fields (legacy clients keep working — HLC is synthesised from `timestamp`), and return `serverTimeMs`.
- The web emit layer stamping HLC (device clock in `localStorage`) and the clock-skew banner.

A shared CRDT reducer (`applyEvent.ts`) also shipped with Phase 1 and was **removed** in the July 2026 pivot — see the decision record in [`offline-architecture.md`](offline-architecture.md).

### Offline pivot Step 1: working-tree triage ✓ landed (2026-07-14)

The pivot from the client-replica design to the portable-server design (decision record in [`offline-architecture.md`](offline-architecture.md)). Deleted the shared reducer, simplified the web projection to a snapshot cache + own-writes overlay, and fixed two latent bugs on the offline fallback path: the seconds-vs-deciseconds drift in the DeviceManager's offline `card.read` payload, and the missing `card.read` apply case in the cloud's `events.push` (now routed through the same `storeReadoutImpl` as online readouts, guarded by the dedupe window).

---

## Planned: Portable server + per-event lease

The target design is documented in [`offline-architecture.md`](offline-architecture.md) — that document is the *what* and *why*. This section is the *how*: phasing, status, and open questions.

### Goal

A venue box (operator laptop or Pi) runs the same Oxygen server image; stations stay plain tRPC clients. The venue and the cloud sync by shipping the journal; conflicts are engineered away with a per-event single-writer lease. Ownership follows the journal: race-critical (journaled) data belongs to the leaseholder, non-critical (non-journaled) data belongs to the cloud always.

### Phased rollout

Each step is independently shippable and rollback-able.

| Step | Scope | Status |
| ---- | ----- | ------ |
| **1. Working-tree triage** | Delete the shared reducer, simplify the projection to snapshot-cache + own-writes overlay, fix the latent offline-path bugs (`card.read` apply case, deciseconds drift). | ✓ **Landed** (2026-07-14) |
| **2. Journal completeness for the race-critical set** (keystone) | `packages/api/src/journalEmit.ts`: `appendJournal(tx, …)` — journal insert in the **same transaction** as the table write. `packages/api/src/serverClock.ts`: monotonic server HLC. Wire into the race-critical mutations only: `race.ts` (`recordFinish`), `cardReadout.ts` (`storeReadout`, `applyResult`), `runner.ts` (create/update/delete), draw start times, `onlineInput` (ROC punches), plus the class/course/control state live results depend on. Extend `packages/shared/src/journal.ts` with typed payloads for the new entry types and the `events.push` wire enum with the remaining race-critical types. Everything else stays pure tRPC and is never journaled. | **2a landed** (2026-07-14): `journalEmit.ts` + `serverClock.ts` (tick on emit; `events.push` folds received stamps) + `recordFinish` → `finish.adjusted` as the pattern proof. **2b remaining:** roll the pattern out to the other race-critical mutations + wire enum. |
| **3. Node identity + journal shipping** | `NODE_ID` / `NODE_ROLE` (cloud\|venue) / peer URL / shared secret via env. `journal_sync_state` migration (per-peer watermarks). `events.since` paginated pull. `packages/api/src/sync/shipper.ts`: background worker pushing local entries above the peer watermark to the peer's `events.push`, pulling via `events.since`, applying idempotently (follower applies register entries verbatim; append-only types apply anywhere via dedupe). Integration harness: two API instances against two test databases. | Planned |
| **4. Lease mechanics + non-critical write forwarding** | `event_lease` migration. tRPC `lease` router: `checkout` (venue fully shipped-up-to-date; initial transfer = snapshot import incl. `event_seqs` counters), `checkin` (barrier: all venue entries shipped + acked), `status`, `forceTakeover` (explicit operator confirmation; revived-box entries drain through `events.push`, conflicts logged loudly). Cloud rejects race-critical writes for leased-out events with a typed error. Venue forwards non-critical writes upstream to the cloud (ordinary outbound tRPC call; typed error when offline) and refreshes its local copy of cloud-owned data periodically. Checkout/checkin UI + lease/connection badge in `CompetitionShell.tsx`. | Planned |
| **5. Venue packaging, discovery, LNA transport** | Venue compose file reusing the existing images + ops runbook (incl. sleep settings, shipping-lag indicator). `targetAddressSpace: "local"` on the tRPC client fetch for venue base URLs; ordinary CORS on the venue server (no TLS certs — Chrome 142+ LNA permission lifts mixed content for LAN targets). PWA discovery: pinned URL → static list `/health` probes → cloud fallback → periodic climb-back; connection-mode badge; service worker excludes venue URLs from caching. iOS / non-Chrome clients are cloud-direct only — documented. | Planned |
| **6. Station resilience polish** | Snapshot cache + thin own-writes overlay (from Step 1's repurposed code) wired into the station pages behind the feature flag; surface outbox drain rejections (`failed` entries) in the station UI — no silently dropped finishes. | Planned |

**Deferred within this plan:** the reverse-tunnel proxy (cloud→venue forwarding of off-LAN race-critical writes over a persistent venue-dialed WebSocket). Designed, then descoped: the typed "checked out to venue" error is the interim behaviour, and the tunnel is added later only if that error path hurts in real operation.

### Verification

- **Unit**: HLC monotonicity/tie-breaks (exists); dedupe helpers (exists); own-writes overlay replay; DeviceManager offline payload units.
- **Integration** (two-node harness, extends `packages/api/src/__tests__/integration/`): checkout → venue writes → cloud replica converges; ROC punch at cloud during lease appears at venue; write to a leased-out event at the cloud → typed error; checkin barrier; force-takeover + revived-box drain; `events.push` idempotency + `card.read` apply.
- **E2E**: station flow against a venue node; airplane-mode station queues and drains with parity to the online path.
- **Manual**: LNA reachability (permission grant + CORS) and discovery on a real laptop venue node; Wi-Fi-drop cycle at a readout station; WebSerial readout against the venue box while the PWA is loaded over HTTPS.

### Open questions

- Checkout/checkin barrier state machine details (in-flight entries during transfer) — design with tests before wiring UI (Step 4).
- Initial checkout transfer: snapshot import + journal-from-there (recommended) vs. full journal replay — confirm during Step 4 design.
- Journal retention/compaction — deferred until after Step 5 (two-node watermarks make it a simple `DELETE WHERE hlc < floor`).
- Venue-copy refresh cadence for cloud-owned data (lean: on checkout + every few minutes while online).

---

## Deferred

These were considered and explicitly deferred or abandoned. Revisit only if a real need surfaces.

- **Client-replica offline-first design** (every PWA a database replica: shared CRDT reducer, Dexie journal fold, LAN relay binary). Abandoned July 2026 — full decision record in [`offline-architecture.md`](offline-architecture.md).
- **Reverse-tunnel proxy** for off-LAN race-critical writes during a lease. Designed; deferred behind a typed error (see above).
- **WebRTC mesh between PWAs.** Only earns its keep when the entire event is hosted on mobiles/tablets — and in those cases cloud-only is usually sufficient anyway.
- **Full permissions / user-management system.** The journal carries `actor_id` (nullable, always `null` today) so the audit log is forward-compatible; the auth and UI side is out of scope.
- **General-purpose CRDT documents (Yjs / Automerge).** Bundle size, mental-model shift, awkward fit with relational FKs. The append-only streams keep hand-built dedupe-key set semantics; it is the library/document model that was rejected, not the principles.
- **PowerSync / ElectricSQL / Replicache.** Dataset is small (< 5MB), bundle size is high, and the sync model assumes long-running websockets we cannot rely on at forest venues.
