import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { PrismaClient } from "@prisma/client";
import { getCompetitionClient } from "./db.js";

/** Context available to all tRPC procedures */
export interface Context {
  /** Competition database name, resolved from the x-competition-id request header */
  dbName: string | null;
}

export async function createContext(
  opts: CreateFastifyContextOptions,
): Promise<Context> {
  const raw = opts.req.headers["x-competition-id"];
  const dbName = (Array.isArray(raw) ? raw[0] : raw) ?? null;
  return { dbName: dbName || null };
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

/** Context shape available inside competitionProcedure handlers */
export interface CompetitionContext extends Context {
  dbName: string; // guaranteed non-null
  db: PrismaClient;
}

/**
 * Base procedure for all competition-scoped operations.
 * Resolves and injects ctx.db (the competition's PrismaClient) from ctx.dbName.
 * Throws BAD_REQUEST if no competition is identified in the request.
 */
export const competitionProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.dbName) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "No competition selected (missing x-competition-id header)",
    });
  }
  const db = await getCompetitionClient(ctx.dbName);
  return next({ ctx: { ...ctx, dbName: ctx.dbName, db } as CompetitionContext });
});
