import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma, resolveEvent, type EventRef } from "./db.js";
import {
  SYNC_SECRET_HEADER,
  syncSharedSecret,
} from "./sync/nodeIdentity.js";

/** Context available to all tRPC procedures. */
export interface Context {
  /** Resolved active event from the x-competition-id header, or null. */
  event: EventRef | null;
  /** Node-to-node shared secret from the request, if any (see peerProcedure). */
  syncSecret?: string | null;
}

/**
 * Build the per-request context. The header is `x-competition-id` for
 * backwards compatibility with the running web clients during the
 * MeOS → Postgres cutover; the next major release renames it to
 * `x-event-id`.
 */
export async function createContext(
  opts: CreateFastifyContextOptions,
): Promise<Context> {
  const raw =
    opts.req.headers["x-event-id"] ?? opts.req.headers["x-competition-id"];
  const nameId = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  const event = nameId ? await resolveEvent(nameId) : null;
  const secretRaw = opts.req.headers[SYNC_SECRET_HEADER];
  const syncSecret = (Array.isArray(secretRaw) ? secretRaw[0] : secretRaw) ?? null;
  return { event, syncSecret };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure.use(async ({ path, next }) => {
  const result = await next();
  if (!result.ok) {
    console.error(`[tRPC ERROR] ${path}:`, result.error);
  }
  return result;
});

/** Context shape inside an eventProcedure handler. */
export interface EventContext extends Context {
  event: EventRef;
  db: PrismaClient;
}

/**
 * Base procedure for all event-scoped operations.
 * Resolves the active event from the request header; injects `ctx.event`
 * (the resolved row) and `ctx.db` (the singleton Prisma client).
 * Throws BAD_REQUEST if no event is identified, NOT_FOUND if the slug
 * doesn't resolve.
 */
export const eventProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.event) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "No event selected (missing or unresolved x-event-id / x-competition-id header)",
    });
  }
  return next({
    ctx: { ...ctx, event: ctx.event, db: prisma() } as EventContext,
  });
});

/**
 * Event-scoped procedure reserved for node-to-node calls (journal shipping).
 * Requires `SYNC_SHARED_SECRET` to be configured on this node AND presented
 * by the caller in the `x-oxygen-sync-secret` header. Without a configured
 * secret every call is refused — peering is opt-in.
 */
export const peerProcedure = eventProcedure.use(async ({ ctx, next }) => {
  const expected = syncSharedSecret();
  if (!expected) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Node-to-node sync is not configured on this node (no SYNC_SHARED_SECRET)",
    });
  }
  if (ctx.syncSecret !== expected) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid or missing node sync secret",
    });
  }
  return next();
});
