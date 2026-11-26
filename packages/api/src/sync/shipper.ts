/**
 * Journal shipper (pivot Step 3).
 *
 * Background worker that keeps this node's journal converged with its peer:
 *
 *   - **Push**: local entries not yet delivered (`journal.pushed_at IS NULL`,
 *     in local arrival order, `ingest_seq`) go to the peer's `events.push`
 *     (the same idempotent sink stations drain into), and are marked
 *     delivered once the peer acks them.
 *   - **Pull**: the peer's undelivered entries come back via
 *     `events.unshipped`, are ingested through the exact same
 *     `ingestJournalEntries` path (so a pulled entry and a pushed entry have
 *     identical apply semantics) and confirmed with `events.ackShipped`.
 *
 * Delivery is a mark on the row, not a position in the HLC order: an entry
 * that reaches a node late with an old HLC (a station's outbox draining
 * after the clock moved on) is still unmarked, so it still ships. **A mark
 * only advances over a contiguous prefix**: the page is walked in order and
 * stops at the first failure, so a failed entry is retried every cycle and
 * nothing behind it is skipped. A permanently failing entry therefore blocks
 * its event's stream and logs loudly every cycle: deliberate (single-copy
 * durability beats silent gaps).
 *
 * Entries this node ingested *from* the peer are created already marked, so
 * nothing is echoed back.
 *
 * Against a peer that predates `events.unshipped` the pull falls back to the
 * old `(hlc, id)` cursor in `journal_sync_state` (`events.since`); the push is
 * the same.
 *
 * The shipper is enabled by setting `SYNC_PEER_URL` (+ the shared secret).
 * The venue dials the cloud; the cloud runs no shipper and never dials a
 * venue. It only answers: `events.push` from the venue, and `events.unshipped`
 * / `events.ackShipped` for the venue that holds the event's lease. Transport is injectable for the two-node integration harness.
 */

import {
  createTRPCClient,
  httpLink,
  type TRPCClient,
} from "@trpc/client";
import type { AppRouter } from "../routers/index.js";
import {
  ingestJournalEntries,
  listUnshippedJournalEntries,
  markJournalShipped,
  type JournalCursor,
  type JournalPage,
  type WireJournalEntry,
} from "../routers/events.js";
import { prisma, type EventRef, type PrismaClient } from "../db.js";
import { encodeHlc } from "@oxygen/shared";
import { TRPCClientError } from "@trpc/client";
import {
  SYNC_SECRET_HEADER,
  SYNC_NODE_ID_HEADER,
  nodeId,
  syncIntervalMs,
  syncPeerUrl,
  syncSettingsRefreshMs,
  syncSharedSecret,
} from "./nodeIdentity.js";
import { makeSyncHeaders } from "./googleIdToken.js";
import { getActiveLease, makeLeasePeer, releaseLease, type LeasePeer } from "./lease.js";
import { isCheckingIn } from "./leaseState.js";
import { pushVenueOwnedSettings, refreshCloudOwnedSettings } from "./settingsRefresh.js";
import { refreshCloudOwnedMaps } from "./mapRefresh.js";

const PUSH_BATCH = 200;
const PULL_BATCH = 200;

/** Node-to-node transport — HTTP in production, in-process in tests. */
export interface PeerTransport {
  push(
    nameId: string,
    entries: WireJournalEntry[],
  ): Promise<{ synced: string[]; failed: Array<{ id: string; error: string }> }>;
  /** The peer's next page of entries it has not delivered to this node. */
  unshipped(
    nameId: string,
    limit: number,
  ): Promise<{ entries: JournalPage["entries"]; hasMore: boolean }>;
  /** Tell the peer these entries are applied here (it marks them delivered). */
  ack(nameId: string, ids: string[]): Promise<void>;
  /** Legacy pull for a peer without `unshipped` (an older box or cloud). */
  since?(
    nameId: string,
    cursor: JournalCursor,
    limit: number,
  ): Promise<JournalPage>;
}

