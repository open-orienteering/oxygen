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
import { nodeRole, syncPeerUrl, syncSharedSecret } from "./nodeIdentity.js";
import { authHeaderName } from "../auth.js";
import { prisma } from "../db.js";
import { makeLeasePeer } from "./lease.js";
import { refreshCloudOwnedMaps } from "./mapRefresh.js";

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

/** The event a request names: `x-event-id`, or `x-competition-id`, which the web sends (`trpc.ts` reads both). */
export function requestEventName(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers["x-event-id"] ?? headers["x-competition-id"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v ? v : null;
}

/** How long a forwarded write's reply waits for the refresh that follows it. */
export const FORWARD_REFRESH_WAIT_MS = 10_000;

/**
 * Refresh the event's map rows after a forwarded write (row G19), waiting
 * at most `waitMs`. Never throws: a failed refresh leaves the box on its
 * copy until the cadence's next one.
 */
export async function refreshAfterForward(nameId: string, peerUrl: string, waitMs = FORWARD_REFRESH_WAIT_MS): Promise<void> {
  const secret = syncSharedSecret();
  if (!secret) return;
  try {
    const db = prisma();
    const event = await db.event.findFirst({ where: { nameId }, select: { id: true, nameId: true, zeroTime: true } });
    if (!event) return;
    const work = refreshCloudOwnedMaps(db, event, makeLeasePeer(peerUrl, secret)).then(
      () => {},
      (err: unknown) => {
        console.warn(`[venue-forwarder] ${nameId}: map refresh after a forwarded write failed:`, err instanceof Error ? err.message : String(err));
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref();
    });
    await Promise.race([work, bound]);
    clearTimeout(timer);
  } catch (err) {
    console.warn(`[venue-forwarder] ${nameId}: map refresh after a forwarded write failed:`, err instanceof Error ? err.message : String(err));
  }
}

/** Why a cloud-owned call failed on a venue: the cloud is unreachable, or the batch mixed it with local calls. */
export type VenueRefusalReason = "CLOUD_UNREACHABLE" | "MIXED_BATCH";

const REFUSAL_MESSAGES: Record<VenueRefusalReason, string> = {
  CLOUD_UNREACHABLE:
    "This action requires connectivity to the cloud (cloud-owned data is not editable at an offline venue).",
  MIXED_BATCH:
    "A cloud-owned change was batched with local calls; nothing was run. Retry the action.",
};

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

export function registerVenueForwarder(server: FastifyInstance): void {
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
    try {
      const upstream = await fetch(`${peerUrl}${req.url}`, {
        method: "POST",
        headers: {
          "content-type": req.headers["content-type"] ?? "application/json",
          ...(req.headers["x-event-id"]
            ? { "x-event-id": String(req.headers["x-event-id"]) }
            : {}),
          ...(req.headers["x-competition-id"]
            ? { "x-competition-id": String(req.headers["x-competition-id"]) }
            : {}),
          ...(() => {
            const name = authHeaderName();
            const raw = req.headers[name];
            if (raw == null) return {};
            return { [name]: Array.isArray(raw) ? raw[0] : raw };
          })(),
        },
        body: JSON.stringify(req.body),
      });
      const text = await upstream.text();
      const nameId = requestEventName(req.headers);
      if (upstream.ok && nameId && refreshesMapRows(paths)) {
        await refreshAfterForward(nameId, peerUrl);
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
