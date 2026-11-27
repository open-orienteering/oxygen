/**
 * Venue-side upstream forwarding for cloud-owned mutations (pivot Step 4).
 *
 * On a venue node, mutations on cloud-owned data (club directory, Eventor
 * administration, external integrations, event lifecycle — see
 * `ownership.ts`) are forwarded to the cloud as an ordinary HTTPS call and
 * executed there; the venue never writes them locally. Queries are always
 * served locally from the checkout-time copy (staleness is harmless by the
 * boundary rule — nothing cloud-owned feeds result computation).
 *
 * When the venue has no internet the forward fails with a tRPC-shaped
 * PRECONDITION_FAILED ("requires connectivity", `data.reason`
 * `CLOUD_UNREACHABLE`) — venue-side users offline mid-race have no business
 * editing Eventor settings; this is the cheap path by design. A batch that
 * mixes cloud-owned and local procedures is refused the same way
 * (`MIXED_BATCH`) and nothing in it runs (row G18).
 *
 * After the cloud accepts a forwarded layout or patch write, the box
 * refreshes its copy of the event's map rows before it replies (row G19,
 * docs/map-storage.md §7.2), so the page's refetch reads its own write
 * with the cloud's token. The wait is bounded; the refresh finishes behind
 * the reply when it takes longer.
 *
 * Registered as a Fastify preHandler only when `NODE_ROLE=venue` and a peer
 * is configured, so the cloud and single-node deployments never pay for it.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { isCloudOwnedMutation } from "./ownership.js";
import {
  SYNC_FORWARDED_HEADER,
  SYNC_NODE_ID_HEADER,
  SYNC_SECRET_HEADER,
  nodeId,
  nodeRole,
  syncPeerUrl,
  syncSharedSecret,
} from "./nodeIdentity.js";
import { makeSyncHeaders } from "./googleIdToken.js";
import { createContext, capabilitiesForEventRow } from "../trpc.js";
import { authMode } from "../auth.js";
import { prisma } from "../db.js";
import { makeLeasePeer } from "./lease.js";
import { refreshCloudOwnedMaps } from "./mapRefresh.js";
import { refreshCloudOwnedSettings } from "./settingsRefresh.js";

/** Parse the procedure paths out of a tRPC request URL (batched or not). */
export function trpcProcedurePaths(url: string): string[] {
  const m = /^\/trpc\/([^?]+)/.exec(url);
  if (!m) return [];
  return decodeURIComponent(m[1])
    .split(",")
    .filter((p) => p.length > 0);
}

/**
 * Forwarding decision for one request. Only POSTs (mutations) forward, and
 * only when EVERY procedure in the (possibly batched) call is cloud-owned —
 * a mixed batch would need a split/merge of the upstream response; the web
 * sends cloud-owned mutations in a batch of their own (`trpc-links.ts`).
 */
export function shouldForwardToCloud(method: string, url: string): boolean {
  if (method !== "POST") return false;
  const paths = trpcProcedurePaths(url);
  return paths.length > 0 && paths.every(isCloudOwnedMutation);
}

/**
 * A POSTed batch that mixes cloud-owned and local procedures. Run locally,
 * its cloud-owned writes would land on the box and be lost at checkin
 * (row G18), so the forwarder refuses it whole instead (nothing runs).
 */
export function isMixedCloudBatch(method: string, url: string): boolean {
  if (method !== "POST") return false;
  const paths = trpcProcedurePaths(url);
  return paths.some(isCloudOwnedMutation) && !paths.every(isCloudOwnedMutation);
}

/** The forwarded writes after which the box refreshes the event's map rows (row G19). */
export const MAP_REFRESH_PREFIXES: readonly string[] = [
  "mapPatch.",
  "courseMap.",
  "mapTemplate.",
  "layout.",
  "graphics.",
  "courseObject.",
];

/** Whether a forwarded call wrote a map row the box mirrors. */
export function refreshesMapRows(paths: readonly string[]): boolean {
  return paths.some((p) => MAP_REFRESH_PREFIXES.some((prefix) => p.startsWith(prefix)));
}

/**
 * The forwarded writes after which the box refreshes the event row's
 * cloud-owned columns (review MC-08): exact paths, or prefixes ending in ".".
 */
export const SETTINGS_REFRESH_PATHS: readonly string[] = [
  "event.updateType",
  "event.setTestEvent",
  "competition.updateType",
  "competition.setTestEvent",
  "course.setOverprintCuts",
  "liveresults.",
  "eventor.",
];

/** Whether a forwarded call wrote a cloud-owned column of the event row. */
export function refreshesSettings(paths: readonly string[]): boolean {
  return paths.some((p) =>
    SETTINGS_REFRESH_PATHS.some((s) => (s.endsWith(".") ? p.startsWith(s) : p === s)),
  );
}