/** The peer answered that it has no such procedure (it is older than this node). */
export function isProcedureMissing(err: unknown): boolean {
  if (err instanceof TRPCClientError) {
    return (err.data as { code?: string } | undefined)?.code === "NOT_FOUND";
  }
  return (err as { code?: string } | null)?.code === "NOT_FOUND";
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
            // With SYNC_GOOGLE_AUDIENCE set (cloud behind IAP) this is an
            // async provider that adds a Bearer ID token per request.
            headers: makeSyncHeaders({
              "x-event-id": nameId,
              [SYNC_SECRET_HEADER]: secret,
              [SYNC_NODE_ID_HEADER]: nodeId(),
            }),
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
    async unshipped(nameId, limit) {
      return clientFor(nameId).events.unshipped.query({ limit });
    },
    async ack(nameId, ids) {
      await clientFor(nameId).events.ackShipped.mutate({ ids });
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

/** Warn once per process that the peer predates `events.unshipped`. */
let warnedLegacyPeer = false;

/** Ids of the longest prefix of `entries` that `acked` contains. */
function ackedPrefix(entries: Array<{ id: string }>, acked: Set<string>): string[] {
  const ids: string[] = [];
  for (const e of entries) {
    if (!acked.has(e.id)) break;
    ids.push(e.id);
  }
  return ids;
}

/**
 * Push all undelivered local entries to the peer, then pull all the peer's
 * undelivered entries and apply them locally. Exported for the integration
 * harness; the background worker loops it over the events it ships.
 */
export async function shipEventOnce(
  db: PrismaClient,
  event: EventRef,
  peerId: string,
  transport: PeerTransport,
  opts: { pull?: boolean } = {},
): Promise<ShipStats> {
  const stats: ShipStats = { pushed: 0, pulled: 0, errors: [] };

  // ── Push ──
  for (;;) {
    const page = await listUnshippedJournalEntries(db, event, PUSH_BATCH);
    if (page.entries.length === 0) break;

    const res = await transport.push(event.nameId, page.entries);
    // Contiguous advance: walk the batch in order, stop at the first entry
    // the peer did not ack.
    const ids = ackedPrefix(page.entries, new Set(res.synced));
    if (ids.length > 0) {
      await markJournalShipped(db, event.id, ids);
      stats.pushed += ids.length;
    }
    if (res.failed.length > 0) {
      stats.errors.push(
        ...res.failed.map((f) => `push ${f.id}: ${f.error}`),
      );
      break; // Failed entry blocks the stream; retried next cycle.
    }
    // Nothing (or only part of the page) was acked: the next page would be
    // the same entries again.
    if (ids.length < page.entries.length || !page.hasMore) break;
  }

  // ── Pull ──
  // Only the lease holder pulls: the peer's delivery mark is one bit, so a
  // copy that no longer holds the event must not consume the entries meant
  // for the current holder.
  if (opts.pull === false) return stats;
  let legacy = false;
  for (;;) {
    let page: { entries: JournalPage["entries"]; hasMore: boolean };
    try {
      page = await transport.unshipped(event.nameId, PULL_BATCH);
    } catch (err) {
      if (!isProcedureMissing(err) || !transport.since) throw err;
      if (!warnedLegacyPeer) {
        warnedLegacyPeer = true;
        console.warn(
          "[shipper] peer has no events.unshipped (older version): pulling by HLC cursor; upgrade the peer to ship late entries reliably.",
        );
      }
      legacy = true;
      break;
    }
    if (page.entries.length === 0) break;

    const res = await ingestJournalEntries(db, event, page.entries, { fromPeer: true });
    const ids = ackedPrefix(page.entries, new Set(res.synced));
    if (ids.length > 0) {
      stats.pulled += ids.length;
      await transport.ack(event.nameId, ids);
    }
    if (res.failed.length > 0) {
      stats.errors.push(
        ...res.failed.map((f) => `pull ${f.id}: ${f.error}`),
      );
      break;
    }
    if (ids.length < page.entries.length || !page.hasMore) break;
  }
  if (legacy) await legacyPull(db, event, peerId, transport, stats);

  return stats;
}

/** The pre-delivery-mark pull: `(hlc, id)` cursor in `journal_sync_state`, `events.since` on the peer. */
async function legacyPull(
  db: PrismaClient,
  event: EventRef,
  peerId: string,
  transport: PeerTransport,
  stats: ShipStats,
): Promise<void> {
  for (;;) {
    const state = await getSyncState(db, peerId, event.id);
    const page = await transport.since!(
      event.nameId,
      { hlc: state.pulledHlc.toString(), id: state.pulledId },
      PULL_BATCH,
    );
    if (page.entries.length === 0) break;

    const res = await ingestJournalEntries(db, event, page.entries, { fromPeer: true });
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
}

/**
 * Takeover detection (review SYNC-08): this box thinks it holds the lease,
 * but the peer says someone else does (a force takeover while the box was
 * dead or off the network), or nobody. The box lets go locally, marked
 * forced, so it stops originating race data; its backlog keeps shipping. A
 * peer that cannot be asked (offline, or older than `lease.holder`) changes
 * nothing.
 */
async function releaseIfTakenOver(
  db: PrismaClient,
  ev: EventRef,
  peer: LeasePeer,
): Promise<void> {
  if (!peer.holder || isCheckingIn(ev.id)) return;
  const mine = await getActiveLease(db, ev.id);
  if (!mine || mine.holderNodeId !== nodeId()) return;
  let answer: { holderNodeId: string | null };
  try {
    answer = await peer.holder(ev.nameId);
  } catch {
    return;
  }
  if (answer.holderNodeId === nodeId()) return;
  // The lease may have been released meanwhile (a checkin on this box).
  if (!(await getActiveLease(db, ev.id))) return;
  await releaseLease(db, ev.id, { forced: true }).catch(() => {});
  console.error(
    `[lease] ${ev.nameId}: the cloud says the lease is ${answer.holderNodeId ? `held by "${answer.holderNodeId}"` : "free"}: this event was taken over. Releasing the local lease; race writes on this copy are refused from now on and the backlog keeps shipping.`,
  );
}

/** One full cycle: ship every non-removed local event. */
export async function shipAllOnce(
  db: PrismaClient,
  peerId: string,
  transport: PeerTransport,
  peer?: LeasePeer,
): Promise<void> {
  // Only events checked out against this peer (checkout writes the
  // sync-state row). An event this box created or kept for itself is not
  // sent to the cloud, and its slug is never asked of the cloud (review MC-23).
  const events = await db.event.findMany({
    where: { removed: false, journalSyncStates: { some: { peerId } } },
    select: { id: true, nameId: true, zeroTime: true, timeZone: true },
  });
  for (const ev of events) {
    try {
      if (peer) await releaseIfTakenOver(db, ev, peer);
      const holds = (await getActiveLease(db, ev.id))?.holderNodeId === nodeId();
      const stats = await shipEventOnce(db, ev, peerId, transport, { pull: holds });
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
 * Slow-cadence pass: push this box's venue-owned event settings to the
 * cloud and refresh the local copy of its cloud-owned ones (review MC-08),
 * then of the event's cloud-owned map rows (row G19,
 * docs/map-storage.md §7.2), for events this node holds a lease on. The
 * two fail independently. Piggybacks on the shipper timer with its own
 * throttle (default 5 min).
 */
export async function refreshAllSettingsOnce(
  db: PrismaClient,
  peerUrl: string,
  secret: string,
): Promise<void> {
  const peer = makeLeasePeer(peerUrl, secret);
  const events = await db.event.findMany({
    where: { removed: false },
    select: { id: true, nameId: true, zeroTime: true, timeZone: true },
  });
  for (const ev of events) {
    try {
      await pushVenueOwnedSettings(db, ev, peer);
    } catch (err) {
      console.warn(
        `[shipper] ${ev.nameId}: venue settings push failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      await refreshCloudOwnedSettings(db, ev, peer);
    } catch (err) {
      console.warn(
        `[shipper] ${ev.nameId}: settings refresh failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      await refreshCloudOwnedMaps(db, ev, peer);
    } catch (err) {
      // Offline, or a cloud that predates `exportMapRows`: the box keeps its copy.
      console.warn(
        `[shipper] ${ev.nameId}: map refresh failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ─── Background worker ──────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let busy = false;
let lastSettingsRefresh = 0;
/** A venue-owned setting the cloud acts on changed: send it before shipping. */
let venueSettingsDirty = false;
/** Ticks left to retry a failed early settings push before leaving it to the cadence. */
let venueSettingsRetries = 0;
const VENUE_SETTINGS_RETRY_TICKS = 120;

/**
 * Ask the shipper to send this box's venue-owned settings ahead of the next
 * journal batch. The cloud pushes the box's readouts to the Google Sheets
 * backup, so a webhook URL set on the box must reach the cloud before the
 * readouts that follow it, not on the 5-minute settings cadence (SYNC-14).
 * Tried ahead of each tick's batch until it succeeds, for a bounded number
 * of ticks (an outage of a few minutes: the first tick back online pushes
 * the settings before the backlog). It never holds shipping back, so a
 * permanent refusal (another holder, an older cloud) costs one request per
 * tick until the retries run out, and then falls back to the cadence.
 */
export function markVenueSettingsChanged(): void {
  venueSettingsDirty = true;
  venueSettingsRetries = VENUE_SETTINGS_RETRY_TICKS;
}

/** Push every held event's venue-owned settings; false when any push failed. */
async function pushAllVenueSettingsOnce(db: PrismaClient, peer: LeasePeer): Promise<boolean> {
  const events = await db.event.findMany({
    where: { removed: false },
    select: { id: true, nameId: true, zeroTime: true, timeZone: true },
  });
  let ok = true;
  for (const ev of events) {
    try {
      await pushVenueOwnedSettings(db, ev, peer);
    } catch (err) {
      ok = false;
      console.warn(
        `[shipper] ${ev.nameId}: venue settings push failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return ok;
}

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
  const leasePeer = makeLeasePeer(peerUrl, secret);
  const tick = () => {
    if (busy) return; // Skip overlapping ticks.
    busy = true;
    void (async () => {
      try {
        // Best effort and never blocking: with the link up the settings land
        // before this tick's journal batch.
        if (venueSettingsDirty) {
          const ok = await pushAllVenueSettingsOnce(prisma(), leasePeer);
          venueSettingsDirty = !ok && --venueSettingsRetries > 0;
        }
        await shipAllOnce(prisma(), peerUrl, transport, leasePeer);
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
