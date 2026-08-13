/**
 * Journal shipper (pivot Step 3).
 *
 * Background worker that keeps this node's journal converged with its peer:
 *
 *   - **Push**: local entries above the peer's push watermark go to the
 *     peer's `events.push` (the same idempotent sink stations drain into).
 *   - **Pull**: peer entries above the pull watermark come back via
 *     `events.since` and are ingested through the exact same
 *     `ingestJournalEntries` path, so a pulled entry and a pushed entry have
 *     identical apply semantics.
 *
 * Watermarks live in `journal_sync_state`, keyed by `(peer_id, event_id)`,
 * as `(hlc, id)` cursors. **A watermark only advances contiguously**: the
 * batch is walked in canonical order and stops at the first failure, so a
 * failed entry is retried every cycle and nothing behind it is skipped. A
 * permanently failing entry therefore blocks its event's stream and logs
 * loudly every cycle — deliberate (single-copy durability beats silent
 * gaps); operator tooling for quarantine arrives with the lease UI (Step 4).
 *
 * Entries this node ingested *from* the peer are pushed back on the next
 * cycle (no origin tracking) — the peer skips them by id, so the echo costs
 * one round of bandwidth per entry and nothing else.
 *
 * The shipper is enabled by setting `SYNC_PEER_URL` (+ the shared secret).
 * In the target topology the venue dials the cloud; the cloud runs no
 * shipper. Transport is injectable for the two-node integration harness.
 */

import {
  createTRPCClient,
  httpLink,
  type TRPCClient,
} from "@trpc/client";
import type { AppRouter } from "../routers/index.js";
import {
  ingestJournalEntries,
  listJournalEntriesSince,
  type JournalCursor,
  type JournalPage,
  type WireJournalEntry,
} from "../routers/events.js";
import { prisma, type EventRef, type PrismaClient } from "../db.js";
import { encodeHlc } from "@oxygen/shared";
import {
  SYNC_SECRET_HEADER,
  syncIntervalMs,
  syncPeerUrl,
  syncSettingsRefreshMs,
  syncSharedSecret,
} from "./nodeIdentity.js";
import { makeLeasePeer } from "./lease.js";
import { refreshCloudOwnedSettings } from "./settingsRefresh.js";

const PUSH_BATCH = 200;
const PULL_BATCH = 200;

/** Node-to-node transport — HTTP in production, in-process in tests. */
export interface PeerTransport {
  push(
    nameId: string,
    entries: WireJournalEntry[],
  ): Promise<{ synced: string[]; failed: Array<{ id: string; error: string }> }>;
  since(
    nameId: string,
    cursor: JournalCursor,
    limit: number,
  ): Promise<JournalPage>;
}

/**
 * Production transport: tRPC over HTTP against the peer's `/trpc` mount,
 * carrying the event slug and the shared sync secret as headers. One thin
 * client per event slug (headers are fixed per client).
 */
export function httpPeerTransport(
  baseUrl: string,
  secret: string,
): PeerTransport {
  const clients = new Map<string, TRPCClient<AppRouter>>();
  const clientFor = (nameId: string): TRPCClient<AppRouter> => {
    let c = clients.get(nameId);
    if (!c) {
      c = createTRPCClient<AppRouter>({
        links: [
          httpLink({
            url: `${baseUrl}/trpc`,
            headers: {
              "x-event-id": nameId,
              [SYNC_SECRET_HEADER]: secret,
            },
          }),
        ],
      });
      clients.set(nameId, c);
    }
    return c;
  };

  return {
    async push(nameId, entries) {
      const res = await clientFor(nameId).events.push.mutate({
        events: entries,
      });
      return { synced: res.synced, failed: res.failed };
    },
    async since(nameId, cursor, limit) {
      return clientFor(nameId).events.since.query({
        afterHlc: cursor.hlc,
        afterId: cursor.id,
        limit,
      });
    },
  };
}

/** Test seam: the integration harness swaps in an in-process transport. */
let transportFactory:
  | ((baseUrl: string, secret: string) => PeerTransport)
  | null = null;
export function _setPeerTransportFactory(
  f: ((baseUrl: string, secret: string) => PeerTransport) | null,
): void {
  transportFactory = f;
}
export function makePeerTransport(
  baseUrl: string,
  secret: string,
): PeerTransport {
  return (transportFactory ?? httpPeerTransport)(baseUrl, secret);
}

// ─── Watermarks ─────────────────────────────────────────────

async function getSyncState(db: PrismaClient, peerId: string, eventId: bigint) {
  return (
    (await db.journalSyncState.findUnique({
      where: { peerId_eventId: { peerId, eventId } },
    })) ?? {
      peerId,
      eventId,
      pushedHlc: 0n,
      pushedId: "",
      pulledHlc: 0n,
      pulledId: "",
    }
  );
}

async function saveSyncState(
  db: PrismaClient,
  peerId: string,
  eventId: bigint,
  patch: Partial<{
    pushedHlc: bigint;
    pushedId: string;
    pulledHlc: bigint;
    pulledId: string;
  }>,
): Promise<void> {
  await db.journalSyncState.upsert({
    where: { peerId_eventId: { peerId, eventId } },
    create: { peerId, eventId, ...patch },
    update: patch,
  });
}

// ─── One shipping cycle for one event ───────────────────────

export interface ShipStats {
  pushed: number;
  pulled: number;
  errors: string[];
}

/**
 * Push all local entries above the push watermark to the peer, then pull all
 * peer entries above the pull watermark and apply them locally. Exported for
 * the integration harness; the background worker loops it over all events.
 */