/** The event a request names: `x-event-id`, or `x-competition-id`, which the web sends (`trpc.ts` reads both). */
export function requestEventName(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers["x-event-id"] ?? headers["x-competition-id"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v ? v : null;
}

/** How long a forwarded write's reply waits for the refresh that follows it. */
export const FORWARD_REFRESH_WAIT_MS = 10_000;

/**
 * Refresh what a forwarded write changed on the cloud — the event's map rows
 * (row G19) and/or the event row's cloud-owned columns (review MC-08) —
 * waiting at most `waitMs`. Never throws: a failed refresh leaves the box on
 * its copy until the cadence's next one.
 */
export async function refreshAfterForward(
  nameId: string,
  peerUrl: string,
  waitMs = FORWARD_REFRESH_WAIT_MS,
  what: { maps?: boolean; settings?: boolean } = { maps: true },
): Promise<void> {
  const secret = syncSharedSecret();
  if (!secret) return;
  try {
    const db = prisma();
    const event = await db.event.findFirst({ where: { nameId }, select: { id: true, nameId: true, zeroTime: true, timeZone: true } });
    if (!event) return;
    const peer = makeLeasePeer(peerUrl, secret);
    const step = (label: string, run: () => Promise<unknown>): Promise<void> =>
      run().then(
        () => {},
        (err: unknown) => {
          console.warn(`[venue-forwarder] ${nameId}: ${label} refresh after a forwarded write failed:`, err instanceof Error ? err.message : String(err));
        },
      );
    const work = Promise.all([
      what.settings ? step("settings", () => refreshCloudOwnedSettings(db, event, peer)) : Promise.resolve(),
      what.maps ? step("map", () => refreshCloudOwnedMaps(db, event, peer)) : Promise.resolve(),
    ]);
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref();
    });
    await Promise.race([work, bound]);
    clearTimeout(timer);
  } catch (err) {
    console.warn(`[venue-forwarder] ${nameId}: refresh after a forwarded write failed:`, err instanceof Error ? err.message : String(err));
  }
}

/** Why a cloud-owned call failed on a venue: the cloud is unreachable, or the batch mixed it with local calls. */
export type VenueRefusalReason = "CLOUD_UNREACHABLE" | "MIXED_BATCH" | "CLOUD_AUTH";

const REFUSAL_MESSAGES: Record<VenueRefusalReason, string> = {
  CLOUD_UNREACHABLE:
    "This action requires connectivity to the cloud (cloud-owned data is not editable at an offline venue).",
  MIXED_BATCH:
    "A cloud-owned change was batched with local calls; nothing was run. Retry the action.",
  CLOUD_AUTH:
    "The cloud refused this box's credentials (check SYNC_SHARED_SECRET and the IAP settings).",
};

/** A forwarded call that gets no answer within this long is treated as an unreachable cloud. */
export const FORWARD_TIMEOUT_MS = 30_000;

/**
 * Whether a cloud reply is a tRPC answer (JSON) the box relays as it is. A
 * redirect (IAP sending the box to a sign-in page) or an HTML page is the
 * front door refusing the box, not the API answering: `CLOUD_AUTH`. An HTML
 * 5xx is an outage in front of the API: `CLOUD_UNREACHABLE`.
 */
export function classifyForwardReply(status: number, contentType: string | null): "relay" | "CLOUD_AUTH" | "CLOUD_UNREACHABLE" {
  if (status >= 300 && status < 400) return "CLOUD_AUTH";
  // A JSON 401 is the cloud's own "invalid or missing node sync secret" (a cloud not behind IAP).
  if (status === 401) return "CLOUD_AUTH";
  if (contentType && /\bjson\b/i.test(contentType)) return "relay";
  return status >= 500 ? "CLOUD_UNREACHABLE" : "CLOUD_AUTH";
}

/** tRPC-shaped error body so the web client surfaces a typed failure (`data.reason` tells the two cases apart). */
export function connectivityErrorBody(
  paths: string[],
  batched: boolean,
  reason: VenueRefusalReason = "CLOUD_UNREACHABLE",
): unknown {
  const one = (path: string) => ({
    error: {
      message: REFUSAL_MESSAGES[reason],
      code: -32603,
      data: { code: "PRECONDITION_FAILED", httpStatus: 412, path, reason },
    },
  });
  return batched ? paths.map(one) : one(paths[0] ?? "");
}

