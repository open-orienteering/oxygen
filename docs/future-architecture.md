# Future Architecture (Post-MeOS)

This document describes the target architecture once MeOS table compatibility is dropped.

## Database: PostgreSQL

PostgreSQL replaces MySQL with:
- Proper schema with foreign keys, constraints, enums
- JSONB for flexible event payloads
- LISTEN/NOTIFY for real-time push (replaces oCounter polling)
- Logical replication for local-to-cloud server sync
- UUIDs for all primary keys (no auto-increment conflicts across stations)
- Timestamps always UTC with timezone

## Event Sourcing

The event queue introduced for offline support becomes the **source of truth**:

```
Events table (append-only):
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  competition_id UUID NOT NULL,
  station_id UUID NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  sequence BIGSERIAL  -- global ordering

Materialized views / projections:
  runners — derived from runner.registered + runner.updated events
  results — derived from finish.recorded + result.applied events
  punches — derived from card.read + punch.recorded events
```

### Benefits
- Complete audit trail (who did what, when, from which station)
- Time-travel debugging ("what did the data look like at 14:35?")
- Trivial sync: exchange event logs between servers/clients, merge by union + dedup
- Offline-first is natural: local events + remote events = same state everywhere
- Undo/redo for free (replay events minus the one to undo)

## Sync Protocol

With events as the foundation, server-to-server sync is straightforward:
- Each server tracks "last sequence received from peer"
- Poll: "give me events where sequence > my_watermark"
- Apply events locally, advance watermark
- Conflicts are impossible — events are immutable facts

This enables:
- **Cloud-only** (small competitions): clients → cloud server
- **Local + cloud** (large competitions): clients → local server ↔ cloud server
- **Local-only** (no internet): clients → local server, sync to cloud later
- **Pure offline** (single station): client-only, sync to any server later

## LAN Peer Discovery

Once events are the protocol, PWA-to-PWA sync on LAN becomes viable:
- A lightweight relay process (or the local Fastify server) on the LAN
- Stations push/pull events to relay
- No cloud needed during race
- Cloud sync happens when internet is available

## Schema Design Principles

- UUIDs for all primary keys
- No MeOS-specific naming (oRunner → runner, oClass → competition_class, etc.)
- Proper relations with foreign keys
- Enums for status values
- JSONB for extensible metadata
- Immutable event log as source of truth
- Materialized views for query performance
