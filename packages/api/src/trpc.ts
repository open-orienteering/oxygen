import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma, resolveEvent, type EventRef } from "./db.js";

/** Context available to all tRPC procedures. */
export interface Context {
  /** Resolved active event from the x-competition-id header, or null. */
  event: EventRef | null;
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
  return { event };
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