/** A tRPC-shaped refusal made by the box itself (the call is not forwarded). */
export function localRefusalBody(paths: string[], batched: boolean, code: "UNAUTHORIZED" | "FORBIDDEN", message: string): unknown {
  const one = (path: string) => ({
    error: {
      message,
      code: code === "UNAUTHORIZED" ? -32001 : -32003,
      data: { code, httpStatus: code === "UNAUTHORIZED" ? 401 : 403, path },
    },
  });
  return batched ? paths.map(one) : one(paths[0] ?? "");
}

/**
 * Who may lend the box's authority upstream. The forward is made as the box,
 * with every capability on events checked out to it, so with login on at the
 * box the local caller is checked first: signed in, and an instance admin or
 * holding `event.manage` on the box's copy of the event the request names (no
 * event: admin only). `null` = allowed. With login off at the box (a LAN
 * venue box) every device on the LAN is trusted, as for all local writes.
 */
export async function localForwardRefusal(req: FastifyRequest): Promise<{ code: "UNAUTHORIZED" | "FORBIDDEN"; message: string } | null> {
  if (authMode() === "off") return null;
  const ctx = await createContext({ req } as unknown as Parameters<typeof createContext>[0]);
  if (!ctx.user) return { code: "UNAUTHORIZED", message: "Not authenticated" };
  if (ctx.user.isAdmin) return null;
  if (ctx.event) {
    const date = ctx.event.date ?? new Date(0);
    const caps = await capabilitiesForEventRow(ctx, { id: ctx.event.id, date });
    if (caps.has("event.manage")) return null;
    return { code: "FORBIDDEN", message: "Missing capability event.manage" };
  }
  return { code: "FORBIDDEN", message: "Admin access required" };
}

export function registerVenueForwarder(server: FastifyInstance, opts: { timeoutMs?: number } = {}): void {
  const timeoutMs = opts.timeoutMs ?? FORWARD_TIMEOUT_MS;
  const peerUrl = syncPeerUrl();
  if (nodeRole() !== "venue" || !peerUrl) return;

  server.addHook("preHandler", async (req: FastifyRequest, reply) => {
    if (isMixedCloudBatch(req.method, req.url)) {
      const paths = trpcProcedurePaths(req.url);
      void reply.code(412).send(connectivityErrorBody(paths, req.url.includes("batch=1"), "MIXED_BATCH"));
      return reply;
    }
    if (!shouldForwardToCloud(req.method, req.url)) return;

    const paths = trpcProcedurePaths(req.url);
    const batched = req.url.includes("batch=1");
    const refusal = await localForwardRefusal(req);
    if (refusal) {
      void reply
        .code(refusal.code === "UNAUTHORIZED" ? 401 : 403)
        .send(localRefusalBody(paths, batched, refusal.code, refusal.message));
      return reply;
    }
    try {
      // The box's own credentials, never the caller's: the node secret, its
      // id and the forwarded marker (the cloud then runs the call as this
      // node, under the lease rule), plus an IAP token when configured. The
      // caller's identity header is not relayed (it would be a header the
      // cloud's proxy never set).
      const secret = syncSharedSecret();
      const base: Record<string, string> = {
        "content-type": req.headers["content-type"] ?? "application/json",
        ...(req.headers["x-event-id"] ? { "x-event-id": String(req.headers["x-event-id"]) } : {}),
        ...(req.headers["x-competition-id"] ? { "x-competition-id": String(req.headers["x-competition-id"]) } : {}),
        ...(secret ? { [SYNC_SECRET_HEADER]: secret } : {}),
        [SYNC_NODE_ID_HEADER]: nodeId(),
        [SYNC_FORWARDED_HEADER]: "1",
      };
      const made = makeSyncHeaders(base);
      const headers = typeof made === "function" ? await made() : made;
      const upstream = await fetch(`${peerUrl}${req.url}`, {
        method: "POST",
        headers,
        body: JSON.stringify(req.body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const verdict = classifyForwardReply(upstream.status, upstream.headers.get("content-type"));
      if (verdict !== "relay") {
        await upstream.body?.cancel().catch(() => {});
        void reply.code(412).send(connectivityErrorBody(paths, batched, verdict));
        return reply;
      }
      const text = await upstream.text();
      const nameId = requestEventName(req.headers);
      if (upstream.ok && nameId) {
        const maps = refreshesMapRows(paths);
        const settings = refreshesSettings(paths);
        if (maps || settings) await refreshAfterForward(nameId, peerUrl, FORWARD_REFRESH_WAIT_MS, { maps, settings });
      }
      void reply
        .code(upstream.status)
        .header(
          "content-type",
          upstream.headers.get("content-type") ?? "application/json",
        )
        .send(text);
    } catch {
      void reply.code(412).send(connectivityErrorBody(paths, batched));
    }
    return reply;
  });
  console.log(`[venue-forwarder] Cloud-owned mutations forward to ${peerUrl}`);
}