export async function shipEventOnce(
  db: PrismaClient,
  event: EventRef,
  peerId: string,
  transport: PeerTransport,
): Promise<ShipStats> {
  const stats: ShipStats = { pushed: 0, pulled: 0, errors: [] };

  // ── Push ──
  for (;;) {
    const state = await getSyncState(db, peerId, event.id);
    const page = await listJournalEntriesSince(
      db,
      event,
      { hlc: state.pushedHlc.toString(), id: state.pushedId },
      PUSH_BATCH,
    );
    if (page.entries.length === 0) break;

    const res = await transport.push(event.nameId, page.entries);
    const syncedIds = new Set(res.synced);

    // Contiguous advance: walk the batch in canonical order, stop at the
    // first entry the peer did not ack.
    let lastAcked: (typeof page.entries)[number] | undefined;
    for (const entry of page.entries) {
      if (!syncedIds.has(entry.id)) break;
      lastAcked = entry;
      stats.pushed++;
    }
    if (lastAcked) {
      await saveSyncState(db, peerId, event.id, {
        pushedHlc: encodeHlc(lastAcked.hlc),
        pushedId: lastAcked.id,
      });
    }
    if (res.failed.length > 0) {
      stats.errors.push(
        ...res.failed.map((f) => `push ${f.id}: ${f.error}`),
      );
      break; // Failed entry blocks the stream; retried next cycle.
    }
    if (!page.hasMore) break;
  }

  // ── Pull ──
  for (;;) {
    const state = await getSyncState(db, peerId, event.id);
    const page = await transport.since(
      event.nameId,
      { hlc: state.pulledHlc.toString(), id: state.pulledId },
      PULL_BATCH,
    );
    if (page.entries.length === 0) break;

    const res = await ingestJournalEntries(db, event, page.entries);
    const syncedIds = new Set(res.synced);

    let lastApplied: (typeof page.entries)[number] | undefined;
    for (const entry of page.entries) {
      if (!syncedIds.has(entry.id)) break;
      lastApplied = entry;
      stats.pulled++;
    }
    if (lastApplied) {
      await saveSyncState(db, peerId, event.id, {
        pulledHlc: encodeHlc(lastApplied.hlc),
        pulledId: lastApplied.id,
      });
    }
    if (res.failed.length > 0) {
      stats.errors.push(
        ...res.failed.map((f) => `pull ${f.id}: ${f.error}`),
      );
      break;
    }
    if (!page.hasMore) break;
  }

  return stats;
}

/** One full cycle: ship every non-removed local event. */
export async function shipAllOnce(
  db: PrismaClient,
  peerId: string,
  transport: PeerTransport,
): Promise<void> {
  const events = await db.event.findMany({
    where: { removed: false },
    select: { id: true, nameId: true, zeroTime: true },
  });
  for (const ev of events) {
    try {
      const stats = await shipEventOnce(db, ev, peerId, transport);
      if (stats.errors.length > 0) {
        console.error(
          `[shipper] ${ev.nameId}: ${stats.errors.length} entr(ies) failed to ship — stream blocked until resolved:`,
          stats.errors.slice(0, 3).join("; "),
        );
      }
    } catch (err) {
      // Network errors land here — expected at a venue with flaky uplink.
      console.warn(
        `[shipper] ${ev.nameId}: cycle failed (peer unreachable?):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Slow-cadence pass: refresh the local copy of cloud-owned event settings
 * for events this node holds a lease on. Piggybacks on the shipper timer
 * with its own throttle (default 5 min).
 */
export async function refreshAllSettingsOnce(
  db: PrismaClient,
  peerUrl: string,
  secret: string,
): Promise<void> {
  const peer = makeLeasePeer(peerUrl, secret);
  const events = await db.event.findMany({
    where: { removed: false },
    select: { id: true, nameId: true, zeroTime: true },
  });
  for (const ev of events) {
    try {
      await refreshCloudOwnedSettings(db, ev, peer);
    } catch (err) {
      console.warn(
        `[shipper] ${ev.nameId}: settings refresh failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ─── Background worker ──────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let busy = false;
let lastSettingsRefresh = 0;

/**
 * Start the interval worker when a peer is configured. No-op otherwise —
 * a node without `SYNC_PEER_URL` (the cloud, normally) never dials out.
 */
export function startShipper(): void {
  const peerUrl = syncPeerUrl();
  const secret = syncSharedSecret();
  if (!peerUrl) return;
  if (!secret) {
    console.error(
      "[shipper] SYNC_PEER_URL is set but SYNC_SHARED_SECRET is missing — shipping disabled.",
    );
    return;
  }
  if (timer) return;

  const transport = makePeerTransport(peerUrl, secret);
  const tick = () => {
    if (busy) return; // Skip overlapping ticks.
    busy = true;
    void (async () => {
      try {
        await shipAllOnce(prisma(), peerUrl, transport);
        if (Date.now() - lastSettingsRefresh >= syncSettingsRefreshMs()) {
          lastSettingsRefresh = Date.now();
          await refreshAllSettingsOnce(prisma(), peerUrl, secret);
        }
      } catch (err) {
        console.error("[shipper] cycle crashed:", err);
      } finally {
        busy = false;
      }
    })();
  };
  console.log(`[shipper] Journal shipping to ${peerUrl} every ${syncIntervalMs()}ms`);
  tick();
  timer = setInterval(tick, syncIntervalMs());
}

export function stopShipper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
