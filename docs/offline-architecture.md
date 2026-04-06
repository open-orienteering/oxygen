# Offline-First Architecture

Oxygen is designed to work during internet outages — from brief drops to full-day operation at forest venues with no connectivity.

## Design Decision

**Approach**: Custom event-based queue + React Query persistence + shared computation logic.

**Why not PowerSync/ElectricSQL?**
- PowerSync's MySQL support is beta; 14.2 MB client bundle is too large for weak-connectivity venues
- ElectricSQL requires PostgreSQL (Oxygen currently uses MySQL for MeOS compatibility)
- Competition data is small (< 5MB) — a sophisticated sync engine is overkill
- Conflict resolution requirements are simple (each station processes different runners)

## How It Works

### Event-Based Mutation Queue

Every user action that modifies data produces an immutable **event**:

1. Event is stored in IndexedDB (via Dexie) immediately
2. Event is applied to local cached state (optimistic UI)
3. Event is POSTed to server when online
4. If POST fails, event stays queued and drains when connectivity returns

Event types: `card.read`, `finish.recorded`, `result.applied`, `start.recorded`, `runner.registered`, `runner.updated`, `punch.recorded`.

### Data Persistence

- React Query cache is persisted to IndexedDB via `@tanstack/react-query-persist-client`
- Station pages (finish, start, registration) use `gcTime: Infinity` — data survives overnight
- All competition data (runners, classes, courses, controls, clubs) is pre-fetched on station mount
- Existing `useExternalChanges` polling keeps data fresh when online

### Shared Computation Logic

Core readout functions live in `@oxygen/shared` so both server and client can use them:
- `parsePunches()`, `matchPunchesToCourse()`, `computeMatchScore()` — punch parsing & course matching
- `computeStatus()` — MeOS-compatible status computation (OK, MP, DNF, OverMaxTime, etc.)
- `computePosition()`, `computeClassPlacements()` — ranking within class

### Service Worker (PWA)

- `vite-plugin-pwa` with Workbox generates a service worker
- Static assets precached (JS, CSS, HTML, fonts)
- tRPC API calls cached with `NetworkFirst` strategy (3s timeout, 24h cache)
- Web manifest enables PWA installability

## Offline Capabilities

| Feature | Online | Offline |
|---------|--------|---------|
| Finish recording | Server-side | Local computation + event queue |
| Receipt printing | Full data | Local data (position may be incomplete) |
| Start station lookup | Server query | Cached runner list |
| Runner registration | Server-side | Event queue (syncs later) |
| Position calculation | Authoritative | Provisional (based on local data) |
| SI card reading | Works (WebSerial) | Works (WebSerial) |
| Receipt printing | Works (WebUSB) | Works (WebUSB) |

## Deployment Scenarios

1. **Cloud-only** (small competitions): Clients connect to cloud server. Offline queue handles brief outages.
2. **Local + cloud** (large competitions): Local Fastify server on LAN. Clients prefer local. Cloud sync when internet available.
3. **Pure offline**: Client-only with event queue. Sync to any server later.

## Key Files

- `packages/web/src/lib/offline/db.ts` — Dexie schema and event types
- `packages/web/src/lib/offline/events.ts` — Event creation and queue management
- `packages/web/src/lib/offline/sync.ts` — Queue drain logic
- `packages/web/src/lib/offline/persister.ts` — IndexedDB persister for React Query
- `packages/web/src/lib/offline/local-readout.ts` — Local readout computation
- `packages/web/src/hooks/useOnlineStatus.ts` — Online/offline detection
- `packages/web/src/hooks/useEventQueue.ts` — Event queue React hook
- `packages/web/src/hooks/useStationSync.ts` — Station data pre-fetching
- `packages/shared/src/readout.ts` — Shared readout logic
- `packages/shared/src/results.ts` — Shared results logic
- `packages/api/src/routers/events.ts` — Server-side event ingestion

## Receipt Handling

All receipts show "Resultat vid utskrift" (result at time of print). This is truthful regardless of online/offline status — faster runners may always finish later.
