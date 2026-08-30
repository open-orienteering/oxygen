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
 * PRECONDITION_FAILED ("requires connectivity") — venue-side users offline
 * mid-race have no business editing Eventor settings; this is the cheap
 * path by design.
 *
 * Registered as a Fastify preHandler only when `NODE_ROLE=venue` and a peer
 * is configured, so the cloud and single-node deployments never pay for it.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { isCloudOwnedMutation } from "./ownership.js";
import { nodeRole, syncPeerUrl } from "./nodeIdentity.js";
import { authHeaderName } from "../auth.js";

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
 * a mixed batch would need a split/merge of the upstream response, and the
 * web client never produces one (batches are per-feature-page).
 */
export function shouldForwardToCloud(method: string, url: string): boolean {
  if (method !== "POST") return false;
  const paths = trpcProcedurePaths(url);
  return paths.length > 0 && paths.every(isCloudOwnedMutation);
}

/** tRPC-shaped error body so the web client surfaces a typed failure. */
export function connectivityErrorBody(
  paths: string[],
  batched: boolean,
): unknown {
  const one = (path: string) => ({
    error: {
      message:
        "This action requires connectivity to the cloud (cloud-owned data is not editable at an offline venue).",
      code: -32603,
      data: { code: "PRECONDITION_FAILED", httpStatus: 412, path },
    },
  });
  return batched ? paths.map(one) : one(paths[0] ?? "");
}

export function registerVenueForwarder(server: FastifyInstance): void {
  const peerUrl = syncPeerUrl();
  if (nodeRole() !== "venue" || !peerUrl) return;

  server.addHook("preHandler", async (req: FastifyRequest, reply) => {
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
